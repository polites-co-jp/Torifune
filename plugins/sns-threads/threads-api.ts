/**
 * Threads API への要求と、応答の分類（040-sns-threads 設計 §6）。
 *
 * **この Plugin が外へ出す HTTP はここに集める。** 宛先・版・制限時間の定数、
 * エラーの分類、`reason` に出してよい数値の集合も、すべてこのファイルの 1 か所に置く。
 * 文言の組み立てと `PublishResult` への変換は `social.ts` が持つ。
 *
 * **アクセストークンは `access_token` の引数で渡す**（POST は form の本体、GET はクエリ。設計 §6.2）。
 * したがって要求の URL と本体にはトークンが入る。**結果に URL も本体も例外の文面も持たせない。**
 */

/* -------------------------------------------------------------------------- */
/* 宛先と版（設計 §6.1）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 宛先。**定数であり、設定にも資格情報にも入れない**（設計 §5.3）。
 *
 * 変えられるようにすると、アクセストークンを任意のサーバへ送らせる口が 1 つ増えるだけになる。
 * 別名のドメインも有効だが、公式の例（延長の口を含む）がこの宛先で書かれているのでこちらを使う（設計 §6.1）。
 */
export const THREADS_API_BASE_URL = 'https://graph.threads.net';

/**
 * Threads API の版。2026-09-24 時点で公開されている唯一の版（設計 §6.1）。
 *
 * **版の更新はこの Plugin の更新で行う。** 値を変えたら `README.md` の記載も合わせる。
 */
export const THREADS_API_VERSION = 'v1.0';

/* -------------------------------------------------------------------------- */
/* 制限時間（設計 §6.8）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `publish()` 全体に使ってよい時間。
 *
 * Core は `publish()` を 30 秒で打ち切り、**結果不明として `failed`** にする。
 * 差の 5 秒は、打ち切りを検知して結果を返すための余白。
 */
export const PUBLISH_TOTAL_BUDGET_MS = 25_000;

/** 公開の要求（R4：`threads_publish`）1 本の制限時間。 */
export const PUBLISH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 準備（container の作成・状態の確認・待ち）に使ってよい時間。
 *
 * 公開の要求に要る時間を合計から先に取り分けた残り。**準備が長引いても公開の要求は途中で切られない。**
 */
export const PREPARE_BUDGET_MS = PUBLISH_TOTAL_BUDGET_MS - PUBLISH_REQUEST_TIMEOUT_MS;

/** container の作成（R1：単体・carousel の子、R2：carousel の親）1 本の制限時間。 */
export const CREATE_CONTAINER_TIMEOUT_MS = 10_000;

/** container の状態の確認（R3）1 本の制限時間。 */
export const STATUS_TIMEOUT_MS = 5_000;

/** 状態の確認の round のあいだの待ち。 */
export const POLL_INTERVAL_MS = 1_000;

/** 状態の確認の round の上限。**上限は回数と準備の期限の早いほう。** */
export const POLL_MAX_ROUNDS = 10;

/** 公開した投稿の URL（R5：permalink）の問い合わせ 1 本の制限時間。 */
export const PERMALINK_TIMEOUT_MS = 3_000;

/** トークンの延長（R6）1 本の制限時間。 */
export const REFRESH_TIMEOUT_MS = 3_000;

/** carousel の子の作成と状態の確認を同時に飛ばす本数の上限。 */
export const CAROUSEL_CHILD_CONCURRENCY = 5;

/** 応答の本体はここまでしか読まない。相手が何を返しても Plugin のメモリを食わせない（設計 §6.2）。 */
export const RESPONSE_BODY_MAX_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/* エラーの分類（設計 §6.9）                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Threads API のエラーの分類。
 *
 * 応答の本体（`{ "error": { … } }`。Graph API の封筒と推定。F18）から読むのは
 * **数値の `code`・`error_subcode` と真偽値の `is_transient` だけ**。自由文（`message` など）は読まない。
 */
export type ThreadsErrorClass =
  'rateLimit' | 'token' | 'permission' | 'rejected' | 'transient' | 'other';

