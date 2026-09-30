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
  CAROUSEL_CONTAINER_ID,
  CONTAINER_ID,
  FBTRACE_ID,
  LEAKY_ERROR_USER_TITLE,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  THREADS_USER_ID,
  childContainerId,
  containerStatus,
  defaultThreadsReply,
  endingJsonResponse,
  htmlPage,
  leakyError,
  mediaIndexOf,
  mediaUrlOf,
  paddedJson,
  redirectTo,
  targetIdOf,
  threadsError,
  threadsPublished,
  threadsRequestKind,
  toResponse,
  type ThreadsErrorExample,
  type ThreadsRequestKind,
  type ThreadsResponseExample,
} from '@/test-support/threads-api';
import { createThreadsPublisher } from '../../../../plugins/sns-threads/social';
import {
  CREATE_CONTAINER_TIMEOUT_MS,
  PERMALINK_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_MAX_ROUNDS,
  PREPARE_BUDGET_MS,
  PUBLISH_REQUEST_TIMEOUT_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  REFRESH_TIMEOUT_MS,
  RESPONSE_BODY_MAX_BYTES,
  STATUS_TIMEOUT_MS,
  THREADS_API_BASE_URL,
  THREADS_API_VERSION,
  sendThreadsRequest,
} from '../../../../plugins/sns-threads/threads-api';

/**
 * Threads 配信 Plugin の `retryable`・秘匿・制限時間の検査（040-sns-threads 設計 §6.8〜§6.11 / §10.9〜§10.11）。
 *
 * **設計 §6.9 の表を 1 行ずつ**書く（表は 24 行。#65 の箇条書きはその部分集合。実装プラン §3 G6 の表）。
 * **どの `retryable` のテストも `logger.warn` の `fields.phase` をアサートする**（テスト名と通った分岐を一致させる。
 * 設計 §10.17 の型 5）。フェーズの名前は実装プラン §8 の 4：
 * `input`（P0）/ `container`（R1 / R2）/ `status`（R3 の失敗と P3 の状態）/ `prepare`（P3 の準備期限の行）/
 * `publish`（R4）/ `permalink`（R5）/ `refresh`（R6）。
 *
 * **R4 の後の予期しない例外のテストは作らない**（設計 §6.9。今の設計では到達する経路が無い）。
 *
 * **実際の Threads を叩かない。** 偽の Threads API・可変の時計・即座に解決する待ちを注入する（設計 §10.1）。
 * 偽の応答の形と要求の見分け方は `test-support/threads-api.ts` の 1 か所から取る（#93）。
 *
 * #107：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 */

let realFetch: typeof globalThis.fetch;

/** 呼ばれたら投げる `fetch`（#107）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  // #107：本物の `fetch` を呼んだら落ちる。差し替え忘れを検出する。
  realFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 偽の Threads API（実装プラン §2「テストの方法」。このファイルに持つ）               */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 時計の起点。 */
const START = Date.parse('2026-09-24T12:00:00.000Z');

type RequestKind = ThreadsRequestKind;

interface FakeCall {
  readonly kind: RequestKind;
  readonly url: string;
  readonly method: string;
  readonly form: URLSearchParams;
  /** 本体の文字列（秘匿の検査で、ログと reason に本体の断片が無いことを見る）。 */
  readonly bodyText: string;
  readonly signal: AbortSignal | undefined;
}

interface RouteContext {
  readonly call: FakeCall;
  readonly index: number;
  readonly mediaIndex: number;
  readonly targetId: string;
}

type RouteReply = ThreadsResponseExample | Response;
type Route = (context: RouteContext) => RouteReply | Promise<RouteReply>;

type FakeThreadsOptions = Partial<Record<RequestKind, Route>>;

interface FakeThreads {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FakeCall[];
  kinds(): RequestKind[];
  of(kind: RequestKind): FakeCall[];
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

/** 偽の Threads API。**知らない宛先・知らない要求では投げる**（`threadsRequestKind`。#107）。 */
function createFakeThreads(options: FakeThreadsOptions = {}): FakeThreads {
  const calls: FakeCall[] = [];
  const counters: Record<RequestKind, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 };

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const bodyText = bodyTextOf(init.body);
    const form = new URLSearchParams(bodyText);
    const kind = threadsRequestKind(url, method, form);
    const call: FakeCall = {
      kind,
      url: url.href,
      method,
      form,
      bodyText,
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
      targetId: targetIdOf(url),
    };
    const route = options[kind];
    const reply = await Promise.race([
      Promise.resolve(
        route === undefined ? defaultThreadsReply(kind, { url, form }) : route(context),
      ),
      rejectOnAbort(call.signal),
    ]);
    return reply instanceof Response ? reply : toResponse(reply, call.signal);
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

/** 例外の文面に**要求の URL と本体（トークン入り）**を混ぜて reject する（本物の例外の文面に URL が入ることがある）。 */
const leakyNetworkDown: Route = ({ call }) => {
  throw new TypeError(`fetch failed: ${call.url} ${call.bodyText}`);
};

/** 解決しない（signal の発火でだけ止まる）。 */
function hang(): Promise<never> {
  return new Promise<never>(() => {});
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

const BODY = '秋の新作マグカップが入荷しました Zp4-body';
const LINK = 'https://shop.example/items/Lk9';
const ALT = 'Alt9-店頭のマグカップ';

function isoDaysFrom(base: number, days: number): string {
  return new Date(base + days * DAY_MS).toISOString();
}

/** 期限が 40 日後（延長しない）。 */
const EXPIRES_AT = isoDaysFrom(START, 40);

/** 期限が 10 日後（延長する）。 */
const NEAR_EXPIRES_AT = isoDaysFrom(START, 10);

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000e001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000e001',
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
    id: '0199aaaa-0000-7000-8000-00000000e001',
    provider: 'threads',
    displayName: '見本のアカウント',
    handle: 'yamada.example',
    status: 'active',
    credentialConfigured: true,
  };
}

