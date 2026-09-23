import type {
  PluginLogger,
  PluginStore,
  PublishResult,
  PublisherRegistration,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';

/**
 * Bluesky 配信 Plugin の `publish()`：正常系（036-sns-bluesky 設計 §10「publish()：正常系」）。
 *
 * **実際の Bluesky を叩かない。** 口は `createBlueskyPublisher({ store, fetch, now })` の
 * `fetch` で、このファイルは偽の PDS を注入する（設計 §10.1）。
 *
 * #52：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 * 差し替え忘れがあれば落ちる。**共有ヘルパにせず、このファイルに持つ**（実装プラン §8 の 2）。
 */

const SESSION_NSID = 'com.atproto.server.createSession';
const UPLOAD_NSID = 'com.atproto.repo.uploadBlob';
const RECORD_NSID = 'com.atproto.repo.createRecord';

/** `createSession` の応答。**`account.handle` とは違う値**にしてある（#36）。 */
const SESSION_DID = 'did:plc:torifunetest0001';
const SESSION_HANDLE = 'real-handle.bsky.example';
const ACCESS_JWT = 'access-jwt-value-0001';
const REFRESH_JWT = 'refresh-jwt-value-0002';

const RKEY = '3ktestrkey0001';
const RECORD_URI = `at://${SESSION_DID}/app.bsky.feed.post/${RKEY}`;

/** Torifune 側に登録されたハンドル。**`externalUrl` には使わない**（設計 §6.4）。 */
const ACCOUNT_HANDLE = 'registered-handle.example';

const IDENTIFIER = 'torifune-test.bsky.example';
const APP_PASSWORD = 'zzzz-yyyy-xxxx-wwww';

/** `record.createdAt` に出る時刻（#35）。 */
const FIXED_NOW = new Date('2026-09-23T12:34:56.789Z');

interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

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
    refreshJwt: REFRESH_JWT,
  });
}

function recordOk(): Response {
  return json({ uri: RECORD_URI, cid: 'bafytestcid0001' });
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

/** 偽の PDS。要求の列を記録し、NSID ごとに用意した応答を返す（実装プラン §2「テストの方法」）。 */
function createFakePds(options: FakePdsOptions = {}): FakePds {
  const calls: FakeCall[] = [];
  let mediaIndex = 0;
  let uploadIndex = 0;

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body,
    });

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

function callAt(fake: FakePds, index: number): FakeCall {
  const call = fake.calls[index];
  if (call === undefined) {
    throw new Error(`${index} 番目の要求が無い（実際は ${fake.calls.length} 件）`);
  }
  return call;
}

function jsonBodyOf(call: FakeCall): Record<string, unknown> {
  if (typeof call.body !== 'string') {
    throw new Error(`本体が JSON 文字列ではない: ${call.url}`);
  }
  return JSON.parse(call.body) as Record<string, unknown>;
}

function recordOf(call: FakeCall): Record<string, unknown> {
  const record = jsonBodyOf(call)['record'];
  if (typeof record !== 'object' || record === null) {
    throw new Error('record が無い');
  }
  return record as Record<string, unknown>;
}

/** 最小の Key-Value Store。`pds-url` の読み書きだけを実装する。 */
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
    body: 'こんにちは',
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
  readonly account?: Partial<SocialAccountView>;
  readonly store?: PluginStore;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
  readonly credential?: Readonly<Record<string, string>>;
}

async function invoke(
  registration: PublisherRegistration,
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (registration.publish === undefined) {
    throw new Error('publish() が実装されていない');
  }
  return await registration.publish({
    post: postView(options.post),
    account: accountView(options.account),
    credential: options.credential ?? { identifier: IDENTIFIER, appPassword: APP_PASSWORD },
    attempt: 1,
    signal: options.signal ?? new AbortController().signal,
    logger: options.logger ?? silentLogger(),
  });
}

