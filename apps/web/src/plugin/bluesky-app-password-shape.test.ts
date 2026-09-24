import type {
  PluginLogger,
  PluginStore,
  PublishResult,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';

/**
 * Bluesky 配信 Plugin：App Password の形でない値を Bluesky へ送らずに断る
 * （041-plugin-help-docs 設計 §6.5、ユーザー裁定 U2、受け入れ条件 #88〜#91）。
 *
 * AT Protocol の `createSession` はアカウントのパスワードも受け付け、そのときは全権限のセッションになる。
 * そこで `publish()` の入口（PDS の URL の解決の後、`createSession` の前）で `appPassword` を
 * `/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/` と比べ、合わなければ
 * **`fetch` を 1 度も呼ばずに** `retryable: false` で返す。
 *
 * **実際の Bluesky を叩かない。** 口は `createBlueskyPublisher({ store, fetch, now })` の `fetch`。
 *
 * 注：
 * - ファイル名を `sns-bluesky` で始めない（既存の静的検査がテストの本数を名前の一覧で固定している。
 *   041 実装プラン §8 の 19）。偽の PDS は既存のテストから写し、共有しない
 * - `beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換え、`afterEach` で戻す
 */

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 値                                                                           */
/* -------------------------------------------------------------------------- */

/** 設計 §6.5.3 の文言（`APP_PASSWORD_SHAPE_REASON`）。 */
const APP_PASSWORD_SHAPE_REASON =
  'App Password（アプリパスワード）の形ではありません。ログイン用のパスワードは送らずに止めました。' +
  'Bluesky の「設定 → プライバシーとセキュリティ → アプリパスワード」で発行した xxxx-xxxx-xxxx-xxxx の形の値を、' +
  '「資格情報を設定」から入れてください。';

/** 設計 #91 が消すことを求める旧い文言。 */
const OLD_401_WORDING = 'ログイン用のパスワードでは配信できません';

const SESSION_NSID = 'com.atproto.server.createSession';
const RECORD_NSID = 'com.atproto.repo.createRecord';

const IDENTIFIER = 'shape-test.bsky.example';
const FIXED_NOW = new Date('2026-09-24T09:00:00.000Z');

/** 設計 #88 の、形に合わない 9 通り。 */
const REJECTED: readonly string[] = [
  'my-login-password',
  'abcd-efgh-ijkl',
  'abcd-efgh-ijkl-mnop-qrst',
  'abcd efgh ijkl mnop',
  'abcd_efgh_ijkl_mnop',
  'abcdefghijklmnop',
  'ａｂｃｄ-ｅｆｇｈ-ｉｊｋｌ-ｍｎｏｐ',
  ' abcd-efgh-ijkl-mnop',
  '',
];

/** 設計 #89 の、形に合う 3 通り。 */
const ACCEPTED: readonly string[] = [
  'abcd-efgh-ijkl-mnop',
  '2b3c-4d5e-6f7g-2h3i',
  'ABCD-EFGH-IJKL-MNOP',
];

/* -------------------------------------------------------------------------- */
/* 偽の PDS（`sns-bluesky-publish.test.ts` の作りを写した）                          */
/* -------------------------------------------------------------------------- */

interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface FakePds {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FakeCall[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFakePds(session?: () => Response): FakePds {
  const calls: FakeCall[] = [];
  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.includes(SESSION_NSID)) {
      return (
        session?.() ??
        json({
          did: 'did:plc:shapetest0001',
          handle: 'real-handle.bsky.example',
          accessJwt: 'access-jwt-shape-0001',
          refreshJwt: 'refresh-jwt-shape-0002',
        })
      );
    }
    if (url.includes(RECORD_NSID)) {
      return json({ uri: 'at://did:plc:shapetest0001/app.bsky.feed.post/3kshape0001', cid: 'x' });
    }
    throw new Error(`偽の PDS が知らない要求: ${url}`);
  };
  return { fetch: impl as unknown as typeof globalThis.fetch, calls };
}

/** 最小の Key-Value Store。`pds-url` は未設定（既定の PDS）＝**正しい設定**。 */
function fakeStore(): PluginStore {
  const unused = (): never => {
    throw new Error('使わない');
  };
  return {
    get: async <T = unknown>(): Promise<T | null> => null,
    set: unused,
    delete: unused,
    keys: unused,
    setSecret: unused,
    getSecret: unused,
    hasSecret: unused,
  };
}

/** 設定の読み出しに失敗する Store（`phase: 'config'` の先の判定を見るため）。 */
function brokenStore(): PluginStore {
  return {
    ...fakeStore(),
    get: async (): Promise<never> => {
      throw new Error('store is down');
    },
  };
}

interface LogEntry {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

function captureLogger(): { readonly logger: PluginLogger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: LogEntry['level']) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields });
    };
  return {
    entries,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}

function accountView(): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a088',
    provider: 'bluesky',
    displayName: 'テストアカウント',
    handle: 'registered-handle.example',
    status: 'active',
    credentialConfigured: true,
  };
}

function postView(): SocialPostView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000b088',
    socialAccountId: accountView().id,
    body: 'こんにちは',
    scheduledAt: '2026-09-24T09:00:00.000Z',
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
  };
}

interface RunOptions {
  readonly appPassword: string;
  readonly fake?: FakePds;
  readonly store?: PluginStore;
}

interface RunResult {
  readonly result: PublishResult;
  readonly fake: FakePds;
  readonly log: LogEntry[];
}