/** レート制限を表す `code`。 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 341, 613]);

/** トークンが無効・期限切れを表す `code`。 */
const TOKEN_CODE = 190;

/** 権限の不足を表す `code`（10 と 200〜299）。 */
const PERMISSION_CODE = 10;
const PERMISSION_CODE_MIN = 200;
const PERMISSION_CODE_MAX = 299;

/** ポリシー違反（368）と重複（506）。同じ内容を送り直しても同じ。 */
const REJECTED_CODES: ReadonlySet<number> = new Set([368, 506]);

/** 応答の本体から読んだ、分類に使う値。**数値でないものは無かったことにする。** */
export interface ThreadsErrorFields {
  readonly code?: number;
  readonly subcode?: number;
  readonly isTransient: boolean;
  /** 形（`isValidFbtraceId`）に合うときだけ。`logger` にだけ渡し、`reason` には載せない。 */
  readonly fbtraceId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  // **数値に直さない。** `"190"` の文字列は `190` として扱わない（設計 §6.11）。
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorObjectOf(body: unknown): Record<string, unknown> | undefined {
  const error = isRecord(body) ? body['error'] : undefined;
  return isRecord(error) ? error : undefined;
}

/** 応答の本体（`JSON.parse` の結果。何でもありうる）から、分類に使う値だけを取り出す。 */
export function readThreadsError(body: unknown): ThreadsErrorFields {
  const error = errorObjectOf(body);
  if (error === undefined) {
    return { isTransient: false };
  }
  const code = numberOrUndefined(error['code']);
  const subcode = numberOrUndefined(error['error_subcode']);
  const fbtrace: unknown = error['fbtrace_id'];
  return {
    ...(code === undefined ? {} : { code }),
    ...(subcode === undefined ? {} : { subcode }),
    isTransient: error['is_transient'] === true,
    ...(isValidFbtraceId(fbtrace) ? { fbtraceId: fbtrace } : {}),
  };
}

/**
 * 失敗した応答を分類する（設計 §6.9 の分類表を**上から順に**）。
 *
 * `rateLimit`（429 か code 4 / 17 / 32 / 341 / 613）→ `token`（190）→ `permission`（10・200〜299）→
 * `rejected`（368・506）→ `transient`（`is_transient === true`）→ `other`。
 * `error_subcode` は分類に使わない（`reason` とログに出すだけ）。
 */
export function classifyThreadsError(status: number, body: unknown): ThreadsErrorClass {
  const { code, isTransient } = readThreadsError(body);

  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return 'rateLimit';
  }
  if (code === TOKEN_CODE) {
    return 'token';
  }
  if (
    code === PERMISSION_CODE ||
    (code !== undefined && code >= PERMISSION_CODE_MIN && code <= PERMISSION_CODE_MAX)
  ) {
    return 'permission';
  }
  if (code !== undefined && REJECTED_CODES.has(code)) {
    return 'rejected';
  }
  if (isTransient) {
    return 'transient';
  }
  return 'other';
}

/* -------------------------------------------------------------------------- */
/* reason に出してよい数値（設計 §6.11）                                          */
/* -------------------------------------------------------------------------- */

/** 知らない値の代わりに `reason` とログへ出す綴り。 */
export const UNKNOWN_THREADS_ERROR = 'unknown';

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * `reason` とログに出してよい `code`（設計 §6.11 の集合そのまま）。
 *
 * **数値でも知らない値は出さない。** 集合に無ければ `unknown` と書く。
 */
export const KNOWN_THREADS_ERROR_CODES: ReadonlySet<number> = new Set([
  1,
  2,
  4,
  10,
  17,
  24,
  32,
  100,
  190,
  ...range(200, 299),
  341,
  368,
  506,
  613,
]);

/**
 * `reason` とログに出してよい `error_subcode`（設計 §6.11。トークンとセッションに関わるもの）。
 *
 * 集合に無い値は `unknown` になるので、集合が小さくても安全側（出さない側）に倒れる。
 */
export const KNOWN_THREADS_ERROR_SUBCODES: ReadonlySet<number> = new Set([
  458, 459, 460, 463, 464, 467, 492,
]);

