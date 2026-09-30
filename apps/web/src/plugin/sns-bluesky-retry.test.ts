import type {
  PluginLogger,
  PluginStore,
  PublishResult,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CREATE_RECORD_TIMEOUT_MS,
  CREATE_SESSION_TIMEOUT_MS,
  MEDIA_FETCH_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
  MEDIA_TOTAL_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  UPLOAD_BLOB_TIMEOUT_MS,
} from '../../../../plugins/sns-bluesky/atproto';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';

/**
 * Bluesky 配信 Plugin の `publish()`：異常系と `retryable`（036-sns-bluesky 設計 §6.9 / §6.11）。
 *
 * **設計 §6.9 の表（21 行）が正。** 受け入れ条件 #44 の箇条書きは「少なくとも次を含む」と
 * 書いてある部分集合で、箇条書きだけを見ると `AccountTakedown` 系・`uploadBlob` の 401・
 * 「その他の 4xx」・「予期しない例外」が落ちる（実装プラン §8 の 13）。
 * このファイルは表の 21 行を `P0` 〜 `P4` と「どこでも」の describe で 1 行ずつ並べる。
 *
 * > 支配的な規則：**`createRecord` を送る前は既定 `true`、送った後は 429 を除きすべて `false`。**
 * > 例外は「時間が経っても直らないもの」（資格情報・設定・投稿の内容）。
 *
 * #52：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 */

const SESSION_NSID = 'com.atproto.server.createSession';
const UPLOAD_NSID = 'com.atproto.repo.uploadBlob';
const RECORD_NSID = 'com.atproto.repo.createRecord';

const SESSION_DID = 'did:plc:torifunetest0001';
const SESSION_HANDLE = 'real-handle.bsky.example';
const ACCESS_JWT = 'access-jwt-value-0001';
const RKEY = '3ktestrkey0001';

const ACCOUNT_HANDLE = 'registered-handle.example';

const IDENTIFIER = 'torifune-test.bsky.example';
const APP_PASSWORD = 'zzzz-yyyy-xxxx-wwww';

/** 秘匿の検査（#49）で「本文が漏れていないか」を見るための目印。 */
const SECRET_BODY = 'ひみつの本文-QQQQ';

const MEDIA_URL = 'https://cdn.example.com/a.png';

const FIXED_NOW = new Date('2026-09-23T12:34:56.789Z');

interface RouteContext {
  readonly url: string;
  readonly init: RequestInit;
  readonly index: number;
}

type Route = (context: RouteContext) => Response | Promise<Response>;

interface FakePdsOptions {
  readonly session?: Route;
  readonly media?: Route;
  readonly upload?: Route;
  readonly record?: Route;
}

interface FakeCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface FakePds {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FakeCall[];
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sessionOk(): Response {
  return json({
    did: SESSION_DID,
    handle: SESSION_HANDLE,
    accessJwt: ACCESS_JWT,
    refreshJwt: 'refresh-jwt-value-0002',
  });
}

function recordOk(): Response {
  return json({ uri: `at://${SESSION_DID}/app.bsky.feed.post/${RKEY}`, cid: 'bafytestcid0001' });
}

function uploadOk(index: number): Response {
  return json({
    blob: { $type: 'blob', ref: { $link: `bafyblob${index}` }, mimeType: 'image/png', size: 4 },
  });
}

function imageOk(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

/** 解決せず、`signal` が発火したときだけ reject する応答（自前の制限時間の代替。#51）。 */
function hangUntilAbort(): Route {
  return ({ init }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      const fail = (): void => {
        reject(new DOMException('打ち切り', 'AbortError'));
      };
      if (signal === null || signal === undefined) {
        return;
      }
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener('abort', fail, { once: true });
    });
}

/** 接続できない（DNS・TCP・TLS。`fetch` が reject）。 */
function connectionRefused(): Route {
  return () => {
    throw new TypeError('fetch failed');
  };
}

function createFakePds(options: FakePdsOptions = {}): FakePds {
  const calls: FakeCall[] = [];
  let mediaIndex = 0;
  let uploadIndex = 0;

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });

    if (url.includes(SESSION_NSID)) {
      return await (options.session ?? sessionOk)({ url, init, index: 0 });
    }
    if (url.includes(UPLOAD_NSID)) {
      const index = uploadIndex;
      uploadIndex += 1;
      return await (options.upload ?? (({ index: i }) => uploadOk(i)))({ url, init, index });
    }
    if (url.includes(RECORD_NSID)) {
      return await (options.record ?? recordOk)({ url, init, index: 0 });
    }
    const index = mediaIndex;
    mediaIndex += 1;
    return await (options.media ?? imageOk)({ url, init, index });
  };

  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

