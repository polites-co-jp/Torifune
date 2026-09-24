import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginLogger,
  PublishResult,
  PublisherRegistration,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTAINER_ID,
  IG_USER_ID,
  MEDIA_ID,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  REFRESHED_EXPIRES_IN,
  containerCreated,
  containerStatus,
  graphError,
  htmlPage,
  meUserId,
  meUserIdRaw,
  mediaPublished,
  permalinkOf,
  toResponse,
  tokenRefreshed,
  type GraphResponseExample,
} from '@/test-support/instagram-graph';
import {
  GRAPH_API_BASE_URL,
  GRAPH_API_VERSION,
  ME_TIMEOUT_MS,
  PREPARE_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
} from '../../../../plugins/sns-instagram/graph';
import { createInstagramPublisher } from '../../../../plugins/sns-instagram/social';
import { isAutoIgUserId } from '../../../../plugins/sns-instagram/token';

/**
 * Instagram 配信 Plugin：ユーザー ID の欄の `auto` を配信の入口で補う
 * （041-plugin-help-docs 設計 §6.4、ユーザー裁定 U1、受け入れ条件 #77〜#84・#86）。
 *
 * `igUserId` が `auto`（大文字・小文字は問わない）なら、準備の最初に R0
 * （`GET https://graph.instagram.com/v26.0/me?fields=user_id`）を送り、得た数字の ID で R1 以降を送る。
 * 公開に成功したときだけ、得た ID を `rotatedCredential` で書き戻す。
 *
 * **実際の Instagram を叩かない。** 口は `createInstagramPublisher({ fetch, now, wait })` で、
 * 偽の Graph API・可変の時計・即座に解決する待ちを注入する。偽の応答の形は
 * `test-support/instagram-graph.ts` から取る（R0 の応答は `meUserId` / `meUserIdRaw`）。
 *
 * 注：
 * - ファイル名を `sns-instagram` で始めない（既存の静的検査がテストの本数を名前の一覧で固定している。
 *   041 実装プラン §8 の 19）。そのため偽の Graph API は既存のテストから写し、共有しない
 * - `beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換え、`afterEach` で戻す
 *   （本物の `fetch` を外へ出さない。`038` #97 の流儀をこのファイルでも守る）
 * - 資格情報のトークンに `torifune` を含めない（041 実装プラン §8 の 23）
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** 時計の起点。 */
const START = Date.parse('2026-09-23T12:00:00.000Z');

/** 資格情報のトークン（`auto` のアカウント）。**`torifune` を含めない。** */
const AUTO_TOKEN = 'IGAAautoUnitTestAccessToken7Kp2';

/** 設計 #77 の R0 の URL そのもの。 */
const ME_URL = 'https://graph.instagram.com/v26.0/me?fields=user_id';

/** 設計 §6.4.2 の新しい文言（`ID_UNRESOLVED_REASON`）。 */
const ID_UNRESOLVED_REASON =
  'Instagram のユーザー ID を自動で確かめられませんでした。「資格情報を設定」で、ユーザー ID の欄に数字だけの ID を入れてください。';

/** 応答の本体に混ぜる目印。`reason` にもログにも出てはならない（#82）。 */
const BODY_MARKER = 'ME-BODY-MARKER-9Z';

function graph(path: string): string {
  return `${GRAPH_API_BASE_URL}/${GRAPH_API_VERSION}/${path}`;
}

function isoDaysFrom(base: number, days: number): string {
  return new Date(base + days * DAY_MS).toISOString();
}

/** 期限が十分先（40 日後）。**延長しない。** */
const FAR_EXPIRY = isoDaysFrom(START, 40);

/* -------------------------------------------------------------------------- */
/* 偽の Graph API（`sns-instagram-publish.test.ts` の作りを写し、R0 を足した）       */
/* -------------------------------------------------------------------------- */

type RequestKind = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

interface FakeCall {
  readonly kind: RequestKind;
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
  readonly redirect: RequestRedirect | undefined;
  readonly signal: AbortSignal | undefined;
}

