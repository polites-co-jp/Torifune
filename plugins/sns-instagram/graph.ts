/**
 * Instagram Graph API（Instagram ログイン版）への要求と、応答の分類（038-sns-instagram 設計 §6）。
 *
 * **この Plugin が外へ出す HTTP はここに集める。** 宛先・版・制限時間の定数、
 * エラーの分類、`reason` に出してよい数値の集合も、すべてこのファイルの 1 か所に置く。
 * 文言の組み立てと `PublishResult` への変換は `social.ts` が持つ。
 */

/* -------------------------------------------------------------------------- */
/* 宛先と版（設計 §6.1）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 宛先。**定数であり、設定にも資格情報にも入れない**（設計 §5.3）。
 *
 * 変えられるようにすると、アクセストークンを任意のサーバへ送らせる口が 1 つ増えるだけになる。
 * Facebook ログイン版の宛先はトークンの延長に App Secret が要るので使わない（設計 §3.2）。
 */
export const GRAPH_API_BASE_URL = 'https://graph.instagram.com';

/**
 * Graph API の版。
 *
 * 実装時点（2026-09-23）の最新の安定版。Meta の Graph API の変更履歴
 * （https://developers.facebook.com/docs/graph-api/changelog）で、v26.0 が
 * 2026-07-29 公開の最新版として載っていることを確かめた。Instagram プラットフォームの
 * 文書は要求の例に `<LATEST_API_VERSION>` と書き、Graph API と同じ版の系列を使う。
 *
 * Graph API の版はおよそ 2 年で廃止される。**版の更新はこの Plugin の更新で行う**（設計 §6.1）。
 * 値を変えたら `README.md` の記載も合わせる。
 */
export const GRAPH_API_VERSION = 'v26.0';

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

/** 公開の要求（`media_publish`）1 本の制限時間。 */
export const MEDIA_PUBLISH_TIMEOUT_MS = 10_000;

/**
 * 準備（container の作成・状態の確認・待ち）に使ってよい時間。
 *
 * 公開の要求に要る時間を合計から先に取り分けた残り。**準備が長引いても公開の要求は途中で切られない。**
 */
export const PREPARE_BUDGET_MS = PUBLISH_TOTAL_BUDGET_MS - MEDIA_PUBLISH_TIMEOUT_MS;

/** container の作成（単体・carousel の子・carousel の親）1 本の制限時間。 */
export const CREATE_CONTAINER_TIMEOUT_MS = 10_000;

/** container の状態の確認 1 本の制限時間。 */
export const STATUS_TIMEOUT_MS = 5_000;

/** 状態の確認の round のあいだの待ち。 */
export const POLL_INTERVAL_MS = 1_000;

/** 状態の確認の round の上限。**上限は回数と準備の期限の早いほう。** */
export const POLL_MAX_ROUNDS = 10;

/** 公開した投稿の URL（permalink）の問い合わせ 1 本の制限時間。 */
export const PERMALINK_TIMEOUT_MS = 3_000;

/** トークンの延長 1 本の制限時間。 */
export const REFRESH_TIMEOUT_MS = 3_000;

/** carousel の子の作成と状態の確認を同時に飛ばす本数の上限。 */
export const CAROUSEL_CHILD_CONCURRENCY = 5;

/* -------------------------------------------------------------------------- */
/* エラーの分類（設計 §6.9）                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Graph API のエラーの分類。
 *
 * 応答の本体（`{ "error": { … } }`）から読むのは**数値の `code`・`error_subcode` と
 * 真偽値の `is_transient` だけ**。自由文（`message` など）は読まない。
 */
export type GraphErrorClass =
  'rateLimit' | 'token' | 'permission' | 'dailyLimit' | 'transient' | 'other';

/** レート制限を表す `code`。 */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613]);

/** トークンが無効・期限切れを表す `code`。 */
const TOKEN_CODE = 190;

/** 権限の不足を表す `code`（10 と 200〜299）。 */
const PERMISSION_CODE = 10;
const PERMISSION_CODE_MIN = 200;
const PERMISSION_CODE_MAX = 299;

/** 24 時間あたりの公開数の上限に達したことを表す `error_subcode`。 */
export const DAILY_LIMIT_SUBCODE = 2207042;

