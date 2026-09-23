import type {
  PluginLogger,
  PublishResult,
  PublisherRegistration,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_MAX_LENGTH, validateCredentialAgainstFields } from '@/domain/social/credential';
import { isValidExternalUrl } from '@/domain/social/social';
import {
  ACCESS_TOKEN,
  CAROUSEL_CONTAINER_ID,
  CONTAINER_ID,
  IG_USER_ID,
  MEDIA_ID,
  OMIT_EXPIRES_IN,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  REFRESHED_EXPIRES_IN,
  childContainerId,
  containerCreated,
  containerStatus,
  graphError,
  htmlPage,
  mediaPublished,
  permalinkOf,
  toResponse,
  tokenRefreshed,
  type GraphResponseExample,
} from '@/test-support/instagram-graph';
import {
  CAROUSEL_CHILD_CONCURRENCY,
  GRAPH_API_BASE_URL,
  GRAPH_API_VERSION,
  POLL_INTERVAL_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  REFRESH_TIMEOUT_MS,
} from '../../../../plugins/sns-instagram/graph';
import { createInstagramPublisher } from '../../../../plugins/sns-instagram/social';

/**
 * Instagram 配信 Plugin の `publish()`：正常系・carousel・ポーリング・延長・外部の文字列の長さ
 * （038-sns-instagram 設計 §10.5 / §10.6 / §10.11）。
 *
 * **実際の Instagram を叩かない。** 口は `createInstagramPublisher({ fetch, now, wait })` で、
 * このファイルは偽の Graph API・可変の時計・即座に解決する待ちを注入する（設計 §10.1）。
 * 偽の応答の形は `test-support/instagram-graph.ts` の 1 か所から取る（#69）。
 *
 * #97：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 * 差し替え忘れがあれば落ちる。**共有ヘルパにせず、このファイルに持つ**（実装プラン §2）。
 */

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  // #97：本物の `fetch` を呼んだら落ちる。差し替え忘れを検出する。
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 偽の Graph API                                                               */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 時計の起点。 */
const START = Date.parse('2026-09-23T12:00:00.000Z');

type RequestKind = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

interface FakeCall {
  readonly kind: RequestKind;
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** POST の本体を form として読んだもの。GET は空。 */
  readonly form: URLSearchParams;
  readonly redirect: RequestRedirect | undefined;
  readonly signal: AbortSignal | undefined;
}

interface RouteContext {
  readonly call: FakeCall;
  /** その種類の要求の何本目か（0 始まり）。 */
  readonly index: number;
  /** R1 のとき、`image_url` から読んだ `media` の添字。 */
  readonly mediaIndex: number;
  /** R3 / R5 のとき、パスの ID。 */
  readonly targetId: string;
}

type RouteReply = GraphResponseExample | Response;
type Route = (context: RouteContext) => RouteReply | Promise<RouteReply>;

type FakeGraphOptions = Partial<Record<RequestKind, Route>>;

interface FakeGraph {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FakeCall[];
  kinds(): RequestKind[];
  of(kind: RequestKind): FakeCall[];
}

function mediaUrl(index: number): string {
  return `https://cdn.example.test/images/${index}.jpg`;
}

function mediaIndexOf(url: string | null): number {
  const matched = /\/images\/([0-9]+)\.jpg$/.exec(url ?? '');
  return matched?.[1] === undefined ? -1 : Number(matched[1]);
}

function kindOf(url: URL, method: string, form: URLSearchParams): RequestKind {
  if (url.pathname === '/refresh_access_token') {
    return 'R6';
  }
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (method === 'POST' && parts[2] === 'media') {
    return form.get('media_type') === 'CAROUSEL' ? 'R2' : 'R1';
  }
  if (method === 'POST' && parts[2] === 'media_publish') {
    return 'R4';
  }
  if (method === 'GET' && parts.length === 2) {
    const fields = url.searchParams.get('fields');
    if (fields === 'status_code') {
      return 'R3';
    }
    if (fields === 'permalink') {
      return 'R5';
    }
  }
  throw new Error(`偽の Graph API が知らない要求: ${method} ${url.pathname}`);
}

