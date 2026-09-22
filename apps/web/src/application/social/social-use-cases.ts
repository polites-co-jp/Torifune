import type { SocialAccountView, SocialPostDraftView } from '@torifune/plugin-api';
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
  canTransition,
  DELIVERED_STATUSES,
  FAILURE_REASON_MAX_LENGTH,
  isValidDisplayName,
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

function toAccountView(account: SocialAccount): SocialAccountView {
  return {
    id: account.id,
    provider: account.provider,
    displayName: account.displayName,
    handle: account.handle,
    status: account.status,
    credentialConfigured: account.credentialConfigured,
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
async function assertPostIsDeliverable(
  subject: PostSubject,
  account: SocialAccount,
): Promise<void> {
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

  const publisher = findPublisher(account.provider);

  // g: 手動投稿に対応していない provider。
  if (subject.deliveryMode === 'manual' && publisher?.registration.manual === undefined) {
    throw new ValidationError(
      'SocialPost',
      'deliveryMode',
      'このSNSは手動投稿に対応していません。',
    );
  }

  if (publisher === null) {
    return;
  }

  const { registration } = publisher;
  const label = registration.label;
  const limits = registration.limits ?? {};

  // j〜l: publisher が宣言した上限。**`status` を問わず掛ける**（下書きの段階で分かるほうがよい）。
  if (limits.bodyMaxLength !== undefined && subject.body.length > limits.bodyMaxLength) {
    throw new ValidationError(
      'SocialPost',
      'body',
      `本文は${limits.bodyMaxLength}文字以内にしてください（${label}）。`,
    );
  }
  if (limits.mediaMax !== undefined && subject.media.length > limits.mediaMax) {
    throw new ValidationError(
      'SocialPost',
      'media',
      `媒体は${limits.mediaMax}件以内にしてください（${label}）。`,
    );
  }
  if (
    limits.mediaRequired === true &&
    subject.deliveryMode === 'auto' &&
    subject.media.length === 0
  ) {
    throw new ValidationError(
      'SocialPost',
      'media',
      `${label} への配信には画像または動画が必要です。`,
    );
  }

  // m: publisher 自身の検査。複数のフィールドを一度に返せる。
  if (registration.validate === undefined) {
    return;
  }

  let problems: readonly { readonly field: string; readonly message: string }[];
  try {
    problems = await registration.validate({
      post: toDraftView(subject),
      account: toAccountView(account),
    });
  } catch (error) {
    // Plugin の例外を素で外へ出さない（027 設計 §3.3）。応答には内容を載せない。
    log.error('social publisher validate failed', {
      provider: account.provider,
      pluginId: publisher.pluginId,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (problems.length === 0) {
    return;
  }

  const details: Record<string, string[]> = {};
  for (const problem of problems) {
    // 見慣れない形のキーをそのまま応答へ出さない。丸め先は providerOptions。
    const key = VALIDATE_FIELD_PATTERN.test(problem.field) ? problem.field : 'providerOptions';
    (details[key] ??= []).push(problem.message);
  }
  const first = problems[0];
  throw new ValidationError(
    'SocialPost',
    Object.keys(details)[0] ?? 'providerOptions',
    first?.message ?? '配信 Plugin の検査に通りませんでした。',
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

    // 事前検査は**変更後の値**に対して、作成と同じ順で掛ける（設計 §6.2）。
    const account = await socialRepository.findAccountById(
      context.connection,
      current.socialAccountId,
    );
    if (account === null) {
      throw new ValidationError('SocialPost', 'socialAccountId', 'SNSアカウントが見つかりません。');
    }
    await assertPostIsDeliverable(
      {
        body: input.body ?? current.body,
        scheduledAt: input.scheduledAt === undefined ? current.scheduledAt : input.scheduledAt,
        status: input.status ?? current.status,
        deliveryMode: input.deliveryMode ?? current.deliveryMode,
        media: input.media ?? current.media,
        link: input.link === undefined ? current.link : input.link,
        providerOptions: input.providerOptions ?? current.providerOptions,
      },
      account,
    );

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
