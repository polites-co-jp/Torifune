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
