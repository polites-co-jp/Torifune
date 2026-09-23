/**
 * X API と画像の取得への HTTP、応答の分類（037-sns-x 設計 §6）。
 *
 * **この Plugin が外へ出す HTTP はここに集める。** 宛先・制限時間の定数と応答の分類も、
 * すべてこのファイルの 1 か所に置く。文言の組み立てと `PublishResult` への変換は `social.ts` が持つ。
 *
 * 外へ出す要求は次の 3 種類だけ（設計 §6）：
 *
 * - R1 `GET <media[i].url>`：画像のバイト列を得る。**`Authorization` を付けない**
 * - R2 `POST /2/media/upload`（multipart）：画像を X へ上げる。**投稿ではない**
 * - R3 `POST /2/tweets`（JSON）：**投稿する。これが「送る」**
 *
 * **応答の本体は分類に読まない**（R2 / R3 の成功の `data` を除く）。X API の自由文は要求の値を混ぜ返すことがある（設計 §6.9）。
 */

/* -------------------------------------------------------------------------- */
/* 宛先（設計 §6.2）                                                              */
/* -------------------------------------------------------------------------- */

/**
 * X API の宛先。**定数であり、設定にも資格情報にも入れない**（設計 §5.3）。
 *
 * 変えられるようにすると、資格情報で署名した要求を任意のサーバへ送らせる口が 1 つ増えるだけになる。
 */
export const X_API_BASE_URL = 'https://api.x.com';

/** R2 の URL。**文字列の連結にせず、`URL` の解析結果から組む**（設計 §6.2）。 */
export const MEDIA_UPLOAD_URL = new URL('/2/media/upload', X_API_BASE_URL).href;

/** R3 の URL。 */
export const CREATE_TWEET_URL = new URL('/2/tweets', X_API_BASE_URL).href;

/* -------------------------------------------------------------------------- */
/* 制限時間（設計 §6.6）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `publish()` 全体に使ってよい時間。
 *
 * Core は `publish()` を 30 秒で打ち切り、**結果不明として `failed`** にする。
 * 差の 5 秒は、打ち切りを検知して結果を返すための余白。
 */
export const PUBLISH_TOTAL_BUDGET_MS = 25_000;

/** R3（投稿）1 本の制限時間。**残りがこれ以上あるときだけ R3 を始める**（設計 §6.4）。 */
export const CREATE_TWEET_TIMEOUT_MS = 10_000;

/**
 * 画像の処理（R1 / R2）に使ってよい時間の合計。
 *
 * 投稿の要求に要る時間を合計から先に取り分けた残り。**画像が長引いても R3 は途中で切られない。**
 */
export const MEDIA_BUDGET_MS = PUBLISH_TOTAL_BUDGET_MS - CREATE_TWEET_TIMEOUT_MS;

/** R1（画像の取得）1 本の制限時間。 */
export const MEDIA_FETCH_TIMEOUT_MS = 10_000;

/** R2（画像のアップロード）1 本の制限時間。 */
export const MEDIA_UPLOAD_TIMEOUT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* 画像の枠（設計 §6.5）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 画像の上限（バイト）。X の画像の上限（5 MB）に揃える。
 *
 * 先に `Content-Length` を見て、無ければ読みながら打ち切る。
 */
export const MEDIA_MAX_BYTES = 5_000_000;

/**
 * 受け付ける画像の種別。**GIF を入れない**（アニメーション GIF は別枠で処理待ちがある。設計 §11 #4）。
 *
 * 知らない値を素通しする口は作らない。ここで丸めた値だけを R2 へ送る。
 */
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** R2 / R3 の応答の本体はここまでしか読まない。相手が何を返しても Plugin のメモリを食わせない。 */
export const RESPONSE_BODY_MAX_BYTES = 64 * 1024;

/* -------------------------------------------------------------------------- */
/* 外から来た文字列の形（設計 §6.5 / §6.7 / §6.9 / §9.7）                         */
/* -------------------------------------------------------------------------- */

/** X の ID（投稿・媒体）。64 ビットの整数を 10 進で書いたもの（最大 20 桁）。 */
const X_ID_PATTERN = /^[0-9]{1,20}$/;

/**
 * 資格情報の 1 値の形。空白・制御文字・非 ASCII を含まない 256 文字以内。
 *
 * 値は署名の鍵とヘッダに入る。改行を含む値ではヘッダが作れず、要求が同期で投げて接続の失敗に化けるので、
 * 入口で止める（設計 §6.9）。
 */
