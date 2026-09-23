import type {
  PluginLogger,
  PublishResult,
  PublisherRegistration,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLISH_TIMEOUT_MS } from '@/domain/social/publishing';
import {
  ACCESS_TOKEN,
  CONTAINER_ID,
  IG_USER_ID,
  MEDIA_ID,
  PERMALINK,
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
  MEDIA_PUBLISH_TIMEOUT_MS,
  PERMALINK_TIMEOUT_MS,
  POLL_MAX_ROUNDS,
  PREPARE_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
} from '../../../../plugins/sns-instagram/graph';
import { createInstagramPublisher } from '../../../../plugins/sns-instagram/social';

/**
 * Instagram 配信 Plugin の `retryable` と制限時間の検査（038-sns-instagram 設計 §6.8 / §6.9 / §10.7〜§10.10）。
 *
 * **実際の Instagram を叩かない。** 偽の Graph API・可変の時計・即座に解決する待ちを注入する（設計 §10.1）。
 * 偽の応答の形は `test-support/instagram-graph.ts` の 1 か所から取る（#69）。
 *
 * #97：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
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
/* 偽の Graph API（実装プラン §2「テストの方法」。このファイルに持つ）                */
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
  readonly form: URLSearchParams;
  readonly signal: AbortSignal | undefined;
}

interface RouteContext {
  readonly call: FakeCall;
  readonly index: number;
  readonly mediaIndex: number;
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
      return containerCreated('17900000000000999');
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

/** 要求が届かなかった（接続できない）。本物の `fetch` は `TypeError` で reject する。 */
function networkDown(): never {
  throw new TypeError('fetch failed');
}

/** 自前の制限時間（`AbortSignal.timeout`）に達した。本物の `fetch` は `TimeoutError` で reject する。 */
function timedOut(): never {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/* -------------------------------------------------------------------------- */
/* 時計・待ち・ログ・入力                                                        */
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

const BODY = '秋の新作が入りました #とりふね';

function isoDaysFrom(base: number, days: number): string {
  return new Date(base + days * DAY_MS).toISOString();
}

/** 期限が 40 日後（延長しない）。 */
const EXPIRES_AT = isoDaysFrom(START, 40);

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

function accountView(): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000a001',
    provider: 'instagram',
    displayName: 'とりふね',
    handle: 'torifune.example',
    status: 'active',
    credentialConfigured: true,
  };
}