function fakeStore(values: Map<string, unknown> = new Map()): PluginStore {
  return {
    get: async <T = unknown>(key: string): Promise<T | null> =>
      values.has(key) ? (values.get(key) as T) : null,
    set: async <T = unknown>(key: string, value: T): Promise<void> => {
      values.set(key, value);
    },
    delete: () => {
      throw new Error('使わない');
    },
    keys: () => {
      throw new Error('使わない');
    },
    setSecret: () => {
      throw new Error('使わない');
    },
    getSecret: () => {
      throw new Error('使わない');
    },
    hasSecret: () => {
      throw new Error('使わない');
    },
  };
}

/** `store.get` が失敗する Key-Value Store（P0 の 2 行目）。 */
function brokenStore(): PluginStore {
  return {
    ...fakeStore(),
    get: () => {
      throw new Error('Key-Value Store が読めない');
    },
  };
}

interface LogEntry {
  readonly level: string;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

function captureLogger(entries: LogEntry[]): PluginLogger {
  return {
    debug: (message, detail) => {
      entries.push({ level: 'debug', message, detail });
    },
    info: (message, detail) => {
      entries.push({ level: 'info', message, detail });
    },
    warn: (message, detail) => {
      entries.push({ level: 'warn', message, detail });
    },
    error: (message, detail) => {
      entries.push({ level: 'error', message, detail });
    },
  };
}

function silentLogger(): PluginLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'bluesky',
    displayName: 'とりふね',
    handle: ACCOUNT_HANDLE,
    status: 'active',
    credentialConfigured: true,
    ...overrides,
  };
}

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000b001',
    socialAccountId: accountView().id,
    body: SECRET_BODY,
    scheduledAt: '2026-09-23T12:00:00.000Z',
    status: 'scheduled',
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

interface PublishOptions {
  readonly post?: Partial<SocialPostView>;
  readonly store?: PluginStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
  /** この Plugin が見る時計（設計 §10.1）。**媒体の期限の判定もここを見る**（#80）。 */
  readonly now?: () => Date;
}

async function publish(options: PublishOptions = {}): Promise<PublishResult> {
  const registration = createBlueskyPublisher({
    store: options.store ?? fakeStore(),
    fetch: options.fetch,
    now: options.now ?? (() => FIXED_NOW),
  });
  if (registration.publish === undefined) {
    throw new Error('publish() が実装されていない');
  }
  return await registration.publish({
    post: postView(options.post),
    account: accountView(),
    credential: { identifier: IDENTIFIER, appPassword: APP_PASSWORD },
    attempt: 2,
    signal: options.signal ?? new AbortController().signal,
    logger: options.logger ?? silentLogger(),
  });
}

/** `publish()` を走らせ、要求が出たところで `input.signal` を発火させる（#51 と同じ手）。 */
async function publishThenAbort(options: PublishOptions = {}): Promise<PublishResult> {
  const controller = new AbortController();
  const promise = publish({ ...options, signal: controller.signal });
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  controller.abort();
  return await promise;
}