function describeKnown(value: unknown, known: ReadonlySet<number>): string {
  return typeof value === 'number' && Number.isInteger(value) && known.has(value)
    ? String(value)
    : UNKNOWN_THREADS_ERROR;
}

/** `reason` に書く `code`。既知の数値ならその数字、それ以外（数値でない値を含む）は `unknown`。 */
export function describeThreadsCode(value: unknown): string {
  return describeKnown(value, KNOWN_THREADS_ERROR_CODES);
}

/** `reason` に書く `error_subcode`。既知の数値ならその数字、それ以外は `unknown`。 */
export function describeThreadsSubcode(value: unknown): string {
  return describeKnown(value, KNOWN_THREADS_ERROR_SUBCODES);
}

/* -------------------------------------------------------------------------- */
/* retryAfterMs（設計 §6.10）                                                    */
/* -------------------------------------------------------------------------- */

/** これより長い `Retry-After` は読まない。 */
const RETRY_AFTER_MAX_LENGTH = 64;

const SECOND_MS = 1000;

/**
 * レート制限の応答の `Retry-After`（秒の整数）を ms にする。
 *
 * ヘッダが無い・64 文字を超える・正の整数でない → `undefined`（Core の既定の間隔に任せる）。
 * **Meta の使用量ヘッダ（`X-Business-Use-Case-Usage` など）は読まない**（Threads の文書に記述が無い。設計 §6.10）。
 * **24 時間で切り詰めるのは Core。** ヘッダの値はここで数値にするだけで、`reason` にもログにも載せない。
 */
export function retryAfterMsFrom(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (value === null || value.length > RETRY_AFTER_MAX_LENGTH || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const milliseconds = Number(value) * SECOND_MS;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

/* -------------------------------------------------------------------------- */
/* 外から来た文字列の形（設計 §6.2 / §6.5 / §6.6 / §6.11）                          */
/* -------------------------------------------------------------------------- */

/** Threads API が返す container ID / media ID の形。次の要求のパスに入る。 */
const THREADS_ID_PATTERN = /^[0-9]{1,64}$/;

/** `social_posts.external_url` の CHECK に合わせた上限。 */
const PERMALINK_MAX_LENGTH = 2048;

/** 投稿の URL として受け付けるホスト（例に 2 つのドメインが混在している。F17）。 */
const PERMALINK_HOSTS: readonly string[] = ['threads.net', 'threads.com'];

const FBTRACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Threads API が返した ID が、パスに入れてよく `externalId` に収まる形か。**数値型は受けない。** */
export function isValidThreadsId(value: unknown): value is string {
  return typeof value === 'string' && THREADS_ID_PATTERN.test(value);
}

/**
 * `permalink` を `externalUrl` に載せてよいか（設計 §6.6）。
 *
 * `new URL()` に通る・`https:`・`username` / `password` を含まない・
 * ホストが `threads.net` / `threads.com` か、`.threads.net` / `.threads.com` で終わる・2048 文字以内。
 * 1 つでも外れたら載せない。**返った値を自前で組み立て直さない。**
 */
export function isAcceptablePermalink(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > PERMALINK_MAX_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PERMALINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** `fbtrace_id` をログに渡してよい形か。**`reason` には形に合っても載せない。** */
export function isValidFbtraceId(value: unknown): value is string {
  return typeof value === 'string' && FBTRACE_ID_PATTERN.test(value);
}

/* -------------------------------------------------------------------------- */
/* HTTP の実装の解決（設計 §10.1）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 外部への HTTP の型。
 *
 * **Node の global を直に見るのは、この型宣言と下の既定値の解決だけ**（設計 §10.1 の 2）。
 * ほかのファイルはこの型と `resolveFetch()` を通してしか外へ出られない。
 */
export type FetchImpl = typeof globalThis.fetch;

/**
 * 実際に使う関数を決める。
 *
 * **既定値の解決はここだけ。** 呼び出しはすべて `impl(url, init)` の形で行う。
 * **毎回引き直す。** モジュールの読み込み時に閉じ込めると、差し替えが効かなくなる。
 */
export function resolveFetch(injected?: FetchImpl): FetchImpl {
  return injected ?? globalThis.fetch;
}

/* -------------------------------------------------------------------------- */
/* 1 本の要求を出して分類する（設計 §6.2 / §10.13 #89）                             */
/* -------------------------------------------------------------------------- */

/**
 * 1 本の要求の結果。
 *
 * - `ok`：**200** で本体が JSON として読めた
 * - `malformed`：200 以外の 2xx、または 200 だが本体が JSON として読めない（64 KiB を超えるものを含む）
 * - `http`：2xx 以外（**3xx を含む**。転送は追わない）。本体は JSON として読めたときだけ持つ
 * - `network`：接続できない（要求が reject した）
 * - `timeout`：制限時間（`AbortSignal.timeout`。要求ごと・準備・合計のどれか）で打ち切られた
 * - `aborted`：呼び出し側が打ち切った（`input.signal`・carousel の子どうしの打ち切り）
 *
 * **要求の URL も本体も例外の文面も持たない**（R3 / R5 / R6 の URL と R1 / R2 / R4 の本体にはトークンが入る。設計 §6.11）。
 */
export type ThreadsOutcome =
  | { readonly kind: 'ok'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'malformed'; readonly status: number }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly body: unknown;
      readonly headers: Headers;
    }
  | { readonly kind: 'network' | 'timeout' | 'aborted' };

export interface ThreadsRequest {
  readonly impl: FetchImpl;
  readonly method: 'GET' | 'POST';
  /** 宛先のパス。**形の検査を通した値だけで組む**（設計 §6.1）。 */
  readonly path: string;
  /** GET のクエリ。`access_token` は呼び出し側がここに入れる。 */
  readonly query?: Readonly<Record<string, string>>;
  /** POST の本体（`application/x-www-form-urlencoded`）。`access_token` は呼び出し側がここに入れる。 */
  readonly form?: Readonly<Record<string, string>>;
  /** この要求 1 本の制限時間。 */
  readonly timeoutMs: number;
  /** 外側の signal（合計の期限・準備の期限・子どうしの打ち切りを混ぜたもの）。 */
  readonly signal: AbortSignal;
}

function errorNameOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as { readonly name?: unknown }).name
    : undefined;
}

