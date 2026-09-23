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