const CREDENTIAL_VALUE_PATTERN = /^[\x21-\x7E]{1,256}$/;

/** `x-rate-limit-reset` をこれより長ければ読まない。 */
const RATE_LIMIT_RESET_MAX_LENGTH = 64;

/** X が返した ID が、次の要求の本体や `externalId` / `externalUrl` に載せてよい形か。 */
export function isValidXId(value: unknown): value is string {
  return typeof value === 'string' && X_ID_PATTERN.test(value);
}

/** 資格情報の 1 値が、署名とヘッダに使ってよい形か。 */
export function isValidCredentialValue(value: unknown): value is string {
  return typeof value === 'string' && CREDENTIAL_VALUE_PATTERN.test(value);
}

/**
 * 429 の `x-rate-limit-reset`（UNIX 秒）から、次に試すまでの待ち（ms）を出す（設計 §9.7）。
 *
 * ヘッダが無い・64 文字を超える・整数でない・結果が 0 以下なら `undefined`（Core の既定の間隔に任せる）。
 * **24 時間で切り詰めるのは Core**。Plugin 側で丸めない。**ヘッダの値は計算にだけ使い、外へ出さない。**
 */
export function retryAfterMsFrom(headers: Headers, nowMs: number): number | undefined {
  const raw = headers.get('x-rate-limit-reset');
  if (raw === null || raw.length > RATE_LIMIT_RESET_MAX_LENGTH || !/^[0-9]+$/.test(raw)) {
    return undefined;
  }
  const waitMs = Number(raw) * 1000 - nowMs;
  return Number.isFinite(waitMs) && waitMs > 0 ? waitMs : undefined;
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

/**
 * 1 本の要求の結果。
 *
 * - `response`：応答が返った（**3xx を含む**。転送は追わない）。本体はまだ読んでいない。
 *   `signal` はこの要求に渡したもの（本体の読み込みの失敗を分類するのに使う）
 * - `network`：接続できない（要求が reject）
 * - `timeout`：制限時間（`AbortSignal.timeout`）で打ち切られた
 * - `aborted`：呼び出し側が打ち切った（`input.signal`）
 *
 * **要求の URL も例外の文面も持たない**（設計 §6.9）。
 */
export type XRequestOutcome =
  | { readonly kind: 'response'; readonly response: Response; readonly signal: AbortSignal }
  | { readonly kind: 'network' | 'timeout' | 'aborted' };

export interface XRequest {
  readonly impl: FetchImpl;
  readonly url: string;
  /** `redirect` と `signal` はこの関数が決める（渡しても上書きする）。 */
  readonly init: RequestInit;
  /** この要求 1 本の制限時間。 */
  readonly timeoutMs: number;
  /** 外側の signal（`input.signal`・合計の期限・画像の期限を混ぜたもの）。 */
  readonly parentSignal: AbortSignal;
}

function errorNameOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null
    ? (value as { readonly name?: unknown }).name
    : undefined;
}

/**
 * 例外を `timeout` / `aborted` / `network` に分ける。**文面は読まない。**
 *
 * 本物の要求は signal の発火で `signal.reason` そのもので reject する（`AbortSignal.timeout` なら `TimeoutError`、
 * `abort()` なら `AbortError`。設計 §10.9 の #56 が実測で固定している）。
 */
export function thrownKind(error: unknown, signal: AbortSignal): 'network' | 'timeout' | 'aborted' {
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
 * 1 本の要求を出して分類する（設計 §10.9 #55 が名指しする関数）。
 *
 * - **`redirect: 'manual'`**。`'error'` にすると 3xx が観測できず `network` に化ける（036 R-1）
 * - **要求ごとの `AbortSignal.timeout` は `impl()` の直前に同期で作る**（`await` を挟まない。実装プラン §7 の 3）
 * - **例外を投げない。**
 */
export async function sendXRequest(request: XRequest): Promise<XRequestOutcome> {
  let signal: AbortSignal = request.parentSignal;
  try {
    signal = AbortSignal.any([request.parentSignal, AbortSignal.timeout(request.timeoutMs)]);
    const response = await request.impl(request.url, {
      ...request.init,
      redirect: 'manual',
      signal,
    });
    return { kind: 'response', response, signal };
  } catch (error) {
    return { kind: thrownKind(error, signal) };
  }
}

/* -------------------------------------------------------------------------- */
/* 本体の読み込み                                                                */
/* -------------------------------------------------------------------------- */

type BoundedRead =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly tooLarge: true }
  | { readonly ok: false; readonly tooLarge: false; readonly error: unknown };