function credentialOf(
  overrides: Partial<Record<'threadsUserId' | 'accessToken' | 'accessTokenExpiresAt', string>> = {},
): Record<string, string> {
  return {
    threadsUserId: THREADS_USER_ID,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function mediaOf(count: number, alt: string | null = null): SocialPostView['media'] {
  return Array.from({ length: count }, (_, index) => ({ url: mediaUrlOf(index), alt }));
}

function publishOf(
  registration: PublisherRegistration,
): NonNullable<PublisherRegistration['publish']> {
  const publish = registration.publish;
  if (publish === undefined) {
    throw new Error('publish が実装されていない');
  }
  return publish.bind(registration);
}

interface RunOptions {
  readonly fake?: FakeThreads;
  readonly clock?: Clock;
  readonly wait?: FakeWait;
  readonly post?: SocialPostView;
  readonly credential?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
}

interface RunResult {
  readonly result: PublishResult;
  readonly fake: FakeThreads;
  readonly clock: Clock;
  readonly wait: FakeWait;
  readonly log: LogEntry[];
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const fake = options.fake ?? createFakeThreads();
  const clock = options.clock ?? createClock();
  const wait = options.wait ?? createFakeWait(clock);
  const captured = captureLogger();
  const publish = publishOf(
    createThreadsPublisher({ fetch: fake.fetch, now: clock.now, wait: wait.wait }),
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

function warnPhases(log: readonly LogEntry[]): unknown[] {
  return log.filter((entry) => entry.level === 'warn').map((entry) => entry.fields?.['phase']);
}

/** 失敗の `retryable` と、`logger.warn` の `fields.phase` を同時に確かめる（型 5）。 */
function expectFailure(
  outcome: RunResult,
  expected: { readonly retryable: boolean; readonly phase: string },
): void {
  expect(retryableOf(outcome.result)).toBe(expected.retryable);
  expect(warnPhases(outcome.log)).toContain(expected.phase);
}

/** `run()` に渡す応答の組。 */
function withRoutes(routes: FakeThreadsOptions, extra: Omit<RunOptions, 'fake'> = {}): RunOptions {
  return { fake: createFakeThreads(routes), ...extra };
}

const html = (code: number) => (): RouteReply => htmlPage(code);
const error = (example: ThreadsErrorExample) => (): RouteReply => threadsError(example);
const plain =
  (code: number, body: unknown = { id: CONTAINER_ID }) =>
  (): RouteReply => ({ status: code, body });
const status =
  (value: unknown) =>
  ({ targetId }: RouteContext): RouteReply => ({
    status: 200,
    body: { status: value, id: targetId },
  });
const redirect = (code: number) => (): RouteReply =>
  redirectTo('https://example.test/elsewhere', code);
/** 1 MiB で**終わる** stream の本体（`extra` を読めれば成功として読める本体）。 */
const endingOversized =
  (extra: Readonly<Record<string, unknown>>, code = 200) =>
  ({ call }: RouteContext): RouteReply =>
    endingJsonResponse({ extra, status: code, signal: call.signal }).response;

/** 対になっていないサロゲート（上位だけ）。**字面に書かず、コードポイントから作る。** */
const LONE_HIGH = String.fromCharCode(0xd800);

/** 👍 U+1F44D（§9.4 の数えで 4）。 */
const THUMBS_UP = String.fromCodePoint(0x1f44d);

/** 異なる URL を `count` 本、空白で区切って並べた本文。 */
function urls(count: number): string {
  return Array.from({ length: count }, (_, index) => `https://a.example/p${index}`).join(' ');
}

/* -------------------------------------------------------------------------- */
/* 失敗する配信の一覧（#69 / #73 / #77 / #78 が全件に掛ける）                         */
/* -------------------------------------------------------------------------- */

interface Scenario {
  readonly label: string;
  readonly options: () => RunOptions;
}

function scenario(label: string, options: () => RunOptions): Scenario {
  return { label, options };
}

/** 設計 §6.9 の各行の代表（どれも実行のたびに新しい偽物を作る）。 */
const FAILURE_SCENARIOS: readonly Scenario[] = [
  scenario('P0 threadsUserId の形', () => ({
    credential: credentialOf({ threadsUserId: '1/../2' }),
  })),
  scenario('P0 accessToken の形', () => ({
    credential: credentialOf({ accessToken: `${ACCESS_TOKEN}\n` }),
  })),
  scenario('P0 media 11 件', () => ({ post: postView({ media: mediaOf(11) }) })),
  scenario('P0 本文 501', () => ({ post: postView({ body: `${'a'.repeat(497)}${THUMBS_UP}` }) })),
  scenario('P0 URL 6 本', () => ({ post: postView({ body: urls(6) }) })),
  scenario('P0 対になっていないサロゲート', () => ({ post: postView({ body: `a${LONE_HIGH}` }) })),
  scenario('P1 reject', () => withRoutes({ R1: networkDown })),
  scenario('P1 例外の文面に URL と本体', () => withRoutes({ R1: leakyNetworkDown })),
  scenario('P1 制限時間', () => withRoutes({ R1: timedOut })),
  scenario('P1 503', () => withRoutes({ R1: html(503) })),
  scenario('P1 code 4', () => withRoutes({ R1: error({ code: 4 }) })),
  scenario('P1 transient', () => withRoutes({ R1: error({ code: 100, isTransient: true }) })),
  scenario('P1 code 190', () => withRoutes({ R1: error({ code: 190, subcode: 463 }) })),
  scenario('P1 code 10', () => withRoutes({ R1: error({ code: 10 }) })),
  scenario('P1 code 368', () => withRoutes({ R1: error({ code: 368 }) })),
  scenario('P1 code 100', () => withRoutes({ R1: error({ code: 100 }) })),
  scenario('P1 302', () => withRoutes({ R1: redirect(302) })),
  scenario('P1 id なし', () => withRoutes({ R1: plain(200, {}) })),
  scenario('P1 carousel の子が混在', () =>
    withRoutes(
      { R1: ({ mediaIndex }) => (mediaIndex === 1 ? threadsError({ code: 100 }) : htmlPage(503)) },
      { post: postView({ media: mediaOf(3, ALT), link: LINK }) },
    ),
  ),
  scenario('P1 carousel の親が 400', () =>
    withRoutes({ R2: error({ code: 100 }) }, { post: postView({ media: mediaOf(2, ALT) }) }),
  ),
  scenario('P2 500', () => withRoutes({ R3: html(500) })),
  scenario('P2 例外の文面に URL', () => withRoutes({ R3: leakyNetworkDown })),
  scenario('P2 code 190', () => withRoutes({ R3: error({ code: 190 }) })),
  scenario('P3 ERROR', () => withRoutes({ R3: status('ERROR') })),
  scenario('P3 EXPIRED', () => withRoutes({ R3: status('EXPIRED') })),
  scenario('P3 PUBLISHED', () => withRoutes({ R3: status('PUBLISHED') })),
  scenario('P3 知らない値', () => withRoutes({ R3: status('WHATEVER') })),
  scenario('P3 IN_PROGRESS のまま', () => withRoutes({ R3: status('IN_PROGRESS') })),
  scenario('P4 code 4', () => withRoutes({ R4: error({ code: 4 }) })),
  scenario('P4 500', () => withRoutes({ R4: html(500) })),
  scenario('P4 reject', () => withRoutes({ R4: networkDown })),
  scenario('P4 例外の文面に URL と本体', () => withRoutes({ R4: leakyNetworkDown })),
  scenario('P4 code 190', () => withRoutes({ R4: error({ code: 190 }) })),
  scenario('P4 id なし', () => withRoutes({ R4: plain(200, {}) })),
];

/* -------------------------------------------------------------------------- */
/* §6.9 P0 入口                                                                 */
/* -------------------------------------------------------------------------- */

describe('P0 入口（§6.9。外へ 1 本も出さない）', () => {
  async function expectP0(options: RunOptions): Promise<void> {
    const outcome = await run(options);

    expectFailure(outcome, { retryable: false, phase: 'input' });
    expect(outcome.fake.calls).toHaveLength(0);
  }

  it.each([
    ['abc', 'abc'],
    ['1/../2', '1/../2'],
    ['1?x=1', '1?x=1'],
    ['65 桁', '1'.repeat(65)],
    ['空文字', ''],
  ])(
    '#65 P0 threadsUserId が %s なら retryable: false・fetch 0 本・phase: input',
    async (_label, threadsUserId) => {
      await expectP0({ credential: credentialOf({ threadsUserId }) });
    },
  );

  it.each([
    ['改行を含む', `${ACCESS_TOKEN}\n`],
    ['空白を含む', `${ACCESS_TOKEN} x`],
    ['全角文字を含む', `${ACCESS_TOKEN}ｔｏｋｅｎ`],
    ['2049 文字', 'a'.repeat(2049)],
    ['空文字', ''],
  ])(
    '#65 P0 accessToken が%sなら retryable: false・fetch 0 本・phase: input',
    async (_label, accessToken) => {
      await expectP0({ credential: credentialOf({ accessToken }) });
    },
  );

  it('#65 P0 資格情報のキーが欠けていても例外を投げず retryable: false・fetch 0 本', async () => {
    await expectP0({ credential: { accessToken: ACCESS_TOKEN } });
  });

  it('#65 P0 media が 11 件なら retryable: false・fetch 0 本・phase: input', async () => {
    await expectP0({ post: postView({ media: mediaOf(11) }) });
  });

  it('#65 P0 本文が §9.4 の数えで 501（String.length は 499）なら retryable: false・fetch 0 本', async () => {
    const body = `${'a'.repeat(497)}${THUMBS_UP}`;

    expect(body.length).toBe(499);
    await expectP0({ post: postView({ body }) });
  });

  it('#65 P0 本文 480 ＋ link 20 文字（改行を含めて 501）なら retryable: false・fetch 0 本', async () => {
    await expectP0({ post: postView({ body: 'a'.repeat(480), link: 'https://a.example/xy' }) });
  });

  it('#65 P0 異なる URL が 6 本なら retryable: false・fetch 0 本', async () => {
    await expectP0({ post: postView({ body: urls(6) }) });
  });

  it('#65 P0 本文の URL 5 本 ＋ 本文に無い link で 6 本なら retryable: false・fetch 0 本', async () => {
    await expectP0({ post: postView({ body: urls(5), link: 'https://b.example/other' }) });
  });

  it.each([
    ['本文の先頭', () => postView({ body: `${LONE_HIGH}a` })],
    ['本文の途中', () => postView({ body: `a${LONE_HIGH}b` })],
    ['下位だけ', () => postView({ body: `a${String.fromCharCode(0xdc00)}` })],
    ['link の中', () => postView({ link: `https://a.example/${LONE_HIGH}` })],
  ])(
    '#65 P0 対になっていないサロゲート（%s）なら retryable: false・fetch 0 本',
    async (_label, post) => {
      await expectP0({ post: post() });
    },
  );

  it('#65 P0 intent URL の長さ（§9.2 の 4）は自動配信の入口では見ない（日本語 224 文字は送る）', async () => {
    // 設計 §6.9 P0（2026-09-24 訂正）：4 は手動投稿だけの検査。
    const { result, fake } = await run({ post: postView({ body: 'あ'.repeat(224) }) });

    expect(result.ok).toBe(true);
    expect(fake.of('R4')).toHaveLength(1);
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
  ])(
    '#65 P1 R1 が %s なら retryable: true・phase: container、R3 も R4 も呼ばない',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: true, phase: 'container' });
      expect(outcome.fake.of('R3')).toHaveLength(0);
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );

  it('#65 P1 R2（carousel の親）が 503 なら retryable: true・phase: container', async () => {
    const outcome = await run(
      withRoutes({ R2: html(503) }, { post: postView({ media: mediaOf(2) }) }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it.each([
    ['400 code 4', error({ code: 4 })],
    ['400 code 17', error({ code: 17 })],
    ['400 code 32', error({ code: 32 })],
    ['400 code 341', error({ code: 341 })],
    ['400 code 613', error({ code: 613 })],
    ['429（code なし）', html(429)],
  ])(
    '#65 P1 R1 が %s（rateLimit）なら retryable: true・phase: container',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: true, phase: 'container' });
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );

  it('#65 P1 R1 が 400 code 100 / is_transient: true（transient）なら retryable: true・phase: container', async () => {
    const outcome = await run(withRoutes({ R1: error({ code: 100, isTransient: true }) }));

    expectFailure(outcome, { retryable: true, phase: 'container' });
  });

  it.each([
    ['code 190', error({ code: 190 })],
    ['code 190 / subcode 463', error({ code: 190, subcode: 463 })],
  ])(
    '#65 P1 R1 が 400 %s（token）なら retryable: false・phase: container',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: false, phase: 'container' });
    },
  );

  it.each([
    ['code 10', error({ code: 10 })],
    ['code 200', error({ code: 200 })],
    ['code 299', error({ code: 299 })],
    ['403 code 10', error({ status: 403, code: 10 })],
  ])(
    '#65 P1 R1 が %s（permission）なら retryable: false・phase: container',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: false, phase: 'container' });
    },
  );

  it.each([
    ['code 368', error({ code: 368 })],
    ['code 506', error({ code: 506 })],
  ])(
    '#65 P1 R1 が 400 %s（rejected）なら retryable: false・phase: container',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: false, phase: 'container' });
    },
  );

  it.each([
    ['400 code 100（is_transient なし）', error({ code: 100 })],
    [
      '400 で code が文字列（THREADS_API__LINK_LIMIT_EXCEEDED）',
      error({ code: 'THREADS_API__LINK_LIMIT_EXCEEDED' }),
    ],
    ['400 本体が HTML', html(400)],
    ['404', html(404)],
  ])(
    '#65 P1 R1 が %s（その他の 4xx）なら retryable: false・phase: container',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: false, phase: 'container' });
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );

  it.each([
    ['500 で code 190（token）', error({ status: 500, code: 190 })],
    ['500 で code 10（permission）', error({ status: 500, code: 10 })],
    ['500 で code 368（rejected）', error({ status: 500, code: 368 })],
  ])(
    '#65 P1 R1 が %s なら 5xx でも retryable: false・phase: container（直らないものは false。§6.9 の支配的な規則 1）',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: false, phase: 'container' });
    },
  );

  it('#65 P1 R2（carousel の親）が 400 code 100 なら retryable: false・phase: container', async () => {
    const outcome = await run(
      withRoutes({ R2: error({ code: 100 }) }, { post: postView({ media: mediaOf(2) }) }),
    );

    expectFailure(outcome, { retryable: false, phase: 'container' });
  });

  it.each([301, 302, 307, 308])(
    '#65 P1 R1 が %i（3xx）なら retryable: false・phase: container',
    async (code) => {
      const outcome = await run(withRoutes({ R1: redirect(code) }));

      expectFailure(outcome, { retryable: false, phase: 'container' });
    },
  );

  it.each([
    ['id が無い', plain(200, {})],
    ['id が x/y', plain(200, { id: 'x/y' })],
    ['id が数値', plain(200, { id: 180000000001 })],
    ['id が 65 桁', plain(200, { id: '1'.repeat(65) })],
    ['本体が HTML', html(200)],
    ['本体が配列', plain(200, [])],
    ['201（200 以外の 2xx）', plain(201)],
    ['202（200 以外の 2xx）', plain(202)],
    [
      '本体が 64 KiB を超える（1 MiB で終わる stream。id は形に合う）',
      endingOversized({ id: CONTAINER_ID }),
    ],
  ])(
    '#65 P1 R1 が 200 系で %s なら retryable: true・phase: container、R3 も R4 も呼ばない',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R1: route }));

      expectFailure(outcome, { retryable: true, phase: 'container' });
      expect(outcome.fake.of('R3')).toHaveLength(0);
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );

  it('#65 P1 R2 が 200 で id が無ければ retryable: true・phase: container', async () => {
    const outcome = await run(
      withRoutes({ R2: plain(200, {}) }, { post: postView({ media: mediaOf(2) }) }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#65 P1 子の R1 の id が形に合わなければ、その ID をパスにも children にも使わず retryable: true', async () => {
    const outcome = await run(
      withRoutes(
        {
          R1: ({ mediaIndex }) =>
            mediaIndex === 1
              ? { status: 200, body: { id: '1/../2' } }
              : { status: 200, body: { id: childContainerId(mediaIndex) } },
        },
        { post: postView({ media: mediaOf(2) }) },
      ),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(outcome.fake.of('R2')).toHaveLength(0);
    for (const call of outcome.fake.calls) {
      expect(call.url).not.toContain('..');
    }
  });

  it('#65 P1 R1 がちょうど 64 KiB の 200（id が形に合う）なら読んで次へ進む', async () => {
    const outcome = await run(
      withRoutes({
        R1: plain(
          200,
          JSON.parse(paddedJson(RESPONSE_BODY_MAX_BYTES, { id: CONTAINER_ID })) as unknown,
        ),
      }),
    );

    expect(outcome.result.ok).toBe(true);
    expect(outcome.fake.of('R4')).toHaveLength(1);
  });

  it('#65 P1 R1 が 64 KiB を 1 バイト超える 200 なら、id があっても retryable: true・R3 を呼ばない', async () => {
    const outcome = await run(
      withRoutes({
        R1: () => ({
          status: 200,
          body: paddedJson(RESPONSE_BODY_MAX_BYTES + 1, { id: CONTAINER_ID }),
        }),
      }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(outcome.fake.of('R3')).toHaveLength(0);
  });

  it('#65 P1 R1 が 400 で本体が 64 KiB を超えるなら、code 4 が入っていても読まず retryable: false（その他の 4xx）', async () => {
    const outcome = await run(withRoutes({ R1: endingOversized({ error: { code: 4 } }, 400) }));

    expectFailure(outcome, { retryable: false, phase: 'container' });
  });

  it('#65 P1 R1 が 400 で本体がちょうど 64 KiB なら code 4 を読み、retryable: true（rateLimit）', async () => {
    const outcome = await run(
      withRoutes({
        R1: () => ({
          status: 400,
          body: paddedJson(RESPONSE_BODY_MAX_BYTES, { error: { code: 4 } }),
        }),
      }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
  });
});

/* -------------------------------------------------------------------------- */
/* retryAfterMs（§6.10）                                                         */
/* -------------------------------------------------------------------------- */

describe('retryAfterMs（§6.10）', () => {
  it.each([
    ['R1 が 429', { R1: error({ status: 429, headers: { 'retry-after': '30' } }) }, 'container'],
    ['R1 が 400 code 4', { R1: error({ code: 4, headers: { 'retry-after': '30' } }) }, 'container'],
    ['R4 が 429', { R4: error({ status: 429, headers: { 'retry-after': '30' } }) }, 'publish'],
    [
      'R4 が 400 code 613',
      { R4: error({ code: 613, headers: { 'retry-after': '30' } }) },
      'publish',
    ],
  ] as const)(
    '#70 %s で Retry-After: 30 なら retryAfterMs === 30000',
    async (_label, routes, phase) => {
      const outcome = await run(withRoutes(routes));

      expectFailure(outcome, { retryable: true, phase });
      expect(retryAfterOf(outcome.result)).toBe(30_000);
    },
  );

  it('#70 R3 のレート制限（P2 の true）にも Retry-After から retryAfterMs を付ける（実装プラン §8 の 10）', async () => {
    const outcome = await run(
      withRoutes({ R3: error({ status: 429, headers: { 'retry-after': '30' } }) }),
    );

    expectFailure(outcome, { retryable: true, phase: 'status' });
    expect(retryAfterOf(outcome.result)).toBe(30_000);
  });

  it.each([
    ['ヘッダなし', {}],
    ['数字でない（abc）', { 'retry-after': 'abc' }],
    ['負（-1）', { 'retry-after': '-1' }],
    ['65 文字', { 'retry-after': '1'.repeat(65) }],
  ])('#70 R1 が 429 で %s なら retryAfterMs を付けない', async (_label, headers) => {
    const outcome = await run(withRoutes({ R1: error({ status: 429, headers }) }));

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(retryAfterOf(outcome.result)).toBeUndefined();
  });

  it('#70 X-Business-Use-Case-Usage があっても読まない（そのヘッダだけで retryAfterMs が付かない）', async () => {
    const usage = JSON.stringify({
      [THREADS_USER_ID]: [{ type: 'threads', call_count: 100, estimated_time_to_regain_access: 7 }],
    });
    const outcome = await run(
      withRoutes({ R1: error({ code: 4, headers: { 'x-business-use-case-usage': usage } }) }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(retryAfterOf(outcome.result)).toBeUndefined();
  });

  it('#70 レート制限でない失敗（503）には、Retry-After があっても retryAfterMs を付けない', async () => {
    const outcome = await run(
      withRoutes({ R1: () => ({ status: 503, body: 'busy', headers: { 'retry-after': '30' } }) }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(retryAfterOf(outcome.result)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* carousel の失敗の集約（§6.3 / §6.9「複数の失敗」）                                */
/* -------------------------------------------------------------------------- */

describe('carousel の失敗の集約（#66〜#68）', () => {
  const mixed = (): RunOptions =>
    withRoutes(
      { R1: ({ mediaIndex }) => (mediaIndex === 1 ? threadsError({ code: 100 }) : htmlPage(503)) },
      { post: postView({ media: mediaOf(3) }) },
    );

  it('#66 子の 1 つが 400 code 100、別の子が 503 なら retryable: false・phase: container', async () => {
    expectFailure(await run(mixed()), { retryable: false, phase: 'container' });
  });

  it('#66 reason は retryable: false の側の失敗から作る（添字の小さい 503 より優先）', async () => {
    const reason = reasonOf((await run(mixed())).result);

    expect(reason).toContain('400');
    expect(reason).toContain('100');
    expect(reason).not.toContain('503');
  });

  it('#66 false が無ければ、添字のいちばん小さい失敗から reason を作る', async () => {
    const outcome = await run(
      withRoutes(
        { R1: ({ mediaIndex }) => (mediaIndex === 0 ? htmlPage(502) : htmlPage(503)) },
        { post: postView({ media: mediaOf(2) }) },
      ),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(reasonOf(outcome.result)).toContain('502');
    expect(reasonOf(outcome.result)).not.toContain('503');
  });

  it('#67 子の 2 番目が失敗したら、飛んでいる他の子の要求が打ち切られる', async () => {
    const fake = createFakeThreads({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? threadsError({ code: 100 }) : hang()),
    });

    const outcome = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expectFailure(outcome, { retryable: false, phase: 'container' });
    const others = fake.of('R1').filter((call) => mediaIndexOf(call.form.get('image_url')) !== 1);
    expect(others).toHaveLength(2);
    for (const call of others) {
      expect(call.signal?.aborted).toBe(true);
    }
  });

  it('#67 子が失敗したら R3・親 R2・R4 を呼ばない', async () => {
    const fake = createFakeThreads({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? threadsError({ code: 100 }) : hang()),
    });

    await run({ fake, post: postView({ media: mediaOf(3) }) });

    expect(fake.of('R2')).toHaveLength(0);
    expect(fake.of('R3')).toHaveLength(0);
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#67 まだ出していない子の要求は出さない（10 枚で 2 番目が失敗）', async () => {
    const fake = createFakeThreads({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? threadsError({ code: 100 }) : hang()),
    });

    await run({ fake, post: postView({ media: mediaOf(10) }) });

    expect(fake.of('R1').length).toBeLessThan(10);
  });

  it('#67 打ち切られた子は失敗に数えない（503 だけなら retryable: true、reason は 503 から）', async () => {
    const fake = createFakeThreads({
      R1: ({ mediaIndex }) => (mediaIndex === 1 ? htmlPage(503) : hang()),
    });

    const outcome = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(reasonOf(outcome.result)).toContain('503');
  });

  it('#68 子が全部 503 なら retryable: true・phase: container', async () => {
    const outcome = await run(
      withRoutes({ R1: html(503) }, { post: postView({ media: mediaOf(3) }) }),
    );

    expectFailure(outcome, { retryable: true, phase: 'container' });
  });

  it('#68 子の状態の確認で 1 つが ERROR、他が FINISHED なら retryable: false・phase: status で R2 を呼ばない', async () => {
    const fake = createFakeThreads({
      R3: ({ targetId }) =>
        containerStatus(targetId === childContainerId(2) ? 'ERROR' : 'FINISHED', targetId),
    });

    const outcome = await run({ fake, post: postView({ media: mediaOf(3) }) });

    expectFailure(outcome, { retryable: false, phase: 'status' });
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
    ['503', html(503)],
    ['429', html(429)],
    ['400 code 4（rateLimit）', error({ code: 4 })],
    ['400 code 100 / is_transient（transient）', error({ code: 100, isTransient: true })],
    ['200 で本体が HTML（形が読めない）', html(200)],
    ['202（200 以外の 2xx。形が読めない）', plain(202, { status: 'FINISHED' })],
  ])(
    '#65 P2 R3 が %s なら retryable: true・phase: status、R4 を呼ばない',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R3: route }));

      expectFailure(outcome, { retryable: true, phase: 'status' });
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );

  it.each([
    ['400 code 190（token）', error({ code: 190 })],
    ['400 code 10（permission）', error({ code: 10 })],
    ['400 code 200（permission）', error({ code: 200 })],
    ['400 code 368（rejected）', error({ code: 368 })],
    ['400 code 100（その他の 4xx）', error({ code: 100 })],
    ['404（その他の 4xx）', html(404)],
    ['302（3xx）', redirect(302)],
  ])(
    '#65 P2 R3 が %s なら retryable: false・phase: status、R4 を呼ばない',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R3: route }));

      expectFailure(outcome, { retryable: false, phase: 'status' });
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* §6.9 P3 状態と準備期限                                                         */
/* -------------------------------------------------------------------------- */

describe('P3 状態と準備期限（§6.4 / §6.9）', () => {
  it('#65 P3 status が ERROR なら retryable: false・phase: status、R4 を呼ばない', async () => {
    const outcome = await run(withRoutes({ R3: status('ERROR') }));

    expectFailure(outcome, { retryable: false, phase: 'status' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it.each([
    ['EXPIRED', status('EXPIRED')],
    ['知らない値（WHATEVER）', status('WHATEVER')],
    ['数値', status(3)],
    ['項目が無い', (({ targetId }) => ({ status: 200, body: { id: targetId } })) as Route],
    ['JSON でない', html(200)],
  ])(
    '#65 P3 status が %s なら retryable: true・phase: status、R4 を呼ばない',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R3: route }));

      expectFailure(outcome, { retryable: true, phase: 'status' });
      expect(outcome.fake.of('R4')).toHaveLength(0);
    },
  );

  it('#65 P3 status が PUBLISHED（まだ R4 を送っていない）なら retryable: false・phase: status、R4 を呼ばない', async () => {
    const outcome = await run(withRoutes({ R3: status('PUBLISHED') }));

    expectFailure(outcome, { retryable: false, phase: 'status' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#65 P3 IN_PROGRESS が続き POLL_MAX_ROUNDS に達したら retryable: true・phase: prepare。R3 は POLL_MAX_ROUNDS 回・wait は 1 回少なく、R4 を呼ばない', async () => {
    const outcome = await run(withRoutes({ R3: status('IN_PROGRESS') }));

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(outcome.fake.of('R3')).toHaveLength(POLL_MAX_ROUNDS);
    expect(outcome.wait.calls).toHaveLength(POLL_MAX_ROUNDS - 1);
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#65 P3 IN_PROGRESS のまま準備期限を過ぎたら（now() を 15 秒進める）retryable: true・phase: prepare、R4 を呼ばない', async () => {
    const clock = createClock();
    const wait: FakeWait = {
      calls: [],
      wait: async (ms) => {
        wait.calls.push(ms);
        clock.advance(PREPARE_BUDGET_MS);
      },
    };

    const outcome = await run({ ...withRoutes({ R3: status('IN_PROGRESS') }), clock, wait });

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(outcome.fake.of('R3').length).toBeLessThan(POLL_MAX_ROUNDS);
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#65 P3 FINISHED になった時点で残りが PUBLISH_REQUEST_TIMEOUT_MS 未満なら retryable: true・phase: prepare、R4 を呼ばない', async () => {
    const clock = createClock();
    const fake = createFakeThreads({
      R3: ({ targetId }) => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - PUBLISH_REQUEST_TIMEOUT_MS + 1);
        return containerStatus('FINISHED', targetId);
      },
    });

    const outcome = await run({ fake, clock });

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(fake.of('R4')).toHaveLength(0);
  });

  it('#65 P3 carousel の子の確認の後で準備期限を過ぎていたら、R2 を呼ばず retryable: true・phase: prepare', async () => {
    const clock = createClock();
    const fake = createFakeThreads({
      R3: ({ targetId }) => {
        clock.set(START + PREPARE_BUDGET_MS);
        return containerStatus('FINISHED', targetId);
      },
    });

    const outcome = await run({ fake, clock, post: postView({ media: mediaOf(2) }) });

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(fake.of('R2')).toHaveLength(0);
    expect(fake.of('R4')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #79 境界（>= と > の取り違えはここでしか落ちない）                                  */
/* -------------------------------------------------------------------------- */

describe('#79 準備期限と R4 の残りのちょうどの境界（§6.8）', () => {
  /** R3 の 1 回目で時計を `elapsed` へ動かし、1 回目は IN_PROGRESS、2 回目以降は FINISHED を返す。 */
  async function pollingWithElapsed(elapsed: number): Promise<RunResult> {
    const clock = createClock();
    const wait: FakeWait = {
      calls: [],
      // 待ちは時計を動かさない（境界を R3 の側で決める）。
      wait: async (ms) => {
        wait.calls.push(ms);
      },
    };
    const fake = createFakeThreads({
      R3: ({ index, targetId }) => {
        if (index === 0) {
          clock.set(START + elapsed);
          return containerStatus('IN_PROGRESS', targetId);
        }
        return containerStatus('FINISHED', targetId);
      },
    });
    return await run({ fake, clock, wait });
  }

  it('#79 経過がちょうど PREPARE_BUDGET_MS なら次の round を始めない（retryable: true・phase: prepare）', async () => {
    const outcome = await pollingWithElapsed(PREPARE_BUDGET_MS);

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(outcome.fake.of('R3')).toHaveLength(1);
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#79 経過が PREPARE_BUDGET_MS より 1ms 短ければ次の round を始める', async () => {
    const outcome = await pollingWithElapsed(PREPARE_BUDGET_MS - 1);

    expect(outcome.fake.of('R3')).toHaveLength(2);
    expect(outcome.result.ok).toBe(true);
  });

  async function finishingWithRemaining(remaining: number): Promise<RunResult> {
    const clock = createClock();
    const fake = createFakeThreads({
      R3: ({ targetId }) => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - remaining);
        return containerStatus('FINISHED', targetId);
      },
    });
    return await run({ fake, clock });
  }

  it('#79 残りがちょうど PUBLISH_REQUEST_TIMEOUT_MS なら R4 を送る', async () => {
    const outcome = await finishingWithRemaining(PUBLISH_REQUEST_TIMEOUT_MS);

    expect(outcome.fake.of('R4')).toHaveLength(1);
    expect(outcome.result.ok).toBe(true);
  });

  it('#79 残りが PUBLISH_REQUEST_TIMEOUT_MS に 1ms 足りなければ R4 を送らない（retryable: true・phase: prepare）', async () => {
    const outcome = await finishingWithRemaining(PUBLISH_REQUEST_TIMEOUT_MS - 1);

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P4 公開（R4）                                                             */
/* -------------------------------------------------------------------------- */

describe('P4 公開（§6.9。R4 の後は rateLimit だけが true）', () => {
  it.each([
    ['400 code 4', error({ code: 4 })],
    ['400 code 17', error({ code: 17 })],
    ['400 code 32', error({ code: 32 })],
    ['400 code 341', error({ code: 341 })],
    ['400 code 613', error({ code: 613 })],
    ['429', html(429)],
  ])('#65 P4 R4 が %s（rateLimit）なら retryable: true・phase: publish', async (_label, route) => {
    const outcome = await run(withRoutes({ R4: route }));

    expectFailure(outcome, { retryable: true, phase: 'publish' });
    expect(outcome.fake.of('R5')).toHaveLength(0);
  });

  /*
   * P4 の rateLimit は **4xx（429 を含む）で返ったときだけ** true（設計 §6.9。2026-09-24 に追記。検証の security 低-1）。
   * 5xx は本体にレート制限の code があっても「届いたか分からない」で false。書き込みの途中で落ちた 5xx が
   * レート制限の code を返すことを否定できず、true にすると二重投稿になりうる。
   */
  it.each([4, 17, 32, 341, 613])(
    '#65 P4 R4 が 500 で code %s（5xx のレート制限）なら retryable: false・phase: publish',
    async (code) => {
      const outcome = await run(withRoutes({ R4: error({ status: 500, code }) }));

      expectFailure(outcome, { retryable: false, phase: 'publish' });
      expect(outcome.fake.of('R5')).toHaveLength(0);
    },
  );

  it.each([
    ['502 code 4', error({ status: 502, code: 4 })],
    ['503 code 613', error({ status: 503, code: 613 })],
  ])(
    '#65 P4 R4 が %s（5xx のレート制限）なら retryable: false・phase: publish',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R4: route }));

      expectFailure(outcome, { retryable: false, phase: 'publish' });
    },
  );

  it('#65 P1（対の条件）R1 が 500 で code 4 なら、R4 を送る前なので retryable: true・phase: container', async () => {
    const outcome = await run(withRoutes({ R1: error({ status: 500, code: 4 }) }));

    expectFailure(outcome, { retryable: true, phase: 'container' });
  });

  it('#65 P4 R4 が 500 で code 4 なら、Retry-After があっても retryAfterMs を付けない', async () => {
    const outcome = await run(
      withRoutes({ R4: error({ status: 500, code: 4, headers: { 'retry-after': '30' } }) }),
    );

    expectFailure(outcome, { retryable: false, phase: 'publish' });
    expect(retryAfterOf(outcome.result)).toBeUndefined();
  });

  it.each([
    ['429（本体に code なし）', error({ status: 429 })],
    ['429 で code 4', error({ status: 429, code: 4 })],
    ['400 で code 4', error({ status: 400, code: 4 })],
    ['403 で code 613', error({ status: 403, code: 613 })],
  ])(
    '#65 P4 R4 が %s（4xx のレート制限）なら retryable: true・phase: publish',
    async (_label, route) => {
      const outcome = await run(withRoutes({ R4: route }));

      expectFailure(outcome, { retryable: true, phase: 'publish' });
    },
  );

  it.each([
    ['接続断（reject）', networkDown as Route],
    ['制限時間', timedOut as Route],
    ['500', html(500)],
    ['503', html(503)],
    ['302（3xx）', redirect(302)],
    ['400 code 190（token）', error({ code: 190 })],
    ['400 code 10（permission）', error({ code: 10 })],
    ['400 code 368（rejected）', error({ code: 368 })],
    ['400 code 506（rejected）', error({ code: 506 })],
    [
      '400 code 100 / is_transient（transient も true にしない）',
      error({ code: 100, isTransient: true }),
    ],
    ['400 code 100（その他の 4xx）', error({ code: 100 })],
    ['201（200 以外の 2xx）', plain(201, { id: MEDIA_ID })],
    ['202（200 以外の 2xx）', plain(202, { id: MEDIA_ID })],
    ['本体が HTML', html(200)],
    ['id が無い', plain(200, {})],
    ['id が null', plain(200, { id: null })],
    [
      '本体が 64 KiB を超える（1 MiB で終わる stream。id は形に合う）',
      endingOversized({ id: MEDIA_ID }),
    ],
  ])(
    '#65 P4 R4 が %s なら retryable: false・phase: publish、R5 も R6 も呼ばない',
    async (_label, route) => {
      const outcome = await run(
        withRoutes(
          { R4: route },
          { credential: credentialOf({ accessTokenExpiresAt: NEAR_EXPIRES_AT }) },
        ),
      );

      expectFailure(outcome, { retryable: false, phase: 'publish' });
      expect(outcome.fake.of('R5')).toHaveLength(0);
      expect(outcome.fake.of('R6')).toHaveLength(0);
    },
  );

  it('#65 P4 R4 がちょうど 64 KiB の 200（id が形に合う）なら読んで ok: true', async () => {
    const outcome = await run(
      withRoutes({
        R4: plain(
          200,
          JSON.parse(paddedJson(RESPONSE_BODY_MAX_BYTES, { id: MEDIA_ID })) as unknown,
        ),
      }),
    );

    expect(outcome.result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#65 P4 R4 の応答のヘッダを受け取った後、本体を読み切る前に合計の期限が発火すると retryable: false・phase: publish（二重投稿へ倒れない）', async () => {
    const probe = probeTimeouts();
    try {
      const inner = createFakeThreads();
      const fake: FakeThreads = {
        ...inner,
        fetch: (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const response = await inner.fetch(input, init);
          if (String(input).endsWith('/threads_publish')) {
            // ヘッダ（200）は受け取った。本体を読む前に合計の期限を発火させる。
            probe.fire(PUBLISH_TOTAL_BUDGET_MS);
          }
          return response;
        }) as typeof globalThis.fetch,
      };

      const outcome = await run({ fake });

      expectFailure(outcome, { retryable: false, phase: 'publish' });
      expect(inner.of('R5')).toHaveLength(0);
      expect(inner.of('R6')).toHaveLength(0);
    } finally {
      probe.restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §6.9 P5 公開の後（R5 / R6）                                                   */
/* -------------------------------------------------------------------------- */

describe('P5 公開の後（§6.9。ok: true を覆さない）', () => {
  it.each([
    ['500', error({ status: 500, code: 1 })],
    ['reject', networkDown as Route],
    ['制限時間', timedOut as Route],
    ['400 code 190', error({ code: 190 })],
    ['本体が HTML', html(200)],
    ['permalink が無い', plain(200, { id: MEDIA_ID })],
  ])(
    '#65 P5 R5 が %s でも ok: true のまま externalId を返し、externalUrl を付けない（phase: permalink）',
    async (_label, route) => {
      const { result, log } = await run(withRoutes({ R5: route }));

      expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
      expect(warnPhases(log)).toContain('permalink');
    },
  );

  it('#65 P5 R4 の後の残り時間が PERMALINK_TIMEOUT_MS 未満なら R5 を送らず、ok: true で externalId を返す', async () => {
    const clock = createClock();
    const fake = createFakeThreads({
      R4: () => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - PERMALINK_TIMEOUT_MS + 1);
        return threadsPublished();
      },
    });

    const { result } = await run({ fake, clock });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
    expect(fake.of('R5')).toHaveLength(0);
  });

  it('#65 P5 残りがちょうど PERMALINK_TIMEOUT_MS なら R5 を送る', async () => {
    const clock = createClock();
    const fake = createFakeThreads({
      R4: () => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - PERMALINK_TIMEOUT_MS);
        return threadsPublished();
      },
    });

    const { result } = await run({ fake, clock });

    expect(fake.of('R5')).toHaveLength(1);
    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it.each([
    ['500', error({ status: 500, code: 1 })],
    ['reject', networkDown as Route],
    ['400 code 190', error({ code: 190 })],
    ['429', html(429)],
  ])('#65 P5 R6 が %s でも ok: true のまま（phase: refresh）', async (_label, route) => {
    const { result, log } = await run(
      withRoutes(
        { R6: route },
        { credential: credentialOf({ accessTokenExpiresAt: NEAR_EXPIRES_AT }) },
      ),
    );

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(warnPhases(log)).toContain('refresh');
  });
});

/* -------------------------------------------------------------------------- */
/* どこでも：予期しない例外・input.signal（§6.9 / §6.11）                             */
/* -------------------------------------------------------------------------- */

describe('例外を投げない・input.signal（#69 / #71 / #72）', () => {
  it('#65 R4 を送る前の予期しない例外（注入した now() が入口で投げる）は retryable: true・phase: input', async () => {
    // 「R4 を送ったか」を 1 つの変数で持って分類する（設計 §6.9「どこでも」）。入口の時点のフェーズは input。
    const clock: Clock = {
      now: () => {
        throw new Error('時計が壊れた');
      },
      advance: () => {},
      set: () => {},
    };

    const outcome = await run({ clock });

    expectFailure(outcome, { retryable: true, phase: 'input' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#69 logger が投げても publish() は例外を投げず、成功は ok: true のまま', async () => {
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
      // R5 の失敗と延長で warn を出させる。
      fake: createFakeThreads({ R5: html(500) }),
      credential: credentialOf({ accessTokenExpiresAt: NEAR_EXPIRES_AT }),
    });

    expect(result.ok).toBe(true);
  });

  it('#69 logger が投げても、失敗は失敗として返る（例外を投げない）', async () => {
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

    const { result } = await run({ logger: throwing, fake: createFakeThreads({ R4: html(500) }) });

    expect(retryableOf(result)).toBe(false);
  });

  it.each(FAILURE_SCENARIOS.map((entry) => [entry.label, entry] as const))(
    '#69 %s でも publish() は例外を投げない',
    async (_label, entry) => {
      await expect(run(entry.options())).resolves.toBeDefined();
    },
  );

  it('#71 input.signal が既に abort 済みなら、fetch を 1 度も呼ばずに戻る', async () => {
    const controller = new AbortController();
    controller.abort();

    const { result, fake } = await run({ signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('#72 R4 の要求中に input.signal が発火したら、publish() はすぐ戻る', async () => {
    const controller = new AbortController();
    const fake = createFakeThreads({
      R4: () => {
        controller.abort();
        return hang();
      },
    });

    const { result } = await run({ fake, signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(fake.of('R4')[0]?.signal?.aborted).toBe(true);
    expect(fake.of('R5')).toHaveLength(0);
    expect(fake.of('R6')).toHaveLength(0);
  });

  it('#72 待ちの最中に input.signal が発火したら、R4 を呼ばずに戻る', async () => {
    const controller = new AbortController();
    const wait: FakeWait = {
      calls: [],
      wait: async (ms, signal) => {
        wait.calls.push(ms);
        controller.abort();
        await rejectOnAbort(signal);
      },
    };

    const { result, fake } = await run({
      ...withRoutes({ R3: status('IN_PROGRESS') }),
      wait,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(fake.of('R4')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.10 reason と logger に出るもの                                              */
/* -------------------------------------------------------------------------- */

describe('reason と logger（#73〜#78）', () => {
  /** `URLSearchParams` で符号化した形（`encodeURIComponent` と違い `~` `!` も符号化する）。 */
  function formEncoded(value: string): string {
    return new URLSearchParams({ v: value }).toString().slice(2);
  }

  /** その配信で使った資格情報から、reason に現れてはならない値（#73）。 */
  function forbiddenInReason(options: RunOptions): string[] {
    const credential = options.credential ?? credentialOf();
    const values = [credential['accessToken'], credential['threadsUserId']].filter(
      (value): value is string => typeof value === 'string' && value !== '',
    );
    return values.flatMap((value) => [
      value,
      encodeURIComponent(value),
      formEncoded(value),
      value.slice(0, 8),
    ]);
  }

  it.each(FAILURE_SCENARIOS.map((entry) => [entry.label, entry] as const))(
    '#73 %s の reason に accessToken / threadsUserId の値・符号化した値・先頭 8 文字が現れない',
    async (_label, entry) => {
      const options = entry.options();
      const reason = reasonOf((await run(options)).result);

      for (const value of forbiddenInReason(options)) {
        expect(reason).not.toContain(value);
      }
      expect(reason).not.toContain('graph.threads.net');
      expect(reason).not.toContain('access_token=');
    },
  );

  it.each(FAILURE_SCENARIOS.map((entry) => [entry.label, entry] as const))(
    '#78 %s の reason は空でない',
    async (_label, entry) => {
      const reason = reasonOf((await run(entry.options())).result);

      expect(reason.trim()).not.toBe('');
    },
  );

  it.each(['R1', 'R4'] as const)(
    '#74 %s が自由文に値と URL を混ぜたエラーを返しても、reason に message / error_user_msg / error_user_title / type / fbtrace_id が現れず、190 と 463 は現れる',
    async (at) => {
      const fake = createFakeThreads({
        [at]: ({ call }: RouteContext) => leakyError(call.url),
      });

      const { result } = await run({ fake });
      const reason = reasonOf(result);

      expect(reason).not.toContain(ACCESS_TOKEN);
      expect(reason).not.toContain(encodeURIComponent(ACCESS_TOKEN));
      expect(reason).not.toContain(ACCESS_TOKEN.slice(0, 8));
      expect(reason).not.toContain(THREADS_API_BASE_URL);
      expect(reason).not.toContain(LEAKY_ERROR_USER_TITLE);
      expect(reason).not.toContain('OAuthException');
      expect(reason).not.toContain(FBTRACE_ID);
      expect(reason).toContain('190');
      expect(reason).toContain('463');
    },
  );

  it('#74 R3 の URL（トークン入り）を混ぜたエラーを R3 が返しても reason に URL もトークンも現れない', async () => {
    const fake = createFakeThreads({ R3: ({ call }) => leakyError(call.url) });

    const reason = reasonOf((await run({ fake })).result);

    expect(reason).not.toContain(ACCESS_TOKEN);
    expect(reason).not.toContain(encodeURIComponent(ACCESS_TOKEN));
    expect(reason).not.toContain(formEncoded(ACCESS_TOKEN));
    expect(reason).not.toContain('graph.threads.net');
  });

  it.each([
    ['知らない code（987654）', { code: 987654 }, '987654'],
    ['知らない error_subcode（7654321）', { code: 100, subcode: 7654321 }, '7654321'],
    ['文字列の code（"190"）', { code: '190' }, '190'],
    ['文字列の code（"<script>"）', { code: '<script>' }, '<script>'],
    ['文字列の error_subcode（"463"）', { code: 190, subcode: '463' }, '463'],
  ] as const)('#75 %s は reason に現れず unknown と書かれる', async (_label, example, value) => {
    const outcome = await run(withRoutes({ R1: error(example) }));
    const reason = reasonOf(outcome.result);

    expect(reason).not.toContain(value);
    expect(reason).toContain('unknown');
    expect(warnPhases(outcome.log)).toContain('container');
  });

  it('#75 文字列の code "190" を token として扱わない（数値に直さない）', async () => {
    const outcome = await run(withRoutes({ R1: error({ code: '190' }) }));

    expectFailure(outcome, { retryable: false, phase: 'container' });
    expect(reasonOf(outcome.result)).not.toContain('発行し直し');
  });

  it('#75 数値でない code はログにも出ない', async () => {
    const outcome = await run(withRoutes({ R1: error({ code: '<script>' }) }));

    expect(JSON.stringify(outcome.log)).not.toContain('<script>');
  });

  it('#76 R3 の応答の error_message（自由文）は reason にもログにも現れない', async () => {
    const secret = 'Zq-秘密の自由文 image_url=https://private.example/x.jpg';
    const outcome = await run(
      withRoutes({
        R3: ({ targetId }) => ({
          status: 200,
          body: { status: 'ERROR', error_message: secret, id: targetId },
        }),
      }),
    );

    expectFailure(outcome, { retryable: false, phase: 'status' });
    expect(reasonOf(outcome.result)).not.toContain('Zq-秘密の自由文');
    expect(JSON.stringify(outcome.log)).not.toContain('Zq-秘密の自由文');
  });

  it('#76 R3 は error_message を要求しない（fields=status だけ）', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });

    for (const call of fake.of('R3')) {
      expect(new URL(call.url).searchParams.get('fields')).toBe('status');
    }
  });

  /** ログに出てはならない値（#77）。**要求の URL・本体の断片を含む。** */
  const FORBIDDEN_IN_LOG: readonly string[] = [
    ACCESS_TOKEN,
    encodeURIComponent(ACCESS_TOKEN),
    formEncoded(ACCESS_TOKEN),
    ACCESS_TOKEN.slice(0, 8),
    THREADS_USER_ID,
    EXPIRES_AT,
    NEAR_EXPIRES_AT,
    REFRESHED_ACCESS_TOKEN,
    encodeURIComponent(REFRESHED_ACCESS_TOKEN),
    formEncoded(REFRESHED_ACCESS_TOKEN),
    BODY,
    LINK,
    ALT,
    mediaUrlOf(0),
    mediaUrlOf(1),
    mediaUrlOf(2),
    CONTAINER_ID,
    childContainerId(0),
    childContainerId(1),
    childContainerId(2),
    CAROUSEL_CONTAINER_ID,
    MEDIA_ID,
    PERMALINK,
    'graph.threads.net',
    'access_token=',
    'creation_id=',
    'media_type=',
    'An error occurred.',
    'OAuthException',
    LEAKY_ERROR_USER_TITLE,
    'yamada.example',
    'fetch failed',
  ];

  function expectCleanLog(log: readonly LogEntry[]): void {
    const text = JSON.stringify(
      log.map((entry) => ({ message: entry.message, fields: entry.fields })),
    );
    for (const value of FORBIDDEN_IN_LOG) {
      expect(text, value).not.toContain(value);
    }
  }

  it.each(FAILURE_SCENARIOS.map((entry) => [entry.label, entry] as const))(
    '#77 %s のログ（message と fields）に秘匿すべき値が現れない',
    async (_label, entry) => {
      expectCleanLog((await run(entry.options())).log);
    },
  );

  it('#77 正常系（carousel・alt・link・延長あり）のログにも秘匿すべき値が現れない', async () => {
    const { result, log } = await run({
      post: postView({ media: mediaOf(3, ALT), link: LINK }),
      credential: credentialOf({ accessTokenExpiresAt: NEAR_EXPIRES_AT }),
    });

    expect(result.ok && result.rotatedCredential).toBeTruthy();
    expectCleanLog(log);
  });

  it.each([
    ['R6 が 400', { R6: error({ code: 190 }) }],
    ['R6 が reject（文面に URL）', { R6: leakyNetworkDown }],
    ['R5 が 500', { R5: html(500) }],
    ['R5 が reject（文面に URL）', { R5: leakyNetworkDown }],
    ['R4 の id が形に合わない', { R4: (() => threadsPublished('123/../456')) as Route }],
    ['R1 が自由文に値を混ぜる', { R1: (({ call }) => leakyError(call.url)) as Route }],
    ['R4 が自由文に値を混ぜる', { R4: (({ call }) => leakyError(call.url)) as Route }],
  ] as const)('#77 %s のログにも秘匿すべき値が現れない', async (_label, routes) => {
    const { log } = await run(
      withRoutes(routes, { credential: credentialOf({ accessTokenExpiresAt: NEAR_EXPIRES_AT }) }),
    );

    expectCleanLog(log);
  });

  it('#78 fbtrace_id が形に合えば logger の fields.fbtraceId に出て、reason には出ない', async () => {
    const outcome = await run(withRoutes({ R1: error({ code: 100, fbtraceId: FBTRACE_ID }) }));

    expect(outcome.log.some((entry) => entry.fields?.['fbtraceId'] === FBTRACE_ID)).toBe(true);
    expect(reasonOf(outcome.result)).not.toContain(FBTRACE_ID);
  });

  it.each([
    ['空白を含む', 'Zb a b'],
    ['65 文字', 'Zb'.padEnd(65, 'x')],
  ])('#78 fbtrace_id が%sならログにも reason にも出ない', async (_label, fbtraceId) => {
    const outcome = await run(withRoutes({ R1: error({ code: 100, fbtraceId }) }));

    expect(
      outcome.log.some((entry) => entry.fields !== undefined && 'fbtraceId' in entry.fields),
    ).toBe(false);
    expect(JSON.stringify(outcome.log)).not.toContain(fbtraceId);
    expect(reasonOf(outcome.result)).not.toContain(fbtraceId);
  });

  it.each([
    ['R1', { R1: error({ code: 190 }) }, 'container'],
    ['R3', { R3: error({ code: 190 }) }, 'status'],
    ['R4', { R4: error({ code: 190 }) }, 'publish'],
  ] as const)(
    '#78 %s の token（190）の reason に「発行し直し」と「資格情報を設定」が現れる',
    async (_label, routes, phase) => {
      const outcome = await run(withRoutes(routes));
      const reason = reasonOf(outcome.result);

      expectFailure(outcome, { retryable: false, phase });
      expect(reason).toContain('発行し直し');
      expect(reason).toContain('資格情報を設定');
    },
  );

  it('#78 ERROR の reason に「JPEG」が現れる', async () => {
    const outcome = await run(withRoutes({ R3: status('ERROR') }));

    expectFailure(outcome, { retryable: false, phase: 'status' });
    expect(reasonOf(outcome.result)).toContain('JPEG');
  });

  it('#78 準備期限（POLL_MAX_ROUNDS）の reason に「公開はしていません」が現れる', async () => {
    const outcome = await run(withRoutes({ R3: status('IN_PROGRESS') }));

    expectFailure(outcome, { retryable: true, phase: 'prepare' });
    expect(reasonOf(outcome.result)).toContain('公開はしていません');
  });

  it('#78 準備期限（now() が過ぎる）の reason に「公開はしていません」が現れる', async () => {
    const clock = createClock();
    const wait: FakeWait = {
      calls: [],
      wait: async (ms) => {
        wait.calls.push(ms);
        clock.advance(PREPARE_BUDGET_MS);
      },
    };

    const outcome = await run({ ...withRoutes({ R3: status('IN_PROGRESS') }), clock, wait });

    expect(reasonOf(outcome.result)).toContain('公開はしていません');
  });

  it.each([
    ['500', html(500)],
    ['reject', networkDown as Route],
    ['制限時間', timedOut as Route],
    ['本体が HTML', html(200)],
    ['id が無い', plain(200, {})],
    ['201', plain(201, { id: MEDIA_ID })],
  ])('#78 P4 の結果不明（R4 が %s）の reason に「確かめて」が現れる', async (_label, route) => {
    const outcome = await run(withRoutes({ R4: route }));

    expectFailure(outcome, { retryable: false, phase: 'publish' });
    expect(reasonOf(outcome.result)).toContain('確かめて');
  });
});

/* -------------------------------------------------------------------------- */
/* §10.11 制限時間の結線（#80 / #81 / #82 / #83）                                    */
/* -------------------------------------------------------------------------- */

interface ProbedTimeout {
  readonly ms: number;
  readonly controller: AbortController;
}

/**
 * `AbortSignal.timeout` を差し替え、**作られた順に ms と controller を記録する**（実装プラン §2）。
 *
 * 返す signal は実時間では発火しない（テストが controller で手動で発火させる）。
 * **生成 1 回ごとに** controller を作る（ms ごとではない）。R1 / R2 / R4（10 秒）と R5 / R6（3 秒）は
 * 値が同じなので、値の一致だけでは結線を確かめられない（設計 §6.8）。
 * **必ず `restore()` を `finally` で呼ぶ**（戻し忘れると後続のテストが道連れになる）。
 */
interface TimeoutProbe {
  readonly created: ProbedTimeout[];
  /** 最後に作られたもの（要求ごとの制限時間は `impl()` の直前に同期で作られる）。 */
  latest(): ProbedTimeout | undefined;
  /** 指定の ms で最初に作られたものを `TimeoutError` で発火させる。 */
  fire(ms: number): void;
  restore(): void;
}

function probeTimeouts(): TimeoutProbe {
  const original = AbortSignal.timeout.bind(AbortSignal);
  const created: ProbedTimeout[] = [];
  AbortSignal.timeout = ((ms: number): AbortSignal => {
    const controller = new AbortController();
    created.push({ ms, controller });
    return controller.signal;
  }) as typeof AbortSignal.timeout;
  return {
    created,
    latest: () => created[created.length - 1],
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

interface WiredPair {
  readonly url: string;
  readonly timeoutMs: number | undefined;
  readonly controller: AbortController | undefined;
  readonly signal: AbortSignal | undefined;
}

/** URL を比べられる形にする（クエリの並びを問わない）。 */
function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  const query = [...parsed.searchParams.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('&');
  return `${parsed.origin}${parsed.pathname}?${query}`;
}

describe('制限時間の結線（§6.8 / §10.11）', () => {
  it('#82 準備の期限 ＋ 公開の制限時間は合計の期限に収まる', () => {
    expect(PREPARE_BUDGET_MS + PUBLISH_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(
      PUBLISH_TOTAL_BUDGET_MS,
    );
  });

  it('#82 合計の期限は Core の 30 秒より 5 秒以上短い（Core の定数をテスト側で import して比べる）', () => {
    expect(PUBLISH_TOTAL_BUDGET_MS + 5_000).toBeLessThanOrEqual(PUBLISH_TIMEOUT_MS);
  });

  const versioned = (path: string): string =>
    `${THREADS_API_BASE_URL}/${THREADS_API_VERSION}/${path}`;
  const withToken = (base: string, query: Record<string, string>): string =>
    `${base}?${new URLSearchParams({ ...query, access_token: ACCESS_TOKEN }).toString()}`;

  /**
   * #80 の配信：画像 2 枚の carousel、延長あり（期限 29 日後）、子 0 の最初の R3 だけ IN_PROGRESS。
   * 要求ごとに「その直前に作られた `AbortSignal.timeout` の ms と controller」を組にする。
   */
  async function wiredCarousel(): Promise<{
    readonly probe: TimeoutProbe;
    readonly pairs: WiredPair[];
    readonly waits: number[];
    readonly result: PublishResult;
  }> {
    const probe = probeTimeouts();
    const pairs: WiredPair[] = [];
    try {
      let firstChild0Check = true;
      const fake = createFakeThreads({
        R3: ({ targetId }) => {
          if (targetId === childContainerId(0) && firstChild0Check) {
            firstChild0Check = false;
            return containerStatus('IN_PROGRESS', targetId);
          }
          return containerStatus('FINISHED', targetId);
        },
      });
      const watched = (async (input: unknown, init: RequestInit = {}): Promise<Response> => {
        // **呼ばれた瞬間の「直前に作られた ms」**。`await` を挟まずに作られていれば、この要求のもの。
        const latest = probe.latest();
        pairs.push({
          url: String(input),
          timeoutMs: latest?.ms,
          controller: latest?.controller,
          signal: init.signal ?? undefined,
        });
        return await fake.fetch(String(input), init);
      }) as typeof globalThis.fetch;
      const clock = createClock();
      const wait = createFakeWait(clock);

      const { result } = await run({
        fake: { ...fake, fetch: watched },
        clock,
        wait,
        post: postView({ media: mediaOf(2) }),
        credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
      });
      return { probe, pairs, waits: wait.calls, result };
    } finally {
      probe.restore();
    }
  }

  it('#80 画像 2 枚の carousel（延長あり）が最後まで通る', async () => {
    const { result } = await wiredCarousel();

    expect(result.ok).toBe(true);
    expect(result.ok && result.rotatedCredential !== undefined).toBe(true);
  });

  it('#80 要求の URL と渡った ms の組が、R1・R3・R2・R4・R5・R6 ごとに決めた定数と一致する', async () => {
    const { pairs } = await wiredCarousel();
    const key = (url: string, ms: number | undefined): string => `${normalizeUrl(url)} ${ms}`;

    expect(pairs.map((pair) => key(pair.url, pair.timeoutMs)).sort()).toEqual(
      [
        // 子 R1 × 2
        key(versioned(`${THREADS_USER_ID}/threads`), CREATE_CONTAINER_TIMEOUT_MS),
        key(versioned(`${THREADS_USER_ID}/threads`), CREATE_CONTAINER_TIMEOUT_MS),
        // 子の R3（round 1 で 2 本、round 2 で子 0 だけ）
        key(withToken(versioned(childContainerId(0)), { fields: 'status' }), STATUS_TIMEOUT_MS),
        key(withToken(versioned(childContainerId(1)), { fields: 'status' }), STATUS_TIMEOUT_MS),
        key(withToken(versioned(childContainerId(0)), { fields: 'status' }), STATUS_TIMEOUT_MS),
        // 親 R2
        key(versioned(`${THREADS_USER_ID}/threads`), CREATE_CONTAINER_TIMEOUT_MS),
        // 親の R3
        key(withToken(versioned(CAROUSEL_CONTAINER_ID), { fields: 'status' }), STATUS_TIMEOUT_MS),
        // R4
        key(versioned(`${THREADS_USER_ID}/threads_publish`), PUBLISH_REQUEST_TIMEOUT_MS),
        // R5
        key(withToken(versioned(MEDIA_ID), { fields: 'permalink' }), PERMALINK_TIMEOUT_MS),
        // R6（版の付かないパス）
        key(
          withToken(`${THREADS_API_BASE_URL}/refresh_access_token`, {
            grant_type: 'th_refresh_token',
          }),
          REFRESH_TIMEOUT_MS,
        ),
      ].sort(),
    );
  });

  it('#80 組にした制限時間は、実際にその要求の signal に混ぜられている（その controller だけで止まり、他は生きている）', async () => {
    // R1 / R2 / R4 と R5 / R6 は値が同じ。「直前に作られた」だけでなく、**その controller を発火させると
    // その要求の signal だけが止まる**ことを見る（発火の前に、先に発火させた分で止まっていないことも見る）。
    const { pairs } = await wiredCarousel();

    expect(pairs).toHaveLength(10);
    for (const pair of pairs) {
      expect(pair.signal?.aborted, pair.url).toBe(false);
      pair.controller?.abort(new DOMException('', 'TimeoutError'));
      expect(pair.signal?.aborted, pair.url).toBe(true);
    }
  });

  it('#80 publish() 全体に PUBLISH_TOTAL_BUDGET_MS、準備に PREPARE_BUDGET_MS が、どの要求よりも先に 1 度ずつ掛かる', async () => {
    const { probe, pairs } = await wiredCarousel();

    expect(probe.created.slice(0, 2).map((entry) => entry.ms)).toEqual([
      PUBLISH_TOTAL_BUDGET_MS,
      PREPARE_BUDGET_MS,
    ]);
    // 残りはすべて要求ごと（要求 1 本につき 1 つ）。
    expect(probe.created).toHaveLength(2 + pairs.length);
  });

  it('#80 合計の期限を発火させると、どの要求の signal も止まる（すべての要求の外側に混ぜてある）', async () => {
    const { probe, pairs } = await wiredCarousel();

    probe.created[0]?.controller.abort(new DOMException('', 'TimeoutError'));

    for (const pair of pairs) {
      expect(pair.signal?.aborted, pair.url).toBe(true);
    }
  });

  it('#80 準備の期限を発火させると、R1 / R2 / R3 の signal だけが止まる（R4 / R5 / R6 は準備の下に無い）', async () => {
    const { probe, pairs } = await wiredCarousel();

    probe.created[1]?.controller.abort(new DOMException('', 'TimeoutError'));

    for (const pair of pairs) {
      const path = new URL(pair.url).pathname;
      const underPrepare =
        path.endsWith('/threads') || new URL(pair.url).searchParams.get('fields') === 'status';
      expect(pair.signal?.aborted, pair.url).toBe(underPrepare);
    }
  });

  it('#80 wait に渡る値は POLL_INTERVAL_MS', async () => {
    const { waits } = await wiredCarousel();

    expect(waits).toEqual([POLL_INTERVAL_MS]);
  });

  it('#81 R4 の要求中に準備の期限（PREPARE_BUDGET_MS）が発火しても、R4 の signal は aborted にならない', async () => {
    const probe = probeTimeouts();
    let r4Aborted: boolean | undefined;
    try {
      const fake = createFakeThreads({
        R4: ({ call }) => {
          probe.fire(PREPARE_BUDGET_MS);
          r4Aborted = call.signal?.aborted;
          return threadsPublished();
        },
      });

      const { result } = await run({ fake });

      expect(r4Aborted).toBe(false);
      expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
      // 発火そのものは効いている：準備の signal の下にあった R1 / R3 の signal は止まっている。
      expect(fake.of('R1')[0]?.signal?.aborted).toBe(true);
      expect(fake.of('R3')[0]?.signal?.aborted).toBe(true);
    } finally {
      probe.restore();
    }
  });

  it('#81 R4 の要求中に合計の期限が発火すれば、R4 の signal は aborted になる（対の条件）', async () => {
    const probe = probeTimeouts();
    let r4Aborted: boolean | undefined;
    try {
      const fake = createFakeThreads({
        R4: ({ call }) => {
          probe.fire(PUBLISH_TOTAL_BUDGET_MS);
          r4Aborted = call.signal?.aborted;
          return threadsPublished();
        },
      });

      await run({ fake });

      expect(r4Aborted).toBe(true);
    } finally {
      probe.restore();
    }
  });

  type Phase = 'R1' | 'R3' | 'wait' | 'R4' | 'R5' | 'R6';

  /**
   * #83。指定のフェーズの要求（または待ち）を解決させず、飛んでいる最中に
   * **合計の期限（`PUBLISH_TOTAL_BUDGET_MS` の `AbortSignal.timeout`）を手で発火させる。**
   */
  async function fireTotalDuring(phase: Phase): Promise<{
    readonly outcome: RunResult;
    readonly inflight: readonly (AbortSignal | undefined)[];
  }> {
    const probe = probeTimeouts();
    const fireLater = (): void => {
      setTimeout(() => probe.fire(PUBLISH_TOTAL_BUDGET_MS), 0);
    };
    const hangAndFire =
      (fireAtIndex = 0): Route =>
      ({ index }) => {
        if (index === fireAtIndex) {
          fireLater();
        }
        return hang();
      };
    const waitSignals: AbortSignal[] = [];

    try {
      const routes: FakeThreadsOptions =
        phase === 'R1'
          ? // carousel の子 2 本が両方飛んでいるところで発火させる。
            { R1: hangAndFire(1) }
          : phase === 'wait'
            ? { R3: status('IN_PROGRESS') }
            : { [phase]: hangAndFire() };
      const fake = createFakeThreads(routes);
      const clock = createClock();
      const wait: FakeWait = {
        calls: [],
        wait: async (ms, signal) => {
          wait.calls.push(ms);
          waitSignals.push(signal);
          fireLater();
          await rejectOnAbort(signal);
        },
      };

      const outcome = await run({
        fake,
        clock,
        wait,
        ...(phase === 'R1' ? { post: postView({ media: mediaOf(2) }) } : {}),
        ...(phase === 'R6'
          ? { credential: credentialOf({ accessTokenExpiresAt: NEAR_EXPIRES_AT }) }
          : {}),
      });

      const inflight = phase === 'wait' ? waitSignals : fake.of(phase).map((call) => call.signal);
      return { outcome, inflight };
    } finally {
      probe.restore();
    }
  }

  it.each(['R1', 'R3', 'wait', 'R4', 'R5', 'R6'] as const)(
    '#83 %s の最中に合計の期限が発火すると、飛んでいる要求の signal がすべて aborted になり publish() が戻る',
    async (phase) => {
      const { inflight } = await fireTotalDuring(phase);

      expect(inflight.length).toBeGreaterThan(0);
      for (const signal of inflight) {
        expect(signal?.aborted).toBe(true);
      }
    },
  );

  it('#83 R1 の最中なら carousel の子 2 本がどちらも止まり、retryable: true（R4 を送っていない）', async () => {
    const { outcome, inflight } = await fireTotalDuring('R1');

    expect(inflight).toHaveLength(2);
    expectFailure(outcome, { retryable: true, phase: 'container' });
    expect(outcome.fake.of('R2')).toHaveLength(0);
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#83 R3 の最中なら retryable: true（R4 を送らない）', async () => {
    const { outcome } = await fireTotalDuring('R3');

    expectFailure(outcome, { retryable: true, phase: 'status' });
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#83 wait の最中なら retryable: true（R4 を送らない）', async () => {
    const { outcome } = await fireTotalDuring('wait');

    expect(retryableOf(outcome.result)).toBe(true);
    // 待ちはポーリングの一部。どちらのフェーズ名で出すかは設計が決めていない（status か prepare）。
    expect(warnPhases(outcome.log).some((phase) => phase === 'status' || phase === 'prepare')).toBe(
      true,
    );
    expect(outcome.fake.of('R4')).toHaveLength(0);
  });

  it('#83 R4 の最中なら retryable: false（届いたか分からない）', async () => {
    const { outcome } = await fireTotalDuring('R4');

    expectFailure(outcome, { retryable: false, phase: 'publish' });
    expect(outcome.fake.of('R5')).toHaveLength(0);
  });

  it('#83 R5 の最中なら ok: true のまま（externalUrl を付けない）', async () => {
    const { outcome } = await fireTotalDuring('R5');

    expect(outcome.result).toEqual({ ok: true, externalId: MEDIA_ID });
  });

  it('#83 R6 の最中なら ok: true のまま（rotatedCredential を付けない）', async () => {
    const { outcome } = await fireTotalDuring('R6');

    expect(outcome.result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });
});

/* -------------------------------------------------------------------------- */
/* 応答の本体は 64 KiB で打ち切る（§6.2。sendThreadsRequest）                          */
/* -------------------------------------------------------------------------- */

describe('応答の本体は 64 KiB で打ち切る（§6.2）', () => {
  const PATH = `/${THREADS_API_VERSION}/${THREADS_USER_ID}/threads`;

  /** 決まった応答を返す偽の fetch（本体は要求の signal と結びつける）。 */
  function replying(example: ThreadsResponseExample): typeof globalThis.fetch {
    return (async (_input: unknown, init: RequestInit = {}) =>
      toResponse(example, init.signal)) as typeof globalThis.fetch;
  }

  function send(impl: typeof globalThis.fetch): ReturnType<typeof sendThreadsRequest> {
    return sendThreadsRequest({
      impl,
      method: 'POST',
      path: PATH,
      form: { media_type: 'TEXT', text: BODY, access_token: ACCESS_TOKEN },
      timeoutMs: CREATE_CONTAINER_TIMEOUT_MS,
      signal: new AbortController().signal,
    });
  }

  function loose(outcome: unknown): Record<string, unknown> {
    return outcome as Record<string, unknown>;
  }

  it('上限は 64 KiB（65536 バイト）', () => {
    expect(RESPONSE_BODY_MAX_BYTES).toBe(64 * 1024);
  });

  it('ちょうど 64 KiB の 200 は JSON として読む（ok）', async () => {
    const body = paddedJson(RESPONSE_BODY_MAX_BYTES, { id: CONTAINER_ID });

    const outcome = loose(await send(replying({ status: 200, body })));

    expect(outcome['kind']).toBe('ok');
    expect(outcome['body']).toEqual(JSON.parse(body));
  });

  it('64 KiB を 1 バイト超える 200 は、JSON として正しくても読まない（malformed）', async () => {
    const outcome = loose(
      await send(
        replying({
          status: 200,
          body: paddedJson(RESPONSE_BODY_MAX_BYTES + 1, { id: CONTAINER_ID }),
        }),
      ),
    );

    expect(outcome['kind']).toBe('malformed');
  });

  it('上限は塊ごとではなく合計で数える（1 KiB ずつの塊で合計 65537 バイトは malformed）', async () => {
    const impl = (async () =>
      endingJsonResponse({
        extra: { id: CONTAINER_ID },
        totalBytes: RESPONSE_BODY_MAX_BYTES + 1,
      }).response) as typeof globalThis.fetch;

    const outcome = loose(await send(impl));

    expect(outcome['kind']).toBe('malformed');
  });

  it('上限を超えたら読むのをやめて stream を cancel する（1 MiB で終わる本体を読み切らない）', async () => {
    const { response, probe } = endingJsonResponse({ extra: { id: CONTAINER_ID } });
    const impl = (async () => response) as typeof globalThis.fetch;

    const outcome = loose(await send(impl));

    expect(outcome['kind']).toBe('malformed');
    expect(probe.cancelled).toBe(true);
    // 65 塊目で上限を超える。読み進めていない（先読みの 1〜2 塊を除く）。
    expect(probe.pulls).toBeLessThanOrEqual(RESPONSE_BODY_MAX_BYTES / 1024 + 3);
  });

  it('2xx 以外で 64 KiB を超える本体は読まない（code 4 が入っていても本体を持たない）', async () => {
    const body = paddedJson(RESPONSE_BODY_MAX_BYTES + 1, { error: { code: 4 } });

    const outcome = loose(await send(replying({ status: 400, body })));

    expect(outcome['kind']).toBe('http');
    expect(outcome['body']).toBeUndefined();
  });

  it('2xx 以外でちょうど 64 KiB なら本体を読む（code を分類に使える）', async () => {
    const body = paddedJson(RESPONSE_BODY_MAX_BYTES, { error: { code: 4 } });

    const outcome = loose(await send(replying({ status: 400, body })));

    expect(outcome['kind']).toBe('http');
    expect(outcome['body']).toEqual(JSON.parse(body));
  });
});
