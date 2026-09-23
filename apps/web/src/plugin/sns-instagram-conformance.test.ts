import type { PublishResult, SocialAccountView, SocialPostView } from '@torifune/plugin-api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ACCESS_TOKEN,
  CONTAINER_ID,
  IG_USER_ID,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  containerCreated,
  containerStatus,
  mediaPublished,
  permalinkOf,
  redirectTo,
  serializeExample,
  toResponse,
  tokenRefreshed,
  type GraphResponseExample,
} from '@/test-support/instagram-graph';
import {
  GRAPH_API_BASE_URL,
  GRAPH_API_VERSION,
  STATUS_TIMEOUT_MS,
  sendGraphRequest,
} from '../../../../plugins/sns-instagram/graph';
import { createInstagramPublisher, defaultWait } from '../../../../plugins/sns-instagram/social';

/**
 * 偽物と本物の一致（038-sns-instagram 設計 §10.9 #64〜#69、#98）。
 *
 * この Plugin の単体テストは `fetch` / `now` / `wait` をすべて偽物にしている。
 * **偽物が本物と違う振る舞いをすると、表の行が緑のまま本番の分岐が死ぬ**（036 検証レポート R-1）。
 * ここだけは `node:http` の**ループバック（127.0.0.1）のサーバ**に**本物の `fetch`** を当て、
 * 偽物を使う前提そのものを確かめる。**外部への通信は 1 本も出ない。**
 *
 * - 本物の `fetch` はモジュールの読み込み時に退避し、**ラッパ越しにだけ**使う（#98）
 * - ラッパは書き換え前の URL が `https://graph.instagram.com/` で始まらなければ、本物を呼ばずに投げる
 * - サーバの応答は `test-support/instagram-graph.ts` の応答例から作る（#69）
 *
 * #97：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 */

/** 本物の `fetch`。**読み込み時に退避する**（`beforeEach` が投げる実装へ置き換える前）。 */
const nativeFetch: typeof globalThis.fetch = globalThis.fetch;

let savedFetch: typeof globalThis.fetch;

beforeEach(() => {
  // #97：本物の `fetch` を素のまま呼んだら落ちる。本物はラッパ越しにだけ使う。
  savedFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
});

/* -------------------------------------------------------------------------- */
/* ループバックのサーバ                                                         */
/* -------------------------------------------------------------------------- */

/** サーバが受け取った要求。偽の `fetch` が記録するものと同じ形にそろえる。 */
interface Received {
  readonly method: string;
  /** パスとクエリ（起点を除いたもの）。 */
  readonly target: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

type Responder = (received: Received) => GraphResponseExample | 'hang';

const PRIMARY_EXPIRES_AT = '2026-11-02T12:00:00.000Z';

/** 時計の起点（期限は 40 日後。延長しない）。 */
const FIXED_NOW = new Date('2026-09-23T12:00:00.000Z');

let server: Server;
let origin: string;
let received: Received[] = [];
let responder: Responder = defaultResponder;
/** 応答を保留した要求（afterAll で閉じる）。 */
const held: ServerResponse[] = [];

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

/** 要求の種類を見分ける（パスとメソッド。偽の Graph API と同じ規則）。 */
function defaultResponder(request: Received): GraphResponseExample {
  const url = new URL(request.target, 'http://loopback.invalid');
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (url.pathname === '/refresh_access_token') {
    return tokenRefreshed();
  }
  if (request.method === 'POST' && parts[2] === 'media') {
    return containerCreated(CONTAINER_ID);
  }
  if (request.method === 'POST' && parts[2] === 'media_publish') {
    return mediaPublished();
  }
  if (request.method === 'GET' && url.searchParams.get('fields') === 'status_code') {
    return containerStatus('FINISHED', parts[1] ?? '');
  }
  if (request.method === 'GET' && url.searchParams.get('fields') === 'permalink') {
    return permalinkOf();
  }
  return { status: 404, body: { error: { message: 'not found', code: 100 } } };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Received = {
        method: request.method ?? '',
        target: request.url ?? '',
        authorization: headerOf(request, 'authorization'),
        contentType: headerOf(request, 'content-type'),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(entry);

      const reply = responder(entry);
      if (reply === 'hang') {
        held.push(response);
        return;
      }
      // **偽の `fetch` と同じ書き出し**（`serializeExample`）を通す（#69）。
      const { status, headers, body } = serializeExample(reply);
      response.writeHead(status, headers).end(body);
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
/* 本物の fetch をループバックへ向けるラッパ（#98）                                */
/* -------------------------------------------------------------------------- */

const GRAPH_ORIGIN_PREFIX = 'https://graph.instagram.com/';

interface Loopback {
  readonly fetch: typeof globalThis.fetch;
  /** 本物の `fetch` を呼んだ回数。 */
  readonly nativeCalls: () => number;
}

/**
 * **起点だけ**をループバックへ書き換えて本物の `fetch` を呼ぶ。`init` はそのまま渡す。
 *
 * 書き換え前の URL が Graph API の宛先で始まらなければ、**本物を呼ばずに投げる**（#98）。
 * 想定外の宛先へ出ていないことの確認を兼ねる。
 */
function loopbackFetch(): Loopback {
  let calls = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(GRAPH_ORIGIN_PREFIX)) {
      throw new Error(`Graph API 以外の宛先へ出ようとした: ${url}`);
    }
    calls += 1;
    return await nativeFetch(`${origin}/${url.slice(GRAPH_ORIGIN_PREFIX.length)}`, init);
  };
  return { fetch: impl as typeof globalThis.fetch, nativeCalls: () => calls };
}

/* -------------------------------------------------------------------------- */
/* 偽の fetch（単体テストの偽物と同じ規則で応答し、要求を同じ形で記録する）          */
/* -------------------------------------------------------------------------- */

/** 本物の `fetch` と同じく、signal が発火したら `signal.reason` で reject する（単体テストの偽物と同じ）。 */
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

interface FakeFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly received: Received[];
}