/**
 * 本体を `limit` バイトまで読む。超えたらそこで読むのをやめて stream を cancel する
 * （`Content-Length` が無くても効く。設計 §6.5）。
 *
 * **ヘッダの後に signal が発火すると、本物の要求は本体の読み込みも reject する**（設計 §6.8 の注記）。
 * その例外は `tooLarge: false` の失敗として返し、呼ぶ側が signal と合わせて分類する。
 */
async function readBounded(response: Response, limit: number): Promise<BoundedRead> {
  const body = response.body;
  if (body === null) {
    // 本体の無い応答（204 など）。空の本体として扱う（R2 / R3 では「`data.id` が無い」に落ちる）。
    // **テストで到達を確かめた分岐ではない**（偽物も本物も、テストの応答は本体を持つ）。
    return { ok: true, bytes: new Uint8Array(0) };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > limit) {
        // cancel の失敗は握る（上限を超えた判定は変わらない）。**握る側はテストで到達を確かめていない。**
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false, tooLarge: false, error };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

const NOT_JSON: unique symbol = Symbol('not-json');

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return NOT_JSON;
  }
}

/**
 * 読まない本体を捨てる。**status だけで分類する**ので中身は要らない（設計 §6.9）。
 * 捨てるのに失敗しても分類は変わらないので、結果を待たない（失敗を握る側はテストで到達を確かめていない）。
 */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 本体の `data`（オブジェクトのときだけ）。 */
function dataOf(body: unknown): Record<string, unknown> | undefined {
  const data = isRecord(body) ? body['data'] : undefined;
  return isRecord(data) ? data : undefined;
}

/* -------------------------------------------------------------------------- */
/* 失敗の形と retryable（設計 §6.8）                                               */
/* -------------------------------------------------------------------------- */

/**
 * どの段階の失敗か（実装プラン §8 の 6）。
 *
 * `media` = R1（と画像の合計時間）、`upload` = R2、`prepare` = R3 を送る前の残り時間、`create` = R3。
 * 入口（`input`）の失敗は外へ出る前なので `social.ts` が扱う。
 */
export type XPhase = 'media' | 'upload' | 'prepare' | 'create';

export type XFailureKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  /** 2xx 以外（3xx を含む）。 */
  | 'http'
  /** R1 の種別が既知の画像でない。 */
  | 'contentType'
  /** R1 が上限（5 MB）を超えた。 */
  | 'tooLarge'
  /** 2xx だが本体が読めない・要る項目が無い・形に合わない。 */
  | 'shape'
  /** R2 の `processing_info.state` が `succeeded` 以外。 */
  | 'processing'
  /** 画像の合計時間・R3 を送るだけの残り時間が無い。 */
  | 'budget';

export interface XFailure {
  readonly phase: XPhase;
  readonly kind: XFailureKind;
  /**
   * R2 / R3 の HTTP の status（送り先は固定の宛先で、運用者が資格情報を直すための情報）。
   * **R1 の失敗は持たない**（取得先の status を外へ出さない。設計 §6.5）。
   */
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type XResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: XFailure };

function failed(failure: XFailure): XResult<never> {
  return { ok: false, failure };
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** 期限が足りない（`kind: 'budget'`）。**どれも R3 を送る前に諦めている**ので `true`（設計 §6.8 の P1 / P3）。 */
export function budgetFailure(phase: 'media' | 'prepare'): XFailure {
  return { phase, kind: 'budget', retryable: true };
}

/* -------------------------------------------------------------------------- */
/* R1：画像の取得（設計 §6.5）                                                    */
/* -------------------------------------------------------------------------- */

export interface FetchedImage {
  /** 画像のバイト列（上限以内）。 */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** 丸めた既知の種別。**取得先の応答ヘッダそのものではない。** */
  readonly type: string;
}

/**
 * 応答の `Content-Type` を既知の画像へ丸める。知らない値なら `undefined`。
 *
 * `; charset=…` のような引数は落とし、大文字小文字と前後の空白を均す。
 */
function imageTypeOf(header: string | null): string | undefined {
  const essence = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_IMAGE_TYPES.has(essence) ? essence : undefined;
}

/** `Content-Length` が上限を超えていると宣言しているか。無い・読めない値は「宣言していない」。 */
function declaresTooLarge(headers: Headers): boolean {
  const raw = headers.get('content-length')?.trim();
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    return false;
  }
  return Number(raw) > MEDIA_MAX_BYTES;
}

