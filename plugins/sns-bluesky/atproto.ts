/**
 * AT Protocol への要求（036-sns-bluesky 設計 §6）。
 *
 * **この Plugin が外へ出す HTTP はここに集めてある。** 外へ出る口を1ファイルに閉じ込めると、
 * 「どこへ何を送っているか」が1か所を読めば分かる。
 *
 * 判定（フェーズ・status・既知の `error` コード → `retryable` / `retryAfterMs`）もここに置き、
 * 文言の組み立てと `PublishResult` への変換は `social.ts` が持つ。
 */

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
 * **既定値の解決はここだけ。** 呼び出しはすべて `impl(url, init)` の形で行い、
 * 外へ出る綴りを増やさない（実装プラン §7 の 1）。
 * **毎回引き直す。** モジュールの読み込み時に閉じ込めると、差し替えが効かなくなる。
 */
export function resolveFetch(injected?: FetchImpl): FetchImpl {
  return injected ?? globalThis.fetch;
}

/**
 * 要求ごとの制限時間（設計 §6.6）。
 *
 * Core は `publish()` を30秒で打ち切り、**結果不明として `failed`** にする（再試行しない）。
 * 30秒に達してから打ち切られるのは最悪の形なので、**自分で早く諦める。**
 */
export const CREATE_SESSION_TIMEOUT_MS = 10_000;
export const MEDIA_FETCH_TIMEOUT_MS = 10_000;
export const UPLOAD_BLOB_TIMEOUT_MS = 10_000;
export const CREATE_RECORD_TIMEOUT_MS = 15_000;

/**
 * `publish()` 1 回に使ってよい合計時間（設計 §6.6）。
 *
 * **要求ごとの制限時間だけでは合計を縛れない。** 10（session）＋ 20（媒体）＋ 15（record）は
 * Core の 30 秒を超える。**この期限をすべての要求の外側の signal に混ぜて、合計を縛る。**
 * 値は `createSession`（10 秒）＋ `createRecord`（15 秒）＝ 媒体なしの最悪の形に、
 * 打ち切りを検知して結果を組み立てるための余白を足したもの。
 */
export const PUBLISH_TOTAL_BUDGET_MS = 25_000;

/**
 * 媒体の処理に使ってよい合計時間。超えたら諦める（まだ `createRecord` を呼んでいない）。
 *
 * **実際の期限は `createSession` の後の残り時間から取る**（`PUBLISH_TOTAL_BUDGET_MS` を超えない。設計 §6.6）。
 */
export const MEDIA_TOTAL_BUDGET_MS = 20_000;

/** 媒体の上限サイズ。Bluesky の `uploadBlob` が受ける画像の上限に合わせる（設計 §6.2）。 */
export const MEDIA_MAX_BYTES = 1_000_000;

/**
 * 受け付ける画像の種別（設計 §6.2）。
 *
 * **`image/` で始まるものを素通しにしない。** ここで丸めた値がそのまま
 * PDS への要求の `Content-Type` になる。取得先は利用者が指した任意のサーバであり、
 * **その応答ヘッダを、資格情報を添えた要求のヘッダへ転記しない。**
 */
const ALLOWED_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** 知らない `error` コードの代わりに `reason` へ出す値（設計 §6.11）。 */
export const UNKNOWN_ERROR_CODE = 'unknown';

/**
 * `reason` に出してよい `error` コード。
 *
 * **知らない値を素通しする口は作らない。** PDS の URL は設定で変えられるので、
 * 応答の文字列は「管理者が指した先のサーバが書いたもの」である（設計 §6.11）。
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'AuthenticationRequired',
  'InvalidPassword',
  'AuthFactorTokenRequired',
  'AccountTakedown',
  'AccountDeactivated',
  'AccountSuspended',
  'RateLimitExceeded',
  'ExpiredToken',
  'InvalidToken',
  'InvalidRequest',
  'BlobTooLarge',
  'UnsupportedMimeType',
]);

/** アカウント側の事情。**人が直すまで直らない**（設計 §6.9 の P1）。 */
export const ACCOUNT_STATE_ERROR_CODES: ReadonlySet<string> = new Set([
  'AccountTakedown',
  'AccountDeactivated',
  'AccountSuspended',
]);

/** 資格情報の問題。**再試行しても直らず、Bluesky のログイン試行の回数を食う**（設計 §6.9）。 */
const CREDENTIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'AuthenticationRequired',
  'InvalidPassword',
  'AuthFactorTokenRequired',
]);