interface Failure {
  readonly reason: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

function failureOf(result: PublishResult): Failure {
  if (result.ok) {
    throw new Error('失敗するはずが成功した');
  }
  return result;
}

/** 媒体を1件だけ添えた投稿（P2 / P3 用）。 */
const WITH_MEDIA: Partial<SocialPostView> = { media: [{ url: MEDIA_URL, alt: 'せつめい' }] };

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  // #52：本物の `fetch` を呼んだら落ちる。
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('制限時間と上限の値（設計 §6.6 / §6.2）', () => {
  it('要求ごとの制限時間が設計どおり', () => {
    expect(CREATE_SESSION_TIMEOUT_MS).toBe(10_000);
    expect(MEDIA_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(UPLOAD_BLOB_TIMEOUT_MS).toBe(10_000);
    expect(CREATE_RECORD_TIMEOUT_MS).toBe(15_000);
  });

  it('媒体の処理に使ってよい合計時間は20秒', () => {
    expect(MEDIA_TOTAL_BUDGET_MS).toBe(20_000);
  });

  it('媒体の上限サイズは 1MB', () => {
    expect(MEDIA_MAX_BYTES).toBe(1_000_000);
  });
});

describe('P0 設定の読み出し（表 2 行）', () => {
  it('pds-url が不正 → retryable: false（人が設定を直すまで直らない）', async () => {
    const fake = createFakePds();
    const store = fakeStore(new Map([['pds-url', 'http://pds.example.com']]));

    const result = failureOf(await publish({ fetch: fake.fetch, store }));

    expect(result.retryable).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('store.get が失敗した → retryable: true（まだ何も送っていない）', async () => {
    const fake = createFakePds();

    const result = failureOf(await publish({ fetch: fake.fetch, store: brokenStore() }));

    expect(result.retryable).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('P1 createSession（表 8 行）', () => {
  it('接続できない（fetch が reject）→ retryable: true', async () => {
    const fake = createFakePds({ session: connectionRefused() });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
  });

  it('#51 自前の制限時間に達した → retryable: true で、Core の30秒より早く返る', async () => {
    const fake = createFakePds({ session: hangUntilAbort() });
    const started = Date.now();

    const result = failureOf(await publishThenAbort({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('429 RateLimitExceeded → retryable: true ＋ retryAfterMs', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const fake = createFakePds({
      session: () =>
        json({ error: 'RateLimitExceeded' }, 429, { 'ratelimit-reset': String(reset) }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(55_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('429 でヘッダが無ければ retryAfterMs を付けない', async () => {
    // Core の既定（1 → 2 → 4 → 8 分）が使われる（設計 §6.10）。
    const fake = createFakePds({ session: () => json({ error: 'RateLimitExceeded' }, 429) });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it('429 で ratelimit-reset が過去を指していれば retryAfterMs を付けない', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const fake = createFakePds({
      session: () => json({ error: 'RateLimitExceeded' }, 429, { 'ratelimit-reset': String(past) }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryAfterMs).toBeUndefined();
  });

  it('5xx → retryable: true（一般則「5xx は false」は送った後の話）', async () => {
    const fake = createFakePds({ session: () => json({ error: 'InternalServerError' }, 503) });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
  });

  it.each([['AuthenticationRequired'], ['InvalidPassword']])(
    '401 %s → retryable: false（再試行してもログイン試行の回数を食うだけ）',
    async (code) => {
      const fake = createFakePds({ session: () => json({ error: code }, 401) });

      const result = failureOf(await publish({ fetch: fake.fetch }));

      expect(result.retryable).toBe(false);
      expect(result.reason).toContain('App Password');
    },
  );

  it('400 AuthFactorTokenRequired → retryable: false', async () => {
    const fake = createFakePds({
      session: () => json({ error: 'AuthFactorTokenRequired' }, 400),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(false);
  });

  it.each([['AccountTakedown'], ['AccountDeactivated'], ['AccountSuspended']])(
    '%s → retryable: false（アカウント側の事情。人が直すまで直らない）',
    async (code) => {
      const fake = createFakePds({ session: () => json({ error: code }, 400) });

      const result = failureOf(await publish({ fetch: fake.fetch }));

      expect(result.retryable).toBe(false);
    },
  );

  it('200 だが応答が JSON でない → retryable: true', async () => {
    // 解釈できなくても、次の要求を出していない（設計 §6.9）。
    const fake = createFakePds({
      session: () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
  });

  it('200 だが accessJwt が無い → retryable: true', async () => {
    const fake = createFakePds({
      session: () => json({ did: SESSION_DID, handle: SESSION_HANDLE }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
  });
});

describe('P2 媒体の取得（表 2 行）', () => {
  it('#74 媒体の GET はリダイレクトを追わない（redirect: manual で出す）', async () => {
    // 検査を通った URL から、検査していない URL へ移らせない（設計 §6.2）。
    // **`'error'` ではない。** `'error'` だと 3xx が `Response` として返らず、
    // 下の「302 → retryable: false」が本番では成立しない（#74 の後半で直に見る）。
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, post: WITH_MEDIA });

    const mediaCall = fake.calls.find((call) => call.url === MEDIA_URL);
    expect(mediaCall?.init.redirect).toBe('manual');
  });

  it.each([
    ['接続断', createFakePds({ media: connectionRefused() })],
    ['5xx', createFakePds({ media: () => json({}, 503) })],
  ])('%s → retryable: true（投稿は作られていない）', async (_label, fake) => {
    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(true);
  });

  it('制限時間 → retryable: true', async () => {
    const fake = createFakePds({ media: hangUntilAbort() });

    const result = failureOf(await publishThenAbort({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(true);
  });

  it('4xx（404）→ retryable: false（人が media[].url を直す）', async () => {
    const fake = createFakePds({ media: () => new Response('', { status: 404 }) });

    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(false);
  });

  it('Content-Type が image/ で始まらない → retryable: false', async () => {
    const fake = createFakePds({
      media: () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(false);
  });

  it('1MB を超える（Content-Length あり）→ retryable: false', async () => {
    const fake = createFakePds({
      media: () =>
        new Response(new Uint8Array(16), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '2000000' },
        }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(false);
  });

  it('1MB を超える（Content-Length が無くても読みながら打ち切る）→ retryable: false', async () => {
    const fake = createFakePds({
      media: () => {
        const chunk = new Uint8Array(64 * 1024);
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 2_000_000) {
              controller.close();
              return;
            }
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } });
      },
    });

    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(false);
  });

  it('リダイレクト（302）→ retryable: false（追わない）', async () => {
    const fake = createFakePds({
      media: () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://elsewhere.example.com/a.png' },
        }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(false);
  });

  it.each([
    ['404', new Response('', { status: 404 }), false],
    ['403', new Response('', { status: 403 }), false],
    ['500', new Response('', { status: 500 }), true],
  ])(
    '#75 媒体が %s でも reason に HTTP の status を載せない（判断には使う）',
    async (status, response, retryable) => {
      // **取得先は利用者が指した任意の URL**（設計 §8.2）。status を `failure_reason` へ出すと、
      // 投稿を積むだけで内部ホストの生死と応答の別を列挙できる（設計 §6.11）。
      const fake = createFakePds({ media: () => response });

      const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

      expect(result.reason).not.toContain(status);
      expect(result.reason).not.toMatch(/\d{3}/);
      // **判断に使うことと外へ出すことは別。** retryable は status で決まり続ける。
      expect(result.retryable).toBe(retryable);
    },
  );

  it('#75 媒体の reason は「再試行する」か「URL を直す」かが読める', async () => {
    const temporary = createFakePds({ media: () => new Response('', { status: 500 }) });
    const permanent = createFakePds({ media: () => new Response('', { status: 404 }) });

    const retried = failureOf(await publish({ fetch: temporary.fetch, post: WITH_MEDIA }));
    const fixed = failureOf(await publish({ fetch: permanent.fetch, post: WITH_MEDIA }));

    expect(retried.reason).toContain('再試行');
    expect(fixed.reason).toContain('URL');
  });

  it('#76 媒体の失敗では logger の detail に status を渡さない', async () => {
    // ログは `system.manage` で読める。`reason` と同じ理由で、媒体だけ落とす（設計 §6.11）。
    const entries: LogEntry[] = [];
    const fake = createFakePds({ media: () => new Response('', { status: 404 }) });

    await publish({ fetch: fake.fetch, post: WITH_MEDIA, logger: captureLogger(entries) });

    const warned = entries.filter((entry) => entry.level === 'warn');
    expect(warned.length).toBeGreaterThan(0);
    for (const entry of warned) {
      expect(entry.detail).toMatchObject({ phase: 'media' });
      expect(entry.detail).not.toHaveProperty('status');
    }
  });

  it.each([
    [
      'createSession',
      createFakePds({ session: () => json({ error: 'InvalidRequest' }, 400) }),
      400,
    ],
    ['uploadBlob', createFakePds({ upload: () => json({ error: 'BlobTooLarge' }, 400) }), 400],
    ['createRecord', createFakePds({ record: () => json({ error: 'InvalidRequest' }, 400) }), 400],
  ])('#76 %s の失敗では logger の detail に status を渡す', async (phase, fake, status) => {
    // 送り先は運用者が設定した PDS ただ1つ。**運用者が自分の設定を直すための情報**である。
    const entries: LogEntry[] = [];

    await publish({ fetch: fake.fetch, post: WITH_MEDIA, logger: captureLogger(entries) });

    expect(entries.filter((entry) => entry.level === 'warn')).toContainEqual(
      expect.objectContaining({ detail: expect.objectContaining({ phase, status }) }),
    );
  });
});

/**
 * #74 の後半。**偽の `fetch` が本番と同じ振る舞いをしていることの担保。**
 *
 * この Plugin のテストはすべて偽の `fetch` を注入している。**偽物が本番と違う振る舞いをすると、
 * 表の行が緑のまま本番で逆に倒れる**（`redirect: 'error'` がまさにそれだった。設計 §6.2 の引用枠）。
 * ここだけは**自分で立てたループバックのサーバへ本物の `fetch` で当てて**、
 * `init` の綴りに対して本番が何を返すかを直に見る。**外部への通信は 1 本も出ない。**
 */
describe('#74 本番の fetch が redirect: manual で 3xx を返すこと（設計 §6.2）', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/redirect.png') {
        response.writeHead(302, { location: '/moved.png' }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from([137, 80, 78, 71]));
    });
    // listen は非同期。待たずに address() を読むと null になる。
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('#74 redirect: manual は 302 を Response として返す（追わない）', async () => {
    const response = await realFetch(`${origin}/redirect.png`, {
      method: 'GET',
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    // 追っていない（追っていれば 200 になる）。ブラウザの opaque-redirect とも違い、中身が読める。
    expect(response.headers.get('location')).toBe('/moved.png');
  });

  it('#74 redirect: error は 3xx を Response として返さず reject する', async () => {
    // **これが `kind: "network"` に落ち、設計 §6.9 の P2 と逆の retryable: true になっていた。**
    await expect(
      realFetch(`${origin}/redirect.png`, { method: 'GET', redirect: 'error' }),
    ).rejects.toThrow();
  });

  it('#74 本物の fetch で本物の 302 を踏んでも retryable: false になる', async () => {
    // 偽の PDS へは偽物を、媒体の取得だけは**本物の `fetch`** を通す。
    const fake = createFakePds();
    const mixed = (async (input: unknown, init: RequestInit = {}): Promise<Response> => {
      const url = String(input);
      return url.startsWith(origin)
        ? await realFetch(url, init)
        : await fake.fetch(url as string, init);
    }) as typeof globalThis.fetch;

    const result = failureOf(
      await publish({
        fetch: mixed,
        post: { media: [{ url: `${origin}/redirect.png`, alt: null }] },
      }),
    );

    // 偽の 302 を返したときと同じ結果になる（＝偽物が本番と同じ振る舞いをしている）。
    expect(result.retryable).toBe(false);
    expect(fake.calls.filter((call) => call.url.includes(RECORD_NSID))).toHaveLength(0);
  });
});

describe('P3 uploadBlob（表 3 行）', () => {
  it.each([
    ['接続断', createFakePds({ upload: connectionRefused() })],
    ['5xx（502）', createFakePds({ upload: () => json({}, 502) })],
    ['429', createFakePds({ upload: () => json({ error: 'RateLimitExceeded' }, 429) })],
  ])('%s → retryable: true（blob は投稿ではない）', async (_label, fake) => {
    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(true);
  });

  it('制限時間 → retryable: true', async () => {
    const fake = createFakePds({ upload: hangUntilAbort() });

    const result = failureOf(await publishThenAbort({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(true);
  });

  it.each([['BlobTooLarge'], ['UnsupportedMimeType'], ['InvalidRequest']])(
    '400 %s → retryable: false（内容の問題）',
    async (code) => {
      const fake = createFakePds({ upload: () => json({ error: code }, 400) });

      const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

      expect(result.retryable).toBe(false);
    },
  );

  it('401 → retryable: false（資格情報の問題。P1 と同じ扱い）', async () => {
    const fake = createFakePds({ upload: () => json({ error: 'ExpiredToken' }, 401) });

    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.retryable).toBe(false);
  });
});

describe('P4 createRecord（表 4 行）', () => {
  it('429 RateLimitExceeded → retryable: true ＋ retryAfterMs', async () => {
    // **書き込む前に断られたと読める**（設計 §6.9）。
    const reset = Math.floor(Date.now() / 1000) + 60;
    const fake = createFakePds({
      record: () => json({ error: 'RateLimitExceeded' }, 429, { 'ratelimit-reset': String(reset) }),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(55_000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it.each([
    ['接続断', createFakePds({ record: connectionRefused() })],
    ['5xx（500）', createFakePds({ record: () => json({ error: 'InternalServerError' }, 500) })],
    [
      '応答が JSON でない',
      createFakePds({
        record: () =>
          new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
      }),
    ],
    ['uri が無い', createFakePds({ record: () => json({ cid: 'bafytestcid0001' }) })],
  ])('%s → retryable: false（届いたか分からない）', async (_label, fake) => {
    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(false);
  });

  it('制限時間 → retryable: false', async () => {
    // **SNS の投稿は取り消せない。** 疑わしきは false に倒す（設計 §6.9）。
    const fake = createFakePds({ record: hangUntilAbort() });

    const result = failureOf(await publishThenAbort({ fetch: fake.fetch }));

    expect(result.retryable).toBe(false);
  });

  it.each([['ExpiredToken'], ['InvalidToken']])('401 %s → retryable: false', async (code) => {
    const fake = createFakePds({ record: () => json({ error: code }, 401) });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(false);
  });

  it('その他の 4xx（400 InvalidRequest）→ retryable: false', async () => {
    const fake = createFakePds({ record: () => json({ error: 'InvalidRequest' }, 400) });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.retryable).toBe(false);
  });
});

describe('どこでも（表 2 行のうち「予期しない例外」。#45）', () => {
  it('予期しない例外 → 例外を投げずに retryable: false', async () => {
    // `providerOptions` は外から来た任意の JSON（設計 §9.3）。触ると投げる値を渡す。
    const hostile = new Proxy({} as Record<string, unknown>, {
      get: () => {
        throw new Error('わざと投げた例外');
      },
    });
    const fake = createFakePds();

    const result = failureOf(
      await publish({ fetch: fake.fetch, post: { providerOptions: hostile } }),
    );

    expect(result.retryable).toBe(false);
  });

  it.each([
    ['createSession が 500', createFakePds({ session: () => json({}, 500) })],
    ['媒体が 404', createFakePds({ media: () => new Response('', { status: 404 }) })],
    ['uploadBlob が 400', createFakePds({ upload: () => json({ error: 'BlobTooLarge' }, 400) })],
    ['createRecord が 500', createFakePds({ record: () => json({}, 500) })],
    ['接続できない', createFakePds({ session: connectionRefused() })],
  ])('#45 %s でも publish() は例外を投げない', async (_label, fake) => {
    await expect(publish({ fetch: fake.fetch, post: WITH_MEDIA })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('秘匿（#46〜#49）', () => {
  function scenarios(): readonly (readonly [string, FakePds])[] {
    return [
      [
        'createSession が 401',
        createFakePds({ session: () => json({ error: 'AuthenticationRequired' }, 401) }),
      ],
      ['createSession が 500', createFakePds({ session: () => json({}, 500) })],
      ['createSession が接続断', createFakePds({ session: connectionRefused() })],
      ['媒体が 404', createFakePds({ media: () => new Response('', { status: 404 }) })],
      ['uploadBlob が 401', createFakePds({ upload: () => json({ error: 'ExpiredToken' }, 401) })],
      [
        'createRecord が 500',
        createFakePds({ record: () => json({ error: 'InternalServerError' }, 500) }),
      ],
      [
        'createRecord が 429',
        createFakePds({ record: () => json({ error: 'RateLimitExceeded' }, 429) }),
      ],
    ];
  }

  it.each(scenarios())('#46 %s の reason に資格情報が現れない', async (_label, fake) => {
    const result = failureOf(await publish({ fetch: fake.fetch, post: WITH_MEDIA }));

    expect(result.reason).not.toContain(IDENTIFIER);
    expect(result.reason).not.toContain(APP_PASSWORD);
  });

  it('#47 PDS が返した message を reason に載せない', async () => {
    // PDS の URL は設定で変えられる。応答の自由文は「管理者が指した先のサーバが書いた文字列」（設計 §6.11）。
    const fake = createFakePds({
      record: () => json({ error: 'InvalidRequest', message: APP_PASSWORD }, 400),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.reason).not.toContain(APP_PASSWORD);
  });

  it('#47 message が任意の文章でも reason に混ざらない', async () => {
    const message = 'この文章はPDSが書いた自由文です';
    const fake = createFakePds({
      record: () => json({ error: 'InvalidRequest', message }, 400),
    });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.reason).not.toContain(message);
  });

  it('#48 知らない error コードは reason に出さず unknown と書く', async () => {
    const fake = createFakePds({ session: () => json({ error: 'ZZZ' }, 400) });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.reason).not.toContain('ZZZ');
    expect(result.reason).toContain('unknown');
  });

  it('#48 既知の error コードは reason に出す', async () => {
    const fake = createFakePds({ session: () => json({ error: 'AuthenticationRequired' }, 401) });

    const result = failureOf(await publish({ fetch: fake.fetch }));

    expect(result.reason).toContain('401');
    expect(result.reason).toContain('AuthenticationRequired');
  });

  it('#49 成功しても logger に資格情報・本文・ハンドルを渡さない', async () => {
    const entries: LogEntry[] = [];
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, logger: captureLogger(entries), post: WITH_MEDIA });

    expect(entries.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(entries);
    for (const secret of [
      IDENTIFIER,
      APP_PASSWORD,
      ACCESS_JWT,
      SECRET_BODY,
      SESSION_HANDLE,
      ACCOUNT_HANDLE,
    ]) {
      expect(dumped).not.toContain(secret);
    }
  });

  it.each(scenarios())(
    '#49 %s でも logger に資格情報・本文・ハンドルを渡さない',
    async (_label, fake) => {
      const entries: LogEntry[] = [];

      await publish({ fetch: fake.fetch, logger: captureLogger(entries), post: WITH_MEDIA });

      const dumped = JSON.stringify(entries);
      for (const secret of [
        IDENTIFIER,
        APP_PASSWORD,
        ACCESS_JWT,
        SECRET_BODY,
        SESSION_HANDLE,
        ACCOUNT_HANDLE,
      ]) {
        expect(dumped).not.toContain(secret);
      }
    },
  );

  it('#49 logger には postId と attempt とフェーズ名が渡る', async () => {
    const entries: LogEntry[] = [];
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, logger: captureLogger(entries) });

    const dumped = JSON.stringify(entries);
    expect(dumped).toContain(postView().id);
    expect(dumped).toContain('attempt');
  });

  it('#52 このファイルは本物の fetch を差し替えている', async () => {
    // 差し替え忘れがあれば、注入していないテストがここで落ちる。
    expect(globalThis.fetch).not.toBe(realFetch);
    expect(() => globalThis.fetch('https://bsky.social')).toThrow('本物の fetch が呼ばれた');
  });
});

describe('media と link は同時に付けられない（設計 §6.8）', () => {
  it('両方あれば黙って片方を捨てずに失敗する', async () => {
    // `embed` は1つしか持てない。`validate()` が断る形だが、配信時にも黙って捨てない。
    const fake = createFakePds();

    const result = failureOf(
      await publish({
        fetch: fake.fetch,
        post: { ...WITH_MEDIA, link: 'https://example.com/a' },
      }),
    );

    expect(result.retryable).toBe(false);
    expect(fake.calls.filter((call) => call.url.includes(RECORD_NSID))).toHaveLength(0);
  });

  it('#82 断るときも logger.warn が出る（phase: embed）', async () => {
    // **失敗して戻るのにログに何も残らない**のは、「通常ここへは来ない」経路ほど困る（設計 §6.8）。
    const entries: LogEntry[] = [];
    const fake = createFakePds();

    await publish({
      fetch: fake.fetch,
      post: { ...WITH_MEDIA, link: 'https://example.com/a' },
      logger: captureLogger(entries),
    });

    expect(entries.filter((entry) => entry.level === 'warn')).toContainEqual(
      expect.objectContaining({ detail: expect.objectContaining({ phase: 'embed' }) }),
    );
  });
});

/**
 * #80 媒体の処理の合計時間（設計 §6.6）。
 *
 * **`kind: 'budget'` の分岐を実際に通す。** 実時間で 20 秒待つ代わりに、
 * **`now()` を進める偽の時計**で期限切れを再現する（設計 §6.6 の「期限の『いま』は `now()` で数える」）。
 */
describe('#80 媒体の処理の合計時間（設計 §6.6）', () => {
  /** 媒体を取りに行くたびに時計を `stepMs` 進める偽の時計つきの偽 PDS。 */
  function advancingClock(stepMs: number, on: 'media' | 'session') {
    let current = FIXED_NOW.getTime();
    const now = (): Date => new Date(current);
    const advance = (): void => {
      current += stepMs;
    };
    const fake = createFakePds({
      media: () => {
        if (on === 'media') advance();
        return imageOk();
      },
      session: () => {
        if (on === 'session') advance();
        return sessionOk();
      },
    });
    return { now, fake };
  }

  const TWO_MEDIA: Partial<SocialPostView> = {
    media: [
      { url: 'https://cdn.example.com/first.png', alt: null },
      { url: 'https://cdn.example.com/second.png', alt: null },
    ],
  };

  it('#80 合計時間を使い切ったら kind: budget で諦める（retryable: true）', async () => {
    const { now, fake } = advancingClock(MEDIA_TOTAL_BUDGET_MS + 1_000, 'media');

    const result = failureOf(await publish({ fetch: fake.fetch, post: TWO_MEDIA, now }));

    expect(result.retryable).toBe(true);
    expect(result.reason).toContain('画像の取得に時間がかかりすぎました');
  });

  it('#80 諦めたときは残りの媒体を取りに行かず、createRecord も呼ばない', async () => {
    // まだ `createRecord` を呼んでいないので、諦めても投稿は作られていない（設計 §6.9 の P2）。
    const { now, fake } = advancingClock(MEDIA_TOTAL_BUDGET_MS + 1_000, 'media');

    await publish({ fetch: fake.fetch, post: TWO_MEDIA, now });

    expect(fake.calls.filter((call) => call.url.includes('cdn.example.com'))).toHaveLength(1);
    expect(fake.calls.filter((call) => call.url.includes(RECORD_NSID))).toHaveLength(0);
  });

  it('#80 媒体の期限は合計の期限を超えない（createSession が食った分だけ縮む）', async () => {
    // 媒体の 20 秒は **`createSession` の後の残り時間から取る**（設計 §6.6）。
    const { now, fake } = advancingClock(PUBLISH_TOTAL_BUDGET_MS + 1_000, 'session');

    const result = failureOf(await publish({ fetch: fake.fetch, post: TWO_MEDIA, now }));

    expect(result.retryable).toBe(true);
    expect(fake.calls.filter((call) => call.url.includes('cdn.example.com'))).toHaveLength(0);
  });

  it('#80 時間に余裕があれば2件とも配信される', async () => {
    // 期限の判定が常に発火するようになっていないことを見る（#80 の対の条件）。
    const { now, fake } = advancingClock(1_000, 'media');

    const result = await publish({ fetch: fake.fetch, post: TWO_MEDIA, now });

    expect(result.ok).toBe(true);
    expect(fake.calls.filter((call) => call.url.includes(RECORD_NSID))).toHaveLength(1);
  });
});

/**
 * #81 制限時間の結線（設計 §6.6）。
 *
 * 値が合っていても**どの定数がどの要求へ渡るか**が入れ替われば意味が変わる。
 * 設計 §6.6 は `AbortSignal.any([外側の signal, AbortSignal.timeout(ms)])` と綴りまで決めているので、
 * **`AbortSignal.timeout` へ渡った値の列**を要求の列と突き合わせる。
 */
describe('#81 制限時間の結線（設計 §6.6）', () => {
  it('#81 どの定数がどの要求へ渡るかが固定されている', async () => {
    const original = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    AbortSignal.timeout = ((ms: number): AbortSignal => {
      requested.push(ms);
      return original(ms);
    }) as typeof AbortSignal.timeout;

    const pairs: { readonly url: string; readonly timeoutMs: number | undefined }[] = [];
    const fake = createFakePds();

    try {
      const watched = (async (input: unknown, init: RequestInit = {}): Promise<Response> => {
        pairs.push({ url: String(input), timeoutMs: requested[requested.length - 1] });
        return await fake.fetch(String(input), init);
      }) as typeof globalThis.fetch;

      await publish({ fetch: watched, post: WITH_MEDIA });
    } finally {
      AbortSignal.timeout = original as typeof AbortSignal.timeout;
    }

    expect(pairs).toEqual([
      { url: `https://bsky.social/xrpc/${SESSION_NSID}`, timeoutMs: CREATE_SESSION_TIMEOUT_MS },
      { url: MEDIA_URL, timeoutMs: MEDIA_FETCH_TIMEOUT_MS },
      { url: `https://bsky.social/xrpc/${UPLOAD_NSID}`, timeoutMs: UPLOAD_BLOB_TIMEOUT_MS },
      { url: `https://bsky.social/xrpc/${RECORD_NSID}`, timeoutMs: CREATE_RECORD_TIMEOUT_MS },
    ]);
  });

  it('#81 publish() 全体に合計の期限が掛かる', async () => {
    // **要求ごとの制限時間だけでは合計を縛れない**（設計 §6.6 の引用枠）。
    const original = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    AbortSignal.timeout = ((ms: number): AbortSignal => {
      requested.push(ms);
      return original(ms);
    }) as typeof AbortSignal.timeout;

    const fake = createFakePds();
    try {
      await publish({ fetch: fake.fetch, post: WITH_MEDIA });
    } finally {
      AbortSignal.timeout = original as typeof AbortSignal.timeout;
    }

    // 1 度だけ、**どの要求よりも先に**作られる。
    expect(requested[0]).toBe(PUBLISH_TOTAL_BUDGET_MS);
    expect(requested.filter((ms) => ms === PUBLISH_TOTAL_BUDGET_MS)).toHaveLength(1);
  });

  it('#81 合計の期限は Core の 30 秒より短い', async () => {
    // 30 秒に達してから打ち切られるのは最悪の形（設計 §6.6）。自分から届かない値にする。
    expect(PUBLISH_TOTAL_BUDGET_MS).toBeLessThan(30_000);
    expect(PUBLISH_TOTAL_BUDGET_MS).toBeGreaterThanOrEqual(
      CREATE_SESSION_TIMEOUT_MS + CREATE_RECORD_TIMEOUT_MS,
    );
  });
});