/**
 * 例外を `timeout` / `aborted` / `network` に分ける。**文面は読まない**（本物の例外の文面には URL が入りうる）。
 *
 * 本物の要求は `signal.reason` そのもので reject する（#90 の実測）：
 * `AbortSignal.timeout` 由来は `TimeoutError`、`AbortController.abort()` 由来は `AbortError`。
 */
function thrownKind(error: unknown, signal: AbortSignal): 'network' | 'timeout' | 'aborted' {
  const name = errorNameOf(error);
  if (name === 'TimeoutError') {
    return 'timeout';
  }
  if (name === 'AbortError') {
    return 'aborted';
  }
  if (signal.aborted) {
    return errorNameOf(signal.reason) === 'TimeoutError' ? 'timeout' : 'aborted';
  }
  return 'network';
}

/**
 * 本体を上限まで読む。超えたらそこで読むのをやめて stream を cancel し、`undefined`（JSON として扱わない）。
 *
 * **合計のバイト数で数える**（塊ごとではない）。読み込みの途中で signal が発火すると reject する
 * （ヘッダの後の abort。呼び出し側の `catch` が分類する）。
 */
async function readBoundedText(response: Response): Promise<string | undefined> {
  const body = response.body;
  if (body === null) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > RESPONSE_BODY_MAX_BYTES) {
      // cancel の失敗は握る（上限を超えた判定は変わらない）。**握る側はテストで到達を確かめていない。**
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const NOT_JSON: unique symbol = Symbol('not-json');

function parseJson(text: string | undefined): unknown {
  if (text === undefined) {
    return NOT_JSON;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}

/**
 * 1 本の要求を出して分類する（設計 §10.13 #89 が名指しする関数）。
 *
 * - URL は `new URL(path, THREADS_API_BASE_URL)` の解析結果から組み、クエリは `searchParams` で付ける（文字列の連結にしない）
 * - POST の本体は `URLSearchParams`（`application/x-www-form-urlencoded`）。**トークンは引数で渡し、ヘッダには載せない**
 * - **`redirect: 'manual'`**。`'error'` にすると 3xx が観測できず `network` に化ける
 * - **要求ごとの `AbortSignal.timeout` は `impl()` の直前に同期で作る**（`await` を挟まない。実装プラン §7 の 3）
 * - **例外を投げない。** 結果に URL・本体の文字列・例外の文面を持たせない
 */
export async function sendThreadsRequest(request: ThreadsRequest): Promise<ThreadsOutcome> {
  let signal: AbortSignal = request.signal;
  try {
    const url = new URL(request.path, THREADS_API_BASE_URL);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const body =
      request.form === undefined ? undefined : new URLSearchParams(request.form).toString();

    signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
    const response = await request.impl(url.href, {
      method: request.method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }),
      redirect: 'manual',
      signal,
    });

    const status = response.status;
    const parsed = parseJson(await readBoundedText(response));
    if (status >= 200 && status < 300) {
      // **成功の候補は 200 だけ**（設計 §6.5。200 以外の 2xx は「その他」）。
      return status === 200 && parsed !== NOT_JSON
        ? { kind: 'ok', status, body: parsed }
        : { kind: 'malformed', status };
    }
    return {
      kind: 'http',
      status,
      body: parsed === NOT_JSON ? undefined : parsed,
      headers: response.headers,
    };
  } catch (error) {
    return { kind: thrownKind(error, signal) };
  }
}