/**
 * どの段階で失敗したか。`retryable` はこれで決まる（設計 §6.9）。
 *
 * `embed` は「画像とリンクカードの同居」を断る段（`createSession` より前。設計 §6.8）。
 * 外へ要求を出していないので `status` を持たない。
 */
export type AtprotoPhase =
  'config' | 'embed' | 'createSession' | 'media' | 'uploadBlob' | 'createRecord';

export type AtprotoFailureKind =
  /** 接続できない（DNS・TCP・TLS。`fetch` が reject）。 */
  | 'network'
  /** 自前の制限時間に達した、または Core が打ち切った。 */
  | 'timeout'
  /** 応答は返ったが 2xx ではない。 */
  | 'http'
  /** 応答が JSON でない、または要る項目が無い。 */
  | 'shape'
  /** 媒体の取得先が転送を返した（追わない）。 */
  | 'redirect'
  /** 媒体が画像ではない。 */
  | 'contentType'
  /** 媒体が上限を超えた。 */
  | 'tooLarge'
  /** 媒体の処理に使ってよい合計時間を超えた。 */
  | 'budget';

export interface AtprotoFailure {
  readonly phase: AtprotoPhase;
  readonly kind: AtprotoFailureKind;
  /** HTTP の status。応答が返らなかったときは持たない。 */
  readonly status?: number;
  /** **既知の** `error` コード、または `unknown`。 */
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type AtprotoResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: AtprotoFailure };

export interface AtprotoSession {
  readonly did: string;
  /** **`externalUrl` はこれで組み立てる。** Torifune 側の登録値と食い違いうる（設計 §6.4）。 */
  readonly handle: string;
  readonly accessJwt: string;
}

export interface FetchedMedia {
  /** **`ArrayBuffer` を持つものに固定する。** `BodyInit` が `ArrayBufferLike` を受けない。 */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** **既知の値へ丸めた種別**（取得先の応答ヘッダそのままではない。設計 §6.2）。 */
  readonly contentType: string;
}

function failed(failure: AtprotoFailure): AtprotoResult<never> {
  return { ok: false, failure };
}

/**
 * XRPC の宛先を組み立てる（設計 §7.2）。
 *
 * **文字列の連結にしない。** 検査（`validatePdsUrl`）は `new URL()` の解析結果を見るので、
 * 組み立ても同じ解析を通す。生で繋ぐと `https://example.com/?` が
 * `https://example.com/?/xrpc/…` になり、**パスがクエリ文字列に化ける。**
 */
