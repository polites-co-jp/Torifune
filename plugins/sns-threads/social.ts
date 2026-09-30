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
import { buildThreadsManualHandoff, checkThreadsText, composeThreadsText } from './threads-text';
import {
  CAROUSEL_CHILD_CONCURRENCY,
  PERMALINK_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_ROUNDS,
  PREPARE_BUDGET_MS,
  PUBLISH_REQUEST_TIMEOUT_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  REFRESH_TIMEOUT_MS,
  budgetFailure,
  createCarouselContainer,
  createImageContainer,
  createTextContainer,
  publishContainer,
  readContainerStatus,
  readPermalink,
  refreshAccessToken,
  resolveFetch,
  type FetchImpl,
  type ThreadsAuth,
  type ThreadsFailure,
  type ThreadsPhase,
  type ThreadsResult,
} from './threads-api';
import {
  expiryFromExpiresIn,
  isValidAccessToken,
  isValidThreadsUserId,
  parseExpiry,
  shouldRefresh,
} from './token';

/**
 * Threads API で投稿する publisher（040-sns-threads 設計 §5〜§9）。
 *
 * **Plugin が書くのは「1 回配信する関数」と「投稿画面の URL を返す関数」だけ。**
 * いつ送るか・再試行・記録・画面は Core が持つ。
 *
 * 状態を 1 つも持たない（設計 §5.3）。
 */

/** `social_accounts.provider` と同じ値。Core の既知の provider の一覧には無い（設計 §11 #1）。 */
export const THREADS_PROVIDER = 'threads';

/** 表示名。Plugin が有効な間はこれが出る。 */
export const THREADS_LABEL = 'Threads';

/** テストのための口（設計 §10.1）。**`store` を受け取らない**（状態を持たない。設計 §5.3）。 */
export interface ThreadsPublisherOptions {
  /** 外部への HTTP。既定は Node の標準実装。**テストはここを差し替える**。`index.ts` は与えない。 */
  readonly fetch?: FetchImpl;
  /** この Plugin が見る時計。既定は現在時刻。期限の判定（設計 §6.8）とトークンの期限（設計 §6.7）がこれを見る。 */
  readonly now?: () => Date;
  /** ポーリングの待ち。既定は `setTimeout` を signal で打ち切る実装。 */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 既定の待ち。`ms` 待って解決し、`signal` が発火したらその場で `signal.reason` で reject する（#92）。
 *
 * HTTP ではないので `threads-api.ts` に置かない（実装プラン §8 の 9）。
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
 * 資格情報の形（設計 §5.1）。**3 つで確定。後から足せない**（足すと既存のアカウントの配信が全部 `failed` になる）。
 *
 * `description` は `/social` の欄の下に出る。ユーザー ID とユーザーネームの取り違え・権限の不足は、
 * 入力の時点で読まれるここに書く。
 */
const CREDENTIAL_FIELDS: readonly PluginSettingsField[] = [
  {
    key: 'threadsUserId',
    label: 'Threads ユーザー ID',
    description:
      'Threads のユーザー ID。数字だけの文字列です（長期アクセストークンで /me を問い合わせると分かります）。' +
      '@ で始まるユーザーネームではありません。',
    kind: 'text',
    placeholder: '17841400000000000',
  },
  {
    key: 'accessToken',
    label: '長期アクセストークン',
    description:
      'Threads API で発行した長期アクセストークン。threads_basic と threads_content_publish の権限が要ります。' +
      '60 日で失効します。Torifune は配信が成功したときに残り日数を見て、必要なら延長して保存し直します。保存後は再表示されません。',
    kind: 'secret',
  },
  {
    key: 'accessTokenExpiresAt',
    label: 'トークンの有効期限',
    description:
      'トークンの有効期限（例：2026-11-23T00:00:00Z）。分からなければ unknown と入れてください。' +
      '次に配信が成功したとき、Torifune がトークンを延長して正しい期限に書き換えます。',
    kind: 'text',
    placeholder: 'unknown',
  },
];

/**
 * Core が登録時と配信直前に適用する制約（設計 §9.1）。
 *
 * **`bodyMaxLength` を宣言しない。** 本文の判定は `validate()`（`checkThreadsText`）が §9.4 の数え方で行う。
 * 二重に書くと、後で `validate()` を緩めたときに片方だけが厳しい側に残る。
 * **`mediaRequired` を宣言しない**（テキストだけの投稿ができる）。
 * `mediaMax` は Core の投稿の上限（10）に合わせる（Threads の carousel は 20 件まで受けるが、Core が 10 で抑える）。
 */
const LIMITS: PublisherLimits = { mediaMax: 10 };

/**
 * 登録時と配信直前の事前検査（設計 §9.2）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。同期で返す。例外を投げない。**
 * 本文について言うことは必ず `checkThreadsText` から来る。複数の違反はすべて返す。
 * 媒体の枚数・URL の形・`alt` の長さは Core が見る（設計 §9.2）。
 */
function validateDraft(post: SocialPostDraftView): PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  // 1〜4：本文の片割れ・長さ・URL の本数・intent URL の長さ。
  problems.push(...checkThreadsText(post));