/* -------------------------------------------------------------------------- */
/* 要求 R1〜R6 と応答の解釈（設計 §6.3〜§6.7 / §6.9）                                */
/* -------------------------------------------------------------------------- */

/**
 * どの段階の失敗か。`retryable` と `reason` とログの `phase` はこれで決まる（設計 §6.9 / 実装プラン §8 の 4）。
 *
 * `container` = R1 / R2、`status` = R3（とその状態）、`prepare` = 準備期限・round の上限・R4 を送る残り時間の不足、
 * `publish` = R4、`permalink` = R5、`refresh` = R6。入口の検査（`input`）は `social.ts` が持つ。
 */
export type ThreadsPhase = 'container' | 'status' | 'prepare' | 'publish' | 'permalink' | 'refresh';

export type ThreadsFailureKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  /** 2xx だが本体が読めない・要る項目が無い・形に合わない・200 以外の 2xx。 */
  | 'shape'
  /** container の状態が `FINISHED` / `IN_PROGRESS` 以外。 */
  | 'state'
  /** 準備の期限・round の上限・R4 を送るだけの残り時間が無い。 */
  | 'budget';

/** container の状態のうち、`reason` に出してよい既知の値。知らない値は `unknown`。 */
export type ContainerState = 'ERROR' | 'EXPIRED' | 'PUBLISHED' | 'unknown';

export interface ThreadsFailure {
  readonly phase: ThreadsPhase;
  readonly kind: ThreadsFailureKind;
  readonly status?: number;
  readonly errorClass?: ThreadsErrorClass;
  /** `reason` に出す `code`（既知の数値か `unknown`）。エラーの本体に `code` が無ければ持たない。 */
  readonly code?: string;
  /** `reason` に出す `error_subcode`（既知の数値か `unknown`）。 */
  readonly subcode?: string;
  /** ログにだけ出す。 */
  readonly fbtraceId?: string;
  readonly state?: ContainerState;
  /** 準備期限・round の上限で諦めたときの、ポーリングの round 数（ログにだけ出す）。 */
  readonly round?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type ThreadsResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ThreadsFailure };

function failure(value: ThreadsFailure): ThreadsResult<never> {
  return { ok: false, failure: value };
}

function versioned(...segments: readonly string[]): string {
  return `/${[THREADS_API_VERSION, ...segments].join('/')}`;
}