function defaultRoute(kind: RequestKind, context: RouteContext): RouteReply {
  switch (kind) {
    case 'R1':
      return containerCreated(
        context.call.form.get('is_carousel_item') === 'true'
          ? childContainerId(context.mediaIndex)
          : CONTAINER_ID,
      );
    case 'R2':
      return containerCreated(CAROUSEL_CONTAINER_ID);
    case 'R3':
      return containerStatus('FINISHED', context.targetId);
    case 'R4':
      return mediaPublished();
    case 'R5':
      return permalinkOf();
    case 'R6':
      return tokenRefreshed();
  }
}

/** 本物の `fetch` と同じく、signal が発火したら `signal.reason` で reject する。 */
function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/** 偽の Graph API。要求の列を記録し、URL のパスとメソッドで R1〜R6 を見分けて応答する。 */
function createFakeGraph(options: FakeGraphOptions = {}): FakeGraph {
  const calls: FakeCall[] = [];
  const counters: Record<RequestKind, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 };

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const form = new URLSearchParams(
      init.body === undefined || init.body === null ? '' : String(init.body),
    );
    const kind = kindOf(url, method, form);
    const call: FakeCall = {
      kind,
      url: url.href,
      method,
      headers: new Headers(init.headers),
      form,
      redirect: init.redirect,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const index = counters[kind];
    counters[kind] += 1;

    if (call.signal?.aborted === true) {
      throw call.signal.reason;
    }

    const context: RouteContext = {
      call,
      index,
      mediaIndex: mediaIndexOf(form.get('image_url')),
      targetId: url.pathname.split('/').filter((part) => part !== '')[1] ?? '',
    };
    const route = options[kind];
    const reply = await Promise.race([
      Promise.resolve(route === undefined ? defaultRoute(kind, context) : route(context)),
      rejectOnAbort(call.signal),
    ]);
    return reply instanceof Response ? reply : toResponse(reply);
  };

  return {
    fetch: impl as unknown as typeof globalThis.fetch,
    calls,
    kinds: () => calls.map((call) => call.kind),
    of: (kind) => calls.filter((call) => call.kind === kind),
  };
}

function only(fake: FakeGraph, kind: RequestKind): FakeCall {
  const found = fake.of(kind);
  if (found.length !== 1) {
    throw new Error(`${kind} がちょうど 1 本ではない（${found.length} 本）`);
  }
  return found[0] as FakeCall;
}

/* -------------------------------------------------------------------------- */
/* 時計・待ち・ログ                                                             */
/* -------------------------------------------------------------------------- */

interface Clock {
  readonly now: () => Date;
  advance(ms: number): void;
  set(ms: number): void;
}

function createClock(start = START): Clock {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

interface FakeWait {
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly calls: number[];
}

/** 呼ばれた ms を記録し、時計を進めて即座に解決する。 */
function createFakeWait(clock: Clock): FakeWait {
  const calls: number[] = [];
  return {
    calls,
    wait: async (ms, signal) => {
      calls.push(ms);
      if (signal.aborted) {
        throw signal.reason;
      }
      clock.advance(ms);
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

/* -------------------------------------------------------------------------- */
/* 入力                                                                         */
/* -------------------------------------------------------------------------- */

const BODY = '秋の新作が入りました #とりふね @torifune.shop';

function isoDaysFrom(base: number, days: number): string {
  return new Date(base + days * DAY_MS).toISOString();
}

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000b001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000a001',
    body: BODY,
    scheduledAt: '2026-09-23T12:00:00.000Z',
    status: 'publishing',
    publishedAt: null,
    failureReason: null,
    deliveryMode: 'auto',
    media: [{ url: mediaUrl(0), alt: null }],
    link: null,
    providerOptions: {},
    externalRef: null,
    externalId: null,
    externalUrl: null,
    failedAt: null,
    ...overrides,
  };
}

function mediaOf(count: number): SocialPostView['media'] {
  return Array.from({ length: count }, (_, index) => ({ url: mediaUrl(index), alt: null }));
}

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'instagram',
    displayName: 'とりふね',
    handle: 'torifune.example',
    status: 'active',
    credentialConfigured: true,
    ...overrides,
  };
}