function endpointOf(pdsUrl: string, nsid: string): string {
  return new URL(`/xrpc/${nsid}`, pdsUrl).href;
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

function isAbortLike(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name: unknown = (error as { readonly name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

type Sent =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly aborted: boolean };

/**
 * 1回の要求を出す。
 *
 * **`AbortSignal` は要求ごとに作る。** 使い回すと、1件目の制限時間で2件目まで止まる。
 * Core が打ち切ったときも、自前の上限に達したときも、同じ1つの signal で止まる（設計 §6.6）。
 */
async function send(
  impl: FetchImpl,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outer: AbortSignal,
): Promise<Sent> {
  const signal = AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);
  try {
    return { ok: true, response: await impl(url, { ...init, signal }) };
  } catch (error) {
    return { ok: false, aborted: isAbortLike(error) };
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  return payload as Record<string, unknown>;
}

/** 応答の `error` コード。**`message`（自由文）は読まない**（設計 §6.11）。 */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  const payload = await readJson(response);
  if (payload === undefined) {
    return undefined;
  }
  const code: unknown = payload['error'];
  if (typeof code !== 'string' || code === '') {
    return undefined;
  }
  return KNOWN_ERROR_CODES.has(code) ? code : UNKNOWN_ERROR_CODE;
}

/**
 * 429 の `ratelimit-reset`（UNIX 秒）から待ち時間を出す（設計 §6.10）。
 *
 * ヘッダが無い・数値でない・過去を指すときは**付けない**（Core の既定が使われる）。
 * **Plugin 側で丸めない**（Core が 24 時間で切り詰める）。
 */
export function retryAfterMsFrom(headers: Headers): number | undefined {
  const raw = headers.get('ratelimit-reset');
  if (raw === null || raw.trim() === '') {
    return undefined;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }
  const waitMs = Math.max(0, seconds * 1000 - Date.now());
  return waitMs > 0 ? waitMs : undefined;
}

function rateLimitRetryAfter(response: Response): number | undefined {
  return response.status === 429 ? retryAfterMsFrom(response.headers) : undefined;
}

/**
 * `createSession` の失敗が再試行で直るか（設計 §6.9 の P1）。
 *
 * **既定は `true`。** セッションすら取れていない＝投稿は作られていない。
 * 例外は「時間が経っても直らないもの」だけ。
 */
function sessionRetryable(status: number, code: string | undefined): boolean {
  if (
    code !== undefined &&
    (CREDENTIAL_ERROR_CODES.has(code) || ACCOUNT_STATE_ERROR_CODES.has(code))
  ) {
    return false;
  }
  // **401 は `false`。** ガイドの表より狭いが意図的（設計 §6.9 / §11 #12）。
  // 再試行しても直らず、Bluesky のログイン試行の回数を食う。
  return status !== 401;
}

export async function createSession(params: {
  readonly impl: FetchImpl;
  readonly pdsUrl: string;
  readonly identifier: string;
  readonly password: string;
  readonly signal: AbortSignal;
}): Promise<AtprotoResult<AtprotoSession>> {
  const sent = await send(
    params.impl,
    endpointOf(params.pdsUrl, 'com.atproto.server.createSession'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // **`credential` のキーをそのまま送らない。** AT Protocol 側の項目名は `password`。
      body: JSON.stringify({ identifier: params.identifier, password: params.password }),
    },
    CREATE_SESSION_TIMEOUT_MS,
    params.signal,
  );

  if (!sent.ok) {
    return failed({
      phase: 'createSession',
      kind: sent.aborted ? 'timeout' : 'network',
      retryable: true,
    });
  }

  const response = sent.response;
  if (!response.ok) {
    const code = await errorCodeOf(response);
    return failed({
      phase: 'createSession',
      kind: 'http',
      status: response.status,
      code,
      retryable: sessionRetryable(response.status, code),
      retryAfterMs: rateLimitRetryAfter(response),
    });
  }

  const payload = await readJson(response);
  const did: unknown = payload?.['did'];
  const handle: unknown = payload?.['handle'];
  const accessJwt: unknown = payload?.['accessJwt'];
  if (typeof did !== 'string' || typeof handle !== 'string' || typeof accessJwt !== 'string') {
    // **解釈できなくても、次の要求を出していない。** 一般則「応答の解釈に失敗 → false」は
    // `createRecord` の話である（設計 §6.9）。
    return failed({ phase: 'createSession', kind: 'shape', retryable: true });
  }

  // **`refreshJwt` は使わずに捨てる。** `store` にも `store.setSecret` にも入れない（設計 §6.5）。
  return { ok: true, value: { did, handle, accessJwt } };
}

type ReadOutcome =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly tooLarge: boolean };

/** 上限まで読み、超えたらそこで打ち切る（`Content-Length` が無くても効く。設計 §6.2）。 */
async function readLimited(response: Response): Promise<ReadOutcome> {
  const body = response.body;
  if (body === null) {
    try {
      const buffer = new Uint8Array(await response.arrayBuffer());
      return buffer.byteLength > MEDIA_MAX_BYTES
        ? { ok: false, tooLarge: true }
        : { ok: true, bytes: buffer };
    } catch {
      return { ok: false, tooLarge: false };
    }
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
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > MEDIA_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/**
 * 媒体を取りに行く（設計 §6.2）。
 *
 * **`media[].url` は `social.write` を持つ誰かが書いた値である。**
 * リダイレクトを追わず、種別と大きさを絞り、**中身をログにも `reason` にも載せない。**
 */
export async function fetchMedia(params: {
  readonly impl: FetchImpl;
  readonly url: string;
  readonly signal: AbortSignal;
}): Promise<AtprotoResult<FetchedMedia>> {
  const sent = await send(
    params.impl,
    params.url,
    // 検査を通った URL から、検査していない URL へ移らせない。
    // **`'error'` にしない。** `'error'` の `fetch` は 3xx を `Response` として返さず reject するので、
    // 下の 3xx の分岐が本番で1度も通らず、リダイレクトが `kind: 'network'`（`retryable: true`）に
    // 落ちて設計 §6.9 の P2 と逆になる。`'manual'` は**追わずに 3xx を観測できる**（設計 §6.2）。
    { method: 'GET', redirect: 'manual' },
    MEDIA_FETCH_TIMEOUT_MS,
    params.signal,
  );

  if (!sent.ok) {
    // 投稿は作られていない。
    return failed({ phase: 'media', kind: sent.aborted ? 'timeout' : 'network', retryable: true });
  }

  const response = sent.response;
  if (response.status >= 300 && response.status < 400) {
    return failed({ phase: 'media', kind: 'redirect', status: response.status, retryable: false });
  }
  if (!response.ok) {
    // 4xx は投稿の内容の問題（人が `media[].url` を直す）。5xx はまだ何も作られていない。
    return failed({
      phase: 'media',
      kind: 'http',
      status: response.status,
      retryable: response.status >= 500,
    });
  }

  // **既知の画像へ丸める。** 画像以外を blob にしても投稿に載らないうえ、
  // 取得先の応答ヘッダをそのまま PDS への要求ヘッダへ転記しないため（設計 §6.2）。
  const contentType = imageTypeOf(response.headers.get('content-type'));
  if (contentType === undefined) {
    return failed({ phase: 'media', kind: 'contentType', retryable: false });
  }

  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MEDIA_MAX_BYTES) {
    return failed({ phase: 'media', kind: 'tooLarge', retryable: false });
  }

  const read = await readLimited(response);
  if (!read.ok) {
    return failed({
      phase: 'media',
      kind: read.tooLarge ? 'tooLarge' : 'network',
      retryable: !read.tooLarge,
    });
  }

  return { ok: true, value: { bytes: read.bytes, contentType } };
}

/**
 * 画像を1件アップロードする（設計 §6.2）。
 *
 * **blob は投稿ではない。** `createRecord` を呼んでいない限り投稿は作られないので、
 * 接続断・5xx・429・制限時間は `true` に倒してよい。
 */
export async function uploadBlob(params: {
  readonly impl: FetchImpl;
  readonly pdsUrl: string;
  readonly accessJwt: string;
  readonly media: FetchedMedia;
  readonly signal: AbortSignal;
}): Promise<AtprotoResult<unknown>> {
  const sent = await send(
    params.impl,
    endpointOf(params.pdsUrl, 'com.atproto.repo.uploadBlob'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.accessJwt}`,
        'content-type': params.media.contentType,
      },
      body: params.media.bytes,
    },
    UPLOAD_BLOB_TIMEOUT_MS,
    params.signal,
  );

  if (!sent.ok) {
    return failed({
      phase: 'uploadBlob',
      kind: sent.aborted ? 'timeout' : 'network',
      retryable: true,
    });
  }

  const response = sent.response;
  if (!response.ok) {
    const code = await errorCodeOf(response);
    return failed({
      phase: 'uploadBlob',
      kind: 'http',
      status: response.status,
      code,
      // 401 は資格情報の問題（P1 と同じ扱い）。そのほかの 4xx は内容の問題。
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: rateLimitRetryAfter(response),
    });
  }

  const payload = await readJson(response);
  const blob: unknown = payload?.['blob'];
  if (typeof blob !== 'object' || blob === null) {
    return failed({ phase: 'uploadBlob', kind: 'shape', retryable: true });
  }

  // **そのまま `embed.images[].image` に入れる**（中身を組み立て直さない。設計 §6.2）。
  return { ok: true, value: blob };
}

/**
 * 投稿を作る（設計 §6.3）。
 *
 * **ここが「送る」。** 送った後の失敗は、429 を除いてすべて `retryable: false` にする。
 * **届いたか分からない。SNS の投稿は取り消せない。**
 */
export async function createRecord(params: {
  readonly impl: FetchImpl;
  readonly pdsUrl: string;
  readonly accessJwt: string;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal;
}): Promise<AtprotoResult<{ readonly rkey: string }>> {
  const sent = await send(
    params.impl,
    endpointOf(params.pdsUrl, 'com.atproto.repo.createRecord'),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${params.accessJwt}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(params.body),
    },
    CREATE_RECORD_TIMEOUT_MS,
    params.signal,
  );

  if (!sent.ok) {
    return failed({
      phase: 'createRecord',
      kind: sent.aborted ? 'timeout' : 'network',
      retryable: false,
    });
  }

  const response = sent.response;
  if (!response.ok) {
    const code = await errorCodeOf(response);
    return failed({
      phase: 'createRecord',
      kind: 'http',
      status: response.status,
      code,
      // **429 だけ `true`**（書き込む前に断られたと読める。設計 §6.9）。
      retryable: response.status === 429,
      retryAfterMs: rateLimitRetryAfter(response),
    });
  }

  const payload = await readJson(response);
  const uri: unknown = payload?.['uri'];
  if (typeof uri !== 'string' || uri === '') {
    return failed({ phase: 'createRecord', kind: 'shape', retryable: false });
  }

  // **`uri` の最後のセグメントが rkey**（設計 §6.3）。
  const rkey = uri.slice(uri.lastIndexOf('/') + 1);
  if (rkey === '') {
    return failed({ phase: 'createRecord', kind: 'shape', retryable: false });
  }

  return { ok: true, value: { rkey } };
}
