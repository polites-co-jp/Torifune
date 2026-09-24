import type {
  PluginLogger,
  PluginSettingsField,
  PublishInput,
  PublishResult,
  PublisherLimits,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialMediaView,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { countHashtags, countMentions } from './caption';
import {
  CAROUSEL_CHILD_CONCURRENCY,
  MEDIA_PUBLISH_TIMEOUT_MS,
  PERMALINK_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_ROUNDS,
  PREPARE_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  REFRESH_TIMEOUT_MS,
  budgetFailure,
  createCarouselContainer,
  createImageContainer,
  publishContainer,
  readContainerStatus,
  readMeUserId,
  readPermalink,
  refreshAccessToken,
  resolveFetch,
  type FetchImpl,
  type GraphFailure,
  type GraphResult,
} from './graph';
import {
  UNKNOWN_EXPIRY,
  expiryFromExpiresIn,
  isAutoIgUserId,
  isValidAccessToken,
  isValidIgUserId,
  parseExpiry,
  shouldRefresh,
} from './token';

/**
 * Instagram（Graph API の Content Publishing）の publisher（038-sns-instagram 設計 §9）。
 *
 * **Plugin が書くのは「1 回配信する関数」だけ。** いつ送るか・再試行・記録・画面は Core が持つ。
 * **手動投稿（`manual`）は実装しない。** キーごと置かないので、Core が
 * `deliveryMode: 'manual'` を 422 で断る（設計 §9.3）。
 */

/** `social_accounts.provider` と同じ値。 */
export const INSTAGRAM_PROVIDER = 'instagram';

/** 1 投稿のハッシュタグの上限。 */
const HASHTAG_MAX = 30;

/** 1 投稿のメンションの上限。 */
const MENTION_MAX = 20;

export interface InstagramPublisherOptions {
  /**
   * 外部への HTTP。既定は Node の標準実装。**テストはここを差し替える**（設計 §10.1）。
   * `index.ts` は与えない。
   */
  readonly fetch?: FetchImpl;
  /** この Plugin が見る時計。既定は現在時刻。期限の判定とトークンの期限がこれを見る。 */
  readonly now?: () => Date;
  /** 状態の確認の待ち。既定は `setTimeout` を signal で打ち切る実装。**テストは実時間を待たない。** */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 既定の待ち。`ms` 待って解決し、`signal` が発火したらその場で `signal.reason` で reject する。
 *
 * HTTP ではないので `graph.ts` に置かない（実装プラン §8 の 4）。
 */
export function defaultWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 資格情報の形（設計 §5.1）。**3 項目で確定。後から足せない**（設計 §5.2）。
 */
const CREDENTIAL_FIELDS: readonly PluginSettingsField[] = [
  {
    key: 'igUserId',
    label: 'Instagram ユーザー ID',
    description:
      'Instagram のプロアカウント（ビジネスまたはクリエイター）の ID。数字だけの文字列です。' +
      '@ で始まるユーザーネームではありません。' +
      '分からなければ auto と入れてください。次の配信のとき、Torifune がアクセストークンから ID を確かめて保存し直します。',
    kind: 'text',
    placeholder: 'auto',
  },
  {
    key: 'accessToken',
    label: '長期アクセストークン',
    description:
      'Instagram API（Instagram ログイン）で発行した長期アクセストークン。' +
      'instagram_business_basic と instagram_business_content_publish の権限が要ります。' +
      '60 日で失効します。Torifune は配信のたびに残り日数を見て、必要なら延長して保存し直します。保存後は再表示されません。',
    kind: 'secret',
  },
  {
    key: 'accessTokenExpiresAt',
    label: 'トークンの有効期限',
    description:
      'トークンの有効期限（例：2026-11-22T00:00:00Z）。分からなければ unknown と入れてください。' +
      '次に配信が成功したとき、Torifune がトークンを延長して正しい期限に書き換えます。',
    kind: 'text',
    placeholder: 'unknown',
  },
];

/**
 * Core が登録時と配信直前に適用する制約（設計 §9.1）。
 *
 * `bodyMaxLength` は厳しい側（`String.length`）に置いたまま。Instagram のキャプションの数え方は公開されていない。
 */
const LIMITS: PublisherLimits = { bodyMaxLength: 2200, mediaRequired: true, mediaMax: 10 };

const LINK_MESSAGE =
  'Instagram はキャプション内の URL をリンクにしません。link は指定できません' +
  '（URL を見せたい場合は本文に書いてください。リンクにはなりません）。';

/**
 * 登録時と配信直前の事前検査（設計 §9.2）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。同期で返す。例外を投げない。**
 * 本文の長さ・媒体の枚数と有無・`media[].url` の形・`alt` は見ない（Core が見る／送らないので断らない）。
 * `deliveryMode` で分岐しない。複数の違反はすべて返す。
 */
function validateDraft(post: SocialPostDraftView): readonly PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  const body = typeof post.body === 'string' ? post.body : '';

  const hashtagCount = countHashtags(body);
  if (hashtagCount > HASHTAG_MAX) {
    problems.push({
      field: 'body',
      message: `Instagram のハッシュタグは${HASHTAG_MAX}個までです。いまは ${hashtagCount} 個です。`,
    });
  }

  const mentionCount = countMentions(body);
  if (mentionCount > MENTION_MAX) {
    problems.push({
      field: 'body',
      message: `Instagram のメンションは${MENTION_MAX}件までです。いまは ${mentionCount} 件です。`,
    });
  }

  // **黙って捨てない。** 本文の末尾へ足すと Core が数えた長さと食い違う（設計 §6.12）。
  const link: unknown = post.link;
  if (link !== null && link !== undefined && link !== '') {
    problems.push({ field: 'link', message: LINK_MESSAGE });
  }

  // 外から来た任意の JSON。循環参照を含みうるので、キーの一覧だけを見る。
  const options: unknown = post.providerOptions;
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      problems.push({
        field: `providerOptions.${key}`,
        message: `${key} は Instagram では使いません。`,
      });
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* publish()：失敗したときの文言（設計 §6.11）                                   */
/* -------------------------------------------------------------------------- */

const ABORTED_REASON = 'Instagram への配信が打ち切られました。';

const MEDIA_REQUIRED_REASON =
  'Instagram への配信には画像が必要です。画像を 1〜10 枚付けて登録し直してください。';

const LINK_REASON =
  'Instagram はキャプション内の URL をリンクにしません。link を外して登録し直してください' +
  '（URL を見せたい場合は本文に書いてください）。';

const CREDENTIAL_REASON =
  'Instagram の資格情報の形が正しくありません（ユーザー ID は数字だけ、長期アクセストークンは空白や改行を含まない' +
  ' 2048 文字以内の文字列）。SNS アカウントの資格情報を登録し直してください。';

/**
 * R0（`auto` のユーザー ID の問い合わせ）の応答の形が期待と違う（041 設計 §6.4.2）。
 *
 * 再試行で直らない（Graph API の仕様の変更か、別の窓口のトークン）。人が数字の ID を入れれば直る。
 */
export const ID_UNRESOLVED_REASON =
  'Instagram のユーザー ID を自動で確かめられませんでした。「資格情報を設定」で、ユーザー ID の欄に数字だけの ID を入れてください。';

const UNEXPECTED_BEFORE_PUBLISH_REASON =
  'Instagram への配信の準備中に予期しない問題が起きました。公開の要求は送っていないので、時間をおいて再試行します。';

const UNEXPECTED_AFTER_PUBLISH_REASON =
  'Instagram へ公開の要求を送った後で予期しない問題が起きました。二重投稿を避けるため再試行しません。' +
  'Instagram 側で投稿を確認してから、必要なら予約し直してください。';

const NOT_CONFIRMED_SUFFIX =
  '二重投稿を避けるため再試行しません。Instagram 側で投稿を確認してから、必要なら予約し直してください。';

/**
 * `reason` に載せる応答の素性。
 *
 * **HTTP の status と、既知の `code` / `error_subcode`（知らなければ `unknown`）だけ。**
 * Graph API の自由文（`message` / `error_user_msg` など）・`fbtrace_id`・要求の URL は載せない。
 * Core の伏せ字は 4 文字以上の完全一致しか消せないので、**伏せ字を当てにしない**（設計 §6.11）。
 */
function detailOf(failure: GraphFailure): string {
  const parts: string[] = [];
  if (failure.status !== undefined) {
    parts.push(`HTTP ${failure.status}`);
  }
  if (failure.code !== undefined) {
    parts.push(`code ${failure.code}`);
  }
  if (failure.subcode !== undefined) {
    parts.push(`subcode ${failure.subcode}`);
  }
  return parts.length === 0 ? '' : `（${parts.join(' / ')}）`;
}

const PHASE_LABELS: Readonly<Record<GraphFailure['phase'], string>> = {
  me: 'ユーザー ID の確認',
  container: 'container の作成',
  status: 'container の状態の確認',
  publish: '公開',
  permalink: '投稿の URL の問い合わせ',
  refresh: 'トークンの延長',
};

/** 状態（`status_code`）の失敗。**知らない値はそのまま出さない**（外から来た文字列）。 */
function stateReason(failure: GraphFailure): string {
  switch (failure.state) {
    case 'ERROR':
      return (
        'Instagram が画像を処理できませんでした（container の状態 ERROR）。' +
        'media の URL が公開された JPEG 画像を指しているか確かめてください。'
      );
    case 'PUBLISHED':
      return (
        'Instagram が、公開の要求を送る前に container を公開済みと返しました（container の状態 PUBLISHED）。' +
        NOT_CONFIRMED_SUFFIX
      );
    case 'EXPIRED':
      return 'Instagram の container が失効しました（container の状態 EXPIRED）。時間をおいて再試行します。';
    default:
      return 'Instagram の container の状態を読み取れませんでした。時間をおいて再試行します。';
  }
}

/** 直らない種類のエラー（どのフェーズでも同じ案内）。 */
function classReason(failure: GraphFailure, detail: string): string | undefined {
  switch (failure.errorClass) {
    case 'token':
      return failure.phase === 'publish'
        ? `Instagram のアクセストークンが公開の途中で無効になりました${detail}。${NOT_CONFIRMED_SUFFIX}` +
            'あわせて長期アクセストークンを発行し直し、SNS アカウントの資格情報を登録し直してください。'
        : `Instagram のアクセストークンが無効か期限切れです${detail}。` +
            '長期アクセストークンを発行し直し、SNS アカウントの資格情報を登録し直してください。';
    case 'dailyLimit':
      return (
        `Instagram の 24 時間あたりの公開数の上限に達しました${detail}。` +
        '時間をおいて新しい投稿として登録し直してください。'
      );
    case 'permission':
      if (failure.phase === 'publish') {
        return undefined;
      }
      return (
        `Instagram の権限が足りません${detail}。プロアカウント（ビジネスまたはクリエイター）であることと、` +
        'instagram_business_content_publish の権限があることを確かめてください。'
      );
    default:
      return undefined;
  }
}

/** R4 を送る前（container の作成・状態の確認）の失敗。 */
function beforePublishReason(failure: GraphFailure, detail: string): string {
  const phase = PHASE_LABELS[failure.phase];
  switch (failure.kind) {
    case 'network':
    case 'timeout':
    case 'aborted':
      return `Instagram へ接続できませんでした（${phase}）。時間をおいて再試行します。`;
    case 'shape':
      return `Instagram の応答を解釈できませんでした（${phase}）${detail}。時間をおいて再試行します。`;
    case 'state':
      return stateReason(failure);
    case 'budget':
      return 'Instagram の画像の処理が時間内に終わりませんでした。時間をおいて再試行します。';
    default:
      break;
  }

  const known = classReason(failure, detail);
  if (known !== undefined) {
    return known;
  }
  const status = failure.status ?? 0;
  if (status >= 300 && status < 400) {
    return `Instagram が想定しない転送を返しました（${phase}）${detail}。転送は追いません。時間をおいて予約し直してください。`;
  }
  if (failure.errorClass === 'rateLimit') {
    return `Instagram の呼び出し回数の制限に達しました${detail}。時間をおいて再試行します。`;
  }
  if (failure.retryable) {
    return `Instagram が一時的に応答できませんでした（${phase}）${detail}。時間をおいて再試行します。`;
  }
  if (failure.phase === 'me') {
    return `Instagram がユーザー ID の確認を断りました${detail}。Instagram 側でアカウントの状態を確かめてください。`;
  }
  return failure.phase === 'container'
    ? `Instagram が画像を受け付けませんでした${detail}。media の URL が公開された JPEG 画像を指しているか確かめてください。`
    : `Instagram が container の状態の確認を断りました${detail}。Instagram 側でアカウントの状態を確かめてください。`;
}

/** R4（公開）の失敗。**送った後は、レート制限のほかは届いたか分からない。** */
function publishReason(failure: GraphFailure, detail: string): string {
  if (failure.kind === 'budget') {
    return '公開の要求を送るだけの時間が残っていなかったため、送らずに中断しました。時間をおいて再試行します。';
  }
  const known = classReason(failure, detail);
  if (known !== undefined) {
    return known;
  }
  if (failure.retryable) {
    return `Instagram への公開が制限されました${detail}。時間をおいて再試行します。`;
  }
  return `Instagram へ公開の要求が届いたかを確認できませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
}

/**
 * `reason` の文言。**運用者が次に何をすればよいかが読める日本語**にする。
 * **Graph API の自由文を載せない**（設計 §6.11）。
 */
function reasonFor(failure: GraphFailure): string {
  const detail = detailOf(failure);
  return failure.phase === 'publish'
    ? publishReason(failure, detail)
    : beforePublishReason(failure, detail);
}

/* -------------------------------------------------------------------------- */
/* publish()：段取り（設計 §6.3〜§6.8）                                           */
/* -------------------------------------------------------------------------- */

type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

/** 1 回の配信のあいだ持ち回る値。 */
interface Session {
  readonly impl: FetchImpl;
  readonly clock: () => Date;
  readonly wait: Wait;
  readonly igUserId: string;
  readonly accessToken: string;
  /** Core から渡された signal。発火したらその場で抜ける。 */
  readonly input: AbortSignal;
  /** 外側の signal（`input` ＋ 合計の期限）。R4〜R6 はこの下で送る。 */
  readonly outer: AbortSignal;
  /** 準備の signal（外側 ＋ 準備の期限）。R1〜R3 と待ちはこの下で行う。 */
  readonly prepare: AbortSignal;
  readonly prepareDeadline: number;
  readonly totalDeadline: number;
}

function remainingMs(session: Session): number {
  return session.totalDeadline - session.clock().getTime();
}

function pastPrepareDeadline(session: Session): boolean {
  return session.clock().getTime() >= session.prepareDeadline;
}

/**
 * 複数の要求を同時に `CAROUSEL_CHILD_CONCURRENCY` 本まで飛ばす（**空いたら次を出す**）。
 *
 * 1 つが失敗したら、共有の controller で**飛んでいる残りを打ち切り**、まだ出していないものは出さない。
 * 結果は **`items` の添字の順**に並ぶ（完了の順ではない）。
 */
async function runGroup<T, R>(
  items: readonly T[],
  send: (item: T, signal: AbortSignal) => Promise<GraphResult<R>>,
): Promise<GraphResult<R[]>> {
  const siblings = new AbortController();
  const values: R[] = new Array<R>(items.length);
  const failures: { readonly index: number; readonly failure: GraphFailure }[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (!siblings.signal.aborted && next < items.length) {
      const index = next;
      next += 1;
      const result = await send(items[index] as T, siblings.signal);
      if (result.ok) {
        values[index] = result.value;
      } else if (result.failure.kind === 'aborted' && siblings.signal.aborted) {
        // **子どうしの打ち切りで止まったものは失敗に数えない**（設計 §6.9「複数の失敗」）。
      } else {
        failures.push({ index, failure: result.failure });
        siblings.abort();
      }
    }
  };

  const workers = Array.from({ length: Math.min(CAROUSEL_CHILD_CONCURRENCY, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  if (failures.length === 0) {
    return { ok: true, value: values };
  }
  return { ok: false, failure: mergeFailures(failures) };
}

/**
 * 複数の失敗を 1 つにまとめる（設計 §6.9「複数の失敗」）。
 *
 * `retryable` は**すべての失敗が `true` のときだけ `true`**。`reason` とログに使うのは
 * `retryable: false` のうち添字がいちばん小さいもの、無ければ添字がいちばん小さいもの。
 * **完了の順で選ばない**（同じ入力で `reason` が変わる）。
 */
function mergeFailures(
  failures: readonly { readonly index: number; readonly failure: GraphFailure }[],
): GraphFailure {
  const ordered = [...failures].sort((a, b) => a.index - b.index);
  // 1 つでも直らない失敗があれば、作り直しても同じところで落ちる。それを選べば `retryable` は `false` になる。
  const chosen = ordered.find((entry) => !entry.failure.retryable) ?? ordered[0];
  return (chosen as (typeof ordered)[number]).failure;
}

/**
 * container が `FINISHED` になるまで待つ（設計 §6.4）。
 *
 * **最初の確認は作成の直後。** round の上限は `POLL_MAX_ROUNDS` と準備の期限の早いほうで、
 * 期限は **`now()` で数える**（実時間の打ち切りは `AbortSignal.timeout` が別に効く）。
 */
async function waitUntilFinished(
  session: Session,
  containerIds: readonly string[],
): Promise<GraphResult<true>> {
  let pending = [...containerIds];
  let round = 0;
  for (;;) {
    const checked = await runGroup(pending, (containerId, siblings) =>
      readContainerStatus({
        impl: session.impl,
        accessToken: session.accessToken,
        containerId,
        signal: AbortSignal.any([session.prepare, siblings]),
      }),
    );
    if (!checked.ok) {
      return checked;
    }
    pending = pending.filter((_, index) => checked.value[index] !== 'FINISHED');
    if (pending.length === 0) {
      return { ok: true, value: true };
    }

    round += 1;
    if (round >= POLL_MAX_ROUNDS || pastPrepareDeadline(session)) {
      return { ok: false, failure: budgetFailure('status') };
    }
    try {
      await session.wait(POLL_INTERVAL_MS, session.prepare);
    } catch {
      return { ok: false, failure: budgetFailure('status') };
    }
    if (session.input.aborted || pastPrepareDeadline(session)) {
      return { ok: false, failure: budgetFailure('status') };
    }
  }
}

/** 公開する container を用意する。単体なら R1、2 枚以上なら子 R1 × N → 親 R2（設計 §6.3）。 */
async function prepareContainer(
  session: Session,
  media: readonly SocialMediaView[],
  caption: string,
): Promise<GraphResult<string>> {
  const base = {
    impl: session.impl,
    igUserId: session.igUserId,
    accessToken: session.accessToken,
  };

  if (media.length === 1) {
    const created = await createImageContainer({
      ...base,
      imageUrl: (media[0] as SocialMediaView).url,
      caption,
      signal: session.prepare,
    });
    if (!created.ok) {
      return created;
    }
    const finished = await waitUntilFinished(session, [created.value]);
    return finished.ok ? created : finished;
  }

  const children = await runGroup(media, (item, siblings) =>
    createImageContainer({
      ...base,
      imageUrl: item.url,
      signal: AbortSignal.any([session.prepare, siblings]),
    }),
  );
  if (!children.ok) {
    return children;
  }
  const childrenFinished = await waitUntilFinished(session, children.value);
  if (!childrenFinished.ok) {
    return childrenFinished;
  }
  if (pastPrepareDeadline(session)) {
    return { ok: false, failure: budgetFailure('status') };
  }

  const parent = await createCarouselContainer({
    ...base,
    children: children.value,
    caption,
    signal: session.prepare,
  });
  if (!parent.ok) {
    return parent;
  }
  const parentFinished = await waitUntilFinished(session, [parent.value]);
  return parentFinished.ok ? parent : parentFinished;
}

/** ログが投げても `publish()` を投げさせない。 */
function safeLogger(logger: PluginLogger): PluginLogger {
  const guard =
    (method: keyof PluginLogger) =>
    (message: string, detail?: Record<string, unknown>): void => {
      try {
        logger[method](message, detail);
      } catch {
        // ログが出せないことを理由に例外を投げない。
      }
    };
  return { debug: guard('debug'), info: guard('info'), warn: guard('warn'), error: guard('error') };
}

/** `link` が指定されているか（空文字は「無し」）。 */
function hasLink(link: unknown): boolean {
  return link !== null && link !== undefined && link !== '';
}

interface AfterPublish {
  externalId?: string;
  externalUrl?: string;
  rotatedCredential?: Readonly<Record<string, string>>;
}

/**
 * 公開の後（R5 / R6）。**何が起きても `ok: true` を覆さない**（設計 §6.9 の P5）。
 *
 * 例外もここで握る。R5 / R6 の例外が外側の `catch` に落ちて `ok: false` にならないようにする。
 */
async function afterPublish(
  session: Session,
  mediaId: string | undefined,
  credential: Readonly<Record<string, string>>,
  resolvedFromAuto: boolean,
  log: (message: string, phase: string, detail?: Record<string, unknown>) => void,
): Promise<PublishResult> {
  const result: AfterPublish = {};
  if (resolvedFromAuto) {
    // `auto` を R0 で解決した ID を書き戻す（041 設計 §6.4.3）。延長したら下で延長後の値に置き換わる。
    // **3 つを明示して組む。** `...credential` で写さない。期限は入っていた値そのまま（unknown を含む）。
    result.rotatedCredential = {
      igUserId: session.igUserId,
      accessToken: session.accessToken,
      accessTokenExpiresAt: credential['accessTokenExpiresAt'] ?? UNKNOWN_EXPIRY,
    };
  }
  try {
    if (mediaId === undefined) {
      // **失敗にしない。** 200 を返した以上、公開されている（設計 §6.5）。
      log('instagram media id rejected', 'publish');
    } else {
      result.externalId = mediaId;
      if (remainingMs(session) >= PERMALINK_TIMEOUT_MS) {
        const permalink = await readPermalink({
          impl: session.impl,
          accessToken: session.accessToken,
          mediaId,
          signal: session.outer,
        });
        if (permalink.ok && permalink.value !== undefined) {
          result.externalUrl = permalink.value;
        } else {
          log(
            'instagram permalink skipped',
            'permalink',
            permalink.ok ? {} : failureFields(permalink.failure),
          );
        }
      } else {
        log('instagram permalink skipped', 'permalink');
      }
    }

    const now = session.clock();
    if (shouldRefresh(parseExpiry(credential['accessTokenExpiresAt'], now), now)) {
      if (remainingMs(session) < REFRESH_TIMEOUT_MS) {
        log('instagram token refresh skipped', 'refresh');
      } else {
        const refreshed = await refreshAccessToken({
          impl: session.impl,
          accessToken: session.accessToken,
          signal: session.outer,
        });
        if (refreshed.ok && isValidAccessToken(refreshed.value.accessToken)) {
          // **3 つを明示して組む。** `...credential` で写さない（設計 §6.7）。
          result.rotatedCredential = {
            igUserId: session.igUserId,
            accessToken: refreshed.value.accessToken,
            accessTokenExpiresAt: expiryFromExpiresIn(refreshed.value.expiresIn, session.clock()),
          };
        } else {
          log(
            'instagram token refresh skipped',
            'refresh',
            refreshed.ok ? {} : failureFields(refreshed.failure),
          );
        }
      }
    }
  } catch {
    log('instagram after publish failed', 'publish');
  }
  return { ok: true, ...result };
}

/** ログに渡してよい失敗の素性（設計 §6.11）。**値・URL・自由文を渡さない。** */
function failureFields(failure: GraphFailure): Record<string, unknown> {
  return {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.subcode === undefined ? {} : { subcode: failure.subcode }),
    ...(failure.fbtraceId === undefined ? {} : { fbtraceId: failure.fbtraceId }),
  };
}

/**
 * 1 回配信する。
 *
 * **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.11）。
 * **「R4 を送ったか」を 1 つの変数で持ち**、予期しない例外の分類はそれで決める。
 */
async function publishPost(
  options: InstagramPublisherOptions,
  input: PublishInput,
): Promise<PublishResult> {
  const { post, credential, attempt, signal } = input;
  const logger = safeLogger(input.logger);
  const media: readonly SocialMediaView[] = Array.isArray(post.media) ? post.media : [];
  const base = { postId: post.id, attempt, mediaCount: media.length };
  const log = (message: string, phase: string, detail: Record<string, unknown> = {}): void => {
    logger.warn(message, { ...base, phase, ...detail });
  };
  /** R4 を送ったか（送ろうとしたか）。**予期しない例外の `retryable` はこれで決める**（設計 §6.11）。 */
  let publishSent = false;

  try {
    if (signal.aborted) {
      // Core は既に「結果不明」として確定させている。何を返しても記録されない（設計 §6.8）。
      return { ok: false, reason: ABORTED_REASON, retryable: false };
    }
    logger.info('Instagram へ配信する', base);

    // P0：外へ 1 本も出さずに断る。人が直すまで直らない（設計 §6.9）。
    if (media.length === 0) {
      log('instagram input rejected', 'input');
      return { ok: false, reason: MEDIA_REQUIRED_REASON, retryable: false };
    }
    if (hasLink(post.link)) {
      // **黙って捨てない**（設計 §6.12）。
      log('instagram input rejected', 'input');
      return { ok: false, reason: LINK_REASON, retryable: false };
    }
    const enteredUserId = credential['igUserId'];
    const accessToken = credential['accessToken'];
    // `auto` は数字の ID の代わりに通す（041 設計 §6.4。ユーザー裁定 U1）。それ以外の形の誤りは従来どおり。
    const autoUserId = isAutoIgUserId(enteredUserId);
    if ((!autoUserId && !isValidIgUserId(enteredUserId)) || !isValidAccessToken(accessToken)) {
      log('instagram credential rejected', 'input');
      return { ok: false, reason: CREDENTIAL_REASON, retryable: false };
    }

    const clock = options.now ?? ((): Date => new Date());
    const startedAt = clock().getTime();
    // **入口で合計の期限を 1 つ作り、すべての要求の外側に混ぜる**（設計 §6.8）。
    const outer = AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_TOTAL_BUDGET_MS)]);
    const prepare = AbortSignal.any([outer, AbortSignal.timeout(PREPARE_BUDGET_MS)]);
    const impl = resolveFetch(options.fetch);

    const fail = (failure: GraphFailure): PublishResult => {
      if (signal.aborted) {
        return { ok: false, reason: ABORTED_REASON, retryable: false };
      }
      log('instagram publish failed', failure.phase, failureFields(failure));
      return {
        ok: false,
        reason: reasonFor(failure),
        retryable: failure.retryable,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      };
    };

    // R0：`auto` なら準備の最初に、準備の signal の下で自分の ID を問い合わせる（041 設計 §6.4.2）。
    // 1 回の配信につき 1 回まで。失敗したら R1 以降を送らない。**ID の値をログに載せない。**
    let igUserId: string;
    if (autoUserId) {
      const me = await readMeUserId({ impl, accessToken, signal: prepare });
      if (!me.ok) {
        return fail(me.failure);
      }
      if (me.value === undefined) {
        if (signal.aborted) {
          return { ok: false, reason: ABORTED_REASON, retryable: false };
        }
        log('instagram user id unresolved', 'me');
        return { ok: false, reason: ID_UNRESOLVED_REASON, retryable: false };
      }
      igUserId = me.value;
      log('instagram user id resolved', 'me');
    } else {
      igUserId = enteredUserId as string;
    }

    const session: Session = {
      impl,
      clock,
      wait: options.wait ?? defaultWait,
      igUserId,
      accessToken,
      input: signal,
      outer,
      prepare,
      prepareDeadline: startedAt + PREPARE_BUDGET_MS,
      totalDeadline: startedAt + PUBLISH_TOTAL_BUDGET_MS,
    };

    const prepared = await prepareContainer(session, media, post.body);
    if (!prepared.ok) {
      return fail(prepared.failure);
    }

    // **途中で切られる見込みの R4 は始めない**（設計 §6.5）。
    if (remainingMs(session) < MEDIA_PUBLISH_TIMEOUT_MS) {
      return fail(budgetFailure('publish'));
    }

    publishSent = true;
    // **R4 は準備の signal ではなく外側の signal の下で送る**（設計 §6.8）。
    const published = await publishContainer({
      impl: session.impl,
      igUserId,
      accessToken,
      creationId: prepared.value,
      signal: outer,
    });
    if (!published.ok) {
      return fail(published.failure);
    }
    logger.info('Instagram へ配信した', base);

    return await afterPublish(session, published.value.mediaId, credential, autoUserId, log);
  } catch {
    // 送っていなければ `true`、送っていれば・分からなければ `false`（設計 §6.11）。
    //
    // **`publishSent === true` の側は防御的なコード**であり、現状のコードでは到達する経路が無い。
    // R4 を送った後に呼ぶのは `publishContainer`（`sendGraphRequest` が例外を投げずに分類する）・
    // `fail`・`afterPublish`（R5 / R6 の例外を自分で握る）だけで、どれもここへ例外を落とさない。
    // 後から R4 の後に処理を足しても二重投稿へ倒れないよう、分岐は残す。**テストで到達を確かめたものではない。**
    logger.error('instagram publish unexpected', {
      ...base,
      phase: publishSent ? 'publish' : 'prepare',
    });
    return publishSent
      ? { ok: false, reason: UNEXPECTED_AFTER_PUBLISH_REASON, retryable: false }
      : { ok: false, reason: UNEXPECTED_BEFORE_PUBLISH_REASON, retryable: true };
  }
}

/**
 * Instagram の publisher を組み立てる。
 *
 * **状態を 1 つも持たない**ので、Key-Value Store を受け取らない（設計 §5.3）。
 */
export function createInstagramPublisher(
  options: InstagramPublisherOptions = {},
): PublisherRegistration {
  return {
    provider: INSTAGRAM_PROVIDER,
    label: 'Instagram',
    credentialFields: CREDENTIAL_FIELDS,
    limits: LIMITS,
    validate: ({ post }) => validateDraft(post),
    // **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.11）。
    publish: async (input) => await publishPost(options, input),
  };
}