/**
 * 失敗の `retryable`（設計 §6.9 の支配的な規則）。
 *
 * 1. **R4 を送る前は既定で `true`。** ただし時間が経っても直らないもの（`token` / `permission` / `rejected`・
 *    その他の 4xx・3xx・状態 `ERROR` / `PUBLISHED`）は、**5xx で返っても** `false`
 * 2. **R4（`publish`）は既定で `false`。** レート制限（書き込む前に断られたと読める）だけ `true`
 *
 * R5 / R6 の失敗は `ok: true` を覆さないので、ここで決まる値は使われない。
 */
export function retryableFor(
  phase: ThreadsPhase,
  kind: ThreadsFailureKind,
  status?: number,
  errorClass?: ThreadsErrorClass,
  state?: ContainerState,
): boolean {
  // 準備の期限・round の上限・R4 を送るだけの残り時間の不足は、どれも R4 を送る前に諦めている（P3）。
  if (kind === 'budget') {
    return true;
  }
  const redirected = status !== undefined && status >= 300 && status < 400;

  if (phase === 'publish') {
    // **送った後は既定で false。** 届いたか分からない。SNS の投稿は取り消せない（P4）。
    // `transient` も true にしない（「もう一度送れば通るかも」は「今回は公開されていない」を言っていない）。
    return kind === 'http' && !redirected && errorClass === 'rateLimit';
  }

  // ここから先は R4 を送る前（P1 / P2 / P3）。既定で true、直らないものだけ false。
  if (kind === 'state') {
    // ERROR は画像の問題。PUBLISHED はまだ送っていないのに公開済みと言われている（迷ったら false）。
    return state === 'EXPIRED' || state === 'unknown';
  }
  if (kind !== 'http') {
    // 接続できない・制限時間・打ち切り・応答が読めない。公開の要求をまだ出していない。
    return true;
  }
  if (redirected) {
    return false;
  }
  if (errorClass === 'token' || errorClass === 'permission' || errorClass === 'rejected') {
    return false;
  }
  if (errorClass === 'rateLimit' || errorClass === 'transient') {
    return true;
  }
  // 5xx はまだ何も作られていない。その他の 4xx は投稿の内容の問題（人が直す）。
  return status !== undefined && status >= 500;
}

function transportFailure(
  phase: ThreadsPhase,
  kind: 'network' | 'timeout' | 'aborted' | 'shape',
  status?: number,
): ThreadsResult<never> {
  return failure({
    phase,
    kind,
    ...(status === undefined ? {} : { status }),
    retryable: retryableFor(phase, kind, status),
  });
}

