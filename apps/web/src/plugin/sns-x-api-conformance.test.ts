import type { PublishResult, SocialAccountView, SocialPostView } from '@torifune/plugin-api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CREDENTIAL,
  IMAGE_ORIGIN,
  PNG_BYTES,
  TWEET_ID,
  htmlPage,
  imageBytesOf,
  imageFetched,
  imageIndexOf,
  imageUrlOf,
  mediaIdOf,
  mediaUploaded,
  rateLimited,
  redirectTo,
  serializeExample,
  toHeldResponse,
  toResponse,
  tweetCreated,
  xProblem,
  type XResponseExample,
} from '@/test-support/x-api';
import { createXApiPublisher } from '../../../../plugins/sns-x-api/social';
import {
  CREATE_TWEET_TIMEOUT_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  X_API_BASE_URL,
  sendXRequest,
} from '../../../../plugins/sns-x-api/xapi';

/**
 * 偽物と本物の一致（037-sns-x 設計 §10.9 #52〜#59、#92 の A 側）。
 *
 * この Plugin の単体テストは `fetch` / `now` / `nonce` をすべて偽物にしている。
 * **偽物が本物と違う振る舞いをすると、表の行が緑のまま本番の分岐が死ぬ**（036 検証レポート R-1）。
 * 本 Plugin は multipart の送信・画像のストリーム読み込み・OAuth のヘッダと、偽物が本物とずれうる所が多い。
 * ここだけは `node:http` の**ループバック（127.0.0.1）のサーバ**に**本物の `fetch`** を当てる。
 * **外部への通信は 1 本も出ない。**
 *
 * - 本物の `fetch` はモジュールの読み込み時に退避し、**ラッパ越しにだけ**使う（#92）
 * - ラッパは書き換え前の URL が `https://api.x.com/` か、テストが宣言した画像の URL で始まらなければ、
 *   本物を呼ばずに投げる（#59）
 * - サーバの応答は `test-support/x-api.ts` の応答例から作る（#58）
 *
 * #89：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 */

/** 本物の `fetch`。**読み込み時に退避する**（`beforeEach` が投げる実装へ置き換える前）。 */
const realFetch: typeof globalThis.fetch = globalThis.fetch;

/** 呼ばれたら投げる `fetch`（#89）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  // #89：本物の `fetch` を素のまま呼んだら落ちる。本物はラッパ越しにだけ使う。
  globalThis.fetch = throwingFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 応答の決め方（サーバと偽の fetch が同じものを使う）                               */
/* -------------------------------------------------------------------------- */

/** 受け取った要求。サーバも偽の `fetch` も同じ形で記録する。 */
interface Received {
  readonly method: string;
  /** パスとクエリ（起点を除いたもの）。 */
  readonly path: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

type Reply =
  | { readonly kind: 'example'; readonly example: XResponseExample }
  /** 応答しない。 */
  | { readonly kind: 'hang' }
  /** ヘッダだけ送り、本体を保留する（#57）。 */
  | { readonly kind: 'held'; readonly example: XResponseExample }
  /** `Content-Length` なしで `total` バイトの画像を流す（#54）。 */
  | { readonly kind: 'stream'; readonly total: number };

type Responder = (received: Received) => Reply;

function example(value: XResponseExample): Reply {
  return { kind: 'example', example: value };
}

/* -------------------------------------------------------------------------- */
/* multipart を読む（依存を足さない。実装プラン §2「multipart の中身」）                  */
/* -------------------------------------------------------------------------- */

interface Part {
  readonly name: string;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/** `multipart/form-data` の本体を、`content-type` の `boundary` で区切って読む。 */
function parseMultipart(body: Uint8Array, contentType: string | null): Part[] {
  const matched = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType ?? '');
  const boundary = matched?.[1] ?? matched?.[2];
  if (boundary === undefined) {
    return [];
  }
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const headerEnd = encoder.encode('\r\n\r\n');
  const parts: Part[] = [];
  let cursor = indexOfBytes(body, delimiter, 0);
  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    // `--boundary--` で終わり。
    if (body[start] === 0x2d && body[start + 1] === 0x2d) {
      break;
    }
    const next = indexOfBytes(body, delimiter, start);
    if (next === -1) {
      break;
    }
    // 区切りの直後の CRLF から、次の区切りの直前の CRLF まで。
    const section = body.subarray(start + 2, next - 2);
    const split = indexOfBytes(section, headerEnd, 0);
    const headers = new TextDecoder().decode(section.subarray(0, split));
    parts.push({
      name: /name="([^"]*)"/.exec(headers)?.[1] ?? '',
      contentType: /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim() ?? null,
      bytes: section.subarray(split + headerEnd.length),
    });
    cursor = next;
  }
  return parts;
}