/** 応答の本体から読んだ、分類に使う値。**数値でないものは無かったことにする。** */
export interface GraphErrorFields {
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

/** 応答の本体（`JSON.parse` の結果。何でもありうる）から、分類に使う値だけを取り出す。 */
export function readGraphError(body: unknown): GraphErrorFields {
  const error = isRecord(body) ? body['error'] : undefined;
  if (!isRecord(error)) {
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
 * 失敗した応答を分類する（設計 §6.9 の分類表）。
 *
 * **判定の順は「直らない側」が先。** `dailyLimit`・`token`・`permission` を
 * `rateLimit`・`transient` より先に見る。2 つに当たる応答（`code: 4` かつ subcode 2207042 など）は
 * 再試行しない側へ倒す（迷ったら再試行しない。実装プラン §8 の 9）。
 */
export function classifyGraphError(status: number, body: unknown): GraphErrorClass {
  const { code, subcode, isTransient } = readGraphError(body);

  if (subcode === DAILY_LIMIT_SUBCODE) {
    return 'dailyLimit';
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
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return 'rateLimit';
  }
  if (isTransient) {
    return 'transient';
  }
  return 'other';
}

/* -------------------------------------------------------------------------- */
/* reason に出してよい数値（設計 §6.11）                                          */
/* -------------------------------------------------------------------------- */

/** 知らない値の代わりに `reason` へ出す綴り。 */
export const UNKNOWN_GRAPH_ERROR = 'unknown';

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/**
 * `reason` とログに出してよい `code`（設計 §6.11 の集合そのまま）。
 *
 * **数値でも知らない値は出さない。** 集合に無ければ `unknown` と書く。
 */
export const KNOWN_GRAPH_ERROR_CODES: ReadonlySet<number> = new Set([
  1,
  2,
  4,
  9,
  10,
  17,
  24,
  25,
  32,
  100,
  190,
  ...range(200, 299),
  368,
  613,
]);

/**
 * `reason` とログに出してよい `error_subcode`（設計 §11 #11。実装時に固定した値）。
 *
 * 出典は Meta の公開している次の 2 つの表（2026-09-23 に参照）：
 *
 * - Instagram プラットフォームのエラーコード表
 *   （https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes）。
 *   **Content Publishing の 2207xxx 系**を全件。動画・商品タグ・サムネイルなど、
 *   この Plugin が送らない引数に関わるものも含めた（数値であり、出して困るものではない）
 * - Graph API のエラー処理の文書
 *   （https://developers.facebook.com/docs/graph-api/guides/error-handling）の
 *   **認証エラーの subcode**（458 / 459 / 460 / 463 / 464 / 467 / 492）
 *
 * 集合に無い値は `unknown` になるので、集合が小さくても安全側（出さない側）に倒れる。
 */
export const KNOWN_GRAPH_ERROR_SUBCODES: ReadonlySet<number> = new Set([
  // 認証（トークン）
  458, 459, 460, 463, 464, 467, 492,
  // Content Publishing
  2207001, 2207003, 2207004, 2207005, 2207006, 2207008, 2207009, 2207010, 2207020, 2207023, 2207026,
  2207027, 2207028, 2207032, 2207035, 2207036, 2207037, 2207040, 2207042, 2207050, 2207051, 2207052,
  2207053, 2207057,
]);

function describeKnown(value: unknown, known: ReadonlySet<number>): string {
  return typeof value === 'number' && Number.isInteger(value) && known.has(value)
    ? String(value)
    : UNKNOWN_GRAPH_ERROR;
}

/** `reason` に書く `code`。既知の数値ならその数字、それ以外は `unknown`。 */
export function describeGraphCode(value: unknown): string {
  return describeKnown(value, KNOWN_GRAPH_ERROR_CODES);
}

/** `reason` に書く `error_subcode`。既知の数値ならその数字、それ以外は `unknown`。 */
export function describeGraphSubcode(value: unknown): string {
  return describeKnown(value, KNOWN_GRAPH_ERROR_SUBCODES);
}

/* -------------------------------------------------------------------------- */
/* retryAfterMs（設計 §6.10）                                                    */
/* -------------------------------------------------------------------------- */

/** これより長いヘッダは読まない。 */
const HEADER_MAX_LENGTH = 4096;

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

function boundedHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null || value.length > HEADER_MAX_LENGTH ? undefined : value;
}

/** `Retry-After`（秒の整数）。 */
function fromRetryAfter(headers: Headers): number | undefined {
  const value = boundedHeader(headers, 'retry-after')?.trim();
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * SECOND_MS : undefined;
}

/** `X-Business-Use-Case-Usage`（JSON）の `estimated_time_to_regain_access`（分）の最大値。 */
function fromBusinessUseCaseUsage(headers: Headers): number | undefined {
  const value = boundedHeader(headers, 'x-business-use-case-usage');
  if (value === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  let maximum: number | undefined;
  for (const entries of Object.values(parsed)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        continue;
      }
      const minutes = entry['estimated_time_to_regain_access'];
      if (typeof minutes === 'number' && Number.isFinite(minutes)) {
        maximum = maximum === undefined ? minutes : Math.max(maximum, minutes);
      }
    }
  }
  return maximum !== undefined && maximum > 0 ? maximum * MINUTE_MS : undefined;
}

/**
 * レート制限の応答から、次に試すまでの待ち（ms）を読む。
 *
 * `Retry-After` → `X-Business-Use-Case-Usage` の順に見て、最初に取れたものを使う。
 * 取れなければ `undefined`（Core の既定の間隔に任せる）。**24 時間で切り詰めるのは Core**。
 * ヘッダの値はここで数値にするだけで、`reason` にもログにも載せない。
 */
export function retryAfterMsFrom(headers: Headers): number | undefined {
  return fromRetryAfter(headers) ?? fromBusinessUseCaseUsage(headers);
}

/* -------------------------------------------------------------------------- */
/* 外から来た文字列の形（設計 §6.2 / §6.5 / §6.6 / §6.11）                          */
/* -------------------------------------------------------------------------- */

/** Graph API が返す container ID / media ID の形。次の要求のパスに入る。 */
const GRAPH_ID_PATTERN = /^[0-9]{1,64}$/;

/** `social_posts.external_url` の CHECK に合わせた上限。 */
const PERMALINK_MAX_LENGTH = 2048;

/** 投稿の URL として受け付けるホスト。 */
const PERMALINK_HOST = 'instagram.com';

const FBTRACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Graph API が返した ID が、パスに入れてよく `externalId` に収まる形か。 */
export function isValidGraphId(value: unknown): value is string {
  return typeof value === 'string' && GRAPH_ID_PATTERN.test(value);
}

/**
 * `permalink` を `externalUrl` に載せてよいか。
 *
 * `https:`・`username` / `password` を含まない・ホストが `instagram.com` か `.instagram.com` で終わる・
 * 2048 文字以内。1 つでも外れたら載せない（設計 §6.6）。
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
  return host === PERMALINK_HOST || host.endsWith(`.${PERMALINK_HOST}`);
}

/** `fbtrace_id` をログに渡してよい形か。**`reason` には形に合っても載せない。** */
export function isValidFbtraceId(value: unknown): value is string {
  return typeof value === 'string' && FBTRACE_ID_PATTERN.test(value);
}

/* -------------------------------------------------------------------------- */
/* 外部への HTTP（設計 §6.2）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 外部への HTTP。
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

/** 応答の本体はここまでしか読まない。相手が何を返しても Plugin のメモリを食わせない。 */
export const RESPONSE_BODY_MAX_BYTES = 64 * 1024;

/**
 * 1 本の要求の結果。
 *
 * - `ok`：2xx で本体が JSON として読めた
 * - `malformed`：2xx だが本体が JSON として読めない（大きすぎるものを含む）
 * - `http`：2xx 以外（**3xx を含む**。転送は追わない）。本体は JSON として読めたときだけ持つ
 * - `network`：接続できない（`fetch` が reject）
 * - `timeout`：制限時間（`AbortSignal.timeout`）で打ち切られた
 * - `aborted`：呼び出し側が打ち切った（`input.signal`・carousel の子どうしの打ち切り）
 *
 * **要求の URL も例外の文面も持たない**（R6 の URL にはトークンが入る。設計 §6.11）。
 */
export type GraphOutcome =
  | { readonly kind: 'ok'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'malformed'; readonly status: number }
  | {
      readonly kind: 'http';
      readonly status: number;
      readonly body: unknown;
      readonly headers: Headers;
    }
  | { readonly kind: 'network' | 'timeout' | 'aborted' };

export interface GraphRequest {
  readonly impl: FetchImpl;
  readonly method: 'GET' | 'POST';
  /** 宛先のパス。**形の検査を通した値だけで組む**（設計 §6.1）。 */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** POST の本体（`application/x-www-form-urlencoded`）。 */
  readonly form?: Readonly<Record<string, string>>;
  /** `Authorization: Bearer` に載せるトークン。R6 は持たない（クエリで渡す）。 */
  readonly bearerToken?: string;
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

/** 例外を `timeout` / `aborted` / `network` に分ける。**文面は読まない。** */
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

/** 上限まで読み、超えたら `undefined`（JSON として扱わない）。 */
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
 * 1 本の要求を出して分類する（設計 §10.9 #66 が名指しする関数）。
 *
 * - URL は `new URL(path, GRAPH_API_BASE_URL)` の解析結果から組む（文字列の連結にしない）
 * - **`redirect: 'manual'`**。`'error'` にすると 3xx が観測できず `network` に化ける
 * - **要求ごとの `AbortSignal.timeout` は `impl()` の直前に同期で作る**（`await` を挟まない。実装プラン §7 の 3）
 * - **例外を投げない。**
 */
export async function sendGraphRequest(request: GraphRequest): Promise<GraphOutcome> {
  let signal: AbortSignal = request.signal;
  try {
    const url = new URL(request.path, GRAPH_API_BASE_URL);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {};
    if (request.bearerToken !== undefined) {
      headers['authorization'] = `Bearer ${request.bearerToken}`;
    }
    let body: string | undefined;
    if (request.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(request.form).toString();
    }

    signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
    const response = await request.impl(url.href, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal,
    });

    const status = response.status;
    const parsed = parseJson(await readBoundedText(response));
    if (status >= 200 && status < 300) {
      return parsed === NOT_JSON
        ? { kind: 'malformed', status }
        : { kind: 'ok', status, body: parsed };
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
 * どの段階の失敗か。`retryable` と `reason` はこれで決まる（設計 §6.9）。
 *
 * `container` = R1 / R2、`status` = R3（とその状態・準備の期限）、`publish` = R4、
 * `permalink` = R5、`refresh` = R6。
 */
export type GraphPhase = 'container' | 'status' | 'publish' | 'permalink' | 'refresh';

export type GraphFailureKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  /** 2xx だが本体が読めない・要る項目が無い・形に合わない。 */
  | 'shape'
  /** container の状態が `FINISHED` / `IN_PROGRESS` 以外。 */
  | 'state'
  /** 準備の期限・round の上限・R4 を送るだけの残り時間が無い。 */
  | 'budget';

/** container の状態のうち、`reason` に出してよい既知の値。知らない値は `unknown`。 */
export type ContainerState = 'ERROR' | 'EXPIRED' | 'PUBLISHED' | 'unknown';

export interface GraphFailure {
  readonly phase: GraphPhase;
  readonly kind: GraphFailureKind;
  readonly status?: number;
  readonly errorClass?: GraphErrorClass;
  /** `reason` に出す `code`（既知の数値か `unknown`）。エラーの本体に `code` が無ければ持たない。 */
  readonly code?: string;
  /** `reason` に出す `error_subcode`（既知の数値か `unknown`）。 */
  readonly subcode?: string;
  /** ログにだけ出す。 */
  readonly fbtraceId?: string;
  readonly state?: ContainerState;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type GraphResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: GraphFailure };

function failure(value: GraphFailure): GraphResult<never> {
  return { ok: false, failure: value };
}

function versioned(...segments: readonly string[]): string {
  return `/${[GRAPH_API_VERSION, ...segments].join('/')}`;
}

function errorObjectOf(body: unknown): Record<string, unknown> | undefined {
  const error = isRecord(body) ? body['error'] : undefined;
  return isRecord(error) ? error : undefined;
}

/**
 * 失敗の `retryable`（設計 §6.9 の支配的な規則）。
 *
 * `container` / `status`（R4 の前）は既定で `true`、直らないものだけ `false`。
 * `publish`（R4）は既定で `false`、レート制限だけ `true`。
 */
export function retryableFor(
  phase: GraphPhase,
  kind: GraphFailureKind,
  status?: number,
  errorClass?: GraphErrorClass,
  state?: ContainerState,
): boolean {
  // 準備の期限・round の上限・R4 を送るだけの残り時間の不足は、どれも R4 を送る前に諦めている（P3）。
  if (kind === 'budget') {
    return true;
  }
  const redirected = status !== undefined && status >= 300 && status < 400;

  if (phase === 'publish') {
    // **送った後は既定で false。** 届いたか分からない。SNS の投稿は取り消せない（P4）。
    // レート制限だけは書き込む前に断られたと読める。`dailyLimit` は分類で先に落ちている。
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
  if (errorClass === 'dailyLimit' || errorClass === 'token' || errorClass === 'permission') {
    return false;
  }
  if (errorClass === 'rateLimit' || errorClass === 'transient') {
    return true;
  }
  // 5xx はまだ何も作られていない。その他の 4xx は投稿の内容の問題（人が直す）。
  return status !== undefined && status >= 500;
}

function transportFailure(
  phase: GraphPhase,
  kind: 'network' | 'timeout' | 'aborted' | 'shape',
  status?: number,
): GraphResult<never> {
  return failure({
    phase,
    kind,
    ...(status === undefined ? {} : { status }),
    retryable: retryableFor(phase, kind, status),
  });
}

/** 2xx 以外の応答を失敗にする。本体から読むのは数値の `code` / `error_subcode` と `is_transient` だけ。 */
function httpFailure(
  phase: GraphPhase,
  outcome: Extract<GraphOutcome, { kind: 'http' }>,
): GraphResult<never> {
  const errorClass = classifyGraphError(outcome.status, outcome.body);
  const error = errorObjectOf(outcome.body);
  const { fbtraceId } = readGraphError(outcome.body);
  const retryable = retryableFor(phase, 'http', outcome.status, errorClass);
  const retryAfterMs =
    retryable && errorClass === 'rateLimit' ? retryAfterMsFrom(outcome.headers) : undefined;
  return failure({
    phase,
    kind: 'http',
    status: outcome.status,
    errorClass,
    ...(error !== undefined && 'code' in error ? { code: describeGraphCode(error['code']) } : {}),
    ...(error !== undefined && 'error_subcode' in error
      ? { subcode: describeGraphSubcode(error['error_subcode']) }
      : {}),
    ...(fbtraceId === undefined ? {} : { fbtraceId }),
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/** `ok` 以外の結果を失敗にする。 */
function notOk(phase: GraphPhase, outcome: GraphOutcome): GraphResult<never> {
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

interface ContainerRequestBase {
  readonly impl: FetchImpl;
  readonly igUserId: string;
  readonly accessToken: string;
  readonly signal: AbortSignal;
}

async function createContainer(
  base: ContainerRequestBase,
  form: Readonly<Record<string, string>>,
): Promise<GraphResult<string>> {
  const outcome = await sendGraphRequest({
    impl: base.impl,
    method: 'POST',
    path: versioned(base.igUserId, 'media'),
    form,
    bearerToken: base.accessToken,
    timeoutMs: CREATE_CONTAINER_TIMEOUT_MS,
    signal: base.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('container', outcome);
  }
  const id: unknown = isRecord(outcome.body) ? outcome.body['id'] : undefined;
  if (!isValidGraphId(id)) {
    // **次の要求を出していない。** container ができていても公開されない（設計 §6.9 の P1）。
    return transportFailure('container', 'shape', outcome.status);
  }
  return { ok: true, value: id };
}

/**
 * R1：画像の container を作る（単体、または carousel の子）。
 *
 * 単体は `caption` を持ち、子は `is_carousel_item=true` を持って `caption` を持たない（設計 §6.3）。
 * **`alt_text` も `video_url` も送らない**（設計 §6.12 / 画像のみ）。
 */
export async function createImageContainer(
  params: ContainerRequestBase & {
    readonly imageUrl: string;
    /** 単体のときだけ。carousel の子は `undefined`。 */
    readonly caption?: string;
  },
): Promise<GraphResult<string>> {
  const form: Record<string, string> =
    params.caption === undefined
      ? { image_url: params.imageUrl, is_carousel_item: 'true' }
      : { image_url: params.imageUrl, caption: params.caption };
  return await createContainer(params, form);
}

/** R2：carousel の親 container を作る。`children` は **`media` の添字の順**（設計 §6.3）。 */
export async function createCarouselContainer(
  params: ContainerRequestBase & {
    readonly children: readonly string[];
    readonly caption: string;
  },
): Promise<GraphResult<string>> {
  return await createContainer(params, {
    media_type: 'CAROUSEL',
    children: params.children.join(','),
    caption: params.caption,
  });
}

/** 準備が済んだか、まだ処理中か。 */
export type ContainerProgress = 'FINISHED' | 'IN_PROGRESS';

const FAILED_STATES: ReadonlySet<string> = new Set(['ERROR', 'EXPIRED', 'PUBLISHED']);

/**
 * R3：container の状態を読む（設計 §6.4）。
 *
 * **取るのは `status_code` だけ。** `status`（自由文）は要求しない（`fields=status_code`）。
 */
export async function readContainerStatus(params: {
  readonly impl: FetchImpl;
  readonly accessToken: string;
  readonly containerId: string;
  readonly signal: AbortSignal;
}): Promise<GraphResult<ContainerProgress>> {
  const outcome = await sendGraphRequest({
    impl: params.impl,
    method: 'GET',
    path: versioned(params.containerId),
    query: { fields: 'status_code' },
    bearerToken: params.accessToken,
    timeoutMs: STATUS_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('status', outcome);
  }
  const code: unknown = isRecord(outcome.body) ? outcome.body['status_code'] : undefined;
  if (code === 'FINISHED' || code === 'IN_PROGRESS') {
    return { ok: true, value: code };
  }
  const state: ContainerState =
    typeof code === 'string' && FAILED_STATES.has(code) ? (code as ContainerState) : 'unknown';
  return failure({
    phase: 'status',
    kind: 'state',
    state,
    retryable: retryableFor('status', 'state', undefined, undefined, state),
  });
}

/** 準備の期限・round の上限・R4 の残り時間の不足（`kind: 'budget'`）。 */
export function budgetFailure(phase: 'status' | 'publish'): GraphFailure {
  return { phase, kind: 'budget', retryable: retryableFor(phase, 'budget') };
}

/**
 * R4：公開する。**ここが「送る」**（設計 §6.5）。
 *
 * 応答の `id` が無い・JSON でない → 失敗（公開されたか分からない）。
 * `id` があって形に合わない → **失敗にしない**（`mediaId: undefined`）。200 を返した以上、公開されている。
 */
export async function publishContainer(
  params: ContainerRequestBase & { readonly creationId: string },
): Promise<GraphResult<{ readonly mediaId: string | undefined }>> {
  const outcome = await sendGraphRequest({
    impl: params.impl,
    method: 'POST',
    path: versioned(params.igUserId, 'media_publish'),
    form: { creation_id: params.creationId },
    bearerToken: params.accessToken,
    timeoutMs: MEDIA_PUBLISH_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('publish', outcome);
  }
  const id: unknown = isRecord(outcome.body) ? outcome.body['id'] : undefined;
  if (id === undefined || id === null) {
    return transportFailure('publish', 'shape', outcome.status);
  }
  return { ok: true, value: { mediaId: isValidGraphId(id) ? id : undefined } };
}

/** R5：投稿の URL。`isAcceptablePermalink` に通らなければ `undefined`（設計 §6.6）。 */
export async function readPermalink(params: {
  readonly impl: FetchImpl;
  readonly accessToken: string;
  readonly mediaId: string;
  readonly signal: AbortSignal;
}): Promise<GraphResult<string | undefined>> {
  const outcome = await sendGraphRequest({
    impl: params.impl,
    method: 'GET',
    path: versioned(params.mediaId),
    query: { fields: 'permalink' },
    bearerToken: params.accessToken,
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
 * **版の付かないパス**で、トークンは**クエリ**に入る（公開ドキュメントの形）。
 * **この URL をログにも `reason` にも渡さない。** 結果にも URL を持たせない。
 * 値の形の検査は呼び出し側（`token.ts`）が行う。
 */
export async function refreshAccessToken(params: {
  readonly impl: FetchImpl;
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<GraphResult<{ readonly accessToken: unknown; readonly expiresIn: unknown }>> {
  const outcome = await sendGraphRequest({
    impl: params.impl,
    method: 'GET',
    path: '/refresh_access_token',
    query: { grant_type: 'ig_refresh_token', access_token: params.accessToken },
    timeoutMs: REFRESH_TIMEOUT_MS,
    signal: params.signal,
  });
  if (outcome.kind !== 'ok') {
    return notOk('refresh', outcome);
  }
  const body = isRecord(outcome.body) ? outcome.body : {};
  return { ok: true, value: { accessToken: body['access_token'], expiresIn: body['expires_in'] } };
}
