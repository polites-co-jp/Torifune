/**
 * 偽の Threads API の応答例と、要求の見分け方（040-sns-threads 設計 §10.13 #93）。
 *
 * **応答の形の唯一の定義。** 単体テスト（偽の `fetch` が返す `Response`）と、
 * ループバックのサーバ（`node:http` が書き出す応答）と、結合テストの偽 Threads API が同じものを使う。
 * 片方だけを書き換えられない。
 *
 * 形は Meta の公開ドキュメントの例に従う（実機で確かめたものではない。設計 §11 #11）。
 * **`plugins/sns-threads` を import しない。** 応答の形と架空の値だけを持つ。
 */

/* -------------------------------------------------------------------------- */
/* 値（どれも架空）                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 外へ出てよい唯一の起点（設計 §6.1）。**Plugin の定数を import せず、ここで独立に書く**
 * （テストが Plugin の定数と突き合わせる）。
 */
export const THREADS_API_ORIGIN = 'https://graph.threads.net';

/**
 * 資格情報の `threadsUserId`（数字だけ。設計 §6.2）。
 *
 * 先頭 8 文字（`27183140`）が `reason` の固定文（「HTTP 400」「code 190」など）の部分文字列にならない値にする。
 */
export const THREADS_USER_ID = '27183140000000001';

/**
 * 資格情報の `accessToken`（実装プラン §2「テストの値」）。
 *
 * * `torifune` を含めない（CI の `DATABASE_URL` の password と同じ綴りを Core が伏せるため）
 * * `encodeURIComponent` と `URLSearchParams` で形が変わる文字（`|` と、`URLSearchParams` だけが符号化する `~` `!`）を含める。
 *   含めないと「符号化した値が出ない」の検査が「生の値が出ない」と同じ検査になる
 * * 先頭 8 文字（`Tq8Wz|pN`）が固定文の部分文字列にならない
 */
export const ACCESS_TOKEN = 'Tq8Wz|pN3~vR-5.k_Jy!Hc';

/** 延長（R6）が返す新しいトークン。形の決め方は `ACCESS_TOKEN` と同じ。 */
export const REFRESHED_ACCESS_TOKEN = 'Rv4Kx|mB7~tQ-9.w_Gz!Ln';

/** 延長（R6）が返す `expires_in`（秒。約 60 日）。 */
export const REFRESHED_EXPIRES_IN = 5_183_944;

/** 単体の container ID（R1 の応答）。 */
export const CONTAINER_ID = '18000000000000001';

/** carousel の親 container ID（R2 の応答）。 */
export const CAROUSEL_CONTAINER_ID = '18000000000000999';

/** carousel の子 container ID。添字ごとに別の値（`18000000000000100` から）。 */
export function childContainerId(index: number): string {
  return `180000000000${String(100 + index).padStart(5, '0')}`;
}

/** 公開した投稿の media ID（R4 の応答）。 */
export const MEDIA_ID = '18100000000000001';

/** 公開した投稿の URL（R5 の応答。F17 の例の形）。 */
export const PERMALINK = 'https://www.threads.net/@yamada.example/post/DAbCdEf012';

/** 形に合う `fbtrace_id`（設計 §6.11）。 */
export const FBTRACE_ID = 'AbC_1';

/**
 * #74 の `error_user_title`。**`reason` の固定文の部分文字列にならない値**
 * （設計 #74。「T」は「Threads」「HTTP」に含まれて検査にならない）。
 */
export const LEAKY_ERROR_USER_TITLE = 'Qz7-title';

/** 画像の URL（Meta が取りに行く。Torifune は要求を出さない）。添字ごとに別の値。 */
export function mediaUrlOf(index: number): string {
  return `https://cdn.example.test/images/${index}.jpg`;
}

/** `mediaUrlOf` で作った URL の添字。当てはまらなければ -1。 */
export function mediaIndexOf(url: string | null): number {
  const matched = /\/images\/([0-9]+)\.jpg$/.exec(url ?? '');
  return matched?.[1] === undefined ? -1 : Number(matched[1]);
}

