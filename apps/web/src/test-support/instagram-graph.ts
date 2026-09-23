/**
 * 偽の Instagram Graph API の応答例（038-sns-instagram 設計 §10.9 #69）。
 *
 * **応答の形の唯一の定義。** 単体テスト（偽の `fetch` が返す `Response`）と、
 * ループバックのサーバ（`node:http` が書き出す応答）が同じものを使う。片方だけを書き換えられない。
 *
 * 形は Meta の公開ドキュメントの例に従う（実機で確かめたものではない。設計 §11 #12）。
 * **`plugins/sns-instagram` を import しない。** 応答の形だけを持つ。
 */

/* -------------------------------------------------------------------------- */
/* 値（どれも架空）                                                             */
/* -------------------------------------------------------------------------- */

/** 資格情報の `igUserId`。 */
export const IG_USER_ID = '17841400000000001';

/** 資格情報の `accessToken`。 */
export const ACCESS_TOKEN = 'IGAAtorifuneTestAccessToken0001';

/** 延長（R6）が返す新しいトークン。 */
export const REFRESHED_ACCESS_TOKEN = 'IGAAtorifuneTestRefreshedToken0002';

/** 延長（R6）が返す `expires_in`（秒。約 60 日）。 */
export const REFRESHED_EXPIRES_IN = 5_183_944;

/** 単体の container ID（R1 の応答）。 */
export const CONTAINER_ID = '17900000000000001';

/** carousel の親 container ID（R2 の応答）。 */
export const CAROUSEL_CONTAINER_ID = '17900000000000999';

/** carousel の子 container ID。添字ごとに別の値。 */
export function childContainerId(index: number): string {
  return `1790000000000${String(100 + index).padStart(4, '0')}`;
}

/** 公開した投稿の media ID（R4 の応答）。 */
export const MEDIA_ID = '17950000000000001';

/** 公開した投稿の URL（R5 の応答）。 */
export const PERMALINK = 'https://www.instagram.com/p/AbCdEf012/';

/* -------------------------------------------------------------------------- */
/* 応答例                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 1 つの応答。`body` が文字列ならそのまま、それ以外は JSON にして返す。
 */