interface RouteContext {
  readonly call: FakeCall;
  readonly index: number;
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

/** URL のパスとメソッドで R0〜R6 を見分ける。R0 は `GET /<版>/me`。 */
function kindOf(url: URL, method: string, form: URLSearchParams): RequestKind {
  if (url.pathname === '/refresh_access_token') {
    return 'R6';
  }
  const parts = url.pathname.split('/').filter((part) => part !== '');
  if (method === 'GET' && parts.length === 2 && parts[1] === 'me') {
    return 'R0';
  }
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
    case 'R0':
      return meUserId(IG_USER_ID);
    case 'R1':
      return containerCreated(CONTAINER_ID);
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
  const counters: Record<RequestKind, number> = {
    R0: 0,
    R1: 0,
    R2: 0,
    R3: 0,
    R4: 0,
    R5: 0,
    R6: 0,
  };

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
      targetId: url.pathname.split('/').filter((part) => part !== '')[1] ?? '',
    };
    const route = options[kind];
    const reply = await Promise.race([
      Promise.resolve(route === undefined ? defaultRoute(kind, context) : route(context)),
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

function only(fake: FakeGraph, kind: RequestKind): FakeCall {
  const found = fake.of(kind);
  if (found.length !== 1) {
    throw new Error(`${kind} がちょうど 1 本ではない（${found.length} 本）`);
  }
  return found[0] as FakeCall;
}

/** 要求が届かなかった（接続できない）。本物の `fetch` は `TypeError` で reject する。 */
function networkDown(): never {
  throw new TypeError('fetch failed');
}

/** 自前の制限時間に達した。本物の `fetch` は `TimeoutError` で reject する。 */
function timedOut(): never {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

/** 解決しない（signal の発火でだけ止まる）。 */
function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

const error =
  (example: Parameters<typeof graphError>[0]): Route =>
  () =>
    graphError(example);

const html =
  (status: number): Route =>
  () =>
    htmlPage(status);

/* -------------------------------------------------------------------------- */
/* 時計・待ち・ログ・制限時間の観測                                               */
/* -------------------------------------------------------------------------- */

interface Clock {
  readonly now: () => Date;
}

function createClock(start = START): Clock & { advance(ms: number): void } {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
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

interface ProbedTimeout {
  readonly ms: number;
  readonly controller: AbortController;
}

interface TimeoutProbe {
  readonly created: ProbedTimeout[];
  latest(): ProbedTimeout | undefined;
  fire(ms: number): void;
  restore(): void;
}

/** `AbortSignal.timeout` を差し替え、作られた制限時間を記録して手で発火できるようにする。 */
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

/* -------------------------------------------------------------------------- */
/* 入力と実行                                                                   */
/* -------------------------------------------------------------------------- */

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000b041',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000a041',
    body: '秋の新作が入りました',
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
    id: '0199aaaa-0000-7000-8000-00000000a041',
    provider: 'instagram',
    displayName: 'テストアカウント',
    handle: 'shop.example',
    status: 'active',
    credentialConfigured: true,
  };
}

/** `auto` の資格情報（期限は 40 日後で延長しない）。 */
function autoCredential(
  overrides: Partial<Record<'igUserId' | 'accessToken' | 'accessTokenExpiresAt', string>> = {},
): Record<string, string> {
  return {
    igUserId: 'auto',
    accessToken: AUTO_TOKEN,
    accessTokenExpiresAt: FAR_EXPIRY,
    ...overrides,
  };
}

/** 数字の ID の資格情報（041 より前の形）。 */
function numericCredential(
  overrides: Partial<Record<'igUserId' | 'accessToken' | 'accessTokenExpiresAt', string>> = {},
): Record<string, string> {
  return autoCredential({ igUserId: IG_USER_ID, ...overrides });
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
  readonly credential?: Record<string, string>;
  readonly post?: SocialPostView;
}

interface RunResult {
  readonly result: PublishResult;
  readonly fake: FakeGraph;
  readonly log: LogEntry[];
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const fake = options.fake ?? createFakeGraph();
  const clock = createClock();
  const { logger, entries } = captureLogger();
  const publish = publishOf(
    createInstagramPublisher({
      fetch: fake.fetch,
      now: clock.now,
      wait: async (ms, signal) => {
        if (signal.aborted) {
          throw signal.reason;
        }
        clock.advance(ms);
      },
    }),
  );
  const result = await publish({
    post: options.post ?? postView(),
    account: accountView(),
    credential: options.credential ?? autoCredential(),
    attempt: 1,
    signal: new AbortController().signal,
    logger,
  });
  return { result, fake, log: entries };
}

function withRoutes(routes: FakeGraphOptions, credential = autoCredential()): RunOptions {
  return { fake: createFakeGraph(routes), credential };
}

function failureOf(result: PublishResult): {
  readonly reason: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
} {
  if (result.ok) {
    throw new Error('失敗を期待したが成功した');
  }
  return result;
}

function rotatedOf(result: PublishResult): Readonly<Record<string, string>> | undefined {
  return result.ok ? result.rotatedCredential : undefined;
}

/* -------------------------------------------------------------------------- */
/* #77 R0 の要求と、得た ID の使い道                                              */
/* -------------------------------------------------------------------------- */

describe('#77 igUserId が auto なら、最初に R0（/me?fields=user_id）を送る', () => {
  it.each(['auto', 'AUTO', 'Auto'])('#77 %j → 最初の要求が R0', async (igUserId) => {
    const { fake } = await run({ credential: autoCredential({ igUserId }) });

    expect(fake.kinds()[0]).toBe('R0');
  });

  it('#77 R0 は GET https://graph.instagram.com/v26.0/me?fields=user_id ちょうど', async () => {
    const { fake } = await run();
    const call = only(fake, 'R0');

    expect(call.method).toBe('GET');
    expect(call.url).toBe(ME_URL);
  });

  it('#77 R0 は Authorization: Bearer <accessToken> を持つ', async () => {
    const { fake } = await run();

    expect(only(fake, 'R0').headers.get('authorization')).toBe(`Bearer ${AUTO_TOKEN}`);
  });

  it('#77 R0 の URL に access_token もトークンの値も現れない', async () => {
    const { fake } = await run();
    const url = only(fake, 'R0').url;

    expect(url).not.toContain('access_token');
    expect(url).not.toContain(AUTO_TOKEN);
  });

  it("#77 R0 の redirect は 'manual'", async () => {
    const { fake } = await run();

    expect(only(fake, 'R0').redirect).toBe('manual');
  });

  it('#77 応答の user_id が R1 以降の URL の ID になり、公開まで進む', async () => {
    const { result, fake } = await run();

    expect(fake.kinds()).toEqual(['R0', 'R1', 'R3', 'R4', 'R5']);
    expect(only(fake, 'R1').url).toBe(graph(`${IG_USER_ID}/media`));
    expect(only(fake, 'R4').url).toBe(graph(`${IG_USER_ID}/media_publish`));
    expect(result.ok).toBe(true);
  });

  it('#77 R1 以降の要求のどこにも auto が現れない', async () => {
    const { fake } = await run();

    // 前提：R0 を送り、R1 以降まで進んでいる（素通りしない）。
    expect(fake.of('R0')).toHaveLength(1);
    expect(fake.of('R1')).toHaveLength(1);
    for (const call of fake.calls.filter((item) => item.kind !== 'R0')) {
      expect(call.url.toLowerCase()).not.toContain('/auto/');
    }
  });

  it('#77 R0 は 1 回の配信につき 1 回（画像 3 枚の carousel でも）', async () => {
    const { fake } = await run({
      post: postView({ media: [0, 1, 2].map((index) => ({ url: mediaUrl(index), alt: null })) }),
    });

    expect(fake.of('R0')).toHaveLength(1);
    expect(fake.kinds()[0]).toBe('R0');
    for (const call of [...fake.of('R1'), ...fake.of('R2')]) {
      expect(call.url).toBe(graph(`${IG_USER_ID}/media`));
    }
  });

  it('#77 auto の判定は /^auto$/i（isAutoIgUserId）', () => {
    for (const value of ['auto', 'AUTO', 'Auto', 'aUtO']) {
      expect(isAutoIgUserId(value), value).toBe(true);
    }
    for (const value of [' auto', 'auto ', 'automatic', 'au to', '', '17841400000000001']) {
      expect(isAutoIgUserId(value), JSON.stringify(value)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #78 公開に成功したときの書き戻し                                                */
/* -------------------------------------------------------------------------- */

describe('#78 auto を解決して公開に成功したら、rotatedCredential で書き戻す', () => {
  it('#78 延長の要らない期限（40 日後）→ 得た ID・入れたトークン・入れた期限の 3 項目ちょうど', async () => {
    const { result } = await run();

    expect(result).toStrictEqual({
      ok: true,
      externalId: MEDIA_ID,
      externalUrl: PERMALINK,
      rotatedCredential: {
        igUserId: IG_USER_ID,
        accessToken: AUTO_TOKEN,
        accessTokenExpiresAt: FAR_EXPIRY,
      },
    });
  });

  it('#78 資格情報に余計なキーがあっても書き戻しに写さない（キーはちょうど 3 つ）', async () => {
    const { result } = await run({ credential: { ...autoCredential(), extra: 'x-value' } });

    expect(Object.keys(rotatedOf(result) ?? {}).sort()).toEqual(
      ['accessToken', 'accessTokenExpiresAt', 'igUserId'].sort(),
    );
  });

  it.each([
    ['unknown', 'unknown'],
    ['29 日後', isoDaysFrom(START, 29)],
  ])(
    '#78 延長の要る期限（%s）で延長（R6）に失敗しても、得た ID と入れた値そのままを書き戻す',
    async (_label, expiresAt) => {
      const { result, fake } = await run(
        withRoutes(
          { R6: error({ code: 190 }) },
          autoCredential({ accessTokenExpiresAt: expiresAt }),
        ),
      );

      expect(fake.of('R6')).toHaveLength(1);
      expect(rotatedOf(result)).toStrictEqual({
        igUserId: IG_USER_ID,
        accessToken: AUTO_TOKEN,
        accessTokenExpiresAt: expiresAt,
      });
    },
  );

  it('#78 延長もした → igUserId は得た ID、accessToken / accessTokenExpiresAt は延長後の値（3 項目ちょうど）', async () => {
    const { result } = await run({
      credential: autoCredential({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });

    expect(rotatedOf(result)).toStrictEqual({
      igUserId: IG_USER_ID,
      accessToken: REFRESHED_ACCESS_TOKEN,
      accessTokenExpiresAt: new Date(START + REFRESHED_EXPIRES_IN * 1000).toISOString(),
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #79 数字の ID は 041 より前と同じ                                              */
/* -------------------------------------------------------------------------- */

describe('#79 igUserId が数字なら R0 を送らない（041 より前と同じ）', () => {
  it('#79 R1 → R3 → R4 → R5 で、延長しなければ rotatedCredential を返さない', async () => {
    const { result, fake } = await run({ credential: numericCredential() });

    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5']);
    expect(result).toStrictEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#79 延長したときの書き戻しは入れた数字の ID のまま（R0 を送らない）', async () => {
    const { result, fake } = await run({
      credential: numericCredential({ accessTokenExpiresAt: isoDaysFrom(START, 29) }),
    });

    expect(fake.of('R0')).toHaveLength(0);
    expect(rotatedOf(result)?.['igUserId']).toBe(IG_USER_ID);
  });
});

/* -------------------------------------------------------------------------- */
/* #80 R0 の失敗の分類                                                           */
/* -------------------------------------------------------------------------- */

describe('#80 R0 の失敗の retryable（R1 と同じ扱い）', () => {
  const failures: readonly (readonly [string, boolean, Route])[] = [
    ['接続できない', true, networkDown],
    ['制限時間', true, timedOut],
    ['HTTP 500', true, html(500)],
    ['HTTP 429', true, error({ status: 429 })],
    ['既知のレート制限のコード（code 4）', true, error({ code: 4 })],
    ['トークンの無効（code 190）', false, error({ code: 190, subcode: 463 })],
    ['権限の不足（code 10）', false, error({ code: 10 })],
  ];

  it.each(failures)('#80 R0 が %s → retryable: %s', async (_label, retryable, route) => {
    const { result, fake } = await run(withRoutes({ R0: route }));

    // 前提：R0 で失敗している（入口で断られたのではない）。
    expect(fake.of('R0')).toHaveLength(1);
    expect(failureOf(result).retryable).toBe(retryable);
  });

  it.each(failures)('#80 R0 が %s なら R1 以降を送らない', async (_label, _retryable, route) => {
    const { fake } = await run(withRoutes({ R0: route }));

    expect(fake.kinds()).toEqual(['R0']);
  });

  it('#80 429 に Retry-After: 30 があれば retryAfterMs が 30000', async () => {
    const { result } = await run(
      withRoutes({ R0: error({ status: 429, headers: { 'retry-after': '30' } }) }),
    );

    expect(failureOf(result).retryAfterMs).toBe(30_000);
  });

  it('#80 接続できない → reason に「接続できませんでした」', async () => {
    const { result } = await run(withRoutes({ R0: networkDown }));

    expect(failureOf(result).reason).toContain('接続できませんでした');
  });

  it('#80 HTTP 500 → reason に「一時的に応答できませんでした」', async () => {
    const { result } = await run(withRoutes({ R0: html(500) }));

    expect(failureOf(result).reason).toContain('一時的に応答できませんでした');
  });

  it('#80 トークンの無効（code 190）→ reason に「アクセストークンが無効か期限切れです」', async () => {
    const { result } = await run(withRoutes({ R0: error({ code: 190 }) }));

    expect(failureOf(result).reason).toContain('アクセストークンが無効か期限切れです');
  });

  it('#80 権限の不足（code 10）→ reason に「権限が足りません」', async () => {
    const { result } = await run(withRoutes({ R0: error({ code: 10 }) }));

    expect(failureOf(result).reason).toContain('権限が足りません');
  });

  /** 同じ応答を R0（auto）と R1（数字の ID）に返したときの分類が揃う（設計 §6.4.2「R1 と同じ扱い」）。 */
  const sameAsR1: readonly (readonly [string, Route])[] = [
    ['接続できない', networkDown],
    ['制限時間', timedOut],
    ['HTTP 500', html(500)],
    ['HTTP 503', html(503)],
    ['HTTP 429（Retry-After: 30）', error({ status: 429, headers: { 'retry-after': '30' } })],
    ['code 4（Retry-After: 5）', error({ code: 4, headers: { 'retry-after': '5' } })],
    ['transient（code 100 / is_transient）', error({ code: 100, isTransient: true })],
    ['code 190', error({ code: 190 })],
    ['code 10', error({ code: 10 })],
    ['HTTP 302', () => ({ status: 302, body: '', headers: { location: 'https://example.test/' } })],
    ['その他の 4xx（400 code 100）', error({ code: 100 })],
    ['HTTP 404', error({ status: 404, code: 100 })],
  ];

  it.each(sameAsR1)(
    '#80 R0 が %s のときの retryable / retryAfterMs は、R1 が同じ応答のときと同じ',
    async (_label, route) => {
      const r0 = await run(withRoutes({ R0: route }));
      const r1 = await run(withRoutes({ R1: route }, numericCredential()));
      const viaR0 = failureOf(r0.result);
      const viaR1 = failureOf(r1.result);

      // 前提：それぞれ R0 / R1 で失敗している。
      expect(r0.fake.kinds()).toEqual(['R0']);
      expect(r1.fake.kinds()).toEqual(['R1']);
      expect(viaR0.retryable).toBe(viaR1.retryable);
      expect(viaR0.retryAfterMs).toBe(viaR1.retryAfterMs);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #81 R0 の応答の形                                                             */
/* -------------------------------------------------------------------------- */

describe('#81 R0 の応答の形', () => {
  const malformed: readonly (readonly [string, GraphResponseExample])[] = [
    ['user_id が無い', { status: 200, body: { id: 'x' } }],
    ["user_id が ''", meUserId('')],
    ["user_id が 'abc'", meUserId('abc')],
    ["user_id が '@name'", meUserId('@name')],
    ['user_id が 65 桁の数字の文字列', meUserId('1'.repeat(65))],
    [
      'user_id が安全な整数を超える数値（17841400000000001 を JSON の number で）',
      meUserIdRaw('{"user_id":17841400000000001}'),
    ],
    [
      'user_id が安全な整数を 1 超える数値（9007199254740992）',
      meUserIdRaw('{"user_id":9007199254740992}'),
    ],
  ];

  it.each(malformed)(
    '#81 %s → retryable: false、reason が ID_UNRESOLVED_REASON ちょうど',
    async (_label, reply) => {
      const { result } = await run(withRoutes({ R0: () => reply }));

      expect(result).toStrictEqual({
        ok: false,
        retryable: false,
        reason: ID_UNRESOLVED_REASON,
      });
    },
  );

  it.each(malformed)('#81 %s → R1 を送らない', async (_label, reply) => {
    const { fake } = await run(withRoutes({ R0: () => reply }));

    expect(fake.kinds()).toEqual(['R0']);
  });

  it.each([
    ['安全な整数の数値（12345）', '12345', meUserIdRaw('{"user_id":12345}')],
    [
      '安全な整数の最大（9007199254740991）',
      '9007199254740991',
      meUserIdRaw('{"user_id":9007199254740991}'),
    ],
    ['64 桁の数字の文字列', '9'.repeat(64), meUserId('9'.repeat(64))],
  ])('#81 %s → 文字列 %s として R1 以降に使い、書き戻す', async (_label, expected, reply) => {
    const { result, fake } = await run(withRoutes({ R0: () => reply }));

    expect(only(fake, 'R1').url).toBe(graph(`${expected}/media`));
    expect(only(fake, 'R4').url).toBe(graph(`${expected}/media_publish`));
    expect(rotatedOf(result)?.['igUserId']).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* #82 reason とログに値を出さない                                                */
/* -------------------------------------------------------------------------- */

describe('#82 reason とログに、トークン・応答の本体・得た ID・/me の URL が現れない', () => {
  /** `/me` の URL の断片。`/media` とは区別する（`\b`）。 */
  function expectNoMeUrl(text: string): void {
    expect(text).not.toMatch(/\/me\b/);
    expect(text).not.toContain('fields=user_id');
    expect(text).not.toContain('graph.instagram.com');
    expect(text).not.toContain(ME_URL);
  }

  function expectClean(text: string, extra: readonly string[] = []): void {
    for (const value of [AUTO_TOKEN, IG_USER_ID, BODY_MARKER, ...extra]) {
      expect(text).not.toContain(value);
    }
    expectNoMeUrl(text);
  }

  const leakyError = (example: Parameters<typeof graphError>[0]): Route =>
    error({
      ...example,
      message: `${BODY_MARKER} ${AUTO_TOKEN} ${IG_USER_ID}`,
      errorUserMsg: BODY_MARKER,
      errorUserTitle: BODY_MARKER,
    });

  const scenarios: readonly (readonly [string, () => RunOptions, readonly string[]])[] = [
    ['成功', () => ({}), [JSON.stringify({ user_id: IG_USER_ID })]],
    [
      '成功（延長あり）',
      () => ({ credential: autoCredential({ accessTokenExpiresAt: isoDaysFrom(START, 10) }) }),
      [],
    ],
    ['R0 が接続できない', () => withRoutes({ R0: networkDown }), []],
    ['R0 が制限時間', () => withRoutes({ R0: timedOut }), []],
    ['R0 が 500', () => withRoutes({ R0: leakyError({ status: 500 }) }), []],
    ['R0 が 429', () => withRoutes({ R0: leakyError({ status: 429 }) }), []],
    ['R0 が code 190', () => withRoutes({ R0: leakyError({ code: 190 }) }), []],
    ['R0 が code 10', () => withRoutes({ R0: leakyError({ code: 10 }) }), []],
    [
      'R0 の user_id が形に合わない',
      () => withRoutes({ R0: () => meUserId(`@${BODY_MARKER}`) }),
      [`@${BODY_MARKER}`],
    ],
    [
      'R0 の user_id が 65 桁',
      () => withRoutes({ R0: () => meUserId('7'.repeat(65)) }),
      ['7'.repeat(65)],
    ],
    [
      'R0 の user_id が安全な整数を超える数値',
      () => withRoutes({ R0: () => meUserIdRaw('{"user_id":17841400000000001}') }),
      ['17841400000000000'],
    ],
    ['R0 の後の R1 が失敗', () => withRoutes({ R1: leakyError({ code: 100 }) }), []],
    ['R0 の後の R4 が失敗', () => withRoutes({ R4: html(500) }), []],
  ];

  it.each(scenarios)('#82 %s：reason に現れない', async (_label, options, extra) => {
    const { result, fake } = await run(options());

    // 前提：R0 を送っている（入口で断られて素通りしない）。
    expect(fake.of('R0')).toHaveLength(1);

    if (!result.ok) {
      expectClean(result.reason, extra);
    }
    // 成功の結果の外部の値（externalId / externalUrl）にも ID・トークンを載せない。
    if (result.ok) {
      expectClean(`${result.externalId ?? ''} ${result.externalUrl ?? ''}`, extra);
    }
  });

  it.each(scenarios)(
    '#82 %s：logger の message と fields に現れない',
    async (_label, options, extra) => {
      const { log, fake } = await run(options());

      expect(fake.of('R0')).toHaveLength(1);
      expect(log.length).toBeGreaterThan(0);
      expectClean(JSON.stringify(log.map((entry) => [entry.message, entry.fields])), extra);
    },
  );

  it("#82 成功時の 'instagram user id resolved' のログは 1 回で、fields に ID が無い", async () => {
    const { log } = await run();
    const resolved = log.filter((entry) => entry.message === 'instagram user id resolved');

    expect(resolved).toHaveLength(1);
    expect(JSON.stringify(resolved[0]?.fields ?? {})).not.toContain(IG_USER_ID);
  });

  it("#82 数字の ID の配信では 'instagram user id resolved' を出さない", async () => {
    const { log } = await run({ credential: numericCredential() });

    expect(log.some((entry) => entry.message === 'instagram user id resolved')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #83 R0 の制限時間                                                             */
/* -------------------------------------------------------------------------- */

describe('#83 R0 の制限時間（ME_TIMEOUT_MS）と準備の期限', () => {
  const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
  const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'sns-instagram');

  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        found.push(...sourceFiles(path));
      } else if (/\.tsx?$/.test(name)) {
        found.push(path);
      }
    }
    return found;
  }

  it('#83 ME_TIMEOUT_MS は 3000', () => {
    expect(ME_TIMEOUT_MS).toBe(3_000);
  });

  it('#83 ME_TIMEOUT_MS = 3_000 の定義は graph.ts の 1 か所だけ', () => {
    const definitions = sourceFiles(PLUGIN_DIR).flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(/\bME_TIMEOUT_MS\s*(?::[^=]+)?=(?!=)/g)].map(
        () => path,
      ),
    );

    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.endsWith('graph.ts')).toBe(true);
    expect(readFileSync(join(PLUGIN_DIR, 'graph.ts'), 'utf8')).toMatch(
      /export const ME_TIMEOUT_MS = 3_000;/,
    );
  });

  it('#83 制限時間は publish() 全体 → 準備 → R0（ME_TIMEOUT_MS）の順に作られる', async () => {
    const probe = probeTimeouts();
    try {
      await run();

      expect(probe.created.slice(0, 3).map((entry) => entry.ms)).toEqual([
        PUBLISH_TOTAL_BUDGET_MS,
        PREPARE_BUDGET_MS,
        ME_TIMEOUT_MS,
      ]);
    } finally {
      probe.restore();
    }
  });

  it('#83 R0 の要求の直前に作られた制限時間が ME_TIMEOUT_MS で、R0 の signal に混ぜられている', async () => {
    const probe = probeTimeouts();
    let latestMs: number | undefined;
    let latestController: AbortController | undefined;
    let r0Signal: AbortSignal | undefined;
    try {
      const fake = createFakeGraph({
        R0: ({ call }) => {
          latestMs = probe.latest()?.ms;
          latestController = probe.latest()?.controller;
          r0Signal = call.signal;
          return meUserId(IG_USER_ID);
        },
      });
      await run({ fake });

      expect(latestMs).toBe(ME_TIMEOUT_MS);
      expect(r0Signal?.aborted).toBe(false);
      latestController?.abort(new DOMException('', 'TimeoutError'));
      expect(r0Signal?.aborted).toBe(true);
    } finally {
      probe.restore();
    }
  });

  it('#83 R0 が ME_TIMEOUT_MS を超えて応答しない → retryable: true、R1 を送らない', async () => {
    const probe = probeTimeouts();
    try {
      const fake = createFakeGraph({
        R0: () => {
          setTimeout(() => probe.fire(ME_TIMEOUT_MS), 0);
          return hang();
        },
      });
      const { result } = await run({ fake });

      expect(failureOf(result).retryable).toBe(true);
      expect(fake.kinds()).toEqual(['R0']);
    } finally {
      probe.restore();
    }
  });

  it('#83 R0 は準備の signal の下で送る：準備の期限が発火すると R0 が止まり、retryable: true で R1 を送らない', async () => {
    const probe = probeTimeouts();
    let abortedAfterFire: boolean | undefined;
    try {
      const fake = createFakeGraph({
        R0: ({ call }) => {
          probe.fire(PREPARE_BUDGET_MS);
          abortedAfterFire = call.signal?.aborted;
          return hang();
        },
      });
      const { result } = await run({ fake });

      expect(abortedAfterFire).toBe(true);
      expect(failureOf(result).retryable).toBe(true);
      expect(fake.kinds()).toEqual(['R0']);
    } finally {
      probe.restore();
    }
  });

  it('#83 auto でも、publish() 全体・準備の期限の値は変わらず、要求 1 本につき制限時間は 1 つ', async () => {
    const probe = probeTimeouts();
    try {
      const { fake } = await run();

      expect(probe.created.filter((entry) => entry.ms === PUBLISH_TOTAL_BUDGET_MS)).toHaveLength(1);
      expect(probe.created).toHaveLength(2 + fake.calls.length);
    } finally {
      probe.restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #84 R0 の後の失敗                                                             */
/* -------------------------------------------------------------------------- */

describe('#84 R0 は成功したが R1〜R4 で失敗', () => {
  const later: readonly (readonly [string, FakeGraphOptions])[] = [
    ['R1 が 400 code 100', { R1: error({ code: 100 }) }],
    ['R1 が 503', { R1: html(503) }],
    ['R3 が ERROR', { R3: () => containerStatus('ERROR') }],
    ['R4 が 500', { R4: html(500) }],
  ];

  it.each(later)('#84 %s → ok: false で rotatedCredential のキーが無い', async (_label, routes) => {
    const { result, fake } = await run(withRoutes(routes));

    // 前提：R0 は成功し、その後の要求まで進んでいる。
    expect(fake.kinds()[0]).toBe('R0');
    expect(fake.kinds().length).toBeGreaterThan(1);
    expect(result.ok).toBe(false);
    expect(Object.keys(result)).not.toContain('rotatedCredential');
  });

  it.each(later)(
    '#84 %s の後、同じ資格情報でもう一度 publish() を呼ぶと、また最初に R0 を送る',
    async (_label, routes) => {
      const fake = createFakeGraph(routes);

      await run({ fake });
      const firstRun = fake.calls.length;
      await run({ fake });

      expect(fake.calls[0]?.kind).toBe('R0');
      expect(fake.calls[firstRun]?.kind).toBe('R0');
      expect(fake.of('R0')).toHaveLength(2);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #86 auto でも数字でもない値                                                    */
/* -------------------------------------------------------------------------- */

describe('#86 auto でも数字でもない値は従来どおり入口で断る', () => {
  /** 041 より前から CREDENTIAL_REASON で断られていた値（既存のテストの表の 1 つ）の reason。 */
  async function credentialReason(): Promise<string> {
    const { result } = await run({ credential: numericCredential({ igUserId: 'abc' }) });
    return failureOf(result).reason;
  }

  it.each(['@name', ' auto', 'auto ', 'automatic'])(
    '#86 %j → CREDENTIAL_REASON・retryable: false',
    async (igUserId) => {
      const expected = await credentialReason();
      const { result } = await run({ credential: autoCredential({ igUserId }) });

      expect(result).toStrictEqual({ ok: false, reason: expected, retryable: false });
    },
  );

  it.each(['@name', ' auto', 'auto ', 'automatic'])(
    '#86 %j → fetch を 1 度も呼ばない',
    async (igUserId) => {
      const { fake } = await run({ credential: autoCredential({ igUserId }) });

      expect(fake.calls).toHaveLength(0);
    },
  );
});
