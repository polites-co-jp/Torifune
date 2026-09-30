import type { PublishResult, SocialAccountView, SocialPostView } from '@torifune/plugin-api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ACCESS_TOKEN,
  CONTAINER_ID,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  THREADS_API_ORIGIN,
  THREADS_USER_ID,
  containerCreated,
  containerStatus,
  defaultThreadsReply,
  mediaUrlOf,
  permalinkOf,
  redirectTo,
  serializeExample,
  threadsPublished,
  threadsRequestKind,
  toHeldResponse,
  toResponse,
  tokenRefreshed,
  type ThreadsResponseExample,
} from '@/test-support/threads-api';
import { createThreadsPublisher, defaultWait } from '../../../../plugins/sns-threads/social';
import {
  PUBLISH_TOTAL_BUDGET_MS,
  STATUS_TIMEOUT_MS,
  THREADS_API_BASE_URL,
  THREADS_API_VERSION,
  sendThreadsRequest,
} from '../../../../plugins/sns-threads/threads-api';

/**
 * 偽物と本物の一致（040-sns-threads 設計 §10.13 #87〜#93、#107 の A 側）。
 *
 * この Plugin の単体テストは `fetch` / `now` / `wait` をすべて偽物にしている。
 * **偽物が本物と違う振る舞いをすると、表の行が緑のまま本番の分岐が死ぬ**（036 検証レポート R-1）。
 * ここだけは `node:http` の**ループバック（127.0.0.1）のサーバ**に**本物の `fetch`** を当て、
 * 偽物を使う前提そのものを確かめる。**外部への通信は 1 本も出ない。**
 *
 * - 本物の `fetch` はモジュールの読み込み時に `realFetch` として退避し、**ラッパ `loopbackFetch` 越しにだけ**使う
 * - ラッパは書き換え前の URL が `https://graph.threads.net/` で始まらなければ、本物を呼ばずに投げる（#107）
 * - サーバの応答と要求の見分け方は `test-support/threads-api.ts` から取る（#93）
 *
 * #107：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 */

/** 本物の `fetch`。**読み込み時に退避する**（`beforeEach` が投げる実装へ置き換える前）。 */
const realFetch: typeof globalThis.fetch = globalThis.fetch;

/** 呼ばれたら投げる `fetch`（#107）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  // #107：本物の `fetch` を素のまま呼んだら落ちる。本物はラッパ越しにだけ使う。
  globalThis.fetch = throwingFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 受け取った要求の形（サーバと偽の fetch が同じ形で記録する）                         */
/* -------------------------------------------------------------------------- */

interface Received {
  readonly method: string;
  /** パス。 */
  readonly path: string;
  /** クエリ（キーの順に並べ直したもの）。 */
  readonly query: string;
  readonly authorization: string | null;
  /** `content-type` の種類の部分（`;` より前）。 */
  readonly contentType: string | null;
  /** form の本体（キーの順に並べ直したもの）。 */
  readonly form: string;
}

type Reply =
  | { readonly kind: 'example'; readonly example: ThreadsResponseExample }
  /** 応答しない。 */
  | { readonly kind: 'hang' }
  /** ヘッダだけ送り、本体を保留する（#91）。 */
  | { readonly kind: 'held'; readonly example: ThreadsResponseExample };

type Responder = (received: Received) => Reply;

function example(value: ThreadsResponseExample): Reply {
  return { kind: 'example', example: value };
}

function sortedParams(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('&');
}

function received(
  method: string,
  url: URL,
  authorization: string | null,
  contentType: string | null,
  body: string,
): Received {
  return {
    method: method.toUpperCase(),
    path: url.pathname,
    query: sortedParams(url.searchParams),
    authorization,
    contentType: contentType === null ? null : (contentType.split(';')[0]?.trim() ?? null),
    form: sortedParams(new URLSearchParams(body)),
  };
}

/** 既定の応答（単体テストの偽物と同じ規則。知らない要求は 404）。 */
function defaultResponder(request: Received): Reply {
  const url = new URL(
    `${request.path}${request.query === '' ? '' : `?${request.query}`}`,
    THREADS_API_ORIGIN,
  );
  const form = new URLSearchParams(request.form);
  try {
    return example(
      defaultThreadsReply(threadsRequestKind(url, request.method, form), { url, form }),
    );
  } catch {
    return example({ status: 404, body: { error: { message: 'not found', code: 100 } } });
  }
}