/** 期限が十分先（40 日後）の資格情報。**延長しない。** */
function credentialOf(
  overrides: Partial<Record<'igUserId' | 'accessToken' | 'accessTokenExpiresAt', string>> = {},
  base = START,
): Record<string, string> {
  return {
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: isoDaysFrom(base, 40),
    ...overrides,
  };
}

function publishOf(
  registration: PublisherRegistration,
): NonNullable<PublisherRegistration['publish']> {
  const publish = registration.publish;
  if (publish === undefined) {
    throw new Error('publish が無い');
  }
  return publish.bind(registration);
}

interface RunOptions {
  readonly fake?: FakeGraph;
  readonly clock?: Clock;
  readonly wait?: FakeWait;
  readonly post?: SocialPostView;
  readonly account?: SocialAccountView;
  readonly credential?: Record<string, string>;
  readonly signal?: AbortSignal;
}

interface RunResult {
  readonly result: PublishResult;
  readonly fake: FakeGraph;
  readonly clock: Clock;
  readonly wait: FakeWait;
  readonly log: LogEntry[];
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const fake = options.fake ?? createFakeGraph();
  const clock = options.clock ?? createClock();
  const wait = options.wait ?? createFakeWait(clock);
  const { logger, entries } = captureLogger();
  const publish = publishOf(
    createInstagramPublisher({ fetch: fake.fetch, now: clock.now, wait: wait.wait }),
  );
  const result = await publish({
    post: options.post ?? postView(),
    account: options.account ?? accountView(),
    credential: options.credential ?? credentialOf(),
    attempt: 1,
    signal: options.signal ?? new AbortController().signal,
    logger,
  });
  return { result, fake, clock, wait, log: entries };
}

function rotatedOf(result: PublishResult): Readonly<Record<string, string>> | undefined {
  return result.ok ? result.rotatedCredential : undefined;
}

/** マイクロタスクとタイマーを一巡させる。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/* -------------------------------------------------------------------------- */
/* §10.1 テストのための口                                                       */
/* -------------------------------------------------------------------------- */