/** 偽の Graph API。サーバと同じ `Responder` で応答し、サーバと同じ形で要求を記録する。 */
function fakeFetch(respond: Responder = defaultResponder): FakeFetch {
  const log: Received[] = [];
  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const entry: Received = {
      method: init.method ?? 'GET',
      target: `${url.pathname}${url.search}`,
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init.body === 'string' ? init.body : '',
    };
    log.push(entry);
    if (init.signal?.aborted === true) {
      throw init.signal.reason;
    }
    const reply = respond(entry);
    if (reply === 'hang') {
      return await rejectOnAbort(init.signal);
    }
    return toResponse(reply);
  };
  return { fetch: impl as typeof globalThis.fetch, received: log };
}

/* -------------------------------------------------------------------------- */
/* 入力                                                                        */
/* -------------------------------------------------------------------------- */

const BODY = '秋の新作が入りました #とりふね';
const IMAGE_URL = 'https://cdn.example.test/images/0.jpg';

function postView(): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000c001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000c001',
    body: BODY,
    scheduledAt: '2026-09-23T12:00:00.000Z',
    status: 'publishing',
    publishedAt: null,
    failureReason: null,
    deliveryMode: 'auto',
    media: [{ url: IMAGE_URL, alt: null }],
    link: null,
    providerOptions: {},
    externalRef: null,
    externalId: null,
    externalUrl: null,
    failedAt: null,
  };
}

function accountView(): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000c001',
    provider: 'instagram',
    displayName: 'とりふね',
    handle: 'torifune.example',
    status: 'active',
    credentialConfigured: true,
  };
}