/* -------------------------------------------------------------------------- */
/* ループバックのサーバ                                                         */
/* -------------------------------------------------------------------------- */

let server: Server;
let origin: string;
let log: Received[] = [];
let responder: Responder = defaultResponder;
/** 応答を保留した要求（afterAll で閉じる）。 */
const held: ServerResponse[] = [];

function headerOf(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry = received(
        request.method ?? '',
        new URL(request.url ?? '/', 'http://loopback.invalid'),
        headerOf(request, 'authorization'),
        headerOf(request, 'content-type'),
        Buffer.concat(chunks).toString('utf8'),
      );
      log.push(entry);

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
        case 'example': {
          // **偽の `fetch` と同じ書き出し**（`serializeExample`）を通す（#93）。
          const { status, headers, body } = serializeExample(reply.example);
          response.writeHead(status, headers).end(body);
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
  log = [];
  responder = defaultResponder;
});

/* -------------------------------------------------------------------------- */
/* 本物の fetch をループバックへ向けるラッパ（#107）                                  */
/* -------------------------------------------------------------------------- */

const THREADS_PREFIX = 'https://graph.threads.net/';

interface Loopback {
  readonly fetch: typeof globalThis.fetch;
  /** 本物の `fetch` を呼んだ回数。 */
  readonly nativeCalls: () => number;
}

/**
 * **起点だけ**をループバックへ書き換えて本物の `fetch` を呼ぶ。`init` はそのまま渡す。
 *
 * 書き換え前の URL が `https://graph.threads.net/` で始まらなければ、**本物を呼ばずに投げる**（#107）。
 */
function loopbackFetch(): Loopback {
  let calls = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(THREADS_PREFIX)) {
      throw new Error(`Threads API 以外の宛先へ出ようとした: ${url}`);
    }
    calls += 1;
    return await realFetch(`${origin}/${url.slice(THREADS_PREFIX.length)}`, init);
  };
  return { fetch: impl as typeof globalThis.fetch, nativeCalls: () => calls };
}

/* -------------------------------------------------------------------------- */
/* 偽の fetch（単体テストの偽物と同じ規則で応答し、要求をサーバと同じ形で記録する）       */
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

function bodyTextOf(body: RequestInit['body']): string {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  return '<form でない本体>';
}

interface FakeFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly received: Received[];
}

/** 偽の Threads API。サーバと同じ `Responder` で応答し、サーバと同じ形で要求を記録する。 */
function fakeFetch(respond: Responder = defaultResponder): FakeFetch {
  const entries: Received[] = [];
  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const hasBody = init.body !== undefined && init.body !== null;
    // 本物の `fetch` と同じ組み立てでヘッダを得る（`URLSearchParams` の本体なら content-type が補われる）。
    const request = new Request(url.href, {
      method,
      headers: init.headers,
      ...(hasBody ? { body: init.body } : {}),
    });
    entries.push(
      received(
        method,
        url,
        request.headers.get('authorization'),
        request.headers.get('content-type'),
        bodyTextOf(init.body),
      ),
    );
    if (init.signal?.aborted === true) {
      throw init.signal.reason;
    }
    const reply = respond(entries[entries.length - 1] as Received);
    switch (reply.kind) {
      case 'hang':
        return await rejectOnAbort(init.signal);
      case 'held':
        return toHeldResponse(reply.example, init.signal ?? new AbortController().signal);
      case 'example':
        return toResponse(reply.example, init.signal);
    }
  };
  return { fetch: impl as typeof globalThis.fetch, received: entries };
}

/* -------------------------------------------------------------------------- */
/* 入力                                                                        */
/* -------------------------------------------------------------------------- */

const BODY = '秋の新作マグカップが入荷しました Zp4-body';