  // 5：外から来た任意の JSON。循環参照を含みうるので、キーの一覧だけを見る。
  const options: unknown = post.providerOptions;
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      problems.push({
        field: `providerOptions.${key}`,
        message: `${key} は Threads では使いません。`,
      });
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* publish()：失敗したときの文言（設計 §6.11）                                   */
/* -------------------------------------------------------------------------- */

/** Core は既に結果を確定させている。何を返しても記録されない（設計 §6.8）。 */
const ABORTED_REASON = 'Threads への配信が打ち切られました。';

const CREDENTIAL_REASON =
  'Threads の資格情報の形が正しくありません（ユーザー ID は数字だけ、長期アクセストークンは空白や改行を含まない' +
  ' 2048 文字以内の文字列）。/social のアカウントの「資格情報を設定」から入れ直してください。';

const MEDIA_COUNT_REASON =
  `Threads へ 1 回の投稿で送れる画像は ${LIMITS.mediaMax ?? 10} 枚までです。` +
  '画像を減らして登録し直してください。';

const TEXT_REASON =
  'Threads へ送れない本文です（本文と link を合わせて 500 文字・リンク 5 本まで、扱えない文字を含まないこと）。' +
  '本文を直して登録し直してください。';

const BUDGET_REASON =
  'Threads の処理が時間内に終わりませんでした（投稿の準備）。公開はしていません。時間をおいて再試行します。';

const UNEXPECTED_BEFORE_PUBLISH_REASON =
  'Threads への配信の準備中に予期しない問題が起きました。公開はしていません。時間をおいて再試行します。';

const UNEXPECTED_AFTER_PUBLISH_REASON =
  'Threads へ公開の要求を送った後で予期しない問題が起きました。二重に投稿しないよう再試行しません。' +
  'Threads 側で投稿されたか確かめてください。';

const NOT_CONFIRMED_SUFFIX =
  '二重に投稿しないよう再試行しません。Threads 側で投稿されたか確かめてから、必要なら予約し直してください。';

const REISSUE_TOKEN =
  '長期アクセストークンを発行し直し、/social のアカウントの「資格情報を設定」から入れ直してください。';

const RETRY_LATER = '公開はしていません。時間をおいて再試行します。';

const PHASE_LABELS: Readonly<Record<ThreadsPhase, string>> = {
  container: 'container の作成',
  status: 'container の状態の確認',
  prepare: '投稿の準備',
  publish: '公開',
  permalink: '投稿の URL の問い合わせ',
  refresh: 'トークンの延長',
};

/**
 * `reason` に載せる応答の素性。
 *
 * **フェーズの言葉・HTTP の status・既知の `code` / `error_subcode`（知らなければ `unknown`）だけ。**
 * Threads API の自由文（`message` / `error_user_msg` など）・`type`・`fbtrace_id`・要求の URL と本体・例外の文面は載せない。
 * Core の伏せ字は 4 文字以上の完全一致しか消せず、URL や form に載ったトークンは符号化されて一致しないので、
 * **伏せ字を当てにしない**（設計 §6.11）。
 */
function detailOf(failure: ThreadsFailure): string {
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
  const label = PHASE_LABELS[failure.phase];
  return parts.length === 0 ? `（${label}）` : `（${label}、${parts.join(' / ')}）`;
}

/** 状態（`status`）の失敗。**知らない値はそのまま出さない**（外から来た文字列）。 */
function stateReason(failure: ThreadsFailure): string {
  switch (failure.state) {
    case 'ERROR':
      return (
        'Threads が画像を処理できませんでした（container の状態 ERROR）。' +
        'media の URL が、インターネットから取得できる 8MB 以下の JPEG か PNG の画像を指しているか確かめてください。'
      );
    case 'PUBLISHED':
      return (
        'Threads が、公開の要求を送る前に container を公開済みと返しました（container の状態 PUBLISHED）。' +
        NOT_CONFIRMED_SUFFIX
      );
    case 'EXPIRED':
      return `Threads の container が失効しました（container の状態 EXPIRED）。${RETRY_LATER}`;
    default:
      return `Threads の container の状態を読み取れませんでした。${RETRY_LATER}`;
  }
}

function isRedirect(failure: ThreadsFailure): boolean {
  return failure.status !== undefined && failure.status >= 300 && failure.status < 400;
}

/** R4 を送る前（container の作成・状態の確認）の失敗。 */
function beforePublishReason(failure: ThreadsFailure, detail: string): string {
  switch (failure.kind) {
    case 'network':
      return `Threads へ接続できませんでした${detail}。${RETRY_LATER}`;
    case 'timeout':
      return `Threads が時間内に応答しませんでした${detail}。${RETRY_LATER}`;
    case 'aborted':
      return `Threads への要求が打ち切られました${detail}。${RETRY_LATER}`;
    case 'shape':
      return `Threads の応答を解釈できませんでした${detail}。${RETRY_LATER}`;
    default:
      break;
  }

  if (isRedirect(failure)) {
    return (
      `Threads が想定しない転送を返しました${detail}。転送は追わないため再試行しません。` +
      '時間をおいて予約し直してください。'
    );
  }
  switch (failure.errorClass) {
    case 'token':
      return `Threads のアクセストークンが無効か期限切れです${detail}。${REISSUE_TOKEN}`;
    case 'permission':
      return (
        `Threads の権限が足りません${detail}。長期アクセストークンに threads_basic と ` +
        'threads_content_publish の権限があるか確かめてください。'
      );
    case 'rejected':
      return (
        `Threads がポリシーへの違反か重複として投稿を断りました${detail}。同じ内容では再試行しません。` +
        '内容を見直して予約し直してください。'
      );
    case 'rateLimit':
      return `Threads の呼び出し回数の制限に達しました${detail}。${RETRY_LATER}`;
    default:
      break;
  }
  if (failure.retryable) {
    return `Threads が一時的に応答できませんでした${detail}。${RETRY_LATER}`;
  }
  return failure.phase === 'container'
    ? `Threads が投稿の内容を受け付けませんでした${detail}。本文・リンクの本数・media の URL` +
        '（インターネットから取得できる 8MB 以下の JPEG か PNG）を確かめて予約し直してください。'
    : `Threads が container の状態の確認を断りました${detail}。Threads 側でアカウントの状態を確かめてください。`;
}

/** R4（公開）の失敗。**送った後は、レート制限のほかは届いたか分からない。** */
function publishReason(failure: ThreadsFailure, detail: string): string {
  if (failure.retryable) {
    // レート制限だけ（retryableFor）。書き込む前に断られたと読める。
    return `Threads の呼び出し回数の制限により公開が断られました${detail}。${RETRY_LATER}`;
  }
  switch (failure.kind) {
    case 'network':
    case 'aborted':
      return `Threads へ公開の要求を送りましたが、応答を受け取れませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
    case 'timeout':
      return `Threads から公開の応答が時間内に返りませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
    case 'shape':
      return `Threads の公開の応答を解釈できませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
    default:
      break;
  }
  if (failure.errorClass === 'token' && !isRedirect(failure)) {
    return (
      `Threads が公開の要求にアクセストークンが無効か期限切れと返しました${detail}。` +
      `${NOT_CONFIRMED_SUFFIX}あわせて${REISSUE_TOKEN}`
    );
  }
  return `Threads の公開の結果が分かりません${detail}。${NOT_CONFIRMED_SUFFIX}`;
}

/**
 * `reason` の文言。**運用者が次に何をすればよいかが読める日本語**にする。
 * **Threads API の自由文を載せない**（設計 §6.11）。
 */
function reasonFor(failure: ThreadsFailure): string {
  if (failure.kind === 'budget') {
    return BUDGET_REASON;
  }
  if (failure.kind === 'state') {
    return stateReason(failure);
  }
  const detail = detailOf(failure);
  return failure.phase === 'publish'
    ? publishReason(failure, detail)
    : beforePublishReason(failure, detail);
}

/* -------------------------------------------------------------------------- */
/* publish()：段取り（設計 §6.3〜§6.8）                                           */
/* -------------------------------------------------------------------------- */

type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

/** ログの `phase`（実装プラン §8 の 4）。`input` は入口の検査。 */
type LogPhase = 'input' | ThreadsPhase;

/** 1 回の配信のあいだ持ち回る値。 */
interface Session {
  readonly auth: ThreadsAuth;
  readonly clock: () => Date;
  readonly wait: Wait;
  /** 外側の signal（`input.signal` ＋ 合計の期限）。R4〜R6 はこの下で送る。 */
  readonly outer: AbortSignal;
  /** 準備の signal（外側 ＋ 準備の期限）。R1〜R3 と待ちはこの下で行う。 */
  readonly prepare: AbortSignal;
  readonly prepareDeadline: number;
  readonly totalDeadline: number;
  /** いまどの段階か。予期しない例外のログの `phase` に使う。 */
  stage: LogPhase;
}

function remainingMs(session: Session): number {
  return session.totalDeadline - session.clock().getTime();
}

/** **境界はちょうど**：経過が `PREPARE_BUDGET_MS` ちょうどなら過ぎたとみなす（設計 §6.8 / #79）。 */
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
  send: (item: T, siblings: AbortSignal) => Promise<ThreadsResult<R>>,
): Promise<ThreadsResult<R[]>> {
  const siblings = new AbortController();
  const values: R[] = new Array<R>(items.length);
  const failures: { readonly index: number; readonly failure: ThreadsFailure }[] = [];
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
  failures: readonly { readonly index: number; readonly failure: ThreadsFailure }[],
): ThreadsFailure {
  const ordered = [...failures].sort((a, b) => a.index - b.index);
  // 1 つでも直らない失敗があれば、作り直しても同じところで落ちる。それを選べば `retryable` は `false` になる。
  const chosen = ordered.find((entry) => !entry.failure.retryable) ?? ordered[0];
  return (chosen as (typeof ordered)[number]).failure;
}

function budget(round?: number): ThreadsResult<never> {
  return { ok: false, failure: budgetFailure(round) };
}

/**
 * container が `FINISHED` になるまで待つ（設計 §6.4）。
 *
 * **最初の確認は作成の直後**（待たずに済む場合がある）。round は container の集合ごとに 0 から数え
 * （実装プラン §8 の 3）、上限は `POLL_MAX_ROUNDS` と準備の期限の早いほう。
 * 期限は **`now()` で数える**（実時間の打ち切りは `AbortSignal.timeout` が別に効く）。
 */
async function waitUntilFinished(
  session: Session,
  containerIds: readonly string[],
): Promise<ThreadsResult<true>> {
  let pending = [...containerIds];
  let round = 0;
  for (;;) {
    session.stage = 'status';
    const checked = await runGroup(pending, (containerId, siblings) =>
      readContainerStatus(session.auth, {
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
      return budget(round);
    }
    session.stage = 'prepare';
    try {
      await session.wait(POLL_INTERVAL_MS, session.prepare);
    } catch {
      // 待ちが打ち切られた（準備・合計の期限か `input.signal`）。R4 はまだ送っていない。
      return budget(round);
    }
    if (session.outer.aborted || pastPrepareDeadline(session)) {
      return budget(round);
    }
  }
}

/**
 * 公開する container を用意する（設計 §6.3）。
 *
 * テキストなら R1（`TEXT`）、画像 1 枚なら R1（`IMAGE`）、2 枚以上なら子 R1 × N → 子の R3 → 親 R2 → 親の R3。
 * **テキストの container も状態を確かめる**（処理待ちがありうるかが文書に無い。設計 §6.4）。
 */
async function prepareContainer(
  session: Session,
  media: readonly SocialMediaView[],
  text: string,
): Promise<ThreadsResult<string>> {
  session.stage = 'container';

  if (media.length <= 1) {
    const single = media[0];
    const created =
      single === undefined
        ? await createTextContainer(session.auth, { text, signal: session.prepare })
        : await createImageContainer(session.auth, {
            imageUrl: single.url,
            alt: single.alt,
            text,
            signal: session.prepare,
          });
    if (!created.ok) {
      return created;
    }
    const finished = await waitUntilFinished(session, [created.value]);
    return finished.ok ? created : finished;
  }

  const children = await runGroup(media, (item, siblings) =>
    createImageContainer(session.auth, {
      imageUrl: item.url,
      alt: item.alt,
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
    return budget();
  }

  session.stage = 'container';
  const parent = await createCarouselContainer(session.auth, {
    children: children.value,
    text,
    signal: session.prepare,
  });
  if (!parent.ok) {
    return parent;
  }
  const parentFinished = await waitUntilFinished(session, [parent.value]);
  return parentFinished.ok ? parent : parentFinished;
}

/** ログが投げても `publish()` を投げさせない・成功を失敗に変えない。 */
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

/**
 * ログに渡してよい失敗の素性（設計 §6.11）。
 *
 * **値・URL・本体・自由文を渡さない。** 値の無いキーはキーごと置かない（実装プラン T21）。
 */
function failureFields(failure: ThreadsFailure): Record<string, unknown> {
  return {
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.subcode === undefined ? {} : { subcode: failure.subcode }),
    ...(failure.fbtraceId === undefined ? {} : { fbtraceId: failure.fbtraceId }),
    ...(failure.round === undefined ? {} : { round: failure.round }),
  };
}

type Log = (message: string, phase: LogPhase, detail?: Record<string, unknown>) => void;

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
  expiresAt: unknown,
  log: Log,
): Promise<PublishResult> {
  const result: AfterPublish = {};
  try {
    if (mediaId === undefined) {
      // **失敗にしない。** 200 と `id` が返った以上、公開されている（設計 §6.5）。R5 は呼ばない。
      log('threads media id rejected', 'publish');
    } else {
      result.externalId = mediaId;
      if (session.outer.aborted || remainingMs(session) < PERMALINK_TIMEOUT_MS) {
        log('threads permalink skipped', 'permalink');
      } else {
        const permalink = await readPermalink(session.auth, { mediaId, signal: session.outer });
        if (permalink.ok && permalink.value !== undefined) {
          result.externalUrl = permalink.value;
        } else {
          // 失敗・形の不一致・`permalink` が返らない（著作権などで省かれる。F17）。
          log(
            'threads permalink skipped',
            'permalink',
            permalink.ok ? {} : failureFields(permalink.failure),
          );
        }
      }
    }

    // 延長は公開の「後」だけ（設計 §6.7）。延長の失敗を投稿の成否に混ぜない。
    const now = session.clock();
    if (shouldRefresh(parseExpiry(expiresAt, now), now)) {
      if (session.outer.aborted || remainingMs(session) < REFRESH_TIMEOUT_MS) {
        log('threads token refresh skipped', 'refresh');
      } else {
        const refreshed = await refreshAccessToken(session.auth, { signal: session.outer });
        if (refreshed.ok && isValidAccessToken(refreshed.value.accessToken)) {
          // **3 つを明示して組む。** `...credential` で写さない（設計 §6.7）。
          // 元と同じ文字列でも返す（期限は延びている）。
          result.rotatedCredential = {
            threadsUserId: session.auth.threadsUserId,
            accessToken: refreshed.value.accessToken,
            accessTokenExpiresAt: expiryFromExpiresIn(refreshed.value.expiresIn, session.clock()),
          };
        } else {
          log(
            'threads token refresh skipped',
            'refresh',
            refreshed.ok ? {} : failureFields(refreshed.failure),
          );
        }
      }
    }
  } catch {
    // R5 / R6 の要求は例外を投げずに分類する。ここへ来るのは注入した時計が投げたときなどで、
    // **テストで到達を確かめたものではない。** 公開は済んでいるので、集めた分だけで `ok: true` を返す。
    log('threads after publish failed', 'publish');
  }
  return { ok: true, ...result };
}

/** 投稿の形（ログにだけ出す）。 */
function shapeOf(count: number): 'text' | 'image' | 'carousel' {
  if (count === 0) {
    return 'text';
  }
  return count === 1 ? 'image' : 'carousel';
}

/**
 * 1 回配信する。
 *
 * **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.11）。
 * **「R4 を送ったか」を 1 つの変数で持ち**、予期しない例外の分類はそれで決める。
 */
async function publishPost(
  options: ThreadsPublisherOptions,
  input: PublishInput,
): Promise<PublishResult> {
  const { post, credential, attempt, signal } = input;
  const logger = safeLogger(input.logger);
  const media: readonly SocialMediaView[] = Array.isArray(post.media) ? post.media : [];
  const base = { postId: post.id, attempt, mediaCount: media.length, shape: shapeOf(media.length) };
  const log: Log = (message, phase, detail = {}) => {
    logger.warn(message, { ...base, phase, ...detail });
  };
  /** R4 を送ったか（送ろうとしたか）。**予期しない例外の `retryable` はこれで決める**（設計 §6.9「どこでも」）。 */
  let publishSent = false;
  let session: Session | undefined;

  try {
    if (signal.aborted) {
      // Core は既に「結果不明」として確定させている。外へ 1 本も出さずに抜ける（設計 §6.8）。
      return { ok: false, reason: ABORTED_REASON, retryable: false };
    }

    // P0：外へ 1 本も出さずに断る。人が直すまで直らない（設計 §6.9）。
    const threadsUserId = credential['threadsUserId'];
    const accessToken = credential['accessToken'];
    if (!isValidThreadsUserId(threadsUserId) || !isValidAccessToken(accessToken)) {
      log('threads credential rejected', 'input');
      return { ok: false, reason: CREDENTIAL_REASON, retryable: false };
    }
    if (media.length > (LIMITS.mediaMax ?? 10)) {
      log('threads media count rejected', 'input');
      return { ok: false, reason: MEDIA_COUNT_REASON, retryable: false };
    }
    // `validate()` と同じ本文の検査（§9.2 の 1〜3。4 は手動投稿だけ）。送れば断られるだけの container を作らない。
    if (checkThreadsText(post).length > 0) {
      log('threads text rejected', 'input');
      return { ok: false, reason: TEXT_REASON, retryable: false };
    }

    const clock = options.now ?? ((): Date => new Date());
    const startedAt = clock().getTime();
    // **入口で合計の期限を 1 つ作り、すべての要求の外側に混ぜる**（設計 §6.8）。
    const outer = AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_TOTAL_BUDGET_MS)]);
    const prepare = AbortSignal.any([outer, AbortSignal.timeout(PREPARE_BUDGET_MS)]);
    session = {
      auth: { impl: resolveFetch(options.fetch), threadsUserId, accessToken },
      clock,
      wait: options.wait ?? defaultWait,
      outer,
      prepare,
      prepareDeadline: startedAt + PREPARE_BUDGET_MS,
      totalDeadline: startedAt + PUBLISH_TOTAL_BUDGET_MS,
      stage: 'input',
    };
    logger.info('threads publish started', base);

    const fail = (failure: ThreadsFailure): PublishResult => {
      if (signal.aborted) {
        return { ok: false, reason: ABORTED_REASON, retryable: false };
      }
      log('threads publish failed', failure.phase, failureFields(failure));
      return {
        ok: false,
        reason: reasonFor(failure),
        retryable: failure.retryable,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      };
    };

    // 自動と手動で同じ文字列（`manual()` の intent URL の `text` と一致する。設計 §9.5 / #44）。
    const prepared = await prepareContainer(session, media, composeThreadsText(post));
    if (!prepared.ok) {
      return fail(prepared.failure);
    }

    // **途中で切られる見込みの R4 は始めない**（設計 §6.5）。残りがちょうど 10 秒なら送る。
    // 外側の signal が既に止まっていれば、時計に依らず始めない（実装プラン §8 の 13。
    // `outer.aborted` の側を名指しするテストは無い）。
    if (outer.aborted || remainingMs(session) < PUBLISH_REQUEST_TIMEOUT_MS) {
      return fail(budgetFailure());
    }

    publishSent = true;
    session.stage = 'publish';
    // **R4 は準備の signal ではなく外側の signal の下で送る**（設計 §6.8）。
    const published = await publishContainer(session.auth, {
      creationId: prepared.value,
      signal: outer,
    });
    if (!published.ok) {
      return fail(published.failure);
    }
    logger.info('threads published', base);

    return await afterPublish(
      session,
      published.value.mediaId,
      credential['accessTokenExpiresAt'],
      log,
    );
  } catch {
    // 送っていなければ `true`、送っていれば・分からなければ `false`（設計 §6.9「どこでも」）。
    //
    // **`publishSent === true` の側は防御的なコード**であり、現状のコードでは到達する経路が無い。
    // R4 を送った後に呼ぶのは `publishContainer`（`sendThreadsRequest` が例外を投げずに分類する）・
    // `fail`・`afterPublish`（R5 / R6 の例外を自分で握る）だけで、どれもここへ例外を落とさない。
    // 後から R4 の後に処理を足しても二重投稿へ倒れないよう、分岐は残す。**テストで到達を確かめたものではない。**
    const phase: LogPhase = publishSent ? 'publish' : (session?.stage ?? 'input');
    log('threads publish unexpected', phase);
    return publishSent
      ? { ok: false, reason: UNEXPECTED_AFTER_PUBLISH_REASON, retryable: false }
      : { ok: false, reason: UNEXPECTED_BEFORE_PUBLISH_REASON, retryable: true };
  }
}

/**
 * Threads の publisher を組み立てる。
 *
 * **状態を 1 つも持たない**ので、Key-Value Store を受け取らない（設計 §5.3）。
 * `index.ts` は引数を与えない。差し替えるのはテストだけ（設計 §10.1）。
 */
export function createThreadsPublisher(
  options: ThreadsPublisherOptions = {},
): PublisherRegistration {
  return {
    provider: THREADS_PROVIDER,
    label: THREADS_LABEL,
    credentialFields: CREDENTIAL_FIELDS,
    limits: LIMITS,
    validate({ post }) {
      return validateDraft(post);
    },
    // Web Intent はブラウザでログイン中のアカウントで開くので、`account` を使わない（設計 §9.5）。
    // 要求を出さない・待たない・例外を投げない。
    manual({ post }) {
      return buildThreadsManualHandoff(post);
    },
    // **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.11）。
    // `account` を使わない（ユーザー ID は資格情報の側。設計 §9）。
    publish: async (input) => await publishPost(options, input),
  };
}
