/**
 * 偽の X API と画像の取得先の応答例（037-sns-x 設計 §10.9 #58）。
 *
 * **応答の形の唯一の定義。** 単体テスト（偽の `fetch` が返す `Response`）と、
 * ループバックのサーバ（`node:http` が書き出す応答）が同じものを使う。片方だけを書き換えられない。
 *
 * 形は X の公開ドキュメントの例に従う（実機で確かめたものではない。設計 §11 #12）。
 * **`plugins/sns-x-*` を import しない。** 応答の形と架空の値だけを持つ。
 */

/* -------------------------------------------------------------------------- */
/* 値（どれも架空）                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 資格情報の 4 値（設計 §5.1）。どれも `^[\x21-\x7E]{1,256}$` に合う。
 *
 * **固定の文言の部分文字列にならない値にする**（`reason` / `logger` の禁止語の検査が空振りしないように）。
 * `apiKey` の先頭 3 文字（#47 の `detail`）も「API」「HTTP」のような語にしない。
 */
export const API_KEY = 'q7ZtorifuneConsumerKey0001';
export const API_KEY_SECRET = 'torifuneConsumerSecretVq2Lr8Xw0002';
export const ACCESS_TOKEN = '1790000000000000001-torifuneAccessTokenKp0003';
export const ACCESS_TOKEN_SECRET = 'torifuneAccessTokenSecretMz9Ty4Nb0004';

/** `publish()` の `credential` に渡す形（キーは `credentialFields` のまま）。 */
export const CREDENTIAL: Readonly<
  Record<'apiKey' | 'apiKeySecret' | 'accessToken' | 'accessTokenSecret', string>
> = {
  apiKey: API_KEY,
  apiKeySecret: API_KEY_SECRET,
  accessToken: ACCESS_TOKEN,
  accessTokenSecret: ACCESS_TOKEN_SECRET,
};

/** 投稿の ID（R3 の応答）。19 桁。 */
export const TWEET_ID = '1800000000000000000';

/** 媒体の ID（R2 の応答）。添字ごとに別の値（19 桁）。 */
export function mediaIdOf(index: number): string {
  return `17100000000000000${String(index).padStart(2, '0')}`;
}

/** 1 枚目の媒体の ID。 */
export const MEDIA_ID = mediaIdOf(0);

/** 画像の取得先の起点（テストが宣言する画像の URL。ループバックのラッパが通してよい起点）。 */
export const IMAGE_ORIGIN = 'https://cdn.example.test';

/** 画像の URL。添字ごとに別の値。 */
export function imageUrlOf(index: number): string {
  return `${IMAGE_ORIGIN}/images/${index}.png`;
}

/** 1×1 の PNG。 */
export const PNG_BYTES: Uint8Array = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * 添字ごとに中身の違う画像のバイト列（PNG の後ろに添字の 1 バイトを足したもの）。
 * R2 に上がったバイト列から「何枚目の画像か」を見分けるのに使う。
 */
export function imageBytesOf(index: number): Uint8Array {
  const bytes = new Uint8Array(PNG_BYTES.byteLength + 1);
  bytes.set(PNG_BYTES, 0);
  bytes[PNG_BYTES.byteLength] = index & 0xff;
  return bytes;
}

/** `imageBytesOf` で作ったバイト列の添字（末尾の 1 バイト）。 */
export function imageIndexOf(bytes: Uint8Array): number {
  return bytes.byteLength === 0 ? -1 : (bytes[bytes.byteLength - 1] ?? -1);
}

/* -------------------------------------------------------------------------- */
/* 応答例                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 1 つの応答。`body` が文字列ならそのまま、`Uint8Array` ならバイト列のまま、それ以外は JSON にして返す。
 */