async function run(options: RunOptions): Promise<RunResult> {
  const fake = options.fake ?? createFakePds();
  const { logger, entries } = captureLogger();
  const registration = createBlueskyPublisher({
    store: options.store ?? fakeStore(),
    fetch: fake.fetch,
    now: () => FIXED_NOW,
  });
  if (registration.publish === undefined) {
    throw new Error('publish() が実装されていない');
  }
  const result = await registration.publish({
    post: postView(),
    account: accountView(),
    credential: { identifier: IDENTIFIER, appPassword: options.appPassword },
    attempt: 3,
    signal: new AbortController().signal,
    logger,
  });
  return { result, fake, log: entries };
}

function reasonOf(result: PublishResult): string {
  if (result.ok) {
    throw new Error('失敗を期待したが成功した');
  }
  return result.reason;
}

/* -------------------------------------------------------------------------- */
/* #88 形に合わない値は送らずに断る                                               */
/* -------------------------------------------------------------------------- */

describe('#88 App Password の形でない値は Bluesky へ送らずに断る', () => {
  it.each(REJECTED)('#88 %j → fetch を 1 度も呼ばない（createSession を含む）', async (value) => {
    const { fake } = await run({ appPassword: value });

    expect(fake.calls).toHaveLength(0);
  });

  it.each(REJECTED)(
    '#88 %j → { ok: false, retryable: false, reason: APP_PASSWORD_SHAPE_REASON }',
    async (value) => {
      const { result } = await run({ appPassword: value });

      expect(result).toStrictEqual({
        ok: false,
        retryable: false,
        reason: APP_PASSWORD_SHAPE_REASON,
      });
    },
  );

  it('#88 形の確認は PDS の URL の解決の後：設定を読み出せなければ、形の誤りより先に設定の失敗を返す', async () => {
    const { result, fake } = await run({ appPassword: 'my-login-password', store: brokenStore() });

    expect(fake.calls).toHaveLength(0);
    expect(reasonOf(result)).not.toBe(APP_PASSWORD_SHAPE_REASON);
    expect(result.ok === false && result.retryable).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #89 形に合う値は従来どおり                                                     */
/* -------------------------------------------------------------------------- */

describe('#89 App Password の形の値は従来どおり createSession へ進む', () => {
  it.each(ACCEPTED)('#89 %j → 最初の要求が createSession', async (value) => {
    const { fake } = await run({ appPassword: value });

    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls[0]?.url).toContain(SESSION_NSID);
  });

  it.each(ACCEPTED)('#89 %j → 配信に成功する', async (value) => {
    const { result } = await run({ appPassword: value });

    expect(result.ok).toBe(true);
  });

  it.each(ACCEPTED)(
    '#89 %j → createSession の本体に値がそのまま入る（書き換えない）',
    async (value) => {
      const { fake } = await run({ appPassword: value });

      const body = JSON.parse(String(fake.calls[0]?.body)) as Record<string, unknown>;
      expect(body['password']).toBe(value);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #90 reason とログに値を出さない                                                */
/* -------------------------------------------------------------------------- */

describe('#90 断ったときの reason とログに、入れた値を出さない', () => {
  const nonEmpty = REJECTED.filter((value) => value.trim() !== '');

  it.each(nonEmpty)('#90 %j：reason に値が現れない', async (value) => {
    const { result } = await run({ appPassword: value });

    expect(reasonOf(result)).not.toContain(value.trim());
  });

  it.each(nonEmpty)('#90 %j：logger の message と fields に値が現れない', async (value) => {
    const { log } = await run({ appPassword: value });

    expect(JSON.stringify(log.map((entry) => [entry.message, entry.fields]))).not.toContain(
      value.trim(),
    );
  });

  it.each(REJECTED)(
    "#90 %j：logger.warn('app password shape rejected') が 1 回で、fields のキーが postId / attempt / phase ちょうど",
    async (value) => {
      const { log } = await run({ appPassword: value });
      const rejected = log.filter((entry) => entry.message === 'app password shape rejected');

      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.level).toBe('warn');
      expect(Object.keys(rejected[0]?.fields ?? {}).sort()).toEqual(
        ['attempt', 'phase', 'postId'].sort(),
      );
      expect(rejected[0]?.fields).toStrictEqual({
        postId: postView().id,
        attempt: 3,
        phase: 'credential',
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #91 createSession の 401 の文言                                                */
/* -------------------------------------------------------------------------- */

describe('#91 createSession の 401 の reason', () => {
  it.each(['AuthenticationRequired', 'InvalidPassword'])(
    `#91 401 %s → 「${OLD_401_WORDING}」が無い`,
    async (code) => {
      const fake = createFakePds(() =>
        json({ error: code, message: 'Invalid identifier or password' }, 401),
      );
      const { result } = await run({ appPassword: 'abcd-efgh-ijkl-mnop', fake });

      expect(reasonOf(result)).not.toContain(OLD_401_WORDING);
    },
  );

  it.each(['AuthenticationRequired', 'InvalidPassword'])(
    '#91 401 %s → 「App Password」と「取り消されていないか」を含む',
    async (code) => {
      const fake = createFakePds(() => json({ error: code }, 401));
      const { result } = await run({ appPassword: 'abcd-efgh-ijkl-mnop', fake });
      const reason = reasonOf(result);

      expect(reason).toContain('App Password');
      expect(reason).toContain('取り消されていないか');
    },
  );

  it('#91 401 は従来どおり retryable: false', async () => {
    const fake = createFakePds(() => json({ error: 'AuthenticationRequired' }, 401));
    const { result } = await run({ appPassword: 'abcd-efgh-ijkl-mnop', fake });

    expect(result.ok === false && result.retryable).toBe(false);
  });
});
