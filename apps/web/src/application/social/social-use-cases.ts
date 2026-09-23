import type { SocialAccountView, SocialPostDraftView, SocialPostView } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { defineUseCase } from '@/application/authorization/use-case';
import { emit } from '@/application/events';
import { findPublisher, type RegisteredPublisher } from '@/application/social/publisher-registry';
import { NotFoundError, ValidationError } from '@/domain/repository';
import type { Secret } from '@/domain/secret';
import {
  CREDENTIAL_MAX_LENGTH,
  validateCredentialAgainstFields,
  type CredentialField,
} from '@/domain/social/credential';
import {
  checkPublisherLimits,
  MANUAL_TIMEOUT_MS,
  VALIDATE_TIMEOUT_MS,
} from '@/domain/social/publishing';
import {
  canTransition,
  DELIVERED_STATUSES,
  EXTERNAL_ID_MAX_LENGTH,
  EXTERNAL_URL_MAX_LENGTH,
  FAILURE_REASON_MAX_LENGTH,
  isValidDisplayName,
  isValidExternalUrl,
  isValidManualUrl,
  isValidPostBody,
  isValidProvider,
  type AccountStatus,
  type DeliveryMode,
  type PostMedia,
  type PostStatus,
  type SocialAccount,
  type SocialPost,
} from '@/domain/social/social';
import type { SocialAccountPage, SocialPostPage } from '@/domain/social/social-repository';
import { encryptSecret } from '@/infrastructure/crypto/cipher';
import { log } from '@/infrastructure/logging';
import { redactSecrets } from '@/infrastructure/secret-text';
import { socialRepository } from '@/infrastructure/social-repository';

/**
 * SNSアカウントと投稿の UseCase。
 *
 * **外部SNSへの実投稿は行わない**（Plugin の責務）。
 * ここが扱うのはデータと状態だけ。
 */

// ---------------------------------------------------------------------------
// publisher の宣言を Core 側の型へ写す
// ---------------------------------------------------------------------------

/**
 * `credentialFields` を Domain の型へ落とす。
 *
 * **Domain は `@torifune/plugin-api` を知らない**（035-social-publishing 設計 §4.1）。
 * 写すのは Application の仕事。
 */
function credentialFieldsOf(publisher: RegisteredPublisher | null): readonly CredentialField[] {
  return (publisher?.registration.credentialFields ?? []).map((field) => ({
    key: field.key,
    kind: field.kind,
  }));
}

/**
 * Plugin へ渡すアカウントの形。
 *
 * **資格情報の平文を載せない。** 設定済みかどうかだけを持たせる
 * （`SocialAccount` 自体が平文を持たない）。
 */
export function toAccountView(account: SocialAccount): SocialAccountView {
  return {
    id: account.id,
    provider: account.provider,
    displayName: account.displayName,
    handle: account.handle,
    status: account.status,
    credentialConfigured: account.credentialConfigured,
  };
}