function credentialOf(
  overrides: Partial<Record<'igUserId' | 'accessToken' | 'accessTokenExpiresAt', string>> = {},
): Record<string, string> {
  return {
    igUserId: IG_USER_ID,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: EXPIRES_AT,
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
  readonly credential?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
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
  const captured = captureLogger();
  const publish = publishOf(
    createInstagramPublisher({ fetch: fake.fetch, now: clock.now, wait: wait.wait }),
  );
  const result = await publish({
    post: options.post ?? postView(),
    account: accountView(),
    credential: options.credential ?? credentialOf(),
    attempt: 1,
    signal: options.signal ?? new AbortController().signal,
    logger: options.logger ?? captured.logger,
  });
  return { result, fake, clock, wait, log: captured.entries };
}

/** 失敗の `retryable`。成功なら落とす。 */
function retryableOf(result: PublishResult): boolean {
  if (result.ok) {
    throw new Error('失敗を期待したが成功した');
  }
  return result.retryable;
}

function reasonOf(result: PublishResult): string {
  if (result.ok) {
    throw new Error('失敗を期待したが成功した');
  }
  return result.reason;
}

function retryAfterOf(result: PublishResult): number | undefined {
  if (result.ok) {
    throw new Error('失敗を期待したが成功した');
  }
  return result.retryAfterMs;
}

function mediaOf(count: number): SocialPostView['media'] {
  return Array.from({ length: count }, (_, index) => ({ url: mediaUrl(index), alt: null }));
}

/** 解決しない（signal の発火でだけ止まる）。偽の Graph API が `rejectOnAbort` と競わせる。 */
function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

/** `run()` に渡す応答の組。 */
function withRoutes(routes: FakeGraphOptions, extra: Omit<RunOptions, 'fake'> = {}): RunOptions {
  return { fake: createFakeGraph(routes), ...extra };
}

const html = (status: number) => (): RouteReply => htmlPage(status);
const error = (example: Parameters<typeof graphError>[0]) => (): RouteReply => graphError(example);
const status =
  (code: unknown) =>
  ({ targetId }: RouteContext): RouteReply => ({
    status: 200,
    body: { status_code: code, id: targetId },
  });

/**
 * 失敗する配信の一覧（#53 / #57 / #61 / #63 が全件に掛ける）。
 * どれも実行のたびに新しい偽物を作る。
 */
const FAILURE_SCENARIOS: readonly (readonly [string, () => RunOptions])[] = [
  ['P0 media が空', () => ({ post: postView({ media: [] }) })],
  ['P0 link あり', () => ({ post: postView({ link: 'https://example.com' }) })],
  ['P0 igUserId の形', () => ({ credential: credentialOf({ igUserId: '1/../2' }) })],
  ['P0 accessToken の形', () => ({ credential: credentialOf({ accessToken: 'IGAA\ntoken' }) })],
  ['P1 reject', () => withRoutes({ R1: networkDown })],
  ['P1 制限時間', () => withRoutes({ R1: timedOut })],
  ['P1 503', () => withRoutes({ R1: html(503) })],
  ['P1 code 4', () => withRoutes({ R1: error({ code: 4 }) })],
  ['P1 transient', () => withRoutes({ R1: error({ code: 100, isTransient: true }) })],
  ['P1 code 190', () => withRoutes({ R1: error({ code: 190, subcode: 463 }) })],
  ['P1 code 10', () => withRoutes({ R1: error({ code: 10 }) })],
  ['P1 dailyLimit', () => withRoutes({ R1: error({ code: 9, subcode: 2207042 }) })],
  ['P1 code 100', () => withRoutes({ R1: error({ code: 100, subcode: 2207052 }) })],
  [
    'P1 302',
    () =>
      withRoutes({
        R1: () => ({ status: 302, body: '', headers: { location: 'https://example.test/' } }),
      }),
  ],
  ['P1 id なし', () => withRoutes({ R1: () => ({ status: 200, body: {} }) })],
  [
    'P1 carousel の子が混在',
    () =>
      withRoutes(
        { R1: ({ mediaIndex }) => (mediaIndex === 1 ? graphError({ code: 100 }) : htmlPage(503)) },
        { post: postView({ media: mediaOf(3) }) },
      ),
  ],
  [
    'P1 carousel の親が 400',
    () => withRoutes({ R2: error({ code: 100 }) }, { post: postView({ media: mediaOf(2) }) }),
  ],
  ['P2 500', () => withRoutes({ R3: html(500) })],
  ['P2 code 190', () => withRoutes({ R3: error({ code: 190 }) })],
  ['P3 ERROR', () => withRoutes({ R3: status('ERROR') })],
  ['P3 EXPIRED', () => withRoutes({ R3: status('EXPIRED') })],
  ['P3 PUBLISHED', () => withRoutes({ R3: status('PUBLISHED') })],
  ['P3 知らない値', () => withRoutes({ R3: status('WHATEVER') })],
  ['P3 IN_PROGRESS のまま', () => withRoutes({ R3: status('IN_PROGRESS') })],
  ['P4 code 4', () => withRoutes({ R4: error({ code: 4 }) })],
  ['P4 dailyLimit', () => withRoutes({ R4: error({ code: 9, subcode: 2207042 }) })],
  ['P4 500', () => withRoutes({ R4: html(500) })],
  ['P4 reject', () => withRoutes({ R4: networkDown })],
  ['P4 code 190', () => withRoutes({ R4: error({ code: 190 }) })],
  ['P4 id なし', () => withRoutes({ R4: () => ({ status: 200, body: {} }) })],
];

/* -------------------------------------------------------------------------- */
/* §6.9 P0 入口                                                                 */
/* -------------------------------------------------------------------------- */

describe('P0 入口（§6.9）', () => {
  it('#49 P0 media が空なら retryable: false で、fetch を 1 本も出さない', async () => {
    const { result, fake } = await run({ post: postView({ media: [] }) });

    expect(retryableOf(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('#49 P0 link があれば retryable: false で、fetch を 1 本も出さない', async () => {
    const { result, fake } = await run({ post: postView({ link: 'https://example.com' }) });

    expect(retryableOf(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('#49 P0 link があれば logger.warn が phase: input で出る', async () => {
    const { log } = await run({ post: postView({ link: 'https://example.com' }) });

    expect(log.some((entry) => entry.level === 'warn' && entry.fields?.['phase'] === 'input')).toBe(
      true,
    );
  });

  it.each(['abc', '1/../2', '1?x=1', '', '1'.repeat(65)])(
    '#49 P0 igUserId が %j なら retryable: false で、fetch を 1 本も出さない',
    async (igUserId) => {
      const { result, fake } = await run({ credential: credentialOf({ igUserId }) });

      expect(retryableOf(result)).toBe(false);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it.each([
    ['改行を含む', 'IGAA\ntoken'],
    ['空白を含む', 'IGAA token'],
    ['全角文字を含む', 'IGAAｔｏｋｅｎ'],
    ['2049 文字', 'a'.repeat(2049)],
  ])(
    '#49 P0 accessToken が%sなら retryable: false で、fetch を 1 本も出さない',
    async (_label, accessToken) => {
      const { result, fake } = await run({ credential: credentialOf({ accessToken }) });

      expect(retryableOf(result)).toBe(false);
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('#49 P0 資格情報のキーが欠けていても例外を投げず retryable: false', async () => {
    const { result, fake } = await run({ credential: { accessToken: ACCESS_TOKEN } });

    expect(retryableOf(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* input.signal                                                                */
/* -------------------------------------------------------------------------- */

describe('input.signal（§6.8）', () => {
  it('#55 input.signal が既に abort 済みなら、fetch を 1 度も呼ばずに戻る', async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, fake } = await run({ signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P5 公開の後（R5 / R6）                                                   */
/* -------------------------------------------------------------------------- */

describe('P5 公開の後（§6.9）', () => {
  it.each([
    ['500', (): RouteReply => graphError({ status: 500, code: 1 })],
    ['reject', networkDown],
    ['制限時間', timedOut],
    ['400 code 190', (): RouteReply => graphError({ status: 400, code: 190 })],
    ['本体が HTML', (): RouteReply => htmlPage(200)],
  ])(
    '#49 P5 R5 が %s でも ok: true のまま externalId を返し、externalUrl を付けない',
    async (_label, route) => {
      const { result } = await run({ fake: createFakeGraph({ R5: route }) });

      expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
    },
  );

  it('#49 P5 R4 の後の残り時間が PERMALINK_TIMEOUT_MS 未満なら R5 を送らず、ok: true で externalId を返す', async () => {
    const clock = createClock();
    const fake = createFakeGraph({
      R4: () => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - PERMALINK_TIMEOUT_MS + 1);
        return mediaPublished();
      },
    });

    const { result } = await run({ fake, clock });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
    expect(fake.of('R5')).toHaveLength(0);
  });

  it.each([
    ['500', (): RouteReply => graphError({ status: 500, code: 1 })],
    ['reject', networkDown],
    ['400 code 190', (): RouteReply => graphError({ status: 400, code: 190 })],
  ])('#49 P5 R6 が %s でも ok: true のまま', async (_label, route) => {
    const { result } = await run({
      fake: createFakeGraph({ R6: route }),
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 10) }),
    });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });
});

/* -------------------------------------------------------------------------- */
/* 制限時間の結線                                                                */
/* -------------------------------------------------------------------------- */

describe('制限時間の結線', () => {
  it('#72 準備の期限 ＋ 公開の制限時間は合計の期限に収まる', () => {
    // R4 を始めるのは準備が終わった後なので、両方の和が合計を超えると R4 が合計の期限で切られる。
    expect(PREPARE_BUDGET_MS + MEDIA_PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(
      PUBLISH_TOTAL_BUDGET_MS,
    );
  });

  it('#72 合計の期限は Core の 30 秒より 5 秒以上短い', () => {
    // 差の 5 秒は、打ち切りを検知して PublishResult を返すための余白（設計 §6.8）。
    // **Core の定数はテスト側で import する。** Plugin は Core を import しない。
    expect(PUBLISH_TOTAL_BUDGET_MS + 5_000).toBeLessThanOrEqual(PUBLISH_TIMEOUT_MS);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P1 container の作成（R1 / R2）                                            */
/* -------------------------------------------------------------------------- */

describe('P1 container の作成（§6.9）', () => {
  it.each([
    ['接続できない（reject）', networkDown as Route],
    ['自前の制限時間', timedOut as Route],
    ['500', html(500)],
    ['503', html(503)],
    ['502（Graph API のエラーの本体つき）', error({ status: 502, code: 1 })],
  ])('#49 P1 R1 が %s なら retryable: true で、R4 を呼ばない', async (_label, route) => {
    const { result, fake } = await run(withRoutes({ R1: route }));

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 P1 R2（carousel の親）が 503 なら retryable: true', async () => {
    const { result, fake } = await run(
      withRoutes({ R2: html(503) }, { post: postView({ media: mediaOf(2) }) }),
    );

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it.each([
    ['400 code 4', error({ code: 4 })],
    ['400 code 17', error({ code: 17 })],
    ['400 code 32', error({ code: 32 })],
    ['400 code 613', error({ code: 613 })],
    ['429（code なし）', html(429)],
  ])('#49 P1 R1 が %s（rateLimit）なら retryable: true', async (_label, route) => {
    const { result } = await run(withRoutes({ R1: route }));

    expect(retryableOf(result)).toBe(true);
  });

  it('#49 P1 R1 が 400 code 100 / is_transient: true（transient）なら retryable: true', async () => {
    const { result } = await run(withRoutes({ R1: error({ code: 100, isTransient: true }) }));

    expect(retryableOf(result)).toBe(true);
  });

  it('#49 P1 R1 が 400 code 190（token）なら retryable: false', async () => {
    const { result } = await run(withRoutes({ R1: error({ code: 190 }) }));

    expect(retryableOf(result)).toBe(false);
  });

  it.each([
    ['code 10', error({ code: 10 })],
    ['code 200', error({ code: 200 })],
    ['code 299', error({ code: 299 })],
    ['403 code 10', error({ status: 403, code: 10 })],
  ])('#49 P1 R1 が %s（permission）なら retryable: false', async (_label, route) => {
    const { result } = await run(withRoutes({ R1: route }));

    expect(retryableOf(result)).toBe(false);
  });

  it.each([
    ['code 9 / subcode 2207042', error({ code: 9, subcode: 2207042 })],
    ['code 4 / subcode 2207042（rateLimit と重なる）', error({ code: 4, subcode: 2207042 })],
  ])('#49 P1 R1 が %s（dailyLimit）なら retryable: false', async (_label, route) => {
    const { result } = await run(withRoutes({ R1: route }));

    expect(retryableOf(result)).toBe(false);
  });

  it.each([
    ['400 code 100（is_transient なし）', error({ code: 100 })],
    ['400 code 100 / subcode 2207052', error({ code: 100, subcode: 2207052 })],
    ['400 本体が HTML', html(400)],
    ['404', html(404)],
  ])('#49 P1 R1 が %s（その他の 4xx）なら retryable: false', async (_label, route) => {
    const { result } = await run(withRoutes({ R1: route }));

    expect(retryableOf(result)).toBe(false);
  });

  it('#49 P1 R2（carousel の親）が 400 code 100 なら retryable: false', async () => {
    const { result } = await run(
      withRoutes({ R2: error({ code: 100 }) }, { post: postView({ media: mediaOf(2) }) }),
    );

    expect(retryableOf(result)).toBe(false);
  });

  it.each([301, 302, 307, 308])('#49 P1 R1 が %i（3xx）なら retryable: false', async (code) => {
    const { result } = await run(
      withRoutes({
        R1: () => ({ status: code, body: '', headers: { location: 'https://example.test/' } }),
      }),
    );

    expect(retryableOf(result)).toBe(false);
  });

  it.each([
    ['id が無い', (): RouteReply => ({ status: 200, body: {} })],
    ['id が x/y', (): RouteReply => containerCreated('x/y')],
    ['id が数値', (): RouteReply => ({ status: 200, body: { id: 179000000001 } })],
    ['本体が HTML', html(200)],
    ['本体が配列', (): RouteReply => ({ status: 200, body: [] })],
  ])(
    '#49 P1 R1 が 200 で %s なら retryable: true で、R3 も R4 も呼ばない',
    async (_label, route) => {
      const { result, fake } = await run(withRoutes({ R1: route }));

      expect(retryableOf(result)).toBe(true);
      expect(fake.of('R3')).toHaveLength(0);
      expect(fake.of('R4')).toHaveLength(0);
    },
  );

  it('#49 P1 R2 が 200 で id が無ければ retryable: true', async () => {
    const { result } = await run(
      withRoutes(
        { R2: () => ({ status: 200, body: {} }) },
        { post: postView({ media: mediaOf(2) }) },
      ),
    );

    expect(retryableOf(result)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* retryAfterMs（§6.10）                                                         */
/* -------------------------------------------------------------------------- */

describe('retryAfterMs（§6.10）', () => {
  const usage = (minutes: unknown): Record<string, string> => ({
    'x-business-use-case-usage': JSON.stringify({
      '17841400000000001': [
        { type: 'instagram', call_count: 100, estimated_time_to_regain_access: minutes },
      ],
    }),
  });

  it('#54 R1 が 400 code 4 で X-Business-Use-Case-Usage の estimated_time_to_regain_access が 7 なら 420000', async () => {
    const { result } = await run(withRoutes({ R1: error({ code: 4, headers: usage(7) }) }));

    expect(retryAfterOf(result)).toBe(420_000);
  });

  it('#54 R4 が 400 code 4 で estimated_time_to_regain_access が 7 なら 420000', async () => {
    const { result } = await run(withRoutes({ R4: error({ code: 4, headers: usage(7) }) }));

    expect(retryableOf(result)).toBe(true);
    expect(retryAfterOf(result)).toBe(420_000);
  });

  it('#54 Retry-After: 30 なら 30000', async () => {
    const { result } = await run(
      withRoutes({ R1: error({ code: 4, headers: { 'retry-after': '30' } }) }),
    );

    expect(retryAfterOf(result)).toBe(30_000);
  });

  it('#54 両方あれば Retry-After を先に見る', async () => {
    const { result } = await run(
      withRoutes({ R1: error({ code: 4, headers: { 'retry-after': '30', ...usage(7) } }) }),
    );

    expect(retryAfterOf(result)).toBe(30_000);
  });

  it.each([
    ['ヘッダなし', {}],
    ['壊れた JSON', { 'x-business-use-case-usage': '{not json' }],
    ['負の値', usage(-3)],
    ['5000 文字のヘッダ', { 'x-business-use-case-usage': `{"a":[{"x":"${'y'.repeat(4990)}"}]}` }],
    ['Retry-After が数字でない', { 'retry-after': 'soon' }],
  ])('#54 %s なら retryAfterMs を付けない', async (_label, headers) => {
    const { result } = await run(withRoutes({ R1: error({ code: 4, headers }) }));

    expect(retryableOf(result)).toBe(true);
    expect(retryAfterOf(result)).toBeUndefined();
  });

  it('#54 レート制限でない失敗（503）には、Retry-After があっても retryAfterMs を付けない', async () => {
    const { result } = await run(
      withRoutes({
        R1: () => ({ status: 503, body: 'busy', headers: { 'retry-after': '30' } }),
      }),
    );

    expect(retryableOf(result)).toBe(true);
    expect(retryAfterOf(result)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* carousel の失敗の集約（§6.9「複数の失敗」）                                      */
/* -------------------------------------------------------------------------- */

describe('carousel の失敗の集約（§6.3 / §6.9）', () => {
  it('#50 子の 1 つが 400 code 100、別の子が 503 なら retryable: false', async () => {
    const { result } = await run(
      withRoutes(
        { R1: ({ mediaIndex }) => (mediaIndex === 1 ? graphError({ code: 100 }) : htmlPage(503)) },
        { post: postView({ media: mediaOf(3) }) },
      ),
    );

    expect(retryableOf(result)).toBe(false);
  });

  it('#50 reason は retryable: false の側の失敗から作る（添字の小さい 503 より優先）', async () => {
    const { result } = await run(
      withRoutes(
        { R1: ({ mediaIndex }) => (mediaIndex === 1 ? graphError({ code: 100 }) : htmlPage(503)) },
        { post: postView({ media: mediaOf(3) }) },
      ),
    );

    expect(reasonOf(result)).toContain('400');
    expect(reasonOf(result)).toContain('code 100');
    expect(reasonOf(result)).not.toContain('503');
  });

  it('#51 子の 2 番目が失敗したら、飛んでいる他の子の要求が打ち切られる', async () => {
    const fake = createFakeGraph({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? graphError({ code: 100 }) : hang()),
    });

    const { result } = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expect(retryableOf(result)).toBe(false);
    const others = fake.of('R1').filter((call) => mediaIndexOf(call.form.get('image_url')) !== 1);
    expect(others).toHaveLength(2);
    for (const call of others) {
      expect(call.signal?.aborted).toBe(true);
    }
  });

  it('#51 子が失敗したら親 R2 と R4 を呼ばない', async () => {
    const fake = createFakeGraph({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? graphError({ code: 100 }) : hang()),
    });

    await run({ fake, post: postView({ media: mediaOf(3) }) });

    expect(fake.of('R2')).toHaveLength(0);
    expect(fake.of('R3')).toHaveLength(0);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#51 まだ出していない子の要求は出さない（10 枚で 2 番目が失敗）', async () => {
    const fake = createFakeGraph({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? graphError({ code: 100 }) : hang()),
    });

    await run({ fake, post: postView({ media: mediaOf(10) }) });

    expect(fake.of('R1').length).toBeLessThan(10);
  });

  it('#51 打ち切られた子は失敗に数えない（reason は失敗した子から作る）', async () => {
    const fake = createFakeGraph({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? htmlPage(503) : hang()),
    });

    const { result } = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expect(retryableOf(result)).toBe(true);
    expect(reasonOf(result)).toContain('503');
  });

  it('#52 子が全部 503 なら retryable: true', async () => {
    const { result } = await run(
      withRoutes({ R1: html(503) }, { post: postView({ media: mediaOf(3) }) }),
    );

    expect(retryableOf(result)).toBe(true);
  });

  it('#52 子の状態の確認で 1 つが ERROR、他が FINISHED なら retryable: false で R2 を呼ばない', async () => {
    const fake = createFakeGraph({
      R3: ({ targetId }) =>
        containerStatus(targetId === childContainerId(2) ? 'ERROR' : 'FINISHED', targetId),
    });

    const { result } = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expect(retryableOf(result)).toBe(false);
    expect(fake.of('R2')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P2 ポーリング（R3）                                                       */
/* -------------------------------------------------------------------------- */

describe('P2 ポーリング（§6.9）', () => {
  it.each([
    ['接続できない', networkDown as Route],
    ['制限時間', timedOut as Route],
    ['500', html(500)],
    ['429', html(429)],
    ['400 code 4（rateLimit）', error({ code: 4 })],
    ['400 code 100 / is_transient（transient）', error({ code: 100, isTransient: true })],
    ['200 で本体が HTML（形が読めない）', html(200)],
  ])('#49 P2 R3 が %s なら retryable: true で、R4 を呼ばない', async (_label, route) => {
    const { result, fake } = await run(withRoutes({ R3: route }));

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it.each([
    ['400 code 190（token）', error({ code: 190 })],
    ['400 code 10（permission）', error({ code: 10 })],
    ['400 code 200（permission）', error({ code: 200 })],
  ])('#49 P2 R3 が %s なら retryable: false', async (_label, route) => {
    const { result, fake } = await run(withRoutes({ R3: route }));

    expect(retryableOf(result)).toBe(false);
    expect(fake.of('R4')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P3 状態と準備期限                                                         */
/* -------------------------------------------------------------------------- */

describe('P3 状態と準備期限（§6.9）', () => {
  it('#49 P3 status_code が ERROR なら retryable: false で、R4 を呼ばない', async () => {
    const { result, fake } = await run(withRoutes({ R3: status('ERROR') }));

    expect(retryableOf(result)).toBe(false);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it.each([
    ['EXPIRED', status('EXPIRED')],
    ['知らない値（WHATEVER）', status('WHATEVER')],
    ['項目が無い', (({ targetId }) => ({ status: 200, body: { id: targetId } })) as Route],
    ['数値', status(3)],
  ])('#49 P3 status_code が %s なら retryable: true で、R4 を呼ばない', async (_label, route) => {
    const { result, fake } = await run(withRoutes({ R3: route }));

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 P3 status_code が PUBLISHED（まだ R4 を送っていない）なら retryable: false で、R4 を呼ばない', async () => {
    const { result, fake } = await run(withRoutes({ R3: status('PUBLISHED') }));

    expect(retryableOf(result)).toBe(false);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 P3 IN_PROGRESS が続き POLL_MAX_ROUNDS に達したら retryable: true で、R4 を呼ばない', async () => {
    const { result, fake } = await run(withRoutes({ R3: status('IN_PROGRESS') }));

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R3')).toHaveLength(POLL_MAX_ROUNDS);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 P3 IN_PROGRESS のまま準備期限を過ぎたら（now() を 15 秒進める）retryable: true で、R4 を呼ばない', async () => {
    const clock = createClock();
    const wait: FakeWait = {
      calls: [],
      wait: async (ms) => {
        wait.calls.push(ms);
        clock.advance(PREPARE_BUDGET_MS);
      },
    };

    const { result, fake } = await run({
      ...withRoutes({ R3: status('IN_PROGRESS') }),
      clock,
      wait,
    });

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R3').length).toBeLessThan(POLL_MAX_ROUNDS);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 P3 FINISHED になった時点で残りが MEDIA_PUBLISH_TIMEOUT_MS 未満なら retryable: true で、R4 を呼ばない', async () => {
    const clock = createClock();
    const fake = createFakeGraph({
      R3: ({ targetId }) => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - MEDIA_PUBLISH_TIMEOUT_MS + 1);
        return containerStatus('FINISHED', targetId);
      },
    });

    const { result } = await run({ fake, clock });

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 P3 残りがちょうど MEDIA_PUBLISH_TIMEOUT_MS なら R4 を送る', async () => {
    const clock = createClock();
    const fake = createFakeGraph({
      R3: ({ targetId }) => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - MEDIA_PUBLISH_TIMEOUT_MS);
        return containerStatus('FINISHED', targetId);
      },
    });

    const { result } = await run({ fake, clock });

    expect(fake.of('R4')).toHaveLength(1);
    expect(result.ok).toBe(true);
  });

  it('#49 P3 carousel の子の確認の後で準備期限を過ぎていたら、R2 を呼ばず retryable: true', async () => {
    const clock = createClock();
    const fake = createFakeGraph({
      R3: ({ targetId }) => {
        clock.set(START + PREPARE_BUDGET_MS);
        return containerStatus('FINISHED', targetId);
      },
    });

    const { result } = await run({ fake, clock, post: postView({ media: mediaOf(2) }) });

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R2')).toHaveLength(0);
    expect(fake.of('R4')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P4 公開（R4）                                                             */
/* -------------------------------------------------------------------------- */

describe('P4 公開（§6.9）', () => {
  it.each([
    ['400 code 4', error({ code: 4 })],
    ['400 code 613', error({ code: 613 })],
    ['429', html(429)],
  ])('#49 P4 R4 が %s（rateLimit）なら retryable: true', async (_label, route) => {
    const { result } = await run(withRoutes({ R4: route }));

    expect(retryableOf(result)).toBe(true);
  });

  it('#49 P4 R4 が 400 code 9 / subcode 2207042（dailyLimit）なら retryable: false', async () => {
    const { result } = await run(withRoutes({ R4: error({ code: 9, subcode: 2207042 }) }));

    expect(retryableOf(result)).toBe(false);
  });

  it.each([
    ['接続断（reject）', networkDown as Route],
    ['制限時間', timedOut as Route],
    ['500', html(500)],
    ['503', html(503)],
    [
      '302',
      (() => ({ status: 302, body: '', headers: { location: 'https://example.test/' } })) as Route,
    ],
    ['400 code 190（token）', error({ code: 190 })],
    ['400 code 10（permission）', error({ code: 10 })],
    ['400 code 100 / is_transient（transient）', error({ code: 100, isTransient: true })],
    ['400 code 100（その他の 4xx）', error({ code: 100 })],
    ['本体が HTML', html(200)],
    ['id が無い', (() => ({ status: 200, body: {} })) as Route],
    ['id が null', (() => ({ status: 200, body: { id: null } })) as Route],
  ])('#49 P4 R4 が %s なら retryable: false', async (_label, route) => {
    const { result, fake } = await run(withRoutes({ R4: route }));

    expect(retryableOf(result)).toBe(false);
    expect(fake.of('R5')).toHaveLength(0);
    expect(fake.of('R6')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 予期しない例外と input.signal（§6.9「どこでも」/ §6.11）                            */
/* -------------------------------------------------------------------------- */

describe('例外を投げない（§6.11）', () => {
  it('#49 R4 を送る前の予期しない例外（時計が投げる）は retryable: true', async () => {
    const clock: Clock = {
      now: () => {
        throw new Error('時計が壊れた');
      },
      advance: () => {},
      set: () => {},
    };

    const { result, fake } = await run({ clock });

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#49 R4 を送った後の予期しない応答（Response でない値）は retryable: false', async () => {
    const { result } = await run(withRoutes({ R4: (() => null) as unknown as Route }));

    expect(retryableOf(result)).toBe(false);
  });

  it('#49 R4 の成功の後に時計が投げても ok: true を覆さない', async () => {
    let broken = false;
    const clock: Clock = {
      now: () => {
        if (broken) {
          throw new Error('時計が壊れた');
        }
        return new Date(START);
      },
      advance: () => {},
      set: () => {},
    };
    const fake = createFakeGraph({
      R4: () => {
        broken = true;
        return mediaPublished();
      },
    });

    const { result } = await run({ fake, clock });

    expect(result.ok).toBe(true);
    expect(result.ok && result.externalId).toBe(MEDIA_ID);
  });

  it('#53 logger が投げても publish() は例外を投げず、成功は ok: true のまま', async () => {
    const throwing: PluginLogger = {
      debug: () => {
        throw new Error('log');
      },
      info: () => {
        throw new Error('log');
      },
      warn: () => {
        throw new Error('log');
      },
      error: () => {
        throw new Error('log');
      },
    };

    const { result } = await run({
      logger: throwing,
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 10) }),
    });

    expect(result.ok).toBe(true);
  });

  it.each(FAILURE_SCENARIOS)('#53 %s でも publish() は例外を投げない', async (_label, options) => {
    await expect(run(options())).resolves.toBeDefined();
  });

  it('#56 R4 の要求中に input.signal が発火したら、publish() はすぐ戻る', async () => {
    const controller = new AbortController();
    const fake = createFakeGraph({
      R4: () => {
        controller.abort();
        return hang();
      },
    });

    const { result } = await run({ fake, signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(fake.of('R4')[0]?.signal?.aborted).toBe(true);
    expect(fake.of('R5')).toHaveLength(0);
  });

  it('#56 待ちの最中に input.signal が発火したら、R4 を呼ばずに戻る', async () => {
    const controller = new AbortController();
    const clock = createClock();
    const wait: FakeWait = {
      calls: [],
      wait: async (ms, signal) => {
        wait.calls.push(ms);
        controller.abort();
        if (signal.aborted) {
          throw signal.reason;
        }
      },
    };

    const { result, fake } = await run({
      ...withRoutes({ R3: status('IN_PROGRESS') }),
      clock,
      wait,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(fake.of('R4')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.8 reason と logger に出るもの                                               */
/* -------------------------------------------------------------------------- */

describe('reason と logger（§6.11 / §10.8）', () => {
  it.each(FAILURE_SCENARIOS)(
    '#57 %s の reason に accessToken / igUserId の値が現れない',
    async (_label, options) => {
      const { result } = await run(options());
      const reason = reasonOf(result);

      expect(reason).not.toContain(ACCESS_TOKEN);
      expect(reason).not.toContain(IG_USER_ID);
    },
  );

  const leaky = (at: 'R1' | 'R4'): RunOptions =>
    withRoutes({
      [at]: error({
        code: 190,
        message: ACCESS_TOKEN,
        errorUserMsg: `${ACCESS_TOKEN.slice(0, 3)}…`,
        // 設計の例の 'T' は固定の文言（HTTP）と重なって検査にならないので、区別できる値にする。
        errorUserTitle: 'GraphUserTitleText',
        type: 'OAuthException',
        fbtraceId: 'AbC_1',
      }),
    });

  it.each(['R1', 'R4'] as const)(
    '#58 %s の Graph API の自由文・type・fbtrace_id は reason に現れず、code 190 は現れる',
    async (at) => {
      const { result } = await run(leaky(at));
      const reason = reasonOf(result);

      expect(reason).not.toContain(ACCESS_TOKEN);
      expect(reason).not.toContain(`${ACCESS_TOKEN.slice(0, 3)}…`);
      expect(reason).not.toContain(ACCESS_TOKEN.slice(0, 3));
      expect(reason).not.toContain('GraphUserTitleText');
      expect(reason).not.toContain('OAuthException');
      expect(reason).not.toContain('AbC_1');
      expect(reason).toContain('190');
    },
  );

  it.each([
    ['知らない code（987654）', { code: 987654 }, '987654'],
    ['知らない error_subcode（7654321）', { code: 100, subcode: 7654321 }, '7654321'],
    ['文字列の code（"190"）', { code: '190' }, '190'],
    ['文字列の code（"<script>"）', { code: '<script>' }, '<script>'],
    ['文字列の error_subcode（"2207042"）', { code: 9, subcode: '2207042' }, '2207042'],
  ])('#59 %s は reason に現れず unknown と書かれる', async (_label, example, value) => {
    const { result } = await run(withRoutes({ R1: error(example) }));
    const reason = reasonOf(result);

    expect(reason).not.toContain(value);
    expect(reason).toContain('unknown');
  });

  it('#59 文字列の code "190" を token として扱わない（数値に直さない）', async () => {
    const { result } = await run(withRoutes({ R1: error({ code: '190' }) }));

    expect(reasonOf(result)).not.toContain('発行し直し');
  });

  it('#60 R3 の status（自由文）は reason にもログにも現れない', async () => {
    const secret = 'Error: 秘密の自由文 image_url=https://private.example/x.jpg';
    const { result, log } = await run(
      withRoutes({
        R3: ({ targetId }) => ({
          status: 200,
          body: { status_code: 'ERROR', status: secret, id: targetId },
        }),
      }),
    );

    expect(reasonOf(result)).not.toContain('秘密の自由文');
    expect(JSON.stringify(log)).not.toContain('秘密の自由文');
  });

  it('#60 R3 は status（自由文）を要求しない（fields=status_code だけ）', async () => {
    const { fake } = await run();

    for (const call of fake.of('R3')) {
      expect(new URL(call.url).searchParams.get('fields')).toBe('status_code');
    }
  });

  /** ログに出てはならない値（#61）。 */
  const FORBIDDEN_IN_LOG: readonly string[] = [
    ACCESS_TOKEN,
    IG_USER_ID,
    EXPIRES_AT,
    isoDaysFrom(START, 10),
    BODY,
    mediaUrl(0),
    mediaUrl(1),
    mediaUrl(2),
    CONTAINER_ID,
    childContainerId(0),
    childContainerId(1),
    childContainerId(2),
    '17900000000000999',
    MEDIA_ID,
    PERMALINK,
    'IGAAtorifuneTestRefreshedToken0002',
    'access_token',
    'refresh_access_token',
    'graph.instagram.com',
  ];

  function expectCleanLog(log: readonly LogEntry[]): void {
    const text = JSON.stringify(log);
    for (const value of FORBIDDEN_IN_LOG) {
      expect(text).not.toContain(value);
    }
  }

  it.each(FAILURE_SCENARIOS)('#61 %s のログに秘匿すべき値が現れない', async (_label, options) => {
    const { log } = await run(options());

    expectCleanLog(log);
  });

  it('#61 正常系（carousel・延長あり）のログにも秘匿すべき値が現れない', async () => {
    const { result, log } = await run({
      post: postView({ media: mediaOf(3) }),
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 10) }),
    });

    expect(result.ok && result.rotatedCredential).toBeTruthy();
    expectCleanLog(log);
  });

  it.each([
    ['R6 が 400', { R6: error({ code: 190 }) }],
    ['R6 が reject', { R6: networkDown as Route }],
    ['R5 が 500', { R5: html(500) }],
    ['R4 の id が形に合わない', { R4: (() => mediaPublished('123/../456')) as Route }],
  ] as const)('#61 %s のログにも秘匿すべき値が現れない', async (_label, routes) => {
    const { log } = await run(
      withRoutes(routes, {
        credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 10) }),
      }),
    );

    expectCleanLog(log);
  });

  it('#62 fbtrace_id が形に合えば logger の fields.fbtraceId に出て、reason には出ない', async () => {
    const { result, log } = await run(withRoutes({ R1: error({ code: 100, fbtraceId: 'AbC_1' }) }));

    expect(log.some((entry) => entry.fields?.['fbtraceId'] === 'AbC_1')).toBe(true);
    expect(reasonOf(result)).not.toContain('AbC_1');
  });

  it.each([
    ['空白を含む', 'a b'],
    ['65 文字', 'x'.repeat(65)],
  ])('#62 fbtrace_id が%sならログにも reason にも出ない', async (_label, fbtraceId) => {
    const { result, log } = await run(withRoutes({ R1: error({ code: 100, fbtraceId }) }));

    expect(log.some((entry) => entry.fields !== undefined && 'fbtraceId' in entry.fields)).toBe(
      false,
    );
    expect(JSON.stringify(log)).not.toContain(fbtraceId);
    expect(reasonOf(result)).not.toContain(fbtraceId);
  });

  it.each(FAILURE_SCENARIOS)('#63 %s の reason は空でない', async (_label, options) => {
    const { result } = await run(options());

    expect(reasonOf(result).trim()).not.toBe('');
  });

  it.each([
    ['R1', withRoutes({ R1: error({ code: 190 }) })],
    ['R3', withRoutes({ R3: error({ code: 190 }) })],
    ['R4', withRoutes({ R4: error({ code: 190 }) })],
  ])('#63 %s の token（190）の reason に「発行し直し」が現れる', async (_label, options) => {
    const { result } = await run(options);

    expect(reasonOf(result)).toContain('発行し直し');
  });

  it('#63 ERROR の reason に「JPEG」が現れる', async () => {
    const { result } = await run(withRoutes({ R3: status('ERROR') }));

    expect(reasonOf(result)).toContain('JPEG');
  });

  it.each([
    ['R1', withRoutes({ R1: error({ code: 9, subcode: 2207042 }) })],
    ['R4', withRoutes({ R4: error({ code: 9, subcode: 2207042 }) })],
  ])('#63 %s の dailyLimit の reason に「上限」が現れる', async (_label, options) => {
    const { result } = await run(options);

    expect(reasonOf(result)).toContain('上限');
  });
});