async function publish(options: PublishOptions = {}): Promise<PublishResult> {
  const registration = createBlueskyPublisher({
    store: options.store ?? fakeStore(),
    fetch: options.fetch,
    now: options.now ?? (() => FIXED_NOW),
  });
  return await invoke(registration, options);
}

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  // #52：本物の `fetch` を呼んだら落ちる。差し替え忘れを検出する。
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('#1 既定の経路（fetch と now を与えない）', () => {
  it('fetch を与えなければ globalThis.fetch を使う', async () => {
    // 本番の経路（`index.ts` は引数を与えずに呼ぶ）が既定を通ることを固定する。
    const fake = createFakePds();
    globalThis.fetch = fake.fetch;

    const result = await invoke(createBlueskyPublisher({ store: fakeStore() }));

    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it('now を与えなければ現在時刻を使う', async () => {
    const fake = createFakePds();
    globalThis.fetch = fake.fetch;

    await invoke(createBlueskyPublisher({ store: fakeStore() }));

    const createdAt = recordOf(callAt(fake, 1))['createdAt'];
    expect(typeof createdAt).toBe('string');
    expect(Math.abs(Date.parse(createdAt as string) - Date.now())).toBeLessThan(60_000);
  });
});

describe('publish()：正常系（#33〜#43）', () => {
  it('#33 createSession → createRecord の2回で成功する', async () => {
    const fake = createFakePds();

    const result = await publish({ fetch: fake.fetch });

    expect(result).toEqual({
      ok: true,
      externalId: RKEY,
      externalUrl: `https://bsky.app/profile/${SESSION_HANDLE}/post/${RKEY}`,
    });
    expect(fake.calls).toHaveLength(2);
    expect(callAt(fake, 0).url).toContain(SESSION_NSID);
    expect(callAt(fake, 1).url).toContain(RECORD_NSID);
  });

  it('#33 rotatedCredential を返さない', async () => {
    // App Password は固定なので延ばす必要がない（設計 §6.5）。
    const fake = createFakePds();

    const result = await publish({ fetch: fake.fetch });

    expect(result).not.toHaveProperty('rotatedCredential');
  });

  it('#34 createSession へ送る本体は identifier と password の2つだけ', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch });

    const body = jsonBodyOf(callAt(fake, 0));
    expect(Object.keys(body).sort()).toEqual(['identifier', 'password']);
    expect(body['identifier']).toBe(IDENTIFIER);
    expect(body['password']).toBe(APP_PASSWORD);
  });

  it('#34 credential のキーをそのまま送らない（appPassword という名前で送らない）', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch });

    expect(callAt(fake, 0).body).not.toContain('appPassword');
  });

  it('#35 createRecord の repo / collection / $type / createdAt', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch });

    const call = callAt(fake, 1);
    const body = jsonBodyOf(call);
    expect(body['repo']).toBe(SESSION_DID);
    expect(body['collection']).toBe('app.bsky.feed.post');

    const record = recordOf(call);
    expect(record['$type']).toBe('app.bsky.feed.post');
    expect(record['text']).toBe('こんにちは');
    // **実際に送った時刻。** 予約時刻（scheduledAt）を書かない（設計 §6.3）。
    expect(record['createdAt']).toBe(FIXED_NOW.toISOString());
  });

  it('#35 createRecord に accessJwt を Bearer で添える', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch });

    expect(callAt(fake, 1).headers.get('authorization')).toBe(`Bearer ${ACCESS_JWT}`);
  });

  it('#36 externalUrl の handle は createSession の応答を使う', async () => {
    // `account.handle` は利用者が書いた表示用の値で、実際のハンドルと食い違いうる（設計 §6.4）。
    const fake = createFakePds();

    const result = await publish({ fetch: fake.fetch, account: { handle: ACCOUNT_HANDLE } });

    expect(result).toMatchObject({
      externalUrl: `https://bsky.app/profile/${SESSION_HANDLE}/post/${RKEY}`,
    });
    expect(result).not.toMatchObject({
      externalUrl: `https://bsky.app/profile/${ACCOUNT_HANDLE}/post/${RKEY}`,
    });
  });

  it('#37 media 2件 → GET 2回 → uploadBlob 2回 → createRecord 1回', async () => {
    const fake = createFakePds();

    const result = await publish({
      fetch: fake.fetch,
      post: {
        media: [
          { url: 'https://cdn.example.com/a.png', alt: '一枚目の説明' },
          { url: 'https://cdn.example.com/b.png', alt: null },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(6);
    expect(fake.calls.filter((call) => call.url.includes('cdn.example.com'))).toHaveLength(2);
    expect(fake.calls.filter((call) => call.url.includes(UPLOAD_NSID))).toHaveLength(2);
    expect(fake.calls.filter((call) => call.url.includes(RECORD_NSID))).toHaveLength(1);
  });

  it('#37 embed.images に uploadBlob の blob をそのまま入れる', async () => {
    const fake = createFakePds();

    await publish({
      fetch: fake.fetch,
      post: {
        media: [
          { url: 'https://cdn.example.com/a.png', alt: '一枚目の説明' },
          { url: 'https://cdn.example.com/b.png', alt: null },
        ],
      },
    });

    const record = recordOf(callAt(fake, 5));
    expect(record['embed']).toEqual({
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: { $type: 'blob', ref: { $link: 'bafyblob0' }, mimeType: 'image/png', size: 4 },
          alt: '一枚目の説明',
        },
        {
          image: { $type: 'blob', ref: { $link: 'bafyblob1' }, mimeType: 'image/png', size: 4 },
          // alt が無ければ空文字（設計 §6.8）。
          alt: '',
        },
      ],
    });
  });

  it('#38 link だけの投稿は embed.external になり、OGP を取りに行かない', async () => {
    const fake = createFakePds();

    await publish({
      fetch: fake.fetch,
      post: { body: 'おしらせ', link: 'https://example.com/articles/1?x=2' },
    });

    // `fetch` は createSession と createRecord の2回だけ（設計 §6.8）。
    expect(fake.calls).toHaveLength(2);
    expect(recordOf(callAt(fake, 1))['embed']).toEqual({
      $type: 'app.bsky.embed.external',
      external: {
        uri: 'https://example.com/articles/1?x=2',
        title: 'example.com',
        description: '',
      },
    });
  });

  it('#39 本文中の URL の facets は UTF-8 のバイト位置', async () => {
    const fake = createFakePds();
    const body = 'おしらせです https://example.com/a をどうぞ';

    await publish({ fetch: fake.fetch, post: { body } });

    const encoder = new TextEncoder();
    const byteStart = encoder.encode('おしらせです ').length;
    const byteEnd = byteStart + encoder.encode('https://example.com/a').length;
    // UTF-16 の添字（`String.indexOf`）とは違う値になることを見る。
    expect(byteStart).not.toBe(body.indexOf('https://example.com/a'));

    expect(recordOf(callAt(fake, 1))['facets']).toEqual([
      {
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://example.com/a' }],
      },
    ]);
  });

  it('#40 URL の末尾に続く句読点・閉じ括弧を含めない', async () => {
    const fake = createFakePds();

    await publish({
      fetch: fake.fetch,
      post: { body: '案内は https://example.com/a。 と https://example.com/b) です' },
    });

    const facets = recordOf(callAt(fake, 1))['facets'] as readonly {
      features: readonly { uri: string }[];
    }[];
    expect(facets.map((facet) => facet.features[0]?.uri)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('#41 本文に URL が無ければ facets のキーを入れない', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, post: { body: 'リンクの無い本文' } });

    expect(recordOf(callAt(fake, 1))).not.toHaveProperty('facets');
  });

  it('#42 providerOptions.langs があれば record.langs に入る', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, post: { providerOptions: { langs: ['ja'] } } });

    expect(recordOf(callAt(fake, 1))['langs']).toEqual(['ja']);
  });

  it('#42 providerOptions.langs が無ければ langs のキーを入れない', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, post: { providerOptions: {} } });

    expect(recordOf(callAt(fake, 1))).not.toHaveProperty('langs');
  });

  it('#43 媒体は1件ずつ順に処理する（2件目の GET は1件目の uploadBlob の後）', async () => {
    // 4件を並行に取りに行くと、相手側の Rate Limit を自分で踏む（設計 §6.6）。
    const fake = createFakePds();

    await publish({
      fetch: fake.fetch,
      post: {
        media: [
          { url: 'https://cdn.example.com/first.png', alt: null },
          { url: 'https://cdn.example.com/second.png', alt: null },
        ],
      },
    });

    expect(
      fake.calls.map((call) => {
        if (call.url.includes(SESSION_NSID)) return 'session';
        if (call.url.includes(UPLOAD_NSID)) return 'upload';
        if (call.url.includes(RECORD_NSID)) return 'record';
        return call.url;
      }),
    ).toEqual([
      'session',
      'https://cdn.example.com/first.png',
      'upload',
      'https://cdn.example.com/second.png',
      'upload',
      'record',
    ]);
  });

  it('#50 input.signal が既に abort 済みなら fetch を1度も呼ばずに戻る', async () => {
    const fake = createFakePds();
    const controller = new AbortController();
    controller.abort();

    const result = await publish({ fetch: fake.fetch, signal: controller.signal });

    expect(fake.calls).toHaveLength(0);
    expect(result.ok).toBe(false);
  });
});