export interface XResponseExample {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** R1：画像を返す。`contentType` に `null` を渡すと `content-type` の無い応答になる。 */
export function imageFetched(
  bytes: Uint8Array = PNG_BYTES,
  contentType: string | null = 'image/png',
  headers: Readonly<Record<string, string>> = {},
): XResponseExample {
  return {
    status: 200,
    body: bytes,
    headers: { ...(contentType === null ? {} : { 'content-type': contentType }), ...headers },
  };
}

/** R2：媒体を上げた（`POST /2/media/upload` の応答。設計 §6.1）。`extra` は `data` に足す項目。 */
export function mediaUploaded(
  id: unknown = MEDIA_ID,
  extra: Readonly<Record<string, unknown>> = {},
): XResponseExample {
  return {
    status: 200,
    body: {
      data: {
        id,
        media_key: `3_${String(id)}`,
        size: PNG_BYTES.byteLength,
        expires_after_secs: 86_400,
        image: { image_type: 'image/png', w: 1, h: 1 },
        ...extra,
      },
    },
  };
}

/** R3：投稿した（`POST /2/tweets` の応答。201。設計 §6.4）。 */
export function tweetCreated(id: unknown = TWEET_ID, text = 'posted'): XResponseExample {
  return { status: 201, body: { data: { id, text } } };
}

/** X API のエラー（problem 形式。設計 §6.1）。 */
export interface XProblemExample {
  readonly title?: string;
  readonly detail?: string;
  readonly type?: string;
  readonly errors?: readonly Readonly<Record<string, unknown>>[];
  readonly headers?: Readonly<Record<string, string>>;
}

export function xProblem(status: number, example: XProblemExample = {}): XResponseExample {
  const body: Record<string, unknown> = {
    title: example.title ?? 'Forbidden',
    detail: example.detail ?? 'You are not permitted to perform this action.',
    type: example.type ?? 'about:blank',
    status,
  };
  if (example.errors !== undefined) {
    body['errors'] = example.errors;
  }
  return {
    status,
    body,
    headers: { 'content-type': 'application/problem+json', ...example.headers },
  };
}

/**
 * **要求の値を混ぜ返す problem**（#47）。
 * `title` に `accessToken` の値、`detail` に `apiKey` の先頭 3 文字、`errors[].message` に本文の断片を入れる。
 */
export function leakyProblem(status: number, bodyFragment: string): XResponseExample {
  return xProblem(status, {
    title: ACCESS_TOKEN,
    detail: `${API_KEY.slice(0, 3)}…`,
    type: 'https://api.x.com/2/problems/x',
    errors: [{ message: bodyFragment, detail: `${bodyFragment} (duplicate)` }],
  });
}

/** 429。`reset` を渡すと `x-rate-limit-reset` に入れる（UNIX 秒の文字列。設計 §9.7）。 */
export function rateLimited(reset?: string): XResponseExample {
  return xProblem(429, {
    title: 'Too Many Requests',
    detail: 'Too Many Requests',
    type: 'about:blank',
    headers: reset === undefined ? {} : { 'x-rate-limit-reset': reset },
  });
}

/** `x-rate-limit-reset` の値：`now` から `afterMs` 後の UNIX 秒。 */
export function resetAfter(now: Date, afterMs: number): string {
  return String(Math.floor((now.getTime() + afterMs) / 1000));
}

/** 本体が HTML（JSON でない）。 */
export function htmlPage(status = 200): XResponseExample {
  return {
    status,
    body: '<!DOCTYPE html><html><body>Something went wrong.</body></html>',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  };
}

/** 転送（3xx）。**追わない**（設計 §6.5）。 */
export function redirectTo(
  location = 'https://example.test/elsewhere',
  status = 302,
): XResponseExample {
  return { status, body: '', headers: { location } };
}

/* -------------------------------------------------------------------------- */
/* 書き出し                                                                     */
/* -------------------------------------------------------------------------- */

/** 応答例を HTTP の 3 要素にする。**偽の `fetch` もループバックのサーバもこれを通す。** */
export function serializeExample(example: XResponseExample): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
} {
  if (example.body instanceof Uint8Array) {
    return { status: example.status, headers: { ...example.headers }, body: example.body };
  }
  const isText = typeof example.body === 'string';
  return {
    status: example.status,
    headers: {
      ...(isText ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      ...example.headers,
    },
    body: isText ? (example.body as string) : JSON.stringify(example.body),
  };
}

function bytesOf(body: string | Uint8Array): Uint8Array {
  return typeof body === 'string' ? new TextEncoder().encode(body) : body;
}

/**
 * 本体を要求の `signal` と結びつけた stream にする（038 の `test-support/instagram-graph.ts` と同じ規則）。
 *
 * **本物の `fetch` と揃える**（#57）：本物はヘッダを返した後で `signal` が発火すると、
 * 本体を全部受信済みでも、まだ読み終えていない（`done` を返していない）`reader.read()` を
 * **`signal.reason` で reject** する。`new Response(文字列)` の本体は `signal` と無関係に最後まで読めるので、
 * そのままでは本物と食い違う。
 *
 * - `highWaterMark: 0`：読まれるまで次を用意しない。最後の塊を読んだ後の「終わり」の読み込みも abort で reject する
 * - `done` を返した後の abort は何もしない（本物も読み終えた本体は覆さない）
 */
function abortableBody(bytes: Uint8Array, signal: AbortSignal): ReadableStream<Uint8Array> {
  let enqueued = false;
  let settled = false;
  let onAbort: (() => void) | undefined;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (signal.aborted) {
          settled = true;
          controller.error(signal.reason);
          return;
        }
        onAbort = (): void => {
          if (!settled) {
            settled = true;
            controller.error(signal.reason);
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      },
      pull(controller) {
        if (settled) {
          return;
        }
        if (!enqueued && bytes.byteLength > 0) {
          enqueued = true;
          controller.enqueue(bytes);
          return;
        }
        settled = true;
        if (onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
        controller.close();
      },
      cancel() {
        settled = true;
        if (onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      },
    },
    { highWaterMark: 0 },
  );
}

/** 本体を持てない status（本物の `Response` も本体を付けられない）。 */
function isBodyless(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/** 文字列の本体なら `new Response()` が補う `content-type` を、stream でも同じく補う。 */
function headersFor(headers: Readonly<Record<string, string>>, body: string | Uint8Array): Headers {
  const withType = new Headers(headers);
  if (typeof body === 'string' && !withType.has('content-type')) {
    withType.set('content-type', 'text/plain;charset=UTF-8');
  }
  return withType;
}

/**
 * 偽の `fetch` が返す `Response`。
 *
 * `signal`（偽の `fetch` が受け取った `init.signal`）を渡すと、本体の読み込みがその signal と結びつく。
 * **偽の `fetch` は必ず渡す。** 渡さないのは、応答例そのものを比べるとき（#58）だけ。
 */
export function toResponse(example: XResponseExample, signal?: AbortSignal | null): Response {
  const { status, headers, body } = serializeExample(example);
  if (isBodyless(status)) {
    return new Response(null, { status, headers });
  }
  if (signal === undefined || signal === null) {
    return new Response(typeof body === 'string' ? body : new Blob([body as BlobPart]), {
      status,
      headers: headersFor(headers, body),
    });
  }
  return new Response(abortableBody(bytesOf(body), signal), {
    status,
    headers: headersFor(headers, body),
  });
}

/**
 * **ヘッダだけを返し、本体を保留する** `Response`（#57）。
 *
 * 本体は `signal` が発火するまで 1 バイトも出さず、発火したら `signal.reason` で reject する。
 * ループバックのサーバが「ヘッダを送ってから本体を保留する」のと同じ振る舞い。
 */
export function toHeldResponse(example: XResponseExample, signal: AbortSignal): Response {
  const { status, headers, body } = serializeExample(example);
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (signal.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { status, headers: headersFor(headers, body) });
}