describe('テストのための口（§10.1）', () => {
  it('#1 引数を与えなければ、呼ばれた時点の globalThis.fetch と現在時刻で配信する', async () => {
    const fake = createFakeGraph();
    globalThis.fetch = fake.fetch;
    const { logger } = captureLogger();

    const result = await publishOf(createInstagramPublisher())({
      post: postView(),
      account: accountView(),
      credential: credentialOf({}, Date.now()),
      attempt: 1,
      signal: new AbortController().signal,
      logger,
    });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5']);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.5 publish()：正常系                                                       */
/* -------------------------------------------------------------------------- */

describe('publish()：正常系（§10.5）', () => {
  it('#29 画像 1 枚は R1 → R3 → R4 → R5 の順で送り、media ID と permalink を返す', async () => {
    const { result, fake } = await run();

    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5']);
    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#29 R3 は作った container を、R4 はその container を、R5 は公開した media を指す', async () => {
    const { fake } = await run();

    expect(only(fake, 'R3').url).toContain(`/${CONTAINER_ID}?`);
    expect(only(fake, 'R4').form.get('creation_id')).toBe(CONTAINER_ID);
    expect(only(fake, 'R5').url).toContain(`/${MEDIA_ID}?`);
  });

  it('#29 期限が 40 日後なら R6 を呼ばず、rotatedCredential を返さない', async () => {
    const { result, fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 40) }),
    });

    expect(fake.of('R6')).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(rotatedOf(result)).toBeUndefined();
  });

  it('#30 R1 の本体は image_url と caption を持つ', async () => {
    const { fake } = await run();
    const form = only(fake, 'R1').form;

    expect(form.get('image_url')).toBe(mediaUrl(0));
    expect(form.get('caption')).toBe(BODY);
  });

  it('#30 R1 の本体は is_carousel_item / media_type / alt_text / video_url を持たない', async () => {
    const { fake } = await run({
      post: postView({ media: [{ url: mediaUrl(0), alt: '店頭に並んだ新作のマグカップ' }] }),
    });
    const form = only(fake, 'R1').form;

    expect(form.has('is_carousel_item')).toBe(false);
    expect(form.has('media_type')).toBe(false);
    expect(form.has('alt_text')).toBe(false);
    expect(form.has('video_url')).toBe(false);
  });

  it('#30 caption は post.body そのまま（link を足さない・削らない）', async () => {
    const body = '  前後の空白も\n改行もそのまま  ';
    const { fake } = await run({ post: postView({ body }) });

    expect(only(fake, 'R1').form.get('caption')).toBe(body);
  });

  it('#31 画像 3 枚：子 R1 × 3 → 子の R3 → 親 R2 → 親の R3 → R4 の順', async () => {
    const { result, fake } = await run({ post: postView({ media: mediaOf(3) }) });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(fake.kinds()).toEqual(['R1', 'R1', 'R1', 'R3', 'R3', 'R3', 'R2', 'R3', 'R4', 'R5']);
  });

  it('#31 子の R1 は is_carousel_item=true を持ち、caption を持たない', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(3) }) });
    const children = fake.of('R1');

    expect(children.map((call) => call.form.get('image_url')).sort()).toEqual(
      [mediaUrl(0), mediaUrl(1), mediaUrl(2)].sort(),
    );
    for (const call of children) {
      expect(call.form.get('is_carousel_item')).toBe('true');
      expect(call.form.has('caption')).toBe(false);
      expect(call.form.has('media_type')).toBe(false);
    }
  });

  it('#31 子の R3 は子の container を 1 本ずつ見る', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(3) }) });
    const firstChecks = fake.of('R3').slice(0, 3);

    expect(firstChecks.map((call) => new URL(call.url).pathname.split('/')[2]).sort()).toEqual(
      [childContainerId(0), childContainerId(1), childContainerId(2)].sort(),
    );
  });

  it('#31 親 R2 は media_type=CAROUSEL・children・caption を持つ', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(3) }) });
    const form = only(fake, 'R2').form;

    expect(form.get('media_type')).toBe('CAROUSEL');
    expect(form.get('children')).toBe(
      [childContainerId(0), childContainerId(1), childContainerId(2)].join(','),
    );
    expect(form.get('caption')).toBe(BODY);
    expect(form.has('image_url')).toBe(false);
  });

  it('#31 親の R3 は親 container を見て、R4 の creation_id は親 ID', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(3) }) });

    const parentCheck = fake.of('R3')[3];
    expect(parentCheck?.url).toContain(`/${CAROUSEL_CONTAINER_ID}?`);
    expect(only(fake, 'R4').form.get('creation_id')).toBe(CAROUSEL_CONTAINER_ID);
  });

  it('#32 子の作成の応答が逆順に返っても、children は media の順', async () => {
    const pending: { readonly mediaIndex: number; readonly resolve: () => void }[] = [];
    const fake = createFakeGraph({
      R1: async ({ mediaIndex }) => {
        await new Promise<void>((resolve) => {
          pending.push({ mediaIndex, resolve });
          if (pending.length === 3) {
            // 添字の大きいものから 1 本ずつ解決する。
            void (async () => {
              for (const entry of [...pending].sort((a, b) => b.mediaIndex - a.mediaIndex)) {
                entry.resolve();
                await flush();
              }
            })();
          }
        });
        return containerCreated(childContainerId(mediaIndex));
      },
    });

    const { result } = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expect(result.ok).toBe(true);
    expect(only(fake, 'R2').form.get('children')).toBe(
      [childContainerId(0), childContainerId(1), childContainerId(2)].join(','),
    );
  });

  it('#33 画像 10 枚で、同時に飛んでいる R1 が 5 本を超えない', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = createFakeGraph({
      R1: async ({ mediaIndex }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        await flush();
        inFlight -= 1;
        return containerCreated(childContainerId(mediaIndex));
      },
    });

    const { result } = await run({ fake, post: postView({ media: mediaOf(10) }) });

    expect(result.ok).toBe(true);
    expect(fake.of('R1')).toHaveLength(10);
    expect(maxInFlight).toBeLessThanOrEqual(CAROUSEL_CHILD_CONCURRENCY);
  });

  it('#33 子は並行に作る（同時に 5 本まで使い切る）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = createFakeGraph({
      R1: async ({ mediaIndex }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        await flush();
        inFlight -= 1;
        return containerCreated(childContainerId(mediaIndex));
      },
    });

    await run({ fake, post: postView({ media: mediaOf(10) }) });

    expect(maxInFlight).toBe(CAROUSEL_CHILD_CONCURRENCY);
  });

  it('#34 R3 が IN_PROGRESS → IN_PROGRESS → FINISHED なら、R3 を 3 回・wait を POLL_INTERVAL_MS で 2 回呼んでから R4 へ進む', async () => {
    const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const fake = createFakeGraph({
      R3: ({ index, targetId }) => containerStatus(statuses[index] ?? 'FINISHED', targetId),
    });

    const { result, wait } = await run({ fake });

    expect(fake.of('R3')).toHaveLength(3);
    expect(wait.calls).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(fake.kinds()).toEqual(['R1', 'R3', 'R3', 'R3', 'R4', 'R5']);
    expect(result.ok).toBe(true);
  });

  it('#35 R1 の直後の最初の R3 が FINISHED なら、wait を 1 度も呼ばない', async () => {
    const { wait, fake } = await run();

    expect(fake.kinds().slice(0, 2)).toEqual(['R1', 'R3']);
    expect(wait.calls).toEqual([]);
  });

  it('#36 R1〜R5 に Authorization: Bearer <accessToken> が付き、URL に access_token が現れない', async () => {
    const { fake } = await run({
      post: postView({ media: mediaOf(2) }),
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });

    const calls = fake.calls.filter((call) => call.kind !== 'R6');
    expect(new Set(calls.map((call) => call.kind))).toEqual(
      new Set(['R1', 'R2', 'R3', 'R4', 'R5']),
    );
    for (const call of calls) {
      expect(call.headers.get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(call.url).not.toContain('access_token');
      expect(call.url).not.toContain(ACCESS_TOKEN);
      expect(call.form.has('access_token')).toBe(false);
    }
  });

  it('#36 R6 だけは URL のクエリに access_token と grant_type=ig_refresh_token を持つ', async () => {
    const { fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });
    const url = new URL(only(fake, 'R6').url);

    expect(url.searchParams.get('grant_type')).toBe('ig_refresh_token');
    expect(url.searchParams.get('access_token')).toBe(ACCESS_TOKEN);
  });

  it('#37 宛先は graph.instagram.com の定数', () => {
    expect(GRAPH_API_BASE_URL).toBe('https://graph.instagram.com');
  });

  it('#37 R1〜R5 の URL は https://graph.instagram.com/<GRAPH_API_VERSION>/…', async () => {
    const { fake } = await run();
    const base = `${GRAPH_API_BASE_URL}/${GRAPH_API_VERSION}`;

    expect(only(fake, 'R1').url).toBe(`${base}/${IG_USER_ID}/media`);
    expect(only(fake, 'R3').url).toBe(`${base}/${CONTAINER_ID}?fields=status_code`);
    expect(only(fake, 'R4').url).toBe(`${base}/${IG_USER_ID}/media_publish`);
    expect(only(fake, 'R5').url).toBe(`${base}/${MEDIA_ID}?fields=permalink`);
  });

  it('#37 R2 の URL も版の付いた /<igUserId>/media', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });

    expect(only(fake, 'R2').url).toBe(
      `${GRAPH_API_BASE_URL}/${GRAPH_API_VERSION}/${IG_USER_ID}/media`,
    );
  });

  it('#37 R6 の URL は版の付かない https://graph.instagram.com/refresh_access_token', async () => {
    const { fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });
    const url = new URL(only(fake, 'R6').url);

    expect(`${url.origin}${url.pathname}`).toBe(`${GRAPH_API_BASE_URL}/refresh_access_token`);
    expect(only(fake, 'R6').method).toBe('GET');
  });

  it('#37 POST の content-type は application/x-www-form-urlencoded', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });
    const posts = fake.calls.filter((call) => call.method === 'POST');

    expect(posts.map((call) => call.kind).sort()).toEqual(['R1', 'R1', 'R2', 'R4']);
    for (const call of posts) {
      expect(call.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    }
  });

  it('#37 R3 / R5 / R6 は GET', async () => {
    const { fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });

    for (const kind of ['R3', 'R5', 'R6'] as const) {
      expect(only(fake, kind).method).toBe('GET');
    }
  });

  it('#38 すべての要求の redirect が manual', async () => {
    const { fake } = await run({
      post: postView({ media: mediaOf(2) }),
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });

    expect(new Set(fake.kinds())).toEqual(new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']));
    for (const call of fake.calls) {
      expect(call.redirect).toBe('manual');
    }
  });

  it('#39 account の値を変えても要求は変わらない（account.handle を使わない）', async () => {
    const snapshot = (fake: FakeGraph): unknown =>
      fake.calls.map((call) => ({
        url: call.url,
        method: call.method,
        headers: [...call.headers.entries()],
        form: call.form.toString(),
      }));

    const first = await run({ account: accountView() });
    const second = await run({
      account: accountView({
        id: '0199aaaa-0000-7000-8000-00000000a999',
        handle: 'someone-else.example',
        displayName: '別の名前',
      }),
    });

    expect(snapshot(second.fake)).toEqual(snapshot(first.fake));
  });
});