describe('PDS の URL（#53〜#57、#62）', () => {
  it('#53 pds-url が未設定なら bsky.social を叩く', async () => {
    const fake = createFakePds();

    await publish({ fetch: fake.fetch, store: fakeStore() });

    expect(callAt(fake, 0).url).toBe(`https://bsky.social/xrpc/${SESSION_NSID}`);
  });

  it('#54 pds-url を設定するとそのホストを叩く', async () => {
    const fake = createFakePds();
    const store = fakeStore(new Map([['pds-url', 'https://pds.example.com']]));

    await publish({ fetch: fake.fetch, store });

    expect(callAt(fake, 0).url).toBe(`https://pds.example.com/xrpc/${SESSION_NSID}`);
    for (const call of fake.calls) {
      expect(call.url).not.toContain('bsky.social');
    }
  });

  it('#55 末尾のスラッシュがあっても //xrpc にならない', async () => {
    const fake = createFakePds();
    const store = fakeStore(new Map([['pds-url', 'https://pds.example.com/']]));

    await publish({ fetch: fake.fetch, store });

    expect(callAt(fake, 0).url).toBe(`https://pds.example.com/xrpc/${SESSION_NSID}`);
  });

  it('#56 http の pds-url は fetch を1度も呼ばずに retryable: false', async () => {
    // そこへ App Password を平文で送ることになる（設計 §7.2）。
    const fake = createFakePds();
    const store = fakeStore(new Map([['pds-url', 'http://pds.example.com']]));

    const result = await publish({ fetch: fake.fetch, store });

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ['資格情報つき', 'https://user:pw@pds.example.com'],
    ['URL ではない', 'ほげ'],
    ['パス付き', 'https://pds.example.com/xrpc'],
    ['クエリ付き', 'https://pds.example.com/?a=1'],
  ])('#57 不正な pds-url（%s）は fetch を呼ばずに retryable: false', async (_label, value) => {
    const fake = createFakePds();
    const store = fakeStore(new Map([['pds-url', value]]));

    const result = await publish({ fetch: fake.fetch, store });

    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('#62 publish() は pds-url を毎回読む', async () => {
    // `activate()` の時点で読んで閉じ込めると、設定を変えても再起動するまで効かない（設計 §7.1）。
    const fake = createFakePds();
    const values = new Map<string, unknown>();
    const store = fakeStore(values);

    await publish({ fetch: fake.fetch, store });
    values.set('pds-url', 'https://second.example.com');
    await publish({ fetch: fake.fetch, store });

    expect(callAt(fake, 0).url).toBe(`https://bsky.social/xrpc/${SESSION_NSID}`);
    expect(callAt(fake, 2).url).toBe(`https://second.example.com/xrpc/${SESSION_NSID}`);
  });
});