/** Plugin へ渡す投稿の形。日時は ISO 文字列にする。 */
export function toPostView(post: SocialPost): SocialPostView {
  return {
    id: post.id,
    socialAccountId: post.socialAccountId,
    body: post.body,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    failureReason: post.failureReason,
    deliveryMode: post.deliveryMode,
    media: post.media.map((item) => ({ url: item.url, alt: item.alt })),
    link: post.link,
    providerOptions: post.providerOptions,
    externalRef: post.externalRef,
    externalId: post.externalId,
    externalUrl: post.externalUrl,
    failedAt: post.failedAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// 資格情報（`credential` / `credentials`）
// ---------------------------------------------------------------------------

/**
 * 保存する資格情報を決める（035-social-publishing 設計 §6.4 / §5.7）。
 *
 * 戻り値は `undefined`（変えない）／`null`（消す）／暗号文。
 * **保存形式は変えない。** `credentials` は JSON オブジェクトの文字列にしてから
 * 丸ごと 1 つの暗号文にする。どのキーが設定されているかも応答には出さない。
 */
function resolveEncryptedCredential(
  provider: string,
  credential: string | undefined,
  credentials: Readonly<Record<string, string>> | undefined,
): string | null | undefined {
  if (credential !== undefined && credentials !== undefined) {
    throw new ValidationError(
      'SocialAccount',
      'credentials',
      'credential と credentials は同時に指定できません。',
    );
  }

  if (credentials === undefined) {
    if (credential === undefined) {
      return undefined;
    }
    return credential === '' ? null : encryptSecret(credential);
  }

  // 空のオブジェクトは「消す」。`credential: ''` と同じ意味。
  if (Object.keys(credentials).length === 0) {
    return null;
  }

  const problems = validateCredentialAgainstFields(
    credentials,
    credentialFieldsOf(findPublisher(provider)),
  );
  if (problems.length > 0) {
    throw new ValidationError(
      'SocialAccount',
      'credentials',
      problems[0]?.message ?? '資格情報が宣言と合いません。',
      { credentials: problems.map((problem) => problem.message) },
    );
  }

  const plaintext = JSON.stringify(credentials);
  if (plaintext.length > CREDENTIAL_MAX_LENGTH) {
    throw new ValidationError(
      'SocialAccount',
      'credentials',
      `資格情報は JSON にして${CREDENTIAL_MAX_LENGTH}文字以内にしてください。`,
    );
  }

  return encryptSecret(plaintext);
}

// ---------------------------------------------------------------------------
// アカウント
// ---------------------------------------------------------------------------

export interface ListAccountsInput {
  readonly page: number;
  readonly perPage: number;
  readonly provider: string | null;
}

export const listSocialAccounts = defineUseCase<ListAccountsInput, SocialAccountPage>({
  name: 'social.account.list',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listAccounts(context.connection, {
      page: input.page,
      perPage: input.perPage,
      provider: input.provider,
    }),
});

export const getSocialAccount = defineUseCase<{ id: string }, SocialAccount>({
  name: 'social.account.get',
  permission: 'social.read',
  handler: async (context, input) => {
    const account = await socialRepository.findAccountById(context.connection, input.id);
    if (account === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    return account;
  },
});

export interface CreateAccountInput {
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  /** 平文。**保存前に暗号化する。** */
  readonly credential: string | null;
  /**
   * publisher が宣言した `credentialFields` に従う資格情報。
   *
   * **`credential` との同時指定は 422**（035-social-publishing 設計 §6.4）。
   * JSON オブジェクトの文字列にしてから暗号化する（§5.7）。
   */
  readonly credentials?: Readonly<Record<string, string>> | undefined;
  readonly status: AccountStatus;
}

export const createSocialAccount = defineUseCase<CreateAccountInput, SocialAccount>({
  name: 'social.account.create',
  permission: 'social.write',
  audit: {
    action: 'created',
    resourceType: 'social_account',
    resourceId: (_input, account) => account.id,
    // 認証情報は残さない。どのSNSのアカウントかが分かれば追跡できる。
    detail: (_input, account) => ({ provider: account.provider }),
  },
  handler: async (context, input) => {
    if (!isValidProvider(input.provider)) {
      throw new ValidationError(
        'SocialAccount',
        'provider',
        '英小文字・数字・アンダースコアで指定してください。',
      );
    }
    if (!isValidDisplayName(input.displayName)) {
      throw new ValidationError('SocialAccount', 'displayName', '表示名を入力してください。');
    }

    // 平文をそのまま保存しない。
    const encryptedCredential =
      resolveEncryptedCredential(
        input.provider,
        input.credential === null ? undefined : input.credential,
        input.credentials,
      ) ?? null;

    const account = await context.connection.transaction((tx) =>
      socialRepository.insertAccount(tx, {
        id: uuidv7(),
        provider: input.provider,
        displayName: input.displayName.trim(),
        handle: input.handle,
        encryptedCredential,
        status: input.status,
      }),
    );

    // ペイロードに資格情報を含めない。Plugin へ渡ると、そこから漏れる。
    await emit('social.account.connected', {
      accountId: account.id,
      provider: account.provider,
      displayName: account.displayName,
    });

    return account;
  },
});

export interface UpdateAccountInput {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly handle?: string | undefined;
  readonly status?: AccountStatus | undefined;
  /**
   * `undefined` なら変えない。空文字なら消す。
   * **「指定しない」と「消す」を区別する。**
   * 区別しないと、表示名だけ直したつもりで資格情報が消える。
   */
  readonly credential?: string | undefined;
  /**
   * `undefined` なら変えない。空のオブジェクトなら消す。
   * **`credential` との同時指定は 422**（035-social-publishing 設計 §6.4）。
   */
  readonly credentials?: Readonly<Record<string, string>> | undefined;
}

export const updateSocialAccount = defineUseCase<UpdateAccountInput, SocialAccount>({
  name: 'social.account.update',
  permission: 'social.write',
  audit: {
    action: 'updated',
    resourceType: 'social_account',
    resourceId: (input) => input.id,
    detail: (input) => ({ changed: Object.keys(input).filter((key) => key !== 'id') }),
  },
  handler: async (context, input) => {
    if (input.displayName !== undefined && !isValidDisplayName(input.displayName)) {
      throw new ValidationError('SocialAccount', 'displayName', '表示名を入力してください。');
    }

    // `credentialFields` は provider ごとなので、いまの provider を引いてから突き合わせる。
    const current = await socialRepository.findAccountById(context.connection, input.id);
    if (current === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }

    const encryptedCredential = resolveEncryptedCredential(
      current.provider,
      input.credential,
      input.credentials,
    );

    const account = await context.connection.transaction((tx) =>
      socialRepository.updateAccount(tx, input.id, {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
        ...(input.handle === undefined ? {} : { handle: input.handle }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(encryptedCredential === undefined ? {} : { encryptedCredential }),
      }),
    );

    if (account === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    return account;
  },
});

export const deleteSocialAccount = defineUseCase<{ id: string }, void>({
  name: 'social.account.delete',
  permission: 'social.delete',
  audit: { action: 'deleted', resourceType: 'social_account', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const deleted = await context.connection.transaction((tx) =>
      socialRepository.deleteAccount(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    await emit('social.account.disconnected', { accountId: input.id });
  },
});

/**
 * 資格情報を復号して取り出す。
 *
 * **外部SNSを叩くのは Plugin なので、いずれ Plugin へ渡す経路が要る**（S10）。
 * 呼び出し箇所を限り、監査できる状態を保つ。
 */
export const readSocialCredential = defineUseCase<{ id: string }, Secret | null>({
  name: 'social.account.readCredential',
  // 資格情報の読み出しは書き込み相当の権限を要求する。
  // 読めれば外部サービスで何でもできるため、read では弱すぎる。
  permission: 'social.write',
  // **「監査できる読み出し口」をどちらの経路でも成り立たせる**（009 §9、035 設計 §6.5.8）。
  // 配信ジョブ側は `recordSystemAudit` で同じ `credential_read` を残す。
  audit: {
    action: 'credential_read',
    resourceType: 'social_account',
    resourceId: (input) => input.id,
    detail: () => ({ purpose: 'manual' }),
  },
  handler: async (context, input) => {
    const account = await socialRepository.findAccountWithCredential(context.connection, input.id);
    if (account === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    return account.credential;
  },
});

// ---------------------------------------------------------------------------
// 投稿
// ---------------------------------------------------------------------------

export interface ListPostsInput {
  readonly page: number;
  readonly perPage: number;
  readonly socialAccountId: string | null;
  readonly status: PostStatus | null;
}

export const listSocialPosts = defineUseCase<ListPostsInput, SocialPostPage>({
  name: 'social.post.list',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listPosts(context.connection, {
      page: input.page,
      perPage: input.perPage,
      socialAccountId: input.socialAccountId,
      // 単一指定を配列へ畳む。`listCampaigns` と同じ形。
      statuses: input.status === null ? [] : [input.status],
      orderBy: 'created',
    }),
});

export interface ListPostHistoryInput {
  readonly page: number;
  readonly perPage: number;
  /** 結果で絞る。null なら配信済みと失敗の両方。 */
  readonly status: 'published' | 'failed' | null;
}

/**
 * 配信履歴（06_画面設計.md §13「履歴」）。
 *
 * **試行履歴のテーブルは無い。** `published` / `failed` は終端状態で、
 * 1つの投稿が持つ配信結果は高々1つ。「履歴」とは
 * **配信結果が確定した投稿の一覧**である（026-screen-completion 設計 §4.3）。
 *
 * 並びは結果が確定した順。作成順ではない。
 * 「いつ配信され、いつ失敗したか」を追うための画面なので、
 * 作成順に並べると、古い投稿がいま失敗したことが下の方に埋もれる。
 */
export const listSocialPostHistory = defineUseCase<ListPostHistoryInput, SocialPostPage>({
  name: 'social.post.history',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listPosts(context.connection, {
      page: input.page,
      perPage: input.perPage,
      socialAccountId: null,
      statuses: input.status === null ? DELIVERED_STATUSES : [input.status],
      orderBy: 'delivered',
    }),
});

/**
 * IDでまとめて引く。
 *
 * キャンペーンに紐づく投稿のように「IDは判っている」場面で使う
 * （026-screen-completion 設計 §3.3）。1件ずつ `getSocialPost` を呼ぶと
 * 件数分の往復になる。
 */
export const listSocialPostsByIds = defineUseCase<
  { ids: readonly string[] },
  readonly SocialPost[]
>({
  name: 'social.post.listByIds',
  permission: 'social.read',
  handler: async (context, input) => socialRepository.findPostsByIds(context.connection, input.ids),
});

export const getSocialPost = defineUseCase<{ id: string }, SocialPost>({
  name: 'social.post.get',
  permission: 'social.read',
  handler: async (context, input) => {
    const post = await socialRepository.findPostById(context.connection, input.id);
    if (post === null) {
      throw new NotFoundError('SocialPost', input.id);
    }
    return post;
  },
});

/**
 * 事前検査の対象（035-social-publishing 設計 §6.1.2 の e〜m）。
 *
 * **作成と更新で同じ検査を掛ける。** 更新では「変更後の値」を組み立ててから渡す。
 */
interface PostSubject {
  readonly body: string;
  readonly scheduledAt: Date | null;
  readonly status: PostStatus;
  readonly deliveryMode: DeliveryMode;
  readonly media: readonly PostMedia[];
  readonly link: string | null;
  readonly providerOptions: Readonly<Record<string, unknown>>;
}

/** `validate()` が返した `field` として受け付ける形。合わないものは丸める。 */
const VALIDATE_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

/**
 * Plugin が書いた自由文をログへ載せる形にそろえる。
 *
 * **接続文字列や資格情報が混じりうる**（設計 §6.5.5）。素通しで出さない。
 */
function safeMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/** Plugin の関数を 1 回呼んだ結果。例外も制限時間超過も観測できる形に畳む。 */
type PluginCallOutcome<T> =
  | { readonly type: 'ok'; readonly value: T }
  | { readonly type: 'thrown'; readonly error: unknown }
  | { readonly type: 'timeout' };

/**
 * Plugin の関数を制限時間つきで 1 回呼ぶ（設計 §6.1.2 / §6.6、検証レポート L-3）。
 *
 * `publish()` と同じく、**解決しない Promise に処理を止めさせない**。
 * 同期で投げる実装も、後から解決する Promise も、ここで畳む
 * （放置された Promise を `unhandledRejection` にしない）。
 *
 * **同期の無限ループは打ち切れない**（設計 §11 #20）。Plugin は信頼されたコードという
 * 前提の範囲で、「待たされる」だけを防ぐ。
 */
async function callWithTimeout<T>(
  call: () => T | Promise<T>,
  timeoutMs: number,
): Promise<PluginCallOutcome<T>> {
  let running: Promise<PluginCallOutcome<T>>;
  try {
    running = Promise.resolve(call()).then(
      (value) => ({ type: 'ok', value }) satisfies PluginCallOutcome<T>,
      (error: unknown) => ({ type: 'thrown', error }) satisfies PluginCallOutcome<T>,
    );
  } catch (error) {
    running = Promise.resolve({ type: 'thrown', error } satisfies PluginCallOutcome<T>);
  }
  void running.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PluginCallOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ type: 'timeout' });
    }, timeoutMs);
  });

  try {
    return await Promise.race([running, timedOut]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function toDraftView(subject: PostSubject): SocialPostDraftView {
  return {
    body: subject.body,
    scheduledAt: subject.scheduledAt?.toISOString() ?? null,
    deliveryMode: subject.deliveryMode,
    media: subject.media.map((item) => ({ url: item.url, alt: item.alt })),
    link: subject.link,
    providerOptions: subject.providerOptions,
  };
}

/**
 * 配信の支度ができていない予約を断らない（035-social-publishing 設計 §6.1.2、要件 §4 裁定 #8）。
 *
 * 「配信 Plugin が無い」「資格情報が未設定」は**予約を断る理由にしない**。
 * 断ると、Plugin を 1 つも入れていない素の Torifune で SNS の予約機能そのものが
 * 使えなくなる。支度が整うまではジョブが飛ばして待つ。
 *
 * 例外は `deliveryMode: 'manual'`。投稿画面の URL は publisher の `manual()` からしか
 * 得られないので、publisher が無ければその投稿は**待っても何もできない**。
 */
interface PreflightOptions {
  /**
   * g（manual 非対応の provider を断る）を掛けるか。
   *
   * **更新では `manual` に*しようとする*要求にだけ掛ける**（設計 §6.2、検証レポート S-3）。
   * 検査 g が守っているのは「`manual` にしても投稿画面の URL を作れない」ことで、
   * それは `manual` にしようとするときにしか問われない。既に `manual` である行に、
   * あとから Plugin が消えたことを理由に**出口を塞ぐ**のは検査の目的を超えている。
   */
  readonly checkManualSupport: boolean;
  /**
   * e / f（予約として成立するか。**Core 自身の規則で、Plugin を呼ばない**）を掛けるか。
   *
   * **更新では変更後の状態が `draft` / `scheduled` のときだけ**（設計 §6.2）。
   * `published` / `failed` への遷移は**起きた事実の記録**であって、予約の検証ではない。
   */
  readonly checkSchedulable: boolean;
  /**
   * j〜m（`limits` / `validate()`。**publisher を呼ぶ検査**）を掛けるか。
   *
   * **更新では変更後が `scheduled` のときだけ**（設計 §6.2、検証レポート §9.2 の R-6）。
   * `draft` への更新は**取りやめ**であり、`validate()` が例外／制限時間超過なら 500 になる。
   * **壊れた Plugin が取りやめを塞ぐ**のは S-3 で直した形そのものである（あのときは 422）。
   *
   * **原則を 1 つにする：既にある行の出口を塞ぐ検査を、Plugin の宣言や生死に依存させない。**
   * これらが守っているのは「予約が配信時刻に初めて失敗しない」ことなので、
   * **予約になる更新にだけ**掛かれば目的を果たす。
   */
  readonly checkPublisherRules: boolean;
}

/**
 * 飛ばした履歴（`skip_count` / `skip_reason` / `next_attempt_at`）を消す更新か
 * （設計 §5.1.1 / §6.2。裁定 #12-a / #13-a）。
 *
 * **条件は「先送りである」の 1 つだけ**：更新後が `scheduled` で、予約日時が
 * **現在時刻より未来**、かつ**更新前の予約日時より後ろ**。
 * `current.status` は見ないので、`draft` → `scheduled`（取りやめ → 予約し直し）も、
 * `scheduled` のまま日時だけ直す更新も、同じ判定で戻る。
 *
 * **差分で判定する**（裁定 #13-a）。更新後の状態だけを見ていると、
 * **未来を一度挟むだけで「過去日時では戻さない」を迂回できた**
 * （未来へ置いてリセットを得てから、過去へ戻す）。
 * 前へ引き戻す更新は、行き先が未来でもリセットしない。
 * `current.scheduledAt` が NULL（予約日時の無い行）なら、未来を指定した時点で先送りとして扱う。
 *
 * **`attempt_count` は戻さない。** あれは `publish()` を呼んだ回数で、
 * 再試行の 5 回という上限は別の話である（設計 §6.5.6）。
 */
function resetsSkipHistory(
  current: Pick<PostSubject, 'scheduledAt'>,
  next: Pick<PostSubject, 'status' | 'scheduledAt'>,
): boolean {
  if (next.status !== 'scheduled' || next.scheduledAt === null) {
    return false;
  }
  if (next.scheduledAt.getTime() <= Date.now()) {
    return false;
  }
  return current.scheduledAt === null || next.scheduledAt.getTime() > current.scheduledAt.getTime();
}

/** 作成では従来どおり全部掛ける（設計 §6.1.2）。 */
const CREATE_PREFLIGHT: PreflightOptions = {
  checkManualSupport: true,
  checkSchedulable: true,
  checkPublisherRules: true,
};

async function assertPostIsDeliverable(
  subject: PostSubject,
  account: SocialAccount,
  options: PreflightOptions,
): Promise<void> {
  if (options.checkSchedulable) {
    // e: 予約するなら予約日時が要る。無いと誰も取り出せない行になる。
    if (subject.status === 'scheduled' && subject.scheduledAt === null) {
      throw new ValidationError(
        'SocialPost',
        'scheduledAt',
        '予約するときは予約日時を指定してください。',
      );
    }

    // f: 手動投稿は媒体を持てない（人が投稿画面で添付する）。
    if (subject.deliveryMode === 'manual' && subject.media.length > 0) {
      throw new ValidationError(
        'SocialPost',
        'media',
        '手動投稿には媒体を添付できません（投稿画面で添付してください）。',
      );
    }
  }

  const publisher = findPublisher(account.provider);

  // g: 手動投稿に対応していない provider。
  if (
    options.checkManualSupport &&
    subject.deliveryMode === 'manual' &&
    publisher?.registration.manual === undefined
  ) {
    throw new ValidationError(
      'SocialPost',
      'deliveryMode',
      'このSNSは手動投稿に対応していません。',
    );
  }

  if (!options.checkPublisherRules || publisher === null) {
    return;
  }

  const { registration } = publisher;

  // j〜l: publisher が宣言した上限。**`status` を問わず掛ける**（下書きの段階で分かるほうがよい）。
  //
  // 判定は Domain の `checkPublisherLimits` が持つ。**配信直前の再検査（設計 §6.5.2.2）と
  // 同じ 1 つの関数を使う。** 別々に書くと、片方だけ直したときに
  // 「登録では弾かれるのに配信では通る」が黙って生まれる。
  // ここでは**先頭 1 件**を `ValidationError` にする（現行の順序・文言は変えない）。
  const limitProblems = checkPublisherLimits(
    subject,
    registration.limits ?? {},
    registration.label,
  );
  const firstLimit = limitProblems[0];
  if (firstLimit !== undefined) {
    // **Plugin 由来の自由文は 422 の本文へそのまま出る**（設計 §6.1.2、3 回目の検証の低-A）。
    // `message` には `checkPublisherLimits` が `registration.label` を埋め込む。
    // `api/route.ts` は `ValidationError` を写すだけで秘匿を掛けないので、ここで通す。
    // 配信直前の再検査（`publish.ts`）と**同じ関数**を通す（経路によって差を作らない）。
    throw new ValidationError('SocialPost', firstLimit.field, redactSecrets(firstLimit.message));
  }

  // m: publisher 自身の検査。複数のフィールドを一度に返せる。
  if (registration.validate === undefined) {
    return;
  }

  // **応答しない `validate()` に `POST /social/posts` を無期限に止めさせない**
  // （設計 §6.1.2、検証レポート L-3）。ここには差し替えの口を作らない。
  // HTTP 要求 1 本につき 1 回しか呼ばれず、`VALIDATE_TIMEOUT_MS` そのものが約束である。
  const validate = registration.validate;
  const outcome = await callWithTimeout(
    () => validate({ post: toDraftView(subject), account: toAccountView(account) }),
    VALIDATE_TIMEOUT_MS,
  );

  if (outcome.type === 'timeout') {
    // 例外と同じ扱い（設計 §6.1.2）。応答は 500 で、内容を外へ出さない。
    log.error('social publisher validate timed out', {
      provider: account.provider,
      pluginId: publisher.pluginId,
      timeoutMs: VALIDATE_TIMEOUT_MS,
    });
    throw new Error('配信 Plugin の検査が制限時間内に終わりませんでした。');
  }
  if (outcome.type === 'thrown') {
    // Plugin の例外を素で外へ出さない（027 設計 §3.3）。応答には内容を載せない。
    log.error('social publisher validate failed', {
      provider: account.provider,
      pluginId: publisher.pluginId,
      reason: safeMessage(outcome.error),
    });
    throw outcome.error;
  }

  const problems = outcome.value;

  if (problems.length === 0) {
    return;
  }

  // **Plugin 由来の自由文は 422 の本文へそのまま出る**（設計 §6.1.2、3 回目の検証の低-A）。
  // `message` も `field` も Plugin が書いた文字列なので、理由文を組み立てる前に伏せる。
  // 配信直前の再検査（`publish.ts`）と**同じ関数**を通す（経路によって差を作らない）。
  const details: Record<string, string[]> = {};
  for (const problem of problems) {
    // 見慣れない形のキーをそのまま応答へ出さない。丸め先は providerOptions。
    const key = VALIDATE_FIELD_PATTERN.test(problem.field)
      ? redactSecrets(problem.field)
      : 'providerOptions';
    (details[key] ??= []).push(redactSecrets(problem.message));
  }
  const first = problems[0];
  throw new ValidationError(
    'SocialPost',
    Object.keys(details)[0] ?? 'providerOptions',
    first === undefined ? '配信 Plugin の検査に通りませんでした。' : redactSecrets(first.message),
    details,
  );
}

export interface CreatePostInput {
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: Date | null;
  readonly status: PostStatus;
  readonly deliveryMode?: DeliveryMode | undefined;
  readonly media?: readonly PostMedia[] | undefined;
  readonly link?: string | null | undefined;
  readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
  /**
   * 外部アプリ側の ID（冪等キー）。
   *
   * **API Token で登録するときだけ指定できる**（035-social-publishing 設計 §6.1.3）。
   * Token が無いと一意の名前空間が無く、PostgreSQL の一意索引は NULL を区別しないので
   * 「冪等のつもりで二重登録」が黙って起きる。
   */
  readonly externalRef?: string | undefined;
}

/**
 * 登録の結果。
 *
 * `created` が false なら**同じ登録要求の再送**で、既存の投稿をそのまま返している。
 * ルートはこれを 201 と 200 の違いに写す（設計 §6.1.3）。
 */
export interface CreatePostOutput {
  readonly post: SocialPost;
  readonly created: boolean;
}

export const createSocialPost = defineUseCase<CreatePostInput, CreatePostOutput>({
  name: 'social.post.create',
  permission: 'social.write',
  audit: {
    action: 'created',
    resourceType: 'social_post',
    resourceId: (_input, output) => output.post.id,
    // 本文は残さない。監査は「誰がいつ何をしたか」であって、内容の複製ではない。
    detail: (_input, output) => ({
      socialAccountId: output.post.socialAccountId,
      status: output.post.status,
      // 再送も記録する。区別できないと「2 回登録された」ように見える。
      replayed: !output.created,
    }),
  },
  handler: async (context, input) => {
    // a: 本文。
    if (!isValidPostBody(input.body)) {
      throw new ValidationError('SocialPost', 'body', '本文を入力してください（10000文字以内）。');
    }

    // b: 存在しないアカウントへの投稿を、FK 違反（500）ではなく 422 で返す。
    const account = await socialRepository.findAccountById(
      context.connection,
      input.socialAccountId,
    );
    if (account === null) {
      throw new ValidationError('SocialPost', 'socialAccountId', 'SNSアカウントが見つかりません。');
    }

    const tokenId = context.apiToken?.id ?? null;

    // c: 冪等キーは API Token の名前空間でしか意味を持たない。
    if (input.externalRef !== undefined && tokenId === null) {
      throw new ValidationError(
        'SocialPost',
        'externalRef',
        'externalRef は API トークンで登録するときだけ指定できます。',
      );
    }

    // d: 同じ登録要求の再送。**以降の検査を行わずに既存を返す。**
    //    登録済みの投稿を後から拒否する意味は無い。
    if (input.externalRef !== undefined && tokenId !== null) {
      const existing = await socialRepository.findByExternalRef(
        context.connection,
        tokenId,
        input.externalRef,
      );
      if (existing !== null) {
        return { post: existing, created: false };
      }
    }

    const deliveryMode = input.deliveryMode ?? 'auto';
    const media = input.media ?? [];
    const providerOptions = input.providerOptions ?? {};
    const link = input.link ?? null;

    await assertPostIsDeliverable(
      {
        body: input.body,
        scheduledAt: input.scheduledAt,
        status: input.status,
        deliveryMode,
        media,
        link,
        providerOptions,
      },
      account,
      CREATE_PREFLIGHT,
    );

    const result = await context.connection.transaction((tx) =>
      socialRepository.insertPostIdempotent(tx, {
        id: uuidv7(),
        socialAccountId: input.socialAccountId,
        body: input.body,
        scheduledAt: input.scheduledAt,
        status: input.status,
        deliveryMode,
        media,
        link,
        providerOptions,
        externalRef: input.externalRef ?? null,
        createdByTokenId: tokenId,
      }),
    );

    // **作成したときだけ発火する。** 再送で 2 回流れると、購読側が二重に動く。
    if (result.created) {
      await emit('social.post.created', {
        postId: result.post.id,
        accountId: result.post.socialAccountId,
        status: result.post.status,
      });
    }

    return result;
  },
});

export interface UpdatePostInput {
  readonly id: string;
  readonly body?: string | undefined;
  readonly scheduledAt?: Date | null | undefined;
  readonly status?: PostStatus | undefined;
  /**
   * 配信に失敗した理由。
   *
   * **これが無かったため、`data.socialPosts.markFailed(id, reason)` が
   * 受け取った理由はどこにも保存されていなかった。**
   * 画面に「失敗」とだけ出て、理由が分からない状態になっていた。
   */
  readonly failureReason?: string | null | undefined;
  readonly deliveryMode?: DeliveryMode | undefined;
  readonly media?: readonly PostMedia[] | undefined;
  readonly link?: string | null | undefined;
  readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
  /** 配信後の SNS 側の投稿 ID。手動投稿では人が貼る。 */
  readonly externalId?: string | null | undefined;
  readonly externalUrl?: string | null | undefined;
}

/**
 * 配信中は内容も状態も変えさせない（035-social-publishing 設計 §6.2）。
 *
 * ジョブは着手時に読んだ内容を送るので、その間の編集は
 * 「送った内容と保存内容が食い違う」を生む。窓は最長でも配信の制限時間＋次のジョブまでで、
 * 中断した行は次の実行で `failed` に落ちてガードが外れる。
 */
const PUBLISH_GUARDED_FIELDS = [
  'body',
  'media',
  'link',
  'providerOptions',
  'scheduledAt',
  'deliveryMode',
  'status',
] as const satisfies readonly (keyof UpdatePostInput)[];

/**
 * 失敗理由を保存できる形にそろえる。
 *
 * **長さで例外にしない。** 外部サービスの応答をそのまま渡す使い方が
 * 想定される場所であり、長かっただけで「失敗の記録が残らない」ほうが困る。
 * 空文字は「理由なし」として null に倒す。
 */
export function normalizeFailureReason(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed.slice(0, FAILURE_REASON_MAX_LENGTH);
}

export const updateSocialPost = defineUseCase<UpdatePostInput, SocialPost>({
  name: 'social.post.update',
  permission: 'social.write',
  audit: {
    action: 'updated',
    resourceType: 'social_post',
    resourceId: (input) => input.id,
    detail: (input) => ({ changed: Object.keys(input).filter((key) => key !== 'id') }),
  },
  handler: async (context, input) => {
    if (input.body !== undefined && !isValidPostBody(input.body)) {
      throw new ValidationError('SocialPost', 'body', '本文を入力してください（10000文字以内）。');
    }

    const current = await socialRepository.findPostById(context.connection, input.id);
    if (current === null) {
      throw new NotFoundError('SocialPost', input.id);
    }

    // 配信中のガード。**遷移の可否より先に見る。**
    // 「配信中だから待て」と「その遷移はできない」は別の話で、前者のほうが状況の説明になる。
    const publishing =
      current.status === 'scheduled' &&
      current.deliveryMode === 'auto' &&
      current.publishStartedAt !== null;
    if (publishing && PUBLISH_GUARDED_FIELDS.some((field) => input[field] !== undefined)) {
      throw new ValidationError(
        'SocialPost',
        'status',
        '配信を開始しているため変更できません。結果が記録されるまで待ってください。',
      );
    }

    if (input.status !== undefined && !canTransition(current.status, input.status)) {
      // 起きた事実は書き換えない。
      throw new ValidationError(
        'SocialPost',
        'status',
        `${current.status} から ${input.status} へは変更できません。`,
      );
    }

    // **`externalUrl` / `externalId` は UseCase で検証する**（設計 §6.2、検証レポート S-4）。
    // Data API の `markPublished(id, { externalUrl })` は Zod を通らないので、
    // ここで見ないと Plugin から任意の文字列が投稿一覧と履歴の `href` へそのまま出る。
    // `body` を同じ UseCase の中で再検証しているのに `externalUrl` はしない、という不揃いも直す。
    if (
      input.externalUrl !== undefined &&
      input.externalUrl !== null &&
      !isValidExternalUrl(input.externalUrl)
    ) {
      throw new ValidationError(
        'SocialPost',
        'externalUrl',
        `投稿の URL は https で ${EXTERNAL_URL_MAX_LENGTH} 文字以内にしてください。`,
      );
    }
    if (
      input.externalId !== undefined &&
      input.externalId !== null &&
      input.externalId.length > EXTERNAL_ID_MAX_LENGTH
    ) {
      throw new ValidationError(
        'SocialPost',
        'externalId',
        `SNS 側の投稿 ID は${EXTERNAL_ID_MAX_LENGTH}文字以内にしてください。`,
      );
    }

    // 事前検査は**変更後の値**に対して、作成と同じ順で掛ける（設計 §6.2）。
    // ただし**掛ける条件が区分ごとに違う**（`PreflightOptions`。検証レポート S-3）。
    const account = await socialRepository.findAccountById(
      context.connection,
      current.socialAccountId,
    );
    if (account === null) {
      throw new ValidationError('SocialPost', 'socialAccountId', 'SNSアカウントが見つかりません。');
    }
    const next: PostSubject = {
      body: input.body ?? current.body,
      scheduledAt: input.scheduledAt === undefined ? current.scheduledAt : input.scheduledAt,
      status: input.status ?? current.status,
      deliveryMode: input.deliveryMode ?? current.deliveryMode,
      media: input.media ?? current.media,
      link: input.link === undefined ? current.link : input.link,
      providerOptions: input.providerOptions ?? current.providerOptions,
    };
    await assertPostIsDeliverable(next, account, {
      checkManualSupport: input.deliveryMode === 'manual',
      checkSchedulable: next.status === 'draft' || next.status === 'scheduled',
      // **publisher を呼ぶ検査は「予約になる更新」にだけ**（設計 §6.2、R-6）。
      // `draft`（取りやめ）を壊れた Plugin に塞がせない。
      checkPublisherRules: next.status === 'scheduled',
    });

    const post = await context.connection.transaction((tx) =>
      socialRepository.updatePost(tx, input.id, {
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
        ...(input.status === undefined ? {} : { status: input.status }),
        // published へ移すときだけ配信時刻を記録する。
        ...(input.status === 'published' ? { publishedAt: new Date() } : {}),
        // failed も同じ扱い。**updated_at で代用しない。**
        // あれは「最後に触った時刻」であって「失敗した時刻」ではない。
        ...(input.status === 'failed' ? { failedAt: new Date() } : {}),
        ...(input.failureReason === undefined
          ? {}
          : { failureReason: normalizeFailureReason(input.failureReason) }),
        ...(input.deliveryMode === undefined ? {} : { deliveryMode: input.deliveryMode }),
        ...(input.media === undefined ? {} : { media: input.media }),
        ...(input.link === undefined ? {} : { link: input.link }),
        ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        ...(input.externalUrl === undefined ? {} : { externalUrl: input.externalUrl }),
        // **予約を未来へ置き直したら数え直しを消す**（設計 §5.1.1 / §6.2。裁定 #12-a）。
        // 戻さないと、後ろへ送られた予定を引きずったまま再予約され、指定した時刻に出ない。
        //
        // **`current.status` は見ない**（検証レポート §9.2 の R-1）。編集フォームは常に
        // `status` を送るので、「予約中の投稿の日時を直す」という最も普通の操作も
        // `scheduled` のままこの経路に入る。`draft` を経由する形だけを見ていると素通りする。
        //
        // **過去日時では戻さない**（R-2）。戻すと、過去日時のまま `draft` → `scheduled` を
        // 繰り返して飛ばした回数を 0 に保ち、期限切れの行を列の先頭に置き続けられる。
        //
        // **判定は差分で行う**（裁定 #13-a）。更新後の状態だけを見ていると、
        // **未来を一度挟むだけ**で上の 2 行が迂回できた（未来へ置いてリセットを得てから過去へ戻す）。
        // 「予約を先送りする」更新だけがリセットを得る。
        ...(resetsSkipHistory(current, next)
          ? { skipCount: 0, skipReason: null, nextAttemptAt: null }
          : {}),
      }),
    );

    if (post === null) {
      throw new NotFoundError('SocialPost', input.id);
    }

    if (input.status === 'published') {
      await emit('social.post.published', {
        postId: post.id,
        accountId: post.socialAccountId,
        status: 'published',
      });
    }

    // **現行は発火していなかった。** 自動配信が入ると「失敗」が人手を介さず起きるので、
    // 通知 Plugin や Webhook が拾えないと運用者が気づけない（設計 §9.6）。
    // 理由は載せない。Plugin が返した自由文で、資格情報が混じりうる。
    if (input.status === 'failed') {
      await emit('social.post.failed', {
        postId: post.id,
        accountId: post.socialAccountId,
        status: 'failed',
      });
    }

    return post;
  },
});

export const deleteSocialPost = defineUseCase<{ id: string }, void>({
  name: 'social.post.delete',
  permission: 'social.delete',
  audit: { action: 'deleted', resourceType: 'social_post', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const deleted = await context.connection.transaction((tx) =>
      socialRepository.deletePost(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('SocialPost', input.id);
    }
  },
});

// ---------------------------------------------------------------------------
// 手動投稿（035-social-publishing 設計 §6.6）
// ---------------------------------------------------------------------------

export interface ListManualPendingInput {
  /** 画面は 50 を渡す。ダッシュボードは件数だけが要るので 1 を渡す（設計 §6.6 / §7.6）。 */
  readonly limit: number;
}

/**
 * 手動投稿待ちの一覧（設計 §5.8 の導出状態）。
 *
 * **状態を増やさない。** `status = 'scheduled'` かつ `deliveryMode = 'manual'` かつ
 * 予約日時が来ていることから導く。`total` は `limit` で切る前の全件数。
 */
export const listManualPendingPosts = defineUseCase<ListManualPendingInput, SocialPostPage>({
  name: 'social.post.listManualPending',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listManualPending(context.connection, input.limit),
});

/**
 * 「投稿画面を開く」の結果（設計 §6.6）。
 *
 * **失敗しても例外にしない。** 区画は行ごとに描かれ、1 つの Plugin の不調で
 * 画面全体を落とすわけにはいかない。理由は画面の文言に写される。
 */
export type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | { readonly ok: false; readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' };

export interface ManualHandoffInput {
  readonly id: string;
  /**
   * この呼び出しの上限（ミリ秒）。省略すると `MANUAL_TIMEOUT_MS`。
   *
   * `publishDuePosts` の `timeoutMs` と同じ流儀の口で、
   * 結合テストが実時間で 2 秒待たないために要る。
   */
  readonly timeoutMs?: number | undefined;
  /**
   * 1 回の描画の**絶対の締切**（壁時計。設計 §6.6。裁定 #12-c）。
   *
   * * 過ぎていれば `manual()` を**呼ばずに** `plugin_error` を返す
   * * 締切までの残りが `timeoutMs` より短ければ、**その行の制限時間を残り時間まで切り詰める**
   *
   * 行ごとに呼ぶ側（`app/social/page.tsx`）がこれを 1 回だけ作って
   * `Promise.all` の全行へ渡すので、**どの行も締切を越えて走らない。**
   */
  readonly deadline?: Date | undefined;
}

/**
 * その投稿の「投稿画面の URL」を publisher に作らせる。
 *
 * **資格情報は渡さない**（設計 §6.5.5 末尾）。Web Intent は公開 URL で足りる。
 * 渡すと「配信のときだけ」という約束が崩れ、監査の外で平文が広がる。
 */
export const resolveManualHandoff = defineUseCase<ManualHandoffInput, ManualHandoffOutcome>({
  name: 'social.post.manualHandoff',
  permission: 'social.read',
  handler: async (context, input) => {
    const post = await socialRepository.findPostById(context.connection, input.id);
    if (post === null) {
      throw new NotFoundError('SocialPost', input.id);
    }
    if (post.deliveryMode !== 'manual') {
      // 自動配信の投稿に「投稿画面を開く」は無い。
      throw new ValidationError('SocialPost', 'deliveryMode', '手動投稿ではありません。');
    }

    const account = await socialRepository.findAccountById(
      context.connection,
      post.socialAccountId,
    );
    if (account === null) {
      throw new NotFoundError('SocialAccount', post.socialAccountId);
    }

    const publisher = findPublisher(account.provider);
    const manual = publisher?.registration.manual;
    if (publisher === null || manual === undefined) {
      // Plugin を無効にした後の画面がこれ（設計 §7.1 の「この SNS の Plugin が無効です」）。
      return { ok: false, reason: 'unsupported' };
    }

    // 1 回の描画の絶対の締切（壁時計。設計 §6.6。裁定 #12-c）。**過ぎていれば呼ばない。**
    //
    // 行ごとの呼び出しは `Promise.all` で並行に行うので、この締切は「累計の予算」ではない。
    // それでも要るのは、`MANUAL_TIMEOUT_MS` が `manual()` の中しか測っていないため。
    // 50 本の UseCase が同時に接続プールへ並ぶと、後ろの行が `manual()` に着くのは何秒か後になりうる。
    const timeoutMs = input.timeoutMs ?? MANUAL_TIMEOUT_MS;
    let remainingMs = timeoutMs;
    if (input.deadline !== undefined) {
      remainingMs = input.deadline.getTime() - Date.now();
      if (remainingMs <= 0) {
        log.warn('social publisher manual skipped by budget', {
          provider: account.provider,
          pluginId: publisher.pluginId,
          postId: post.id,
        });
        return { ok: false, reason: 'plugin_error' };
      }
      // **締切までの残りが制限時間より短ければ、その行は残り時間で打ち切る**
      // （検証レポート §9.2 の R-4）。「呼ぶ／呼ばない」の 1 回の判定だけだと、
      // 締切の 1 ミリ秒前に始まった行が制限時間ぶん（2 秒）はみ出せる。
      remainingMs = Math.min(timeoutMs, remainingMs);
    }

    // 同期でも Promise でもよい（設計 §6.6）。**応答しない `manual()` に画面を止めさせない**
    // （検証レポート L-3）。`publish()` の 30 秒より短く取る。
    const outcome = await callWithTimeout(
      () => manual({ post: toPostView(post), account: toAccountView(account) }),
      remainingMs,
    );

    if (outcome.type === 'timeout') {
      // 画面には出さないが、運用者が原因へ辿れる経路は残す。
      log.error('social publisher manual timed out', {
        provider: account.provider,
        pluginId: publisher.pluginId,
        postId: post.id,
      });
      return { ok: false, reason: 'plugin_error' };
    }
    if (outcome.type === 'thrown') {
      // Plugin の例外を素で外へ出さない（027 設計 §3.3）。**戻り値にも画面にも内容を載せない。**
      log.error('social publisher manual failed', {
        provider: account.provider,
        pluginId: publisher.pluginId,
        postId: post.id,
        reason: safeMessage(outcome.error),
      });
      return { ok: false, reason: 'plugin_error' };
    }

    const handoff = outcome.value;

    if (!isValidManualUrl(handoff.url)) {
      log.warn('social publisher manual returned an unusable url', {
        provider: account.provider,
        pluginId: publisher.pluginId,
        postId: post.id,
      });
      return { ok: false, reason: 'invalid_url' };
    }

    return { ok: true, url: handoff.url, note: handoff.note ?? null };
  },
});