/**
 * R1：画像を取りに行く。
 *
 * **`media[].url` は `social.write` を持つ誰かが書いた値である。** `Authorization` を付けず、転送を追わず、
 * 種別と大きさを絞る。**失敗に HTTP の status を持たせない**（`retryable` の判断にだけ使う。設計 §6.5 / 036 中-1）。
 */
export async function fetchImage(params: {
  readonly impl: FetchImpl;
  readonly url: string;
  readonly signal: AbortSignal;
}): Promise<XResult<FetchedImage>> {
  const sent = await sendXRequest({
    impl: params.impl,
    url: params.url,
    init: { method: 'GET' },
    timeoutMs: MEDIA_FETCH_TIMEOUT_MS,
    parentSignal: params.signal,
  });
  if (sent.kind !== 'response') {
    // 投稿は作られていない。
    return failed({ phase: 'media', kind: sent.kind, retryable: true });
  }

  const { response } = sent;
  if (!isSuccess(response.status)) {
    discardBody(response);
    // 3xx・4xx は人が `media[].url` を直す。5xx はまだ何も作られていない。
    return failed({ phase: 'media', kind: 'http', retryable: response.status >= 500 });
  }

  const type = imageTypeOf(response.headers.get('content-type'));
  if (type === undefined) {
    discardBody(response);
    return failed({ phase: 'media', kind: 'contentType', retryable: false });
  }
  if (declaresTooLarge(response.headers)) {
    discardBody(response);
    return failed({ phase: 'media', kind: 'tooLarge', retryable: false });
  }

  // 本体の途中で打ち切られた（制限時間など）ときは `true`（投稿は作られていない）。この分岐はテストで到達を確かめていない。
  const read = await readBounded(response, MEDIA_MAX_BYTES);
  if (!read.ok) {
    return read.tooLarge
      ? failed({ phase: 'media', kind: 'tooLarge', retryable: false })
      : failed({ phase: 'media', kind: thrownKind(read.error, sent.signal), retryable: true });
  }
  return { ok: true, value: { bytes: read.bytes, type } };
}

/* -------------------------------------------------------------------------- */
/* R2：画像のアップロード（設計 §6.5）                                              */
/* -------------------------------------------------------------------------- */

/**
 * R2 の 2xx 以外の `retryable`（設計 §6.8 の P2）。**媒体は投稿ではない**ので、一時的なものは `true`。
 */
function uploadRetryable(status: number): boolean {
  if (status === 429) {
    return true;
  }
  if (isRedirect(status) || status === 401 || status === 403) {
    return false;
  }
  return status >= 500;
}

/**
 * R2：画像を上げ、媒体の ID を返す。
 *
 * `multipart/form-data` に `media`（種別は丸めた値）と `media_category=tweet_image` を入れる。
 * **`Content-Type`（boundary つき）は自分で付けない。** 本体は署名に含めない（設計 §6.3）。
 * 媒体の ID は **`^[0-9]{1,20}$` に合うときだけ**使う。合わなければ R3 を送らずに `true`（設計 §6.5）。
 */