/* -------------------------------------------------------------------------- */
/* §10.6 トークンの延長                                                          */
/* -------------------------------------------------------------------------- */

describe('publish()：トークンの延長（§10.6）', () => {
  const nearExpiry = (): Record<string, string> =>
    credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) });

  it('#40 期限が 29 日後なら、R5 の後に R6 を呼ぶ', async () => {
    const { fake } = await run({ credential: nearExpiry() });

    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5', 'R6']);
  });

  it('#40 rotatedCredential は igUserId（元のまま）・新しいトークン・now + expires_in の 3 キーちょうど', async () => {
    const { result } = await run({ credential: nearExpiry() });

    expect(result).toEqual({
      ok: true,
      externalId: MEDIA_ID,
      externalUrl: PERMALINK,
      rotatedCredential: {
        igUserId: IG_USER_ID,
        accessToken: REFRESHED_ACCESS_TOKEN,
        accessTokenExpiresAt: new Date(START + REFRESHED_EXPIRES_IN * 1000).toISOString(),
      },
    });
    expect(Object.keys(rotatedOf(result) ?? {}).sort()).toEqual(
      ['accessToken', 'accessTokenExpiresAt', 'igUserId'].sort(),
    );
  });

  it('#40 資格情報に余計なキーがあっても rotatedCredential に写さない', async () => {
    const { result } = await run({ credential: { ...nearExpiry(), extra: 'x-value' } });

    expect(Object.keys(rotatedOf(result) ?? {}).sort()).toEqual(
      ['accessToken', 'accessTokenExpiresAt', 'igUserId'].sort(),
    );
  });

  it('#41 期限が 31 日後なら R6 を呼ばない', async () => {
    const { result, fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 31) }),
    });

    expect(fake.of('R6')).toHaveLength(0);
    expect(rotatedOf(result)).toBeUndefined();
  });

  it.each([
    ['unknown', 'unknown'],
    ['空文字', ''],
    ['読めない文字列', 'あした'],
    ['61 日より先', '2099-01-01T00:00:00Z'],
  ])('#42 期限が %s なら R6 を呼ぶ', async (_label, expiresAt) => {
    const { result, fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: expiresAt }),
    });

    expect(fake.of('R6')).toHaveLength(1);
    expect(rotatedOf(result)?.['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
  });

  const refreshFailures: readonly [string, Route][] = [
    ['400', () => graphError({ status: 400, code: 190 })],
    [
      '接続断',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      '制限時間',
      () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    ],
    ['JSON でない', () => htmlPage(200)],
    [
      'access_token が無い',
      () => ({ status: 200, body: { token_type: 'bearer', expires_in: 100 } }),
    ],
  ];

  it.each(refreshFailures)(
    '#43 R6 が %s なら ok: true のまま rotatedCredential を付けない',
    async (_label, route) => {
      const { result } = await run({
        fake: createFakeGraph({ R6: route }),
        credential: nearExpiry(),
      });

      expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    },
  );

  it.each(refreshFailures)(
    '#43 R6 が %s なら logger.warn が phase: refresh で出る',
    async (_label, route) => {
      const { log } = await run({ fake: createFakeGraph({ R6: route }), credential: nearExpiry() });

      expect(
        log.some((entry) => entry.level === 'warn' && entry.fields?.['phase'] === 'refresh'),
      ).toBe(true);
    },
  );

  it.each([
    ['改行を含む', 'IGAAnew\ntoken'],
    ['空白を含む', 'IGAAnew token'],
    ['2049 文字', 'a'.repeat(2049)],
    ['全角を含む', 'IGAAnewｔｏｋｅｎ'],
    ['空', ''],
    ['文字列でない', 12345],
  ])('#44 R6 の access_token が %s なら rotatedCredential を返さない', async (_label, token) => {
    const { result } = await run({
      fake: createFakeGraph({ R6: () => tokenRefreshed(token) }),
      credential: nearExpiry(),
    });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#44 R6 の access_token が 2048 文字ちょうどなら返す', async () => {
    const token = 'a'.repeat(2048);
    const { result } = await run({
      fake: createFakeGraph({ R6: () => tokenRefreshed(token) }),
      credential: nearExpiry(),
    });

    expect(rotatedOf(result)?.['accessToken']).toBe(token);
  });

  it.each([
    ['無い', OMIT_EXPIRES_IN],
    ['負', -1],
    ['0', 0],
    ['文字列', '5183944'],
    ['小数', 1.5],
    ['61 日を超える', 61 * 24 * 60 * 60 + 1],
  ])(
    '#45 R6 の expires_in が %s なら rotatedCredential を返し、期限は unknown',
    async (_label, expiresIn) => {
      const { result } = await run({
        fake: createFakeGraph({ R6: () => tokenRefreshed(REFRESHED_ACCESS_TOKEN, expiresIn) }),
        credential: nearExpiry(),
      });

      expect(rotatedOf(result)).toEqual({
        igUserId: IG_USER_ID,
        accessToken: REFRESHED_ACCESS_TOKEN,
        accessTokenExpiresAt: 'unknown',
      });
    },
  );

  it('#46 公開（R4）が 500 なら R6 を呼ばない', async () => {
    const { result, fake } = await run({
      fake: createFakeGraph({ R4: () => graphError({ status: 500, code: 1 }) }),
      credential: nearExpiry(),
    });

    expect(result.ok).toBe(false);
    expect(fake.of('R6')).toHaveLength(0);
  });

  it('#46 R6 は R4 より後に呼ぶ（公開の前に延長しない）', async () => {
    const { fake } = await run({ credential: nearExpiry() });
    const kinds = fake.kinds();

    expect(kinds.indexOf('R6')).toBeGreaterThan(kinds.indexOf('R4'));
    expect(kinds.lastIndexOf('R6')).toBe(kinds.length - 1);
  });

  it('#47 R5 の後の残り時間が REFRESH_TIMEOUT_MS 未満なら R6 を呼ばず、ok: true', async () => {
    const clock = createClock();
    const fake = createFakeGraph({
      R5: () => {
        // 合計の期限まで残り REFRESH_TIMEOUT_MS − 1。
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - REFRESH_TIMEOUT_MS + 1);
        return permalinkOf();
      },
    });

    const { result } = await run({ fake, clock, credential: nearExpiry() });

    expect(fake.of('R6')).toHaveLength(0);
    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#47 残り時間がちょうど REFRESH_TIMEOUT_MS なら R6 を呼ぶ', async () => {
    const clock = createClock();
    const fake = createFakeGraph({
      R5: () => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - REFRESH_TIMEOUT_MS);
        return permalinkOf();
      },
    });

    await run({ fake, clock, credential: nearExpiry() });

    expect(fake.of('R6')).toHaveLength(1);
  });

  it('#48 rotatedCredential のキーの集合は credentialFields と一致し、Core の検査で問題 0 件', async () => {
    const registration = createInstagramPublisher();
    const { result } = await run({ credential: nearExpiry() });
    const rotated = rotatedOf(result);

    expect(rotated).toBeDefined();
    expect(Object.keys(rotated ?? {}).sort()).toEqual(
      registration.credentialFields.map((field) => field.key).sort(),
    );
    expect(
      validateCredentialAgainstFields(
        rotated ?? {},
        registration.credentialFields.map((field) => ({
          key: field.key,
          kind: field.kind === 'secret' ? ('secret' as const) : ('text' as const),
        })),
      ),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.11 外部の文字列の長さ                                                    */
/* -------------------------------------------------------------------------- */

describe('外部の文字列の長さ（§10.11）', () => {
  it('#74 R4 の id が 200 文字の数字なら、externalId も externalUrl も付けずに ok: true。R5 を呼ばない', async () => {
    const { result, fake } = await run({
      fake: createFakeGraph({ R4: () => mediaPublished('1'.repeat(200)) }),
    });

    expect(result).toEqual({ ok: true });
    expect(fake.of('R5')).toHaveLength(0);
  });

  it('#75 R4 の id が 123/../456 なら ok: true だけ。R5 を呼ばない', async () => {
    const { result, fake } = await run({
      fake: createFakeGraph({ R4: () => mediaPublished('123/../456') }),
    });

    expect(result).toEqual({ ok: true });
    expect(fake.of('R5')).toHaveLength(0);
  });

  it('#75 R4 の id が 65 文字の数字でも ok: true だけ', async () => {
    const { result } = await run({
      fake: createFakeGraph({ R4: () => mediaPublished('9'.repeat(65)) }),
    });

    expect(result).toEqual({ ok: true });
  });

  it('#76 R4 の id が 64 文字の数字なら externalId が付く', async () => {
    const id = '9'.repeat(64);
    const { result, fake } = await run({ fake: createFakeGraph({ R4: () => mediaPublished(id) }) });

    expect(result.ok && result.externalId).toBe(id);
    expect(only(fake, 'R5').url).toContain(`/${id}?`);
  });

  function permalinkOfLength(length: number): string {
    const prefix = 'https://www.instagram.com/p/';
    return `${prefix}${'a'.repeat(length - prefix.length)}`;
  }

  it('#77 permalink が 2049 文字なら externalUrl を付けない（externalId は残す）', async () => {
    const { result } = await run({
      fake: createFakeGraph({ R5: () => permalinkOf(permalinkOfLength(2049)) }),
    });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
  });

  it('#77 permalink が 2048 文字ちょうどなら externalUrl を付ける', async () => {
    const permalink = permalinkOfLength(2048);
    const { result } = await run({ fake: createFakeGraph({ R5: () => permalinkOf(permalink) }) });

    expect(permalink).toHaveLength(2048);
    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: permalink });
  });

  it.each([
    'http://www.instagram.com/p/x/',
    'https://evil.test/p/x/',
    'https://user:pw@www.instagram.com/p/x/',
    'https://instagram.com.evil.test/',
    'not a url',
    '',
  ])('#78 permalink が %s なら externalUrl を付けない', async (permalink) => {
    const { result } = await run({ fake: createFakeGraph({ R5: () => permalinkOf(permalink) }) });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
  });

  it('#78 permalink が文字列でなければ externalUrl を付けない', async () => {
    const { result } = await run({ fake: createFakeGraph({ R5: () => permalinkOf(12345) }) });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
  });

  it('#79 permalink が https://www.instagram.com/p/AbC/ なら付き、Core の isValidExternalUrl に通る', async () => {
    const permalink = 'https://www.instagram.com/p/AbC/';
    const { result } = await run({ fake: createFakeGraph({ R5: () => permalinkOf(permalink) }) });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: permalink });
    expect(isValidExternalUrl(permalink)).toBe(true);
  });

  it('#80 2048 文字のトークンを含めた rotatedCredential の JSON は Core の上限（4096 文字）を超えない', async () => {
    const { result } = await run({
      fake: createFakeGraph({ R6: () => tokenRefreshed('a'.repeat(2048)) }),
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });
    const rotated = rotatedOf(result);

    expect(rotated).toBeDefined();
    expect(JSON.stringify(rotated).length).toBeLessThanOrEqual(CREDENTIAL_MAX_LENGTH);
  });
});