/** 2xx 以外の応答を失敗にする。本体から読むのは数値の `code` / `error_subcode` と `is_transient` だけ。 */
function httpFailure(
  phase: ThreadsPhase,
  outcome: Extract<ThreadsOutcome, { kind: 'http' }>,
): ThreadsResult<never> {
  const errorClass = classifyThreadsError(outcome.status, outcome.body);
  const error = errorObjectOf(outcome.body);
  const { fbtraceId } = readThreadsError(outcome.body);
  const retryable = retryableFor(phase, 'http', outcome.status, errorClass);
  // レート制限で再試行するときだけ `Retry-After` を読む（5xx に付いていても読まない）。
  const retryAfterMs =
    retryable && errorClass === 'rateLimit' ? retryAfterMsFrom(outcome.headers) : undefined;
  return failure({
    phase,
    kind: 'http',
    status: outcome.status,
    errorClass,
    ...(error !== undefined && 'code' in error ? { code: describeThreadsCode(error['code']) } : {}),
    ...(error !== undefined && 'error_subcode' in error
      ? { subcode: describeThreadsSubcode(error['error_subcode']) }
      : {}),
    ...(fbtraceId === undefined ? {} : { fbtraceId }),
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** `ok` 以外の結果を失敗にする。 */
function notOk(phase: ThreadsPhase, outcome: ThreadsOutcome): ThreadsResult<never> {
  switch (outcome.kind) {
    case 'http':
      return httpFailure(phase, outcome);
    case 'malformed':
    case 'ok':
      return transportFailure(phase, 'shape', outcome.status);
    default:
      return transportFailure(phase, outcome.kind);
  }
}

/** 1 回の配信のあいだ変わらない、要求の宛先と認証。 */
export interface ThreadsAuth {
  readonly impl: FetchImpl;
  readonly threadsUserId: string;
  readonly accessToken: string;
}

/**
 * R1 / R2：container を作る。応答の `id` が形に合わなければ失敗（P1 の `true`。**次の要求を出していない**）。
 * 外から来た ID をそのまま次の要求のパスへ差し込まない（設計 §6.2）。
 */
async function createContainer(
  auth: ThreadsAuth,
  form: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<ThreadsResult<string>> {
  const outcome = await sendThreadsRequest({
    impl: auth.impl,
    method: 'POST',
    path: versioned(auth.threadsUserId, 'threads'),
    form: { ...form, access_token: auth.accessToken },
    timeoutMs: CREATE_CONTAINER_TIMEOUT_MS,
    signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('container', outcome);
  }
  const id: unknown = isRecord(outcome.body) ? outcome.body['id'] : undefined;
  if (!isValidThreadsId(id)) {
    // container ができていても、R4 を送らない限り公開されない（設計 §6.9 の P1）。
    return transportFailure('container', 'shape', outcome.status);
  }
  return { ok: true, value: id };
}

/** `alt_text` は空でない文字列のときだけ送る（キーごと付けない。設計 §6.3）。 */
function altTextOf(alt: unknown): Record<string, string> {
  return typeof alt === 'string' && alt !== '' ? { alt_text: alt } : {};
}

/** R1：テキストだけの container（`media_type=TEXT`）。**`link_attachment` を送らない**（設計 §3.2）。 */
export async function createTextContainer(
  auth: ThreadsAuth,
  params: { readonly text: string; readonly signal: AbortSignal },
): Promise<ThreadsResult<string>> {
  return await createContainer(auth, { media_type: 'TEXT', text: params.text }, params.signal);
}

/**
 * R1：画像の container（`media_type=IMAGE`）。
 *
 * 単体は `text` を持ち、carousel の子は `is_carousel_item=true` を持って `text` を持たない（設計 §6.3）。
 * **Meta が `image_url` を取りに行く。** Torifune から媒体の URL へ要求は出さない。
 */
export async function createImageContainer(
  auth: ThreadsAuth,
  params: {
    readonly imageUrl: string;
    readonly alt: unknown;
    /** 単体のときだけ。carousel の子は `undefined`。 */
    readonly text?: string;
    readonly signal: AbortSignal;
  },
): Promise<ThreadsResult<string>> {
  const form: Record<string, string> =
    params.text === undefined
      ? { media_type: 'IMAGE', image_url: params.imageUrl, is_carousel_item: 'true' }
      : { media_type: 'IMAGE', image_url: params.imageUrl, text: params.text };
  return await createContainer(auth, { ...form, ...altTextOf(params.alt) }, params.signal);
}

/** R2：carousel の親 container。`children` は **`media` の添字の順**のカンマ連結（設計 §6.3）。 */
export async function createCarouselContainer(
  auth: ThreadsAuth,
  params: {
    readonly children: readonly string[];
    readonly text: string;
    readonly signal: AbortSignal;
  },
): Promise<ThreadsResult<string>> {
  return await createContainer(
    auth,
    { media_type: 'CAROUSEL', children: params.children.join(','), text: params.text },
    params.signal,
  );
}

/** 公開してよいか、まだ処理中か。 */
export type ContainerProgress = 'FINISHED' | 'IN_PROGRESS';

const FAILED_STATES: ReadonlySet<string> = new Set(['ERROR', 'EXPIRED', 'PUBLISHED']);

/**
 * R3：container の状態を読む（設計 §6.4）。
 *
 * **取るのは `status` だけ。** `error_message`（自由文）は要求しない（`fields=status`）。
 */
export async function readContainerStatus(
  auth: ThreadsAuth,
  params: { readonly containerId: string; readonly signal: AbortSignal },
): Promise<ThreadsResult<ContainerProgress>> {
  const outcome = await sendThreadsRequest({
    impl: auth.impl,
    method: 'GET',
    path: versioned(params.containerId),
    query: { fields: 'status', access_token: auth.accessToken },
    timeoutMs: STATUS_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('status', outcome);
  }
  const value: unknown = isRecord(outcome.body) ? outcome.body['status'] : undefined;
  if (value === 'FINISHED' || value === 'IN_PROGRESS') {
    return { ok: true, value };
  }
  const state: ContainerState =
    typeof value === 'string' && FAILED_STATES.has(value) ? (value as ContainerState) : 'unknown';
  return failure({
    phase: 'status',
    kind: 'state',
    state,
    retryable: retryableFor('status', 'state', undefined, undefined, state),
  });
}

/** 準備の期限・round の上限・R4 の残り時間の不足（`kind: 'budget'`。P3 の `true`）。 */
export function budgetFailure(round?: number): ThreadsFailure {
  return {
    phase: 'prepare',
    kind: 'budget',
    ...(round === undefined ? {} : { round }),
    retryable: retryableFor('prepare', 'budget'),
  };
}

/**
 * R4：公開する。**ここが「送る」**（設計 §6.5）。
 *
 * 応答の `id` が無い（`null` を含む）・JSON でない → 失敗（公開されたか分からない。`false`）。
 * `id` があって形に合わない → **失敗にしない**（`mediaId: undefined`）。200 と `id` が返った以上、公開されている。
 */
export async function publishContainer(
  auth: ThreadsAuth,
  params: { readonly creationId: string; readonly signal: AbortSignal },
): Promise<ThreadsResult<{ readonly mediaId: string | undefined }>> {
  const outcome = await sendThreadsRequest({
    impl: auth.impl,
    method: 'POST',
    path: versioned(auth.threadsUserId, 'threads_publish'),
    form: { creation_id: params.creationId, access_token: auth.accessToken },
    timeoutMs: PUBLISH_REQUEST_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('publish', outcome);
  }
  const id: unknown = isRecord(outcome.body) ? outcome.body['id'] : undefined;
  if (id === undefined || id === null) {
    return transportFailure('publish', 'shape', outcome.status);
  }
  return { ok: true, value: { mediaId: isValidThreadsId(id) ? id : undefined } };
}

/** R5：投稿の URL。`isAcceptablePermalink` に通らなければ `undefined`（設計 §6.6）。 */
export async function readPermalink(
  auth: ThreadsAuth,
  params: { readonly mediaId: string; readonly signal: AbortSignal },
): Promise<ThreadsResult<string | undefined>> {
  const outcome = await sendThreadsRequest({
    impl: auth.impl,
    method: 'GET',
    path: versioned(params.mediaId),
    query: { fields: 'permalink', access_token: auth.accessToken },
    timeoutMs: PERMALINK_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('permalink', outcome);
  }
  const permalink: unknown = isRecord(outcome.body) ? outcome.body['permalink'] : undefined;
  return { ok: true, value: isAcceptablePermalink(permalink) ? permalink : undefined };
}

/**
 * R6：トークンを延長する（設計 §6.7）。
 *
 * **版の付かないパス**で、トークンは**クエリ**に入る（公式の文書の形。`client_secret` は要らない）。
 * **この URL をログにも `reason` にも渡さない。** 結果にも URL を持たせない。
 * 値の形の検査は呼び出し側（`token.ts`）が行う。
 */
export async function refreshAccessToken(
  auth: ThreadsAuth,
  params: { readonly signal: AbortSignal },
): Promise<ThreadsResult<{ readonly accessToken: unknown; readonly expiresIn: unknown }>> {
  const outcome = await sendThreadsRequest({
    impl: auth.impl,
    method: 'GET',
    path: '/refresh_access_token',
    query: { grant_type: 'th_refresh_token', access_token: auth.accessToken },
    timeoutMs: REFRESH_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('refresh', outcome);
  }
  const body = isRecord(outcome.body) ? outcome.body : {};
  return { ok: true, value: { accessToken: body['access_token'], expiresIn: body['expires_in'] } };
}