/* -------------------------------------------------------------------------- */
/* 要求の見分け方（設計 §6 の R1〜R6）                                            */
/* -------------------------------------------------------------------------- */

export type ThreadsRequestKind = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

/**
 * 要求を R1〜R6 のどれかに見分ける。**知らない宛先・知らない要求では投げる**（設計 #107）。
 *
 * * R1 / R2：`POST /{v}/{threadsUserId}/threads`（本体の `media_type` が `CAROUSEL` なら R2）
 * * R3：`GET /{v}/{containerId}?fields=status`
 * * R4：`POST /{v}/{threadsUserId}/threads_publish`
 * * R5：`GET /{v}/{mediaId}?fields=permalink`
 * * R6：`GET /refresh_access_token`（版の付かないパス）
 */
export function threadsRequestKind(
  url: URL,
  method: string,
  form: URLSearchParams,
): ThreadsRequestKind {
  if (url.origin !== THREADS_API_ORIGIN) {
    throw new Error(`偽の Threads API が知らない宛先: ${url.origin}`);
  }
  if (url.pathname === '/refresh_access_token' && method === 'GET') {
    return 'R6';
  }
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (method === 'POST' && parts.length === 3 && parts[2] === 'threads') {
    return form.get('media_type') === 'CAROUSEL' ? 'R2' : 'R1';
  }
  if (method === 'POST' && parts.length === 3 && parts[2] === 'threads_publish') {
    return 'R4';
  }
  if (method === 'GET' && parts.length === 2) {
    const fields = url.searchParams.get('fields');
    if (fields === 'status') {
      return 'R3';
    }
    if (fields === 'permalink') {
      return 'R5';
    }
  }
  throw new Error(`偽の Threads API が知らない要求: ${method} ${url.pathname}`);
}

/** パスの 2 つ目の部分（R3 / R5 の container ID・media ID）。 */
export function targetIdOf(url: URL): string {
  return url.pathname.split('/').filter((part) => part !== '')[1] ?? '';
}

/* -------------------------------------------------------------------------- */
/* 応答例                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 1 つの応答。`body` が文字列ならそのまま、それ以外は JSON にして返す。
 */