/** 要求の種類を見分けて、既定の応答を返す（サーバと偽の `fetch` が同じ規則を使う）。 */
function defaultResponder(request: Received): Reply {
  const path = new URL(request.path, 'http://loopback.invalid').pathname;
  const image = /^\/images\/([0-9]+)\.png$/.exec(path);
  if (request.method === 'GET' && image?.[1] !== undefined) {
    return example(imageFetched(imageBytesOf(Number(image[1])), 'image/png'));
  }
  if (request.method === 'POST' && path === '/2/media/upload') {
    const media = parseMultipart(request.body, request.contentType).find(
      (part) => part.name === 'media',
    );
    return example(mediaUploaded(mediaIdOf(imageIndexOf(media?.bytes ?? new Uint8Array()))));
  }
  if (request.method === 'POST' && path === '/2/tweets') {
    return example(tweetCreated());
  }
  return example(xProblem(404, { title: 'Not Found' }));
}

/* -------------------------------------------------------------------------- */
/* ループバックのサーバ                                                         */
/* -------------------------------------------------------------------------- */

interface StreamState {
  sent: number;
  /** サーバ側で接続が閉じられた。 */
  closed: boolean;
  /** 閉じられた時点で応答を書き終えていたか（`end()` を呼んだか）。 */
  endedAtClose: boolean | null;
}

let server: Server;
let origin: string;
let received: Received[] = [];
let responder: Responder = defaultResponder;
let streamState: StreamState = { sent: 0, closed: false, endedAtClose: null };
/** 応答を保留した要求（afterAll で閉じる）。 */
const held: ServerResponse[] = [];

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

/**
 * `Content-Length` なしで `total` バイトを 64 KiB ずつ流す。**書き終えても `end()` しない。**
 * 受け手が上限で打ち切って接続を閉じたことを、`close` の時点で `end()` 前だったことで見分ける（#54）。
 */
function streamBytes(response: ServerResponse, total: number): void {
  const state: StreamState = { sent: 0, closed: false, endedAtClose: null };
  streamState = state;
  response.writeHead(200, { 'content-type': 'image/png' });
  response.on('close', () => {
    state.closed = true;
    state.endedAtClose = response.writableEnded;
  });
  const CHUNK = 64 * 1024;
  const writeMore = (): void => {
    while (state.sent < total && !state.closed) {
      const size = Math.min(CHUNK, total - state.sent);
      state.sent += size;
      if (!response.write(Buffer.alloc(size, 0x42))) {
        response.once('drain', writeMore);
        return;
      }
    }
  };
  writeMore();
  held.push(response);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Received = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: headerOf(request, 'authorization'),
        contentType: headerOf(request, 'content-type'),
        body: new Uint8Array(Buffer.concat(chunks)),
      };
      received.push(entry);

      const reply = responder(entry);
      switch (reply.kind) {
        case 'hang':
          held.push(response);
          return;
        case 'held': {
          // ヘッダだけ送り、本体は保留する。
          const { status, headers } = serializeExample(reply.example);
          response.writeHead(status, headers);
          response.flushHeaders();
          held.push(response);
          return;
        }
        case 'stream':
          streamBytes(response, reply.total);
          return;
        case 'example': {
          // **偽の `fetch` と同じ書き出し**（`serializeExample`）を通す（#58）。
          const { status, headers, body } = serializeExample(reply.example);
          response.writeHead(status, headers).end(Buffer.from(body));
          return;
        }
      }
    });
  });
  // listen は非同期。待たずに address() を読むと null になる。
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const response of held) {
    response.destroy();
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  responder = defaultResponder;
});

/* -------------------------------------------------------------------------- */
/* 本物の fetch をループバックへ向けるラッパ（#59 / #92）                            */
/* -------------------------------------------------------------------------- */

const X_API_PREFIX = 'https://api.x.com/';