export async function uploadMedia(params: {
  readonly impl: FetchImpl;
  readonly image: FetchedImage;
  readonly authorization: string;
  readonly signal: AbortSignal;
  readonly nowMs: () => number;
}): Promise<XResult<string>> {
  const form = new FormData();
  form.append('media', new Blob([params.image.bytes], { type: params.image.type }));
  form.append('media_category', 'tweet_image');

  const sent = await sendXRequest({
    impl: params.impl,
    url: MEDIA_UPLOAD_URL,
    init: { method: 'POST', headers: { authorization: params.authorization }, body: form },
    timeoutMs: MEDIA_UPLOAD_TIMEOUT_MS,
    parentSignal: params.signal,
  });
  if (sent.kind !== 'response') {
    return failed({ phase: 'upload', kind: sent.kind, retryable: true });
  }

  const { response } = sent;
  const status = response.status;
  if (!isSuccess(status)) {
    discardBody(response);
    const retryAfterMs =
      status === 429 ? retryAfterMsFrom(response.headers, params.nowMs()) : undefined;
    return failed({
      phase: 'upload',
      kind: 'http',
      status,
      retryable: uploadRetryable(status),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  // ここから先はどれも R3 を送っていない。読めなくても形が合わなくても `true`。
  // 本体が上限を超える・本体の途中で打ち切られる分岐は、テストで到達を確かめていない（どちらも `true` で、§6.8 の P2 の既存の行）。
  const read = await readBounded(response, RESPONSE_BODY_MAX_BYTES);
  if (!read.ok) {
    return read.tooLarge
      ? failed({ phase: 'upload', kind: 'shape', status, retryable: true })
      : failed({ phase: 'upload', kind: thrownKind(read.error, sent.signal), retryable: true });
  }
  const data = dataOf(parseJson(read.bytes));
  const id: unknown = data?.['id'];
  if (!isValidXId(id)) {
    return failed({ phase: 'upload', kind: 'shape', status, retryable: true });
  }
  if (data !== undefined && 'processing_info' in data) {
    const processing: unknown = data['processing_info'];
    const state: unknown = isRecord(processing) ? processing['state'] : undefined;
    if (state !== 'succeeded') {
      // 画像では通常現れない（設計 §11 #4）。処理待ちはしない。
      return failed({ phase: 'upload', kind: 'processing', status, retryable: true });
    }
  }
  return { ok: true, value: id };
}

/* -------------------------------------------------------------------------- */
/* R3：投稿（設計 §6.4）                                                         */
/* -------------------------------------------------------------------------- */

/**
 * R3：投稿する。**ここが「送る」。**
 *
 * - 本体は `{ text }`、`mediaIds` が 1 件以上のときだけ `media: { media_ids }` を足す（空の `media` を送らない）
 * - 成功は **200 / 201 かつ `data.id` がある**（`undefined` / `null` でない）
 * - `data.id` があって形に合わない（数値型・空文字を含む）→ **失敗にしない**（`tweetId: undefined`）。
 *   201 と `id` が返った以上は投稿されている（設計 §6.4 / §6.7）
 * - 429 だけ `true`。**それ以外はすべて `false`**（届いたか分からない。SNS の投稿は取り消せない。設計 §6.8 の P4）
 * - **ヘッダの後・本体を読み切る前の打ち切りも `false`**（二重投稿の向きに倒さない。#57）
 */
export async function createTweet(params: {
  readonly impl: FetchImpl;
  readonly text: string;
  readonly mediaIds: readonly string[];
  readonly authorization: string;
  readonly signal: AbortSignal;
  readonly nowMs: () => number;
}): Promise<XResult<{ readonly tweetId: string | undefined }>> {
  const payload =
    params.mediaIds.length === 0
      ? { text: params.text }
      : { text: params.text, media: { media_ids: [...params.mediaIds] } };

  const sent = await sendXRequest({
    impl: params.impl,
    url: CREATE_TWEET_URL,
    init: {
      method: 'POST',
      headers: { authorization: params.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    timeoutMs: CREATE_TWEET_TIMEOUT_MS,
    parentSignal: params.signal,
  });
  if (sent.kind !== 'response') {
    return failed({ phase: 'create', kind: sent.kind, retryable: false });
  }

  const { response } = sent;
  const status = response.status;
  if (status !== 200 && status !== 201) {
    discardBody(response);
    // 429 は書き込む前に断られたと読める。401 / 403 も送っていないと読めるが、再試行で直らない（設計 §6.8）。
    const retryAfterMs =
      status === 429 ? retryAfterMsFrom(response.headers, params.nowMs()) : undefined;
    return failed({
      phase: 'create',
      kind: 'http',
      status,
      retryable: status === 429,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  // 本体が上限を超えたら「JSON でない」と同じ扱い（`false`。実装プラン §8 の 8）。上限を超える分岐はテストで到達を確かめていない。
  const read = await readBounded(response, RESPONSE_BODY_MAX_BYTES);
  if (!read.ok) {
    return read.tooLarge
      ? failed({ phase: 'create', kind: 'shape', status, retryable: false })
      : failed({ phase: 'create', kind: thrownKind(read.error, sent.signal), retryable: false });
  }
  const id: unknown = dataOf(parseJson(read.bytes))?.['id'];
  if (id === undefined || id === null) {
    return failed({ phase: 'create', kind: 'shape', status, retryable: false });
  }
  return { ok: true, value: { tweetId: isValidXId(id) ? id : undefined } };
}