export interface GraphResponseExample {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** container の状態（R3 の `status_code`）。 */
export type ContainerStatusCode = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

/** Graph API のエラーの本体に入れる項目（公開ドキュメントの形）。 */
export interface GraphErrorExample {
  readonly status?: number;
  readonly code?: unknown;
  readonly subcode?: unknown;
  readonly isTransient?: boolean;
  readonly message?: string;
  readonly type?: string;
  readonly errorUserTitle?: string;
  readonly errorUserMsg?: string;
  readonly fbtraceId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** R1 / R2：container を作った。 */
export function containerCreated(id: string): GraphResponseExample {
  return { status: 200, body: { id } };
}

/** R3：container の状態。 */
export function containerStatus(
  statusCode: ContainerStatusCode | string,
  id: string = CONTAINER_ID,
): GraphResponseExample {
  return { status: 200, body: { status_code: statusCode, id } };
}

/** R4：公開した。 */
export function mediaPublished(id: string = MEDIA_ID): GraphResponseExample {
  return { status: 200, body: { id } };
}

/** R5：投稿の URL。 */
export function permalinkOf(
  permalink: unknown = PERMALINK,
  id: string = MEDIA_ID,
): GraphResponseExample {
  return { status: 200, body: { permalink, id } };
}

/** `tokenRefreshed` の `expires_in` を本体に入れないことを表す値。 */
export const OMIT_EXPIRES_IN: unique symbol = Symbol('omit-expires-in');

/** R6：延長した。`expiresIn` に `OMIT_EXPIRES_IN` を渡すと `expires_in` の無い本体になる。 */
export function tokenRefreshed(
  accessToken: unknown = REFRESHED_ACCESS_TOKEN,
  expiresIn: unknown = REFRESHED_EXPIRES_IN,
): GraphResponseExample {
  const body: Record<string, unknown> = { access_token: accessToken, token_type: 'bearer' };
  if (expiresIn !== OMIT_EXPIRES_IN) {
    body['expires_in'] = expiresIn;
  }
  return { status: 200, body };
}

/** Graph API のエラー（`{ "error": { … } }`）。既定は HTTP 400。 */
export function graphError(example: GraphErrorExample = {}): GraphResponseExample {
  const error: Record<string, unknown> = {
    message: example.message ?? 'An error occurred.',
    type: example.type ?? 'OAuthException',
  };
  if (example.code !== undefined) {
    error['code'] = example.code;
  }
  if (example.subcode !== undefined) {
    error['error_subcode'] = example.subcode;
  }
  if (example.isTransient !== undefined) {
    error['is_transient'] = example.isTransient;
  }
  if (example.errorUserTitle !== undefined) {
    error['error_user_title'] = example.errorUserTitle;
  }
  if (example.errorUserMsg !== undefined) {
    error['error_user_msg'] = example.errorUserMsg;
  }
  if (example.fbtraceId !== undefined) {
    error['fbtrace_id'] = example.fbtraceId;
  }
  return {
    status: example.status ?? 400,
    body: { error },
    ...(example.headers === undefined ? {} : { headers: example.headers }),
  };
}

/** 本体が HTML（JSON でない）。 */
export function htmlPage(status = 200): GraphResponseExample {
  return {
    status,
    body: '<!DOCTYPE html><html><body>Sorry, something went wrong.</body></html>',
    headers: { 'content-type': 'text/html; charset=utf-8' },
  };
}

/** 転送（3xx）。**追わない**（設計 §6.2）。 */
export function redirectTo(
  location = 'https://example.test/elsewhere',
  status = 302,
): GraphResponseExample {
  return { status, body: '', headers: { location } };
}

/* -------------------------------------------------------------------------- */
/* 書き出し                                                                     */
/* -------------------------------------------------------------------------- */

/** 応答例を HTTP の 3 要素にする。**偽の `fetch` もループバックのサーバもこれを通す。** */
export function serializeExample(example: GraphResponseExample): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const isText = typeof example.body === 'string';
  return {
    status: example.status,
    headers: {
      ...(isText ? {} : { 'content-type': 'application/json; charset=UTF-8' }),
      ...example.headers,
    },
    body: isText ? (example.body as string) : JSON.stringify(example.body),
  };
}

/**
 * 本体を要求の `signal` と結びつけた stream にする。
 *
 * **本物の `fetch` と揃える**（conformance「ヘッダ受信後の abort」。Node v24.16.0 で実測）：
 * 本物はヘッダを返した後で `signal` が発火すると、本体を全部受信済みでも、まだ読み終えていない
 * （`done` を返していない）`reader.read()` を **`signal.reason` で reject** する。
 * `new Response(文字列)` の本体は `signal` と無関係に最後まで読めるので、そのままでは本物と食い違う。
 *
 * - `highWaterMark: 0`：読まれるまで次を用意しない。本物と同じく、最後の塊を読んだ後の
 *   「終わり」の読み込みも abort で reject する
 * - `done` を返した後の abort は何もしない（本物も読み終えた本体は覆さない）
 */
function abortableBody(text: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
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

/**
 * 偽の `fetch` が返す `Response`。
 *
 * `signal`（偽の `fetch` が受け取った `init.signal`）を渡すと、本体の読み込みがその signal と結びつく
 * （`abortableBody`）。**偽の `fetch` は必ず渡す。** 渡さないのは、応答例そのものを比べるとき（#69）だけ。
 */
export function toResponse(example: GraphResponseExample, signal?: AbortSignal | null): Response {
  const { status, headers, body } = serializeExample(example);
  // 1xx / 204 / 205 / 304 は本体を持てない。
  const bodyless = status === 204 || status === 205 || status === 304;
  if (bodyless) {
    return new Response(null, { status, headers });
  }
  if (signal === undefined || signal === null) {
    return new Response(body, { status, headers });
  }
  // 文字列の本体なら `new Response()` が補う `content-type` を、stream でも同じく補う（#69 の注記と揃える）。
  const withType = new Headers(headers);
  if (!withType.has('content-type')) {
    withType.set('content-type', 'text/plain;charset=UTF-8');
  }
  return new Response(abortableBody(body, signal), { status, headers: withType });
}