/** このファイルが宣言する画像の URL（ラッパが通してよい起点）。 */
const DECLARED_IMAGES: readonly string[] = [imageUrlOf(0)];

interface Loopback {
  readonly fetch: typeof globalThis.fetch;
  /** 本物の `fetch` を呼んだ回数。 */
  readonly nativeCalls: () => number;
}

/**
 * **起点だけ**をループバックへ書き換えて本物の `fetch` を呼ぶ。`init` はそのまま渡す。
 *
 * 書き換え前の URL が `https://api.x.com/` か、宣言した画像の URL で始まらなければ、**本物を呼ばずに投げる**（#59）。
 */
function loopbackFetch(): Loopback {
  let calls = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    let rest: string | null = null;
    if (url.startsWith(X_API_PREFIX)) {
      rest = url.slice(X_API_PREFIX.length);
    } else if (DECLARED_IMAGES.some((image) => url.startsWith(image))) {
      rest = url.slice(`${IMAGE_ORIGIN}/`.length);
    }
    if (rest === null) {
      throw new Error(`宣言していない宛先へ出ようとした: ${url}`);
    }
    calls += 1;
    return await realFetch(`${origin}/${rest}`, init);
  };
  return { fetch: impl as typeof globalThis.fetch, nativeCalls: () => calls };
}

/* -------------------------------------------------------------------------- */
/* 偽の fetch（単体テストの偽物と同じ規則で応答し、要求を同じ形で記録する）          */
/* -------------------------------------------------------------------------- */

/** 本物の `fetch` と同じく、signal が発火したら `signal.reason` で reject する。 */
function rejectOnAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal === null || signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** 終わりのある stream（偽物側。打ち切りが壊れていても OOM にならない）。 */
function streamedResponse(total: number): Response {
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(64 * 1024, total - sent);
        sent += size;
        controller.enqueue(new Uint8Array(size).fill(0x42));
      },
    }),
    { status: 200, headers: { 'content-type': 'image/png' } },
  );
}

interface FakeFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly received: Received[];
}

/** 偽の X API。サーバと同じ `Responder` で応答し、サーバと同じ形で要求を記録する。 */
function fakeFetch(respond: Responder = defaultResponder): FakeFetch {
  const log: Received[] = [];
  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    // `fetch` が実際に送る形（FormData なら boundary つきの multipart）に組み立てて読む。
    const request = new Request(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body ?? null,
      duplex: 'half',
    } as RequestInit);
    const entry: Received = {
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get('authorization'),
      contentType: request.headers.get('content-type'),
      body: new Uint8Array(await request.arrayBuffer()),
    };
    log.push(entry);
    if (init.signal?.aborted === true) {
      throw init.signal.reason;
    }
    const reply = respond(entry);
    switch (reply.kind) {
      case 'hang':
        return await rejectOnAbort(init.signal);
      case 'held':
        return toHeldResponse(reply.example, init.signal ?? new AbortController().signal);
      case 'stream':
        return streamedResponse(reply.total);
      case 'example':
        return toResponse(reply.example, init.signal);
    }
  };
  return { fetch: impl as typeof globalThis.fetch, received: log };
}

/* -------------------------------------------------------------------------- */
/* 入力                                                                        */
/* -------------------------------------------------------------------------- */

const BODY = '秋の新作が入りました #とりふね';
const FIXED_NOW = new Date('2026-09-23T12:00:00.000Z');
const TWEETS_URL = 'https://api.x.com/2/tweets';

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000e001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000e001',
    body: BODY,
    scheduledAt: '2026-09-23T12:00:00.000Z',
    status: 'publishing',
    publishedAt: null,
    failureReason: null,
    deliveryMode: 'auto',
    media: [{ url: imageUrlOf(0), alt: null }],
    link: null,
    providerOptions: {},
    externalRef: null,
    externalId: null,
    externalUrl: null,
    failedAt: null,
    ...overrides,
  };
}

function accountView(): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000e001',
    provider: 'x',
    displayName: 'とりふね',
    handle: 'torifune_example',
    status: 'active',
    credentialConfigured: true,
  };
}

/** 呼ばれるたびに `nonce-0001`, `nonce-0002`, … を返す。配信ごとに作り直す（本物と偽物で同じ列にする）。 */
function sequentialNonce(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `nonce-${String(count).padStart(4, '0')}`;
  };
}