/** 時計（期限は 40 日後。延長しない）。 */
const FIXED_NOW = new Date('2026-09-24T12:00:00.000Z');
const FAR_EXPIRES_AT = '2026-11-03T12:00:00.000Z';
const NEAR_EXPIRES_AT = '2026-10-04T12:00:00.000Z';

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000f001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000f001',
    body: BODY,
    scheduledAt: '2026-09-24T12:00:00.000Z',
    status: 'publishing',
    publishedAt: null,
    failureReason: null,
    deliveryMode: 'auto',
    media: [],
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
    id: '0199aaaa-0000-7000-8000-00000000f001',
    provider: 'threads',
    displayName: '見本のアカウント',
    handle: 'yamada.example',
    status: 'active',
    credentialConfigured: true,
  };
}

async function publishWith(
  impl: typeof globalThis.fetch,
  options: { readonly post?: SocialPostView; readonly expiresAt?: string } = {},
): Promise<PublishResult> {
  const publish = createThreadsPublisher({ fetch: impl, now: () => FIXED_NOW }).publish;
  if (publish === undefined) {
    throw new Error('publish が実装されていない');
  }
  return await publish({
    post: options.post ?? postView(),
    account: accountView(),
    credential: {
      threadsUserId: THREADS_USER_ID,
      accessToken: ACCESS_TOKEN,
      accessTokenExpiresAt: options.expiresAt ?? FAR_EXPIRES_AT,
    },
    attempt: 1,
    signal: new AbortController().signal,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}

function versioned(path: string): string {
  return `/${THREADS_API_VERSION}/${path}`;
}

function formOf(values: Record<string, string>): string {
  return sortedParams(new URLSearchParams(values));
}

/** GET で出るはずの要求（単体テスト #52 / #53 が偽物で確かめている値）。 */
function getRequest(path: string, query: Record<string, string>): Received {
  return {
    method: 'GET',
    path,
    query: formOf({ ...query, access_token: ACCESS_TOKEN }),
    authorization: null,
    contentType: null,
    form: '',
  };
}

/** POST で出るはずの要求（form の本体に access_token。URL にクエリなし）。 */
function postRequest(path: string, form: Record<string, string>): Received {
  return {
    method: 'POST',
    path,
    query: '',
    authorization: null,
    contentType: 'application/x-www-form-urlencoded',
    form: formOf({ ...form, access_token: ACCESS_TOKEN }),
  };
}

/** テキストだけの正常系で出るはずの要求（単体テスト #45 / #52 / #53 の値）。 */
const TEXT_REQUESTS: readonly Received[] = [
  postRequest(versioned(`${THREADS_USER_ID}/threads`), { media_type: 'TEXT', text: BODY }),
  getRequest(versioned(CONTAINER_ID), { fields: 'status' }),
  postRequest(versioned(`${THREADS_USER_ID}/threads_publish`), { creation_id: CONTAINER_ID }),
  getRequest(versioned(MEDIA_ID), { fields: 'permalink' }),
];

/** 画像 1 枚の正常系で出るはずの要求（単体テスト #46 の値。alt は null）。 */
const IMAGE_REQUESTS: readonly Received[] = [
  postRequest(versioned(`${THREADS_USER_ID}/threads`), {
    media_type: 'IMAGE',
    image_url: mediaUrlOf(0),
    text: BODY,
  }),
  ...TEXT_REQUESTS.slice(1),
];

/* -------------------------------------------------------------------------- */
/* #87 正常系                                                                   */
/* -------------------------------------------------------------------------- */

describe('#87 本物の fetch でテキストと画像 1 枚の正常系が通る', () => {
  it('#87 テキストだけ：ループバック越しの本物の fetch で ok: true', async () => {
    const loopback = loopbackFetch();

    const result = await publishWith(loopback.fetch);

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(loopback.nativeCalls()).toBe(4);
  });

  it('#87 画像 1 枚：ループバック越しの本物の fetch で ok: true', async () => {
    const result = await publishWith(loopbackFetch().fetch, {
      post: postView({ media: [{ url: mediaUrlOf(0), alt: null }] }),
    });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#87 テキスト：サーバが受け取ったメソッド・パス・クエリ・content-type・form の本体・authorization なしが、単体テストで確かめている値と一致する', async () => {
    await publishWith(loopbackFetch().fetch);

    expect(log).toEqual(TEXT_REQUESTS);
  });

  it('#87 画像 1 枚：サーバが受け取った要求が、単体テストで確かめている値と一致する', async () => {
    await publishWith(loopbackFetch().fetch, {
      post: postView({ media: [{ url: mediaUrlOf(0), alt: null }] }),
    });

    expect(log).toEqual(IMAGE_REQUESTS);
  });

  it('#87 同じ配信で、サーバが受け取った要求と偽の fetch が受け取った要求が一致する', async () => {
    const fake = fakeFetch();

    const real = await publishWith(loopbackFetch().fetch);
    const faked = await publishWith(fake.fetch);

    expect(log).toEqual(fake.received);
    expect(real).toEqual(faked);
  });

  it('#87 延長（R6）も同じ：版の付かないパス・クエリの access_token と grant_type・本体なし・authorization なし', async () => {
    // 期限が 10 日後なら R5 の後に R6 を送る（設計 §6.7）。
    const fake = fakeFetch();

    const real = await publishWith(loopbackFetch().fetch, { expiresAt: NEAR_EXPIRES_AT });
    const faked = await publishWith(fake.fetch, { expiresAt: NEAR_EXPIRES_AT });

    expect(real).toEqual(faked);
    expect(real.ok && real.rotatedCredential?.['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
    expect(log[log.length - 1]).toEqual(
      getRequest('/refresh_access_token', { grant_type: 'th_refresh_token' }),
    );
    expect(log).toEqual(fake.received);
  });
});

/* -------------------------------------------------------------------------- */
/* #88 302                                                                     */
/* -------------------------------------------------------------------------- */

describe('#88 本物の 302 は偽の 302 と同じ retryable になる', () => {
  function redirectingR1(location: string): Responder {
    return (request) =>
      request.method === 'POST' && request.path.endsWith('/threads')
        ? example(redirectTo(location))
        : defaultResponder(request);
  }

  it("#88 本物の fetch（redirect: 'manual'）は 302 を追わず、P1 で retryable: false", async () => {
    responder = redirectingR1(`${origin}/followed`);

    const result = await publishWith(loopbackFetch().fetch);

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.retryable).toBe(false);
    // 追っていれば /followed への要求が 2 本目として届く。
    expect(log.map((request) => request.path)).toEqual([versioned(`${THREADS_USER_ID}/threads`)]);
  });

  it('#88 偽の 302 を返したときと結果が同じ', async () => {
    responder = redirectingR1(`${origin}/followed`);
    const fake = fakeFetch(redirectingR1(`${origin}/followed`));

    const real = await publishWith(loopbackFetch().fetch);
    const faked = await publishWith(fake.fetch);

    expect(real).toEqual(faked);
  });

  it("#88 本物の fetch は redirect: 'manual' なら 302 を Response として返す（reject しない）", async () => {
    // 3xx が観測できずに `network` へ化けると retryable: true に倒れる（036 検証レポート R-1）。
    responder = () => example(redirectTo(`${origin}/followed`));

    const response = await loopbackFetch().fetch(`${THREADS_PREFIX}start`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(log).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #89 応答しないサーバ                                                         */
/* -------------------------------------------------------------------------- */

describe('#89 応答しないサーバで sendThreadsRequest が timeout になる', () => {
  function request(
    impl: typeof globalThis.fetch,
    signal: AbortSignal,
  ): ReturnType<typeof sendThreadsRequest> {
    // **制限時間の定数は差し替えない**（結線は #80 が見る）。短い期限は外側の signal に混ぜる。
    return sendThreadsRequest({
      impl,
      method: 'GET',
      path: versioned(CONTAINER_ID),
      query: { fields: 'status', access_token: ACCESS_TOKEN },
      timeoutMs: STATUS_TIMEOUT_MS,
      signal,
    });
  }

  function kindOf(outcome: unknown): unknown {
    return (outcome as { readonly kind?: unknown }).kind;
  }

  it('#89 本物の fetch に短い AbortSignal.timeout を混ぜると、分類が timeout', async () => {
    responder = () => ({ kind: 'hang' });

    const outcome = await request(loopbackFetch().fetch, AbortSignal.timeout(100));

    expect(kindOf(outcome)).toBe('timeout');
    expect(log).toHaveLength(1);
  });

  it('#89 偽の fetch（signal の発火で reject する）を与えても同じ分類', async () => {
    const outcome = await request(
      fakeFetch(() => ({ kind: 'hang' })).fetch,
      AbortSignal.timeout(100),
    );

    expect(kindOf(outcome)).toBe('timeout');
  });

  it('#89 呼び出し側の abort() で止めたときも、本物と偽物で分類が同じ（aborted）', async () => {
    responder = () => ({ kind: 'hang' });
    const real = new AbortController();
    const fake = new AbortController();
    setTimeout(() => real.abort(), 50);
    setTimeout(() => fake.abort(), 50);

    const outcomes = await Promise.all([
      request(loopbackFetch().fetch, real.signal),
      request(fakeFetch(() => ({ kind: 'hang' })).fetch, fake.signal),
    ]);

    expect(outcomes.map(kindOf)).toEqual(['aborted', 'aborted']);
  });

  it('#89 sendThreadsRequest は 3xx を http として返す（本物の fetch でも偽物でも）', async () => {
    responder = () => example(redirectTo(`${origin}/followed`));

    const outcomes = [
      await request(loopbackFetch().fetch, new AbortController().signal),
      await request(
        fakeFetch(() => example(redirectTo(`${origin}/followed`))).fetch,
        new AbortController().signal,
      ),
    ];

    expect(outcomes.map(kindOf)).toEqual(['http', 'http']);
  });
});

/* -------------------------------------------------------------------------- */
/* #90 abort されたときの error.name                                             */
/* -------------------------------------------------------------------------- */

describe('#90 本物の fetch が abort されたときの error.name', () => {
  // 実測は Plugin の定数に依らない宛先で行う（ラッパが通す起点だけを使う）。
  const TARGET = `${THREADS_PREFIX}v1.0/${CONTAINER_ID}?fields=status`;

  async function rejectionOf(impl: typeof globalThis.fetch, signal: AbortSignal): Promise<unknown> {
    try {
      await impl(TARGET, { signal });
    } catch (error) {
      return error;
    }
    throw new Error('reject しなかった');
  }

  function nameOf(value: unknown): unknown {
    return (value as { readonly name?: unknown }).name;
  }

  beforeEach(() => {
    responder = () => ({ kind: 'hang' });
  });

  it('#90 AbortSignal.timeout で止めると、本物は TimeoutError で reject する', async () => {
    const error = await rejectionOf(loopbackFetch().fetch, AbortSignal.timeout(50));

    expect(nameOf(error)).toBe('TimeoutError');
  });

  it('#90 AbortController.abort() で止めると、本物は AbortError で reject する', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);

    const error = await rejectionOf(loopbackFetch().fetch, controller.signal);

    expect(nameOf(error)).toBe('AbortError');
  });

  it('#90 AbortSignal.any に混ぜた timeout でも、本物は TimeoutError で reject する', async () => {
    // Plugin は要求ごとに `AbortSignal.any([外側, AbortSignal.timeout(ms)])` を渡す（設計 §6.8）。
    const error = await rejectionOf(
      loopbackFetch().fetch,
      AbortSignal.any([new AbortController().signal, AbortSignal.timeout(50)]),
    );

    expect(nameOf(error)).toBe('TimeoutError');
  });

  it('#90 本物は signal.reason そのもので reject する（偽物が真似ている振る舞い）', async () => {
    const signal = AbortSignal.timeout(50);

    const error = await rejectionOf(loopbackFetch().fetch, signal);

    expect(error).toBe(signal.reason);
  });

  it('#90 偽の fetch は本物と同じ name で reject する（timeout / abort() の両方）', async () => {
    const realController = new AbortController();
    const fakeController = new AbortController();
    setTimeout(() => realController.abort(), 30);
    setTimeout(() => fakeController.abort(), 30);

    const names = await Promise.all([
      rejectionOf(loopbackFetch().fetch, AbortSignal.timeout(50)).then(nameOf),
      rejectionOf(fakeFetch(() => ({ kind: 'hang' })).fetch, AbortSignal.timeout(50)).then(nameOf),
      rejectionOf(loopbackFetch().fetch, realController.signal).then(nameOf),
      rejectionOf(fakeFetch(() => ({ kind: 'hang' })).fetch, fakeController.signal).then(nameOf),
    ]);

    expect(names).toEqual(['TimeoutError', 'TimeoutError', 'AbortError', 'AbortError']);
  });

  it('#90 単体テストが「自前の制限時間」として投げる DOMException も同じ name', () => {
    // `sns-threads-retry.test.ts` の `timedOut()` と同じ組み立て。
    expect(new DOMException('The operation was aborted due to timeout', 'TimeoutError').name).toBe(
      'TimeoutError',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #91 ヘッダの後の abort                                                        */
/* -------------------------------------------------------------------------- */

interface ProbedTimeout {
  readonly ms: number;
  readonly controller: AbortController;
}

/** `AbortSignal.timeout` を差し替え、作られた順に記録する（`sns-threads-retry.test.ts` と同じ手）。 */
function probeTimeouts(): {
  readonly created: ProbedTimeout[];
  fire(ms: number): void;
  restore(): void;
} {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const created: ProbedTimeout[] = [];
  AbortSignal.timeout = ((ms: number): AbortSignal => {
    const controller = new AbortController();
    created.push({ ms, controller });
    return controller.signal;
  }) as typeof AbortSignal.timeout;
  return {
    created,
    fire: (ms) => {
      const entry = created.find((candidate) => candidate.ms === ms);
      if (entry === undefined) {
        throw new Error(`${ms}ms の AbortSignal.timeout が作られていない`);
      }
      entry.controller.abort(
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      );
    },
    restore: () => {
      AbortSignal.timeout = original as typeof AbortSignal.timeout;
    },
  };
}

describe('#91 ヘッダの後の abort で本体の読み込みが reject する（本物と偽物）', () => {
  // 実測は Plugin の定数に依らない宛先で行う（ラッパが通す起点だけを使う）。
  const PUBLISH_URL = `${THREADS_PREFIX}v1.0/${THREADS_USER_ID}/threads_publish`;

  async function readError(read: () => Promise<unknown>): Promise<unknown> {
    try {
      await read();
    } catch (error) {
      return error;
    }
    return null;
  }

  function heldR4(request: Received): Reply {
    return request.method === 'POST' && request.path.endsWith('/threads_publish')
      ? { kind: 'held', example: threadsPublished() }
      : defaultResponder(request);
  }

  it('#91 本物：ヘッダ（200）を受け取った後、本体を保留している間に abort() すると text() が signal.reason で reject する', async () => {
    responder = heldR4;
    const controller = new AbortController();
    const response = await loopbackFetch().fetch(PUBLISH_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();

    const error = await readError(() => response.text());

    expect(response.status).toBe(200);
    expect(error).toBe(controller.signal.reason);
    expect((error as { readonly name?: unknown }).name).toBe('AbortError');
  });

  it('#91 偽物（test-support の toHeldResponse）も同じく signal.reason で reject する', async () => {
    const controller = new AbortController();
    const response = await fakeFetch(heldR4).fetch(PUBLISH_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();

    const error = await readError(() => response.text());

    expect(response.status).toBe(200);
    expect(error).toBe(controller.signal.reason);
  });

  it('#91 本物：本体を受信済みでも、読み終える前に abort() すると text() が reject する', async () => {
    // 038 検証 §2 の 2（Node v24 で実測）。本体が小さく、abort の時点で受信は終わっている。
    const controller = new AbortController();
    const response = await loopbackFetch().fetch(PUBLISH_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();

    expect(await readError(() => response.text())).toBe(controller.signal.reason);
  });

  it('#91 偽物（toResponse の signal と結んだ本体）も、読み終える前の abort() で text() が reject する', async () => {
    const controller = new AbortController();
    const response = await fakeFetch().fetch(PUBLISH_URL, {
      method: 'POST',
      signal: controller.signal,
    });
    controller.abort();

    expect(await readError(() => response.text())).toBe(controller.signal.reason);
  });

  it('#91 本物も偽物も、読み終えた後の abort() は読んだ本体を覆さない', async () => {
    const realController = new AbortController();
    const fakeController = new AbortController();
    const real = await loopbackFetch().fetch(PUBLISH_URL, {
      method: 'POST',
      signal: realController.signal,
    });
    const faked = await fakeFetch().fetch(PUBLISH_URL, {
      method: 'POST',
      signal: fakeController.signal,
    });
    const texts = [await real.text(), await faked.text()];
    realController.abort();
    fakeController.abort();

    expect(texts.map((text) => JSON.parse(text) as unknown)).toEqual([
      threadsPublished().body,
      threadsPublished().body,
    ]);
  });

  /** R4 のヘッダを受け取った直後に、合計の期限（PUBLISH_TOTAL_BUDGET_MS）を発火させる。 */
  async function publishFiringTotalAfterR4Headers(
    impl: typeof globalThis.fetch,
  ): Promise<PublishResult> {
    const probe = probeTimeouts();
    try {
      const wrapped = (async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: RequestInit,
      ) => {
        const response = await impl(input, init);
        if (String(input).endsWith('/threads_publish')) {
          probe.fire(PUBLISH_TOTAL_BUDGET_MS);
        }
        return response;
      }) as typeof globalThis.fetch;
      return await publishWith(wrapped);
    } finally {
      probe.restore();
    }
  }

  it('#91 本物：R4 のヘッダの後・本体を読み切る前に合計の期限が発火すると publish() は retryable: false', async () => {
    responder = heldR4;

    const result = await publishFiringTotalAfterR4Headers(loopbackFetch().fetch);

    expect(result.ok ? null : result.retryable).toBe(false);
    // R5 / R6 へ進んでいない。
    expect(log.map((entry) => entry.path)).toEqual([
      versioned(`${THREADS_USER_ID}/threads`),
      versioned(CONTAINER_ID),
      versioned(`${THREADS_USER_ID}/threads_publish`),
    ]);
  });

  it('#91 偽物でも同じく retryable: false（本物と同じ結果）', async () => {
    responder = heldR4;

    const real = await publishFiringTotalAfterR4Headers(loopbackFetch().fetch);
    const faked = await publishFiringTotalAfterR4Headers(fakeFetch(heldR4).fetch);

    expect(faked.ok ? null : faked.retryable).toBe(false);
    expect(real).toEqual(faked);
  });

  it('#91 本物と偽物で、sendThreadsRequest の外側の signal がヘッダの後に発火したときの分類が同じ', async () => {
    // fetch が解決した直後（本体を読む前）に外側の signal を発火させるラッパ。
    function abortAfterHeaders(
      impl: typeof globalThis.fetch,
      controller: AbortController,
    ): typeof globalThis.fetch {
      return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const response = await impl(input, init);
        controller.abort();
        return response;
      }) as typeof globalThis.fetch;
    }
    const real = new AbortController();
    const fake = new AbortController();
    const send = (
      impl: typeof globalThis.fetch,
      signal: AbortSignal,
    ): ReturnType<typeof sendThreadsRequest> =>
      sendThreadsRequest({
        impl,
        method: 'POST',
        path: versioned(`${THREADS_USER_ID}/threads_publish`),
        form: { creation_id: CONTAINER_ID, access_token: ACCESS_TOKEN },
        timeoutMs: STATUS_TIMEOUT_MS,
        signal,
      });

    const outcomes = [
      await send(abortAfterHeaders(loopbackFetch().fetch, real), real.signal),
      await send(abortAfterHeaders(fakeFetch().fetch, fake), fake.signal),
    ];

    // 本体が読めていない。成功（ok）には倒れず、呼び出し側の abort（AbortError）として aborted に分類する。
    expect(outcomes.map((outcome) => (outcome as { readonly kind?: unknown }).kind)).toEqual([
      'aborted',
      'aborted',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #92 既定の wait                                                              */
/* -------------------------------------------------------------------------- */

describe('#92 既定の wait は signal の発火で待たずに終わる', () => {
  it('#92 10 秒の待ちでも、signal が発火すればすぐ reject する', async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 20);

    const error = await defaultWait(10_000, controller.signal).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBe(controller.signal.reason);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('#92 AbortSignal.timeout で発火すれば TimeoutError で reject する（偽の wait と同じく signal.reason）', async () => {
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

  it('#92 既に発火している signal では待たずに reject する', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(defaultWait(10_000, controller.signal)).rejects.toBe(controller.signal.reason);
  });

  it('#92 発火しなければ指定の時間で解決する', async () => {
    await expect(defaultWait(5, new AbortController().signal)).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #93 応答例の共有                                                             */
/* -------------------------------------------------------------------------- */

describe('#93 単体テストとループバックのサーバが 1 つの応答例を共有する', () => {
  it.each([
    ['R1 / R2', containerCreated(CONTAINER_ID)],
    ['R3', containerStatus('FINISHED')],
    ['R4', threadsPublished()],
    ['R5', permalinkOf()],
    ['R6', tokenRefreshed()],
    ['302', redirectTo()],
  ])(
    '#93 %s：サーバが返す応答と偽の fetch が返す Response が同じ status・本体になる',
    async (_label, value) => {
      responder = () => example(value);

      const fromServer = await loopbackFetch().fetch(`${THREADS_PREFIX}any`, {
        redirect: 'manual',
      });
      const fromFake = toResponse(value);

      expect(fromServer.status).toBe(fromFake.status);
      expect(await fromServer.text()).toBe(await fromFake.text());
      expect(fromServer.headers.get('location')).toBe(fromFake.headers.get('location'));
      // 応答例が宣言したヘッダはどちらにも同じく付く。**本体が文字列で `content-type` を宣言しない
      // 応答例（302）では、`new Response()` だけが `text/plain` を補う**。Plugin は `content-type` を
      // 読まない（本体を JSON として読めるかだけを見る）ので、分類には効かない。
      const declared = serializeExample(value).headers['content-type'] ?? null;
      expect(fromServer.headers.get('content-type')).toBe(declared);
      if (declared !== null) {
        expect(fromFake.headers.get('content-type')).toBe(declared);
      }
    },
  );

  it('#93 サーバは応答例を serializeExample で、偽の fetch は toResponse で書き出す（同じ定義を通る）', async () => {
    const value = threadsPublished();

    expect(await toResponse(value).text()).toBe(serializeExample(value).body);
  });

  it('#93 偽の fetch の本体は signal と結んだ stream（signal を渡すと本体が stream になる）', async () => {
    const controller = new AbortController();
    const response = toResponse(threadsPublished(), controller.signal);
    controller.abort();

    await expect(response.text()).rejects.toBe(controller.signal.reason);
  });
});

/* -------------------------------------------------------------------------- */
/* #107 ラッパは想定外の宛先で本物を呼ばない                                         */
/* -------------------------------------------------------------------------- */

describe('#107 ラッパは Threads API 以外の宛先で本物の fetch を呼ばずに投げる', () => {
  it('#107 https://example.test/ を渡すと投げる', async () => {
    const loopback = loopbackFetch();

    await expect(loopback.fetch('https://example.test/')).rejects.toThrow();
  });

  it('#107 そのときサーバは要求を 1 本も受け取っていない', async () => {
    const loopback = loopbackFetch();

    await loopback.fetch('https://example.test/').catch(() => undefined);

    expect(log).toHaveLength(0);
    expect(loopback.nativeCalls()).toBe(0);
  });

  it.each([
    'http://graph.threads.net/v1.0/1',
    'https://graph.threads.net.evil.test/v1.0/1',
    'https://graph.threads.com/v1.0/1',
    'https://graph.instagram.com/v1.0/1',
  ])('#107 %s も同じく投げる', async (url) => {
    const loopback = loopbackFetch();

    await expect(loopback.fetch(url)).rejects.toThrow();
    expect(loopback.nativeCalls()).toBe(0);
  });

  it('#107 宛先の定数は https://graph.threads.net（ラッパの前提と一致する）', () => {
    expect(`${THREADS_API_BASE_URL}/`).toBe(THREADS_PREFIX);
  });
});