async function publishWith(
  impl: typeof globalThis.fetch,
  expiresAt: string = PRIMARY_EXPIRES_AT,
): Promise<PublishResult> {
  const publish = createInstagramPublisher({ fetch: impl, now: () => FIXED_NOW }).publish;
  if (publish === undefined) {
    throw new Error('publish が無い');
  }
  return await publish({
    post: postView(),
    account: accountView(),
    credential: {
      igUserId: IG_USER_ID,
      accessToken: ACCESS_TOKEN,
      accessTokenExpiresAt: expiresAt,
    },
    attempt: 1,
    signal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

function versioned(path: string): string {
  return `/${GRAPH_API_VERSION}/${path}`;
}

/** 画像 1 枚の正常系で出るはずの要求（単体テスト #29 / #30 / #36 / #37 が偽物で確かめている値）。 */
const SINGLE_IMAGE_REQUESTS: readonly Received[] = [
  {
    method: 'POST',
    target: versioned(`${IG_USER_ID}/media`),
    authorization: `Bearer ${ACCESS_TOKEN}`,
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({ image_url: IMAGE_URL, caption: BODY }).toString(),
  },
  {
    method: 'GET',
    target: `${versioned(CONTAINER_ID)}?fields=status_code`,
    authorization: `Bearer ${ACCESS_TOKEN}`,
    contentType: null,
    body: '',
  },
  {
    method: 'POST',
    target: versioned(`${IG_USER_ID}/media_publish`),
    authorization: `Bearer ${ACCESS_TOKEN}`,
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams({ creation_id: CONTAINER_ID }).toString(),
  },
  {
    method: 'GET',
    target: `${versioned(MEDIA_ID)}?fields=permalink`,
    authorization: `Bearer ${ACCESS_TOKEN}`,
    contentType: null,
    body: '',
  },
];

/* -------------------------------------------------------------------------- */
/* #64 正常系                                                                   */
/* -------------------------------------------------------------------------- */

describe('#64 本物の fetch で画像 1 枚の正常系が通る', () => {
  it('#64 ループバック越しの本物の fetch で ok: true になり、media ID と permalink を返す', async () => {
    const loopback = loopbackFetch();

    const result = await publishWith(loopback.fetch);

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(loopback.nativeCalls()).toBe(4);
  });

  it('#64 サーバが受け取ったメソッド・パス・authorization・content-type・form の本体が、単体テストで確かめている値と一致する', async () => {
    await publishWith(loopbackFetch().fetch);

    expect(received).toEqual(SINGLE_IMAGE_REQUESTS);
  });

  it('#64 同じ配信で、サーバが受け取った要求と偽の fetch が受け取った要求が一致する', async () => {
    const fake = fakeFetch();

    await publishWith(loopbackFetch().fetch);
    await publishWith(fake.fetch);

    expect(received).toEqual(fake.received);
  });

  it('#64 延長（R6）も同じ：版の付かないパス・クエリの access_token・authorization なし', async () => {
    // 期限が 10 日後なら R5 の後に R6 を送る（設計 §6.7）。
    const fake = fakeFetch();

    const real = await publishWith(loopbackFetch().fetch, '2026-10-03T12:00:00.000Z');
    const faked = await publishWith(fake.fetch, '2026-10-03T12:00:00.000Z');

    expect(real).toEqual(faked);
    expect(real.ok && real.rotatedCredential?.['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
    const refresh = received[received.length - 1];
    expect(refresh).toEqual({
      method: 'GET',
      target: `/refresh_access_token?${new URLSearchParams({
        grant_type: 'ig_refresh_token',
        access_token: ACCESS_TOKEN,
      }).toString()}`,
      authorization: null,
      contentType: null,
      body: '',
    });
    expect(received).toEqual(fake.received);
  });
});

/* -------------------------------------------------------------------------- */
/* #65 302                                                                     */
/* -------------------------------------------------------------------------- */

describe('#65 本物の 302 は偽の 302 と同じ retryable になる', () => {
  function redirectingR1(location: string): Responder {
    return (request) =>
      request.method === 'POST' && request.target.endsWith('/media')
        ? redirectTo(location)
        : defaultResponder(request);
  }

  it('#65 本物の fetch（redirect: manual）は 302 を追わず、P1 で retryable: false', async () => {
    responder = redirectingR1(`${origin}/followed`);

    const result = await publishWith(loopbackFetch().fetch);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.retryable).toBe(false);
    // 追っていれば /followed への要求が 2 本目として届く。
    expect(received.map((request) => request.target)).toEqual([versioned(`${IG_USER_ID}/media`)]);
  });

  it('#65 偽の 302 を返したときと結果が同じ', async () => {
    responder = redirectingR1(`${origin}/followed`);
    const fake = fakeFetch(redirectingR1(`${origin}/followed`));

    const real = await publishWith(loopbackFetch().fetch);
    const faked = await publishWith(fake.fetch);

    expect(real).toEqual(faked);
  });

  it('#65 本物の fetch は 302 を Response として返す（reject しない）', async () => {
    // 3xx が観測できずに `network` へ化けると retryable: true に倒れる（036 検証レポート R-1）。
    responder = () => redirectTo(`${origin}/followed`);

    const response = await nativeFetch(`${origin}/start`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(received).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #66 応答しないサーバ                                                         */
/* -------------------------------------------------------------------------- */

describe('#66 応答しないサーバで sendGraphRequest が timeout になる', () => {
  const PATH = `${versioned(CONTAINER_ID)}`;

  function request(
    impl: typeof globalThis.fetch,
    signal: AbortSignal,
  ): ReturnType<typeof sendGraphRequest> {
    // **制限時間の定数は差し替えない**（結線は #70 が見る）。短い期限は外側の signal に混ぜる。
    return sendGraphRequest({
      impl,
      method: 'GET',
      path: PATH,
      query: { fields: 'status_code' },
      bearerToken: ACCESS_TOKEN,
      timeoutMs: STATUS_TIMEOUT_MS,
      signal,
    });
  }

  it('#66 本物の fetch に短い AbortSignal.timeout を混ぜると、分類が timeout', async () => {
    responder = () => 'hang';

    const outcome = await request(loopbackFetch().fetch, AbortSignal.timeout(100));

    expect(outcome).toEqual({ kind: 'timeout' });
    expect(received).toHaveLength(1);
  });

  it('#66 偽の fetch（signal の発火で reject する）を与えても同じ分類', async () => {
    const outcome = await request(fakeFetch(() => 'hang').fetch, AbortSignal.timeout(100));

    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('#66 呼び出し側の abort() で止めたときも、本物と偽物で分類が同じ（aborted）', async () => {
    responder = () => 'hang';
    const real = new AbortController();
    const fake = new AbortController();
    setTimeout(() => real.abort(), 50);
    setTimeout(() => fake.abort(), 50);

    const outcomes = await Promise.all([
      request(loopbackFetch().fetch, real.signal),
      request(fakeFetch(() => 'hang').fetch, fake.signal),
    ]);

    expect(outcomes).toEqual([{ kind: 'aborted' }, { kind: 'aborted' }]);
  });
});

/* -------------------------------------------------------------------------- */
/* #67 abort されたときの error.name                                             */
/* -------------------------------------------------------------------------- */

describe('#67 本物の fetch が abort されたときの error.name', () => {
  async function rejectionOf(impl: typeof globalThis.fetch, signal: AbortSignal): Promise<unknown> {
    try {
      await impl(`${GRAPH_API_BASE_URL}${versioned(CONTAINER_ID)}`, { signal });
    } catch (error) {
      return error;
    }
    throw new Error('reject しなかった');
  }

  function nameOf(value: unknown): unknown {
    return (value as { readonly name?: unknown }).name;
  }

  it('#67 AbortSignal.timeout で止めると、本物は TimeoutError で reject する', async () => {
    // 実測（Node 22 / 24）。G2・G3 の分類（`TimeoutError` → timeout）が拠り所にしている値。
    responder = () => 'hang';

    const error = await rejectionOf(loopbackFetch().fetch, AbortSignal.timeout(50));

    expect(nameOf(error)).toBe('TimeoutError');
  });

  it('#67 AbortController.abort() で止めると、本物は AbortError で reject する', async () => {
    responder = () => 'hang';
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const error = await rejectionOf(loopbackFetch().fetch, controller.signal);

    expect(nameOf(error)).toBe('AbortError');
  });

  it('#67 AbortSignal.any に混ぜた timeout でも、本物は TimeoutError で reject する', async () => {
    // Plugin は要求ごとに `AbortSignal.any([外側, AbortSignal.timeout(ms)])` を渡す（設計 §6.8）。
    responder = () => 'hang';

    const error = await rejectionOf(
      loopbackFetch().fetch,
      AbortSignal.any([new AbortController().signal, AbortSignal.timeout(50)]),
    );

    expect(nameOf(error)).toBe('TimeoutError');
  });

  it('#67 本物は signal.reason そのもので reject する（偽物が真似ている振る舞い）', async () => {
    responder = () => 'hang';
    const signal = AbortSignal.timeout(50);

    const error = await rejectionOf(loopbackFetch().fetch, signal);

    expect(error).toBe(signal.reason);
  });

  it('#67 偽の fetch は本物と同じ name で reject する（timeout / abort() の両方）', async () => {
    responder = () => 'hang';
    const realController = new AbortController();
    const fakeController = new AbortController();
    setTimeout(() => realController.abort(), 30);
    setTimeout(() => fakeController.abort(), 30);

    const names = await Promise.all([
      rejectionOf(loopbackFetch().fetch, AbortSignal.timeout(50)).then(nameOf),
      rejectionOf(fakeFetch(() => 'hang').fetch, AbortSignal.timeout(50)).then(nameOf),
      rejectionOf(loopbackFetch().fetch, realController.signal).then(nameOf),
      rejectionOf(fakeFetch(() => 'hang').fetch, fakeController.signal).then(nameOf),
    ]);

    expect(names).toEqual(['TimeoutError', 'TimeoutError', 'AbortError', 'AbortError']);
  });

  it('#67 単体テストが「自前の制限時間」として投げる DOMException も同じ name', () => {
    // `sns-instagram-retry.test.ts` の `timedOut()` と同じ組み立て。
    expect(new DOMException('The operation was aborted due to timeout', 'TimeoutError').name).toBe(
      'TimeoutError',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #68 既定の wait                                                              */
/* -------------------------------------------------------------------------- */

describe('#68 既定の wait は signal の発火で待たずに終わる', () => {
  it('#68 10 秒の待ちでも、signal が発火すればすぐ reject する', async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 20);

    const error = await defaultWait(10_000, controller.signal).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBe(controller.signal.reason);
    expect((error as { readonly name?: unknown }).name).toBe('AbortError');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('#68 AbortSignal.timeout で発火すれば TimeoutError で reject する（偽の wait と同じく signal.reason）', async () => {
    const signal = AbortSignal.timeout(20);
    const started = performance.now();

    const error = await defaultWait(10_000, signal).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBe(signal.reason);
    expect((error as { readonly name?: unknown }).name).toBe('TimeoutError');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('#68 既に発火している signal では待たずに reject する', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(defaultWait(10_000, controller.signal)).rejects.toBe(controller.signal.reason);
  });

  it('#68 発火しなければ指定の時間で解決する', async () => {
    await expect(defaultWait(5, new AbortController().signal)).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #69 応答例の共有                                                             */
/* -------------------------------------------------------------------------- */

describe('#69 単体テストとループバックのサーバが 1 つの応答例を共有する', () => {
  it.each([
    ['R1 / R2', containerCreated(CONTAINER_ID)],
    ['R3', containerStatus('FINISHED')],
    ['R4', mediaPublished()],
    ['R5', permalinkOf()],
    ['R6', tokenRefreshed()],
    ['302', redirectTo()],
  ])(
    '#69 %s：サーバが返す応答と偽の fetch が返す Response が同じ status・本体になる',
    async (_label, example) => {
      responder = () => example;

      const fromServer = await nativeFetch(`${origin}/any`, { redirect: 'manual' });
      const fromFake = toResponse(example);

      expect(fromServer.status).toBe(fromFake.status);
      expect(await fromServer.text()).toBe(await fromFake.text());
      expect(fromServer.headers.get('location')).toBe(fromFake.headers.get('location'));
      // 応答例が宣言したヘッダはどちらにも同じく付く。**本体が文字列で `content-type` を宣言しない
      // 応答例（302）では、`new Response()` だけが `text/plain` を補う**。Plugin は `content-type` を
      // 読まない（本体を JSON として読めるかだけを見る）ので、分類には効かない。
      const declared = serializeExample(example).headers['content-type'] ?? null;
      expect(fromServer.headers.get('content-type')).toBe(declared);
      if (declared !== null) {
        expect(fromFake.headers.get('content-type')).toBe(declared);
      }
    },
  );

  it('#69 サーバは応答例を serializeExample で、偽の fetch は toResponse で書き出す（同じ定義を通る）', async () => {
    const example = mediaPublished();

    expect(await toResponse(example).text()).toBe(serializeExample(example).body);
  });
});

/* -------------------------------------------------------------------------- */
/* #98 ラッパは想定外の宛先で本物を呼ばない                                        */
/* -------------------------------------------------------------------------- */

describe('#98 ラッパは Graph API 以外の宛先で本物の fetch を呼ばずに投げる', () => {
  it('#98 https://example.test/ を渡すと投げる', async () => {
    const loopback = loopbackFetch();

    await expect(loopback.fetch('https://example.test/')).rejects.toThrow();
  });

  it('#98 そのときサーバは要求を 1 本も受け取っていない', async () => {
    const loopback = loopbackFetch();

    await loopback.fetch('https://example.test/').catch(() => undefined);

    expect(received).toHaveLength(0);
    expect(loopback.nativeCalls()).toBe(0);
  });

  it.each([
    'http://graph.instagram.com/v26.0/1',
    'https://graph.instagram.com.evil.test/v26.0/1',
    'https://graph.facebook.com/v26.0/1',
  ])('#98 %s も同じく投げる', async (url) => {
    const loopback = loopbackFetch();

    await expect(loopback.fetch(url)).rejects.toThrow();
    expect(loopback.nativeCalls()).toBe(0);
  });

  it('#98 宛先の定数は https://graph.instagram.com（ラッパの前提と一致する）', () => {
    expect(`${GRAPH_API_BASE_URL}/`).toBe(GRAPH_ORIGIN_PREFIX);
  });
});