async function publishWith(
  impl: typeof globalThis.fetch,
  post: SocialPostView = postView(),
): Promise<PublishResult> {
  const publish = createXApiPublisher({
    fetch: impl,
    now: () => FIXED_NOW,
    nonce: sequentialNonce(),
  }).publish;
  if (publish === undefined) {
    throw new Error('publish が無い');
  }
  return await publish({
    post,
    account: accountView(),
    credential: { ...CREDENTIAL },
    attempt: 1,
    signal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

/** 比べるための形（boundary は毎回変わるので、種別と boundary の有無と中身に分ける）。 */
function comparable(entry: Received): Record<string, unknown> {
  const mediaType = entry.contentType?.split(';')[0]?.trim() ?? null;
  const base = {
    method: entry.method,
    path: entry.path,
    authorization: entry.authorization,
    mediaType,
  };
  if (mediaType === 'multipart/form-data') {
    return {
      ...base,
      boundary: /boundary=/.test(entry.contentType ?? ''),
      parts: parseMultipart(entry.body, entry.contentType).map((part) => ({
        name: part.name,
        contentType: part.contentType,
        bytes: [...part.bytes],
      })),
    };
  }
  if (mediaType === 'application/json') {
    return { ...base, json: JSON.parse(new TextDecoder().decode(entry.body)) as unknown };
  }
  return { ...base, bodyLength: entry.body.length };
}

/* -------------------------------------------------------------------------- */
/* AbortSignal.timeout の差し替え（#57 の publish() で合計の期限を手で発火させる）      */
/* -------------------------------------------------------------------------- */

function probeTimeouts(): {
  fire(ms: number): void;
  restore(): void;
} {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const created: { ms: number; controller: AbortController }[] = [];
  AbortSignal.timeout = ((ms: number): AbortSignal => {
    const controller = new AbortController();
    created.push({ ms, controller });
    return controller.signal;
  }) as typeof AbortSignal.timeout;
  return {
    fire: (ms) => {
      created
        .find((entry) => entry.ms === ms)
        ?.controller.abort(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        );
    },
    restore: () => {
      AbortSignal.timeout = original as typeof AbortSignal.timeout;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* #52 正常系                                                                   */
/* -------------------------------------------------------------------------- */

describe('#52 本物の fetch で画像 1 枚の正常系が通る', () => {
  it('#52 ループバック越しの本物の fetch で ok: true になり、externalId と externalUrl を返す', async () => {
    const loopback = loopbackFetch();

    const result = await publishWith(loopback.fetch);

    expect(result).toEqual({
      ok: true,
      externalId: TWEET_ID,
      externalUrl: `https://x.com/i/status/${TWEET_ID}`,
    });
    expect(loopback.nativeCalls()).toBe(3);
  });

  it('#52 サーバが受け取ったメソッドとパスは R1 → R2 → R3', async () => {
    await publishWith(loopbackFetch().fetch);

    expect(received.map((entry) => [entry.method, entry.path])).toEqual([
      ['GET', '/images/0.png'],
      ['POST', '/2/media/upload'],
      ['POST', '/2/tweets'],
    ]);
  });

  it('#52 R2 の content-type は multipart/form-data; boundary=…（本物の fetch が付ける）', async () => {
    await publishWith(loopbackFetch().fetch);

    expect(received[1]?.contentType ?? '').toMatch(/^multipart\/form-data; boundary=\S+/);
  });

  it('#52 R2 の multipart に media_category=tweet_image と、R1 の画像のバイト列（種別 image/png）がある', async () => {
    await publishWith(loopbackFetch().fetch);
    const parts = parseMultipart(
      received[1]?.body ?? new Uint8Array(),
      received[1]?.contentType ?? null,
    );
    const category = parts.find((part) => part.name === 'media_category');
    const media = parts.find((part) => part.name === 'media');

    expect(new TextDecoder().decode(category?.bytes)).toBe('tweet_image');
    expect([...(media?.bytes ?? [])]).toEqual([...imageBytesOf(0)]);
    expect(media?.contentType).toBe('image/png');
  });

  it('#52 R3 の content-type は application/json で、本体は { text, media: { media_ids } }', async () => {
    await publishWith(loopbackFetch().fetch);
    const r3 = received[2];

    expect(r3?.contentType?.split(';')[0]?.trim()).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(r3?.body))).toStrictEqual({
      text: BODY,
      media: { media_ids: [mediaIdOf(0)] },
    });
  });

  it('#52 R1 に authorization が無く、R2 / R3 には OAuth の authorization がある', async () => {
    await publishWith(loopbackFetch().fetch);

    expect(received[0]?.authorization).toBeNull();
    expect(received[1]?.authorization ?? '').toMatch(/^OAuth /);
    expect(received[2]?.authorization ?? '').toMatch(/^OAuth /);
  });

  it('#52 同じ配信で、サーバが受け取った要求と偽の fetch が受け取った要求が一致する（authorization・multipart・JSON を含む）', async () => {
    const fake = fakeFetch();

    await publishWith(loopbackFetch().fetch);
    await publishWith(fake.fetch);

    expect(received.map(comparable)).toEqual(fake.received.map(comparable));
  });

  it('#52 同じ配信の結果が本物と偽物で一致する', async () => {
    const real = await publishWith(loopbackFetch().fetch);
    const faked = await publishWith(fakeFetch().fetch);

    expect(real).toEqual(faked);
  });
});

/* -------------------------------------------------------------------------- */
/* #53 302                                                                     */
/* -------------------------------------------------------------------------- */

describe('#53 本物の 302 は偽の 302 と同じ retryable になる', () => {
  function redirectingR1(request: Received): Reply {
    return request.path.startsWith('/images/')
      ? example(redirectTo(`${origin}/followed`))
      : defaultResponder(request);
  }

  it('#53 本物の fetch（redirect: manual）は 302 を追わず、retryable: false', async () => {
    responder = redirectingR1;

    const result = await publishWith(loopbackFetch().fetch);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.retryable).toBe(false);
    // 追っていれば /followed への要求が 2 本目として届く。
    expect(received.map((entry) => entry.path)).toEqual(['/images/0.png']);
  });

  it('#53 偽の 302 を返したときと結果が同じ', async () => {
    responder = redirectingR1;

    const real = await publishWith(loopbackFetch().fetch);
    const faked = await publishWith(fakeFetch(redirectingR1).fetch);

    expect(real).toEqual(faked);
  });

  it('#53 本物の fetch は redirect: manual なら 302 を Response として返す（reject しない）', async () => {
    responder = redirectingR1;

    const response = await loopbackFetch().fetch(imageUrlOf(0), { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(received).toHaveLength(1);
  });

  it("#53 本物の fetch は redirect: 'error' なら reject する（3xx を観測できず、接続の失敗と見分けられない）", async () => {
    responder = redirectingR1;

    await expect(
      loopbackFetch().fetch(imageUrlOf(0), { redirect: 'error' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(received).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #54 Content-Length なしの大きな画像                                           */
/* -------------------------------------------------------------------------- */

describe('#54 Content-Length なしの 5,000,001 バイトを本物の fetch でも打ち切る', () => {
  function streamingR1(request: Received): Reply {
    return request.path.startsWith('/images/')
      ? { kind: 'stream', total: 5_000_001 }
      : defaultResponder(request);
  }

  async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!condition() && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('#54 本物の fetch で retryable: false になり、R2 / R3 を送らない', async () => {
    responder = streamingR1;

    const result = await publishWith(loopbackFetch().fetch);

    expect(result.ok ? null : result.retryable).toBe(false);
    expect(received.map((entry) => entry.path)).toEqual(['/images/0.png']);
  });

  it('#54 サーバ側で、応答を書き終える（end）前に接続が閉じられる', async () => {
    // サーバは 5,000,001 バイトを書いても end() しない。受け手が上限で打ち切って閉じなければ close は来ない。
    responder = streamingR1;

    await publishWith(loopbackFetch().fetch);
    await waitUntil(() => streamState.closed);

    expect(streamState.closed).toBe(true);
    expect(streamState.endedAtClose).toBe(false);
  });

  it('#54 偽物（終わりのある stream）を与えたときと結果が同じ', async () => {
    responder = streamingR1;

    const real = await publishWith(loopbackFetch().fetch);
    const faked = await publishWith(fakeFetch(streamingR1).fetch);

    expect(real).toEqual(faked);
  });
});

/* -------------------------------------------------------------------------- */
/* #55 応答しないサーバ                                                         */
/* -------------------------------------------------------------------------- */

describe('#55 応答しないサーバで sendXRequest が timeout になる', () => {
  function request(
    impl: typeof globalThis.fetch,
    parentSignal: AbortSignal,
  ): ReturnType<typeof sendXRequest> {
    // **制限時間の定数は差し替えない**（結線は #60 が見る）。短い期限は外側の signal に混ぜる。
    return sendXRequest({
      impl,
      url: TWEETS_URL,
      init: { method: 'POST' },
      timeoutMs: CREATE_TWEET_TIMEOUT_MS,
      parentSignal,
    });
  }

  it('#55 本物の fetch に短い AbortSignal.timeout を混ぜると、分類が timeout', async () => {
    responder = () => ({ kind: 'hang' });

    const outcome = await request(loopbackFetch().fetch, AbortSignal.timeout(100));

    expect(outcome.kind).toBe('timeout');
    expect(received).toHaveLength(1);
  });

  it('#55 偽の fetch（signal の発火で reject する）を与えても同じ分類', async () => {
    const outcome = await request(
      fakeFetch(() => ({ kind: 'hang' })).fetch,
      AbortSignal.timeout(100),
    );

    expect(outcome.kind).toBe('timeout');
  });

  it('#55 呼び出し側の abort() で止めたときも、本物と偽物で分類が同じ', async () => {
    responder = () => ({ kind: 'hang' });
    const real = new AbortController();
    const fake = new AbortController();
    setTimeout(() => real.abort(), 50);
    setTimeout(() => fake.abort(), 50);

    const [fromReal, fromFake] = await Promise.all([
      request(loopbackFetch().fetch, real.signal),
      request(fakeFetch(() => ({ kind: 'hang' })).fetch, fake.signal),
    ]);

    expect(fromReal.kind).toBe(fromFake.kind);
  });

  it('#55 sendXRequest は 3xx を response として返す（本物の fetch でも偽物でも）', async () => {
    responder = () => example(redirectTo(`${origin}/followed`));

    const fromReal = await request(loopbackFetch().fetch, new AbortController().signal);
    const fromFake = await request(
      fakeFetch(() => example(redirectTo(`${origin}/followed`))).fetch,
      new AbortController().signal,
    );

    expect(fromReal.kind).toBe('response');
    expect(fromFake.kind).toBe('response');
  });
});

/* -------------------------------------------------------------------------- */
/* #56 abort されたときの error.name                                             */
/* -------------------------------------------------------------------------- */

describe('#56 本物の fetch が abort されたときの error.name', () => {
  async function rejectionOf(impl: typeof globalThis.fetch, signal: AbortSignal): Promise<unknown> {
    try {
      await impl(TWEETS_URL, { method: 'POST', signal });
    } catch (error) {
      return error;
    }
    throw new Error('reject しなかった');
  }

  function nameOf(value: unknown): unknown {
    return (value as { readonly name?: unknown }).name;
  }

  it('#56 AbortSignal.timeout で止めると、本物は TimeoutError で reject する', async () => {
    responder = () => ({ kind: 'hang' });

    const error = await rejectionOf(loopbackFetch().fetch, AbortSignal.timeout(50));

    expect(nameOf(error)).toBe('TimeoutError');
  });

  it('#56 AbortController.abort() で止めると、本物は AbortError で reject する', async () => {
    responder = () => ({ kind: 'hang' });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const error = await rejectionOf(loopbackFetch().fetch, controller.signal);

    expect(nameOf(error)).toBe('AbortError');
  });

  it('#56 AbortSignal.any に混ぜた timeout でも、本物は TimeoutError で reject する', async () => {
    // Plugin は要求ごとに `AbortSignal.any([外側, AbortSignal.timeout(ms)])` を渡す（設計 §6.6）。
    responder = () => ({ kind: 'hang' });

    const error = await rejectionOf(
      loopbackFetch().fetch,
      AbortSignal.any([new AbortController().signal, AbortSignal.timeout(50)]),
    );

    expect(nameOf(error)).toBe('TimeoutError');
  });

  it('#56 本物は signal.reason そのもので reject する（偽物が真似ている振る舞い）', async () => {
    responder = () => ({ kind: 'hang' });
    const signal = AbortSignal.timeout(50);

    const error = await rejectionOf(loopbackFetch().fetch, signal);

    expect(error).toBe(signal.reason);
  });

  it('#56 偽の fetch は本物と同じ name で reject する（timeout / abort() の両方）', async () => {
    responder = () => ({ kind: 'hang' });
    const realController = new AbortController();
    const fakeController = new AbortController();
    setTimeout(() => realController.abort(), 30);
    setTimeout(() => fakeController.abort(), 30);
    const hanging = (): FakeFetch => fakeFetch(() => ({ kind: 'hang' }));

    const names = await Promise.all([
      rejectionOf(loopbackFetch().fetch, AbortSignal.timeout(50)).then(nameOf),
      rejectionOf(hanging().fetch, AbortSignal.timeout(50)).then(nameOf),
      rejectionOf(loopbackFetch().fetch, realController.signal).then(nameOf),
      rejectionOf(hanging().fetch, fakeController.signal).then(nameOf),
    ]);

    expect(names).toEqual(['TimeoutError', 'TimeoutError', 'AbortError', 'AbortError']);
  });
});

/* -------------------------------------------------------------------------- */
/* #57 ヘッダ受信後の abort（本体の読み込み）                                       */
/* -------------------------------------------------------------------------- */

describe('#57 ヘッダの後の abort で本体の読み込みが reject する（本物と偽物）', () => {
  async function readError(read: () => Promise<unknown>): Promise<unknown> {
    try {
      await read();
    } catch (error) {
      return error;
    }
    return null;
  }

  function heldR3(request: Received): Reply {
    return request.path === '/2/tweets'
      ? { kind: 'held', example: tweetCreated() }
      : defaultResponder(request);
  }

  it('#57 本物：ヘッダ（201）を受け取った後、本体を保留している間に abort() すると text() が signal.reason で reject する', async () => {
    responder = heldR3;
    const controller = new AbortController();
    const response = await loopbackFetch().fetch(TWEETS_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();

    const error = await readError(() => response.text());

    expect(response.status).toBe(201);
    expect(error).toBe(controller.signal.reason);
    expect((error as { readonly name?: unknown }).name).toBe('AbortError');
  });

  it('#57 偽物（test-support/x-api.ts の toHeldResponse）も同じく signal.reason で reject する', async () => {
    const controller = new AbortController();
    const response = await fakeFetch(heldR3).fetch(TWEETS_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();

    const error = await readError(() => response.text());

    expect(response.status).toBe(201);
    expect(error).toBe(controller.signal.reason);
  });

  it('#57 本物：本体を受信済みでも、読み終える前に abort() すると text() が reject する', async () => {
    // 038 検証 §2 の 2（Node v24 で実測）。本体が小さく、abort の時点で受信は終わっている。
    const controller = new AbortController();
    const response = await loopbackFetch().fetch(TWEETS_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    expect(await readError(() => response.text())).toBe(controller.signal.reason);
  });

  it('#57 偽物（toResponse の本体）も、読み終える前の abort() で text() が reject する', async () => {
    const controller = new AbortController();
    const response = await fakeFetch().fetch(TWEETS_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();

    expect(await readError(() => response.text())).toBe(controller.signal.reason);
  });

  it('#57 本物も偽物も、読み終えた後の abort() は読んだ本体を覆さない', async () => {
    const realController = new AbortController();
    const fakeController = new AbortController();
    const real = await loopbackFetch().fetch(TWEETS_URL, {
      method: 'POST',
      signal: realController.signal,
    });
    const faked = await fakeFetch().fetch(TWEETS_URL, {
      method: 'POST',
      signal: fakeController.signal,
    });
    const texts = [await real.text(), await faked.text()];
    realController.abort();
    fakeController.abort();

    expect(texts.map((text) => JSON.parse(text) as unknown)).toEqual([
      tweetCreated().body,
      tweetCreated().body,
    ]);
  });

  /** R3 のヘッダを受け取った直後に、合計の期限（PUBLISH_TOTAL_BUDGET_MS）を発火させる。 */
  async function publishFiringTotalAfterR3Headers(
    impl: typeof globalThis.fetch,
  ): Promise<PublishResult> {
    const probe = probeTimeouts();
    try {
      const wrapped = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) => {
        const response = await impl(input, init);
        if (String(input) === TWEETS_URL) {
          probe.fire(PUBLISH_TOTAL_BUDGET_MS);
        }
        return response;
      }) as typeof globalThis.fetch;
      return await publishWith(wrapped, postView({ media: [] }));
    } finally {
      probe.restore();
    }
  }

  it('#57 本物：R3 のヘッダの後・本体を読み切る前に合計の期限が発火すると publish() は retryable: false', async () => {
    responder = heldR3;

    const result = await publishFiringTotalAfterR3Headers(loopbackFetch().fetch);

    expect(result.ok ? null : result.retryable).toBe(false);
    expect(received.map((entry) => entry.path)).toEqual(['/2/tweets']);
  });

  it('#57 偽物でも同じく retryable: false（本物と同じ結果）', async () => {
    responder = heldR3;

    const real = await publishFiringTotalAfterR3Headers(loopbackFetch().fetch);
    const faked = await publishFiringTotalAfterR3Headers(fakeFetch(heldR3).fetch);

    expect(faked.ok ? null : faked.retryable).toBe(false);
    expect(real).toEqual(faked);
  });
});

/* -------------------------------------------------------------------------- */
/* #58 応答例の共有                                                             */
/* -------------------------------------------------------------------------- */

describe('#58 単体テストとループバックのサーバが 1 つの応答例を共有する', () => {
  it.each([
    ['R1 画像', imageFetched(PNG_BYTES, 'image/png')],
    ['R2 成功', mediaUploaded()],
    ['R3 成功', tweetCreated()],
    ['problem 403', xProblem(403)],
    ['429', rateLimited('1790000060')],
    ['302', redirectTo()],
    ['HTML 500', htmlPage(500)],
  ] as const)(
    '#58 %s：サーバが返す応答と偽の fetch が返す Response が同じ status・本体・ヘッダになる',
    async (_label, value) => {
      responder = () => example(value);

      // 本物の fetch もラッパ越しにだけ使う（#92）。`https://api.x.com/any` はサーバの `/any` に届く。
      const fromServer = await loopbackFetch().fetch(`${X_API_PREFIX}any`, { redirect: 'manual' });
      const fromFake = toResponse(value);

      expect(fromServer.status).toBe(fromFake.status);
      expect([...new Uint8Array(await fromServer.arrayBuffer())]).toEqual([
        ...new Uint8Array(await fromFake.arrayBuffer()),
      ]);
      for (const name of ['location', 'x-rate-limit-reset']) {
        expect(fromServer.headers.get(name), name).toBe(fromFake.headers.get(name));
      }
      // 応答例が宣言した content-type はどちらにも同じく付く（宣言しない 302 では new Response() だけが補う）。
      const declared = serializeExample(value).headers['content-type'] ?? null;
      expect(fromServer.headers.get('content-type')).toBe(declared);
      if (declared !== null) {
        expect(fromFake.headers.get('content-type')).toBe(declared);
      }
    },
  );

  it('#58 サーバは serializeExample で、偽の fetch は toResponse で書き出す（同じ定義を通る）', async () => {
    const value = tweetCreated();

    expect(await toResponse(value).text()).toBe(serializeExample(value).body);
  });
});

/* -------------------------------------------------------------------------- */
/* #59 ラッパは想定外の宛先で本物を呼ばない                                        */
/* -------------------------------------------------------------------------- */

describe('#59 ラッパは宣言していない宛先で本物の fetch を呼ばずに投げる', () => {
  it('#59 https://example.test/ を渡すと投げる', async () => {
    const loopback = loopbackFetch();

    await expect(loopback.fetch('https://example.test/')).rejects.toThrow();
  });

  it('#59 そのときサーバは要求を 1 本も受け取っていない', async () => {
    const loopback = loopbackFetch();

    await loopback.fetch('https://example.test/').catch(() => undefined);

    expect(received).toHaveLength(0);
    expect(loopback.nativeCalls()).toBe(0);
  });

  it.each([
    'http://api.x.com/2/tweets',
    'https://api.x.com.evil.test/2/tweets',
    'https://api.twitter.com/2/tweets',
    'https://cdn.example.test.evil/images/0.png',
    imageUrlOf(1),
  ])('#59 %s も同じく投げる', async (url) => {
    const loopback = loopbackFetch();

    await expect(loopback.fetch(url)).rejects.toThrow();
    expect(loopback.nativeCalls()).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('#59 宛先の定数は https://api.x.com（ラッパの前提と一致する）', () => {
    expect(`${X_API_BASE_URL}/`).toBe(X_API_PREFIX);
  });
});