export interface ThreadsResponseExample {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** container の状態（R3 の `status`。F9）。 */
export type ContainerStatus = 'FINISHED' | 'IN_PROGRESS' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

/** R1 / R2：container を作った。 */
export function containerCreated(id: unknown = CONTAINER_ID): ThreadsResponseExample {
  return { status: 200, body: { id } };
}

/** R3：container の状態。 */
export function containerStatus(
  status: ContainerStatus | string,
  id: string = CONTAINER_ID,
): ThreadsResponseExample {
  return { status: 200, body: { status, id } };
}

/** R4：公開した。 */
export function threadsPublished(id: unknown = MEDIA_ID): ThreadsResponseExample {
  return { status: 200, body: { id } };
}

/** R5：投稿の URL。 */
export function permalinkOf(
  permalink: unknown = PERMALINK,
  id: string = MEDIA_ID,
): ThreadsResponseExample {
  return { status: 200, body: { permalink, id } };
}

/** `tokenRefreshed` の `expires_in` を本体に入れないことを表す値（既定引数が `undefined` を飲み込まないように）。 */
export const OMIT_EXPIRES_IN: unique symbol = Symbol('omit-expires-in');

/** R6：延長した（F5：`{ access_token, token_type: "bearer", expires_in }`）。 */
export function tokenRefreshed(
  accessToken: unknown = REFRESHED_ACCESS_TOKEN,
  expiresIn: unknown = REFRESHED_EXPIRES_IN,
): ThreadsResponseExample {
  const body: Record<string, unknown> = { access_token: accessToken, token_type: 'bearer' };
  if (expiresIn !== OMIT_EXPIRES_IN) {
    body['expires_in'] = expiresIn;
  }
  return { status: 200, body };
}

/** Graph API 形式のエラーの本体に入れる項目（F18。封筒は推定）。 */
export interface ThreadsErrorExample {
  readonly status?: number;
  readonly code?: unknown;
  readonly subcode?: unknown;
  readonly isTransient?: unknown;
  readonly message?: string;
  readonly type?: string;
  readonly errorUserTitle?: string;
  readonly errorUserMsg?: string;
  readonly fbtraceId?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Graph API 形式のエラー（`{ "error": { … } }`）。既定は HTTP 400。 */
export function threadsError(example: ThreadsErrorExample = {}): ThreadsResponseExample {
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

/**
 * **要求の値を混ぜ返すエラー**（設計 #74）。
 * `message` に `accessToken` の値、`error_user_msg` に要求の URL（トークン入り）を入れる。
 */
export function leakyError(requestUrl: string, status = 400): ThreadsResponseExample {
  return threadsError({
    status,
    code: 190,
    subcode: 463,
    message: ACCESS_TOKEN,
    errorUserMsg: requestUrl,
    errorUserTitle: LEAKY_ERROR_USER_TITLE,
    type: 'OAuthException',
    fbtraceId: FBTRACE_ID,
  });
}

/** 本体が HTML（JSON でない）。 */
export function htmlPage(status = 200): ThreadsResponseExample {
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
): ThreadsResponseExample {
  return { status, body: '', headers: { location } };
}

/**
 * 偽 Threads API の既定の応答（正常系）。単体テストの偽物・ループバックのサーバ・結合テストの偽物が共有する。
 *
 * * R1：`is_carousel_item=true` なら `image_url` の添字の子 ID、そうでなければ `CONTAINER_ID`
 * * R2：`CAROUSEL_CONTAINER_ID`
 * * R3：パスの ID について `FINISHED`
 */
export function defaultThreadsReply(
  kind: ThreadsRequestKind,
  request: { readonly url: URL; readonly form: URLSearchParams },
): ThreadsResponseExample {
  switch (kind) {
    case 'R1':
      return containerCreated(
        request.form.get('is_carousel_item') === 'true'
          ? childContainerId(mediaIndexOf(request.form.get('image_url')))
          : CONTAINER_ID,
      );
    case 'R2':
      return containerCreated(CAROUSEL_CONTAINER_ID);
    case 'R3':
      return containerStatus('FINISHED', targetIdOf(request.url));
    case 'R4':
      return threadsPublished();
    case 'R5':
      return permalinkOf();
    case 'R6':
      return tokenRefreshed();
  }
}

/* -------------------------------------------------------------------------- */
/* 大きな本体（64 KiB の上限の検査。設計 §6.2）                                     */
/* -------------------------------------------------------------------------- */

/**
 * `extra` に `pad` を足した JSON を、**ちょうど `bytes` バイト**にする（JSON として読める）。
 *
 * 上限を外す変異で成功として読めてしまう本体にするため、`extra` には形に合う `id` を入れて使う
 * （上限で打ち切らなければ読めない本体でないと、打ち切りを外す変異が落ちない。`037` 軽微-1）。
 */
export function paddedJson(bytes: number, extra: Readonly<Record<string, unknown>>): string {
  const head = JSON.stringify({ ...extra, pad: '' });
  const padding = bytes - new TextEncoder().encode(head).byteLength;
  if (padding < 0) {
    throw new Error('小さすぎる');
  }
  return JSON.stringify({ ...extra, pad: 'x'.repeat(padding) });
}

/** 1 MiB（`endingJsonResponse` の既定の大きさ）。 */
export const ONE_MIB = 1024 * 1024;

/** `endingJsonResponse` がどこまで読まれたか。 */
export interface EndingStreamProbe {
  /** 出した塊の数。 */
  pulls: number;
  /** 読み手が `cancel` したか。 */
  cancelled: boolean;
}

/**
 * **終わる** stream の本体を持つ `Response`（既定 1 MiB の JSON を 1 KiB ずつ流して閉じる）。
 *
 * 上限の検査に終わらない stream を使うと、打ち切りを外す変異でワーカーが固まるだけでテストとしては落ちない
 * （`038` 軽微-4）。**必ず終わる**ものにする。`signal` を渡すと、本物の `fetch` と同じく発火で `signal.reason` の
 * エラーになる（読み終えた後は何もしない）。
 */
export function endingJsonResponse(options: {
  readonly extra: Readonly<Record<string, unknown>>;
  readonly totalBytes?: number;
  readonly status?: number;
  readonly signal?: AbortSignal | null;
}): { readonly response: Response; readonly probe: EndingStreamProbe } {
  const bytes = new TextEncoder().encode(paddedJson(options.totalBytes ?? ONE_MIB, options.extra));
  const probe: EndingStreamProbe = { pulls: 0, cancelled: false };
  const signal = options.signal ?? null;
  let offset = 0;
  let settled = false;
  let onAbort: (() => void) | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (signal === null) {
          return;
        }
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
        if (offset >= bytes.byteLength) {
          settled = true;
          if (signal !== null && onAbort !== undefined) {
            signal.removeEventListener('abort', onAbort);
          }
          controller.close();
          return;
        }
        probe.pulls += 1;
        controller.enqueue(bytes.slice(offset, offset + 1024));
        offset += 1024;
      },
      cancel() {
        settled = true;
        probe.cancelled = true;
        if (signal !== null && onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(stream, {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    }),
    probe,
  };
}

/* -------------------------------------------------------------------------- */
/* 書き出し                                                                     */
/* -------------------------------------------------------------------------- */

/** 応答例を HTTP の 3 要素にする。**偽の `fetch` もループバックのサーバもこれを通す。** */
export function serializeExample(example: ThreadsResponseExample): {
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
 * 本体を要求の `signal` と結びつけた stream にする（`038` の `instagram-graph.ts` と同じ規則）。
 *
 * **本物の `fetch` と揃える**（#91）：本物はヘッダを返した後で `signal` が発火すると、
 * 本体を全部受信済みでも、まだ読み終えていない（`done` を返していない）`reader.read()` を
 * **`signal.reason` で reject** する。`new Response(文字列)` の本体は `signal` と無関係に最後まで読めるので、
 * そのままでは本物と食い違う。
 *
 * - `highWaterMark: 0`：読まれるまで次を用意しない。最後の塊を読んだ後の「終わり」の読み込みも abort で reject する
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

/** 本体を持てない status（本物の `Response` も本体を付けられない）。 */
function isBodyless(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

/** 文字列の本体なら `new Response()` が補う `content-type` を、stream でも同じく補う。 */
function headersFor(headers: Readonly<Record<string, string>>): Headers {
  const withType = new Headers(headers);
  if (!withType.has('content-type')) {
    withType.set('content-type', 'text/plain;charset=UTF-8');
  }
  return withType;
}

/**
 * 偽の `fetch` が返す `Response`。
 *
 * `signal`（偽の `fetch` が受け取った `init.signal`）を渡すと、本体の読み込みがその signal と結びつく。
 * **偽の `fetch` は必ず渡す。** 渡さないのは、応答例そのものを比べるとき（#93）だけ。
 */
export function toResponse(example: ThreadsResponseExample, signal?: AbortSignal | null): Response {
  const { status, headers, body } = serializeExample(example);
  if (isBodyless(status)) {
    return new Response(null, { status, headers });
  }
  if (signal === undefined || signal === null) {
    return new Response(body, { status, headers });
  }
  return new Response(abortableBody(body, signal), { status, headers: headersFor(headers) });
}

/**
 * **ヘッダだけを返し、本体を保留する** `Response`（#91）。
 *
 * 本体は `signal` が発火するまで 1 バイトも出さず、発火したら `signal.reason` で reject する。
 * ループバックのサーバが「ヘッダを送ってから本体を保留する」のと同じ振る舞い。
 */
export function toHeldResponse(example: ThreadsResponseExample, signal: AbortSignal): Response {
  const { status, headers } = serializeExample(example);
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
  return new Response(stream, { status, headers: headersFor(headers) });
}
