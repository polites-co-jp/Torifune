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
  MEDIA_ID,
  OMIT_EXPIRES_IN,
  PERMALINK,
  REFRESHED_ACCESS_TOKEN,
  REFRESHED_EXPIRES_IN,
  THREADS_API_ORIGIN,
  THREADS_USER_ID,
  childContainerId,
  containerCreated,
  containerStatus,
  defaultThreadsReply,
  htmlPage,
  mediaIndexOf,
  mediaUrlOf,
  permalinkOf,
  redirectTo,
  targetIdOf,
  threadsError,
  threadsPublished,
  threadsRequestKind,
  toResponse,
  tokenRefreshed,
  type ThreadsRequestKind,
  type ThreadsResponseExample,
} from '@/test-support/threads-api';
import { createThreadsPublisher } from '../../../../plugins/sns-threads/social';
import {
  CAROUSEL_CHILD_CONCURRENCY,
  CREATE_CONTAINER_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  REFRESH_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  THREADS_API_BASE_URL,
  THREADS_API_VERSION,
  sendThreadsRequest,
} from '../../../../plugins/sns-threads/threads-api';

/**
 * Threads 配信 Plugin の `publish()`：正常系・ポーリング・carousel・トークンの延長・外部の文字列の形と長さ・
 * 自動と手動の本文の一致（040-sns-threads 設計 §6.1〜§6.7 / §10.1 / §10.6 #44 / §10.7 / §10.8 / §10.12）。
 * あわせて、1 本の要求を出して分類する関数 `sendThreadsRequest` の土台（実装プラン T10）を見る。
 *
 * **実際の Threads を叩かない。** 口は `createThreadsPublisher({ fetch, now, wait })` で、
 * このファイルは偽の Threads API・可変の時計・即座に解決する待ちを注入する（設計 §10.1）。
 * 偽の応答の形と要求の見分け方は `test-support/threads-api.ts` の 1 か所から取る（#93）。
 *
 * #107：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 * 差し替え忘れがあれば落ちる。**共有ヘルパにせず、このファイルに持つ**（実装プラン §2）。
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
  /** 本物の `fetch` と同じ規則で組んだ要求のヘッダ（本体から補われる `content-type` を含む）。 */
  readonly headers: Headers;
  /** POST の本体を form として読んだもの。GET は空。 */
  readonly form: URLSearchParams;
  /** 本体があったか（GET に本体を付けていないことを見る）。 */
  readonly hasBody: boolean;
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

type RouteReply = ThreadsResponseExample | Response;
type Route = (context: RouteContext) => RouteReply | Promise<RouteReply>;

type FakeThreadsOptions = Partial<Record<RequestKind, Route>>;

interface FakeThreads {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FakeCall[];
  kinds(): RequestKind[];
  of(kind: RequestKind): FakeCall[];
}

/** 本体を文字列として読む（本物の `fetch` と同じく、`URLSearchParams` はその文字列表現）。 */
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
  // form の本体（設計 §6.2）以外の形は、form としては読めない。
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

/**
 * 偽の Threads API。要求の列を記録し、URL のパスとメソッドで R1〜R6 を見分けて応答する。
 * **知らない宛先・知らない要求では投げる**（`threadsRequestKind`。#107）。
 */
function createFakeThreads(options: FakeThreadsOptions = {}): FakeThreads {
  const calls: FakeCall[] = [];
  const counters: Record<RequestKind, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 };

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const hasBody = init.body !== undefined && init.body !== null;
    // ヘッダは本物の `fetch` と同じ組み立て（`URLSearchParams` の本体なら content-type が補われる）。
    const request = new Request(url.href, {
      method,
      headers: init.headers,
      ...(hasBody ? { body: init.body } : {}),
    });
    const form = new URLSearchParams(bodyTextOf(init.body));
    const kind = threadsRequestKind(url, method, form);
    const call: FakeCall = {
      kind,
      url: url.href,
      method,
      headers: request.headers,
      form,
      hasBody,
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

function only(fake: FakeThreads, kind: RequestKind): FakeCall {
  const found = fake.of(kind);
  if (found.length !== 1) {
    throw new Error(`${kind} がちょうど 1 本ではない（${found.length} 本）`);
  }
  return found[0] as FakeCall;
}

/** form のキーの集合（並びを問わない）。 */
function keysOf(form: URLSearchParams): string[] {
  return [...new Set(form.keys())].sort();
}

/** クエリのキーの集合（並びを問わない）。 */
function queryKeysOf(url: string): string[] {
  return [...new Set(new URL(url).searchParams.keys())].sort();
}

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
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

function warnPhases(log: readonly LogEntry[]): unknown[] {
  return log.filter((entry) => entry.level === 'warn').map((entry) => entry.fields?.['phase']);
}

/* -------------------------------------------------------------------------- */
/* 入力                                                                         */
/* -------------------------------------------------------------------------- */

const BODY = '秋の新作マグカップが入荷しました Zp4-body #新作';
const LINK = 'https://shop.example/items/Lk9';

function isoDaysFrom(base: number, days: number): string {
  return new Date(base + days * DAY_MS).toISOString();
}

/** 既定はテキストだけの投稿（`media` なし）。 */
function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000d001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000d001',
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

function mediaOf(count: number): SocialPostView['media'] {
  return Array.from({ length: count }, (_, index) => ({ url: mediaUrlOf(index), alt: null }));
}

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000d001',
    provider: 'threads',
    displayName: '見本のアカウント',
    handle: 'yamada.example',
    status: 'active',
    credentialConfigured: true,
    ...overrides,
  };
}

/** 期限が十分先（40 日後）の資格情報。**延長しない。** */
function credentialOf(
  overrides: Partial<Record<'threadsUserId' | 'accessToken' | 'accessTokenExpiresAt', string>> = {},
  base = START,
): Record<string, string> {
  return {
    threadsUserId: THREADS_USER_ID,
    accessToken: ACCESS_TOKEN,
    accessTokenExpiresAt: isoDaysFrom(base, 40),
    ...overrides,
  };
}

/** 期限が 29 日後（延長する）。 */
function nearExpiry(): Record<string, string> {
  return credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 29) });
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
  readonly account?: SocialAccountView;
  readonly credential?: Record<string, string>;
  readonly signal?: AbortSignal;
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
  const { logger, entries } = captureLogger();
  const publish = publishOf(
    createThreadsPublisher({ fetch: fake.fetch, now: clock.now, wait: wait.wait }),
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
    const fake = createFakeThreads();
    globalThis.fetch = fake.fetch;
    const { logger } = captureLogger();

    const result = await publishOf(createThreadsPublisher())({
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

  it('#17 publish がある', () => {
    expect(typeof createThreadsPublisher().publish).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */
/* sendThreadsRequest：1 本の要求を出して分類する（実装プラン T10 / 設計 §6.2）         */
/* -------------------------------------------------------------------------- */

describe('sendThreadsRequest：要求の形と結果の分類（§6.2 / §6.11）', () => {
  interface Seen {
    readonly url: string;
    readonly init: RequestInit;
  }

  /** 決まった応答を返し、受け取った要求を記録する偽の fetch（本体は要求の signal と結びつける）。 */
  function replying(example: ThreadsResponseExample): {
    readonly impl: typeof globalThis.fetch;
    readonly seen: Seen[];
  } {
    const seen: Seen[] = [];
    const impl = (async (input: unknown, init: RequestInit = {}) => {
      seen.push({ url: String(input), init });
      return toResponse(example, init.signal);
    }) as typeof globalThis.fetch;
    return { impl, seen };
  }

  function rejecting(error: unknown): typeof globalThis.fetch {
    return (async () => {
      throw error;
    }) as typeof globalThis.fetch;
  }

  const STATUS_PATH = `/${THREADS_API_VERSION}/${CONTAINER_ID}`;
  const CREATE_PATH = `/${THREADS_API_VERSION}/${THREADS_USER_ID}/threads`;

  function getStatus(
    impl: typeof globalThis.fetch,
    signal: AbortSignal = new AbortController().signal,
  ): ReturnType<typeof sendThreadsRequest> {
    return sendThreadsRequest({
      impl,
      method: 'GET',
      path: STATUS_PATH,
      query: { fields: 'status', access_token: ACCESS_TOKEN },
      timeoutMs: STATUS_TIMEOUT_MS,
      signal,
    });
  }

  function postCreate(impl: typeof globalThis.fetch): ReturnType<typeof sendThreadsRequest> {
    return sendThreadsRequest({
      impl,
      method: 'POST',
      path: CREATE_PATH,
      form: { media_type: 'TEXT', text: BODY, access_token: ACCESS_TOKEN },
      timeoutMs: CREATE_CONTAINER_TIMEOUT_MS,
      signal: new AbortController().signal,
    });
  }

  /** 結果の中の文字列を残らず集める（Error の message・Headers の値・Response の url を含む）。 */
  function stringsIn(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value === 'string') {
      return [value];
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) {
      return [];
    }
    seen.add(value);
    const out: string[] = [];
    if (value instanceof Headers) {
      for (const [key, entry] of value.entries()) {
        out.push(key, entry);
      }
    }
    if (value instanceof Response) {
      out.push(value.url);
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      out.push(...stringsIn((value as Record<string, unknown>)[key], seen));
    }
    return out;
  }

  function loose(outcome: unknown): Record<string, unknown> {
    return outcome as Record<string, unknown>;
  }

  it('GET：宛先の起点と版の付いたパスに、クエリを付けて送る', async () => {
    const { impl, seen } = replying(containerStatus('FINISHED'));

    await getStatus(impl);

    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${THREADS_API_BASE_URL}${STATUS_PATH}`);
    expect(url.searchParams.get('fields')).toBe('status');
    expect(url.searchParams.get('access_token')).toBe(ACCESS_TOKEN);
    expect((seen[0]?.init.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('POST：form の本体（application/x-www-form-urlencoded）で送り、URL にクエリを付けない', async () => {
    const { impl, seen } = replying(containerCreated());

    await postCreate(impl);

    const init = seen[0]?.init ?? {};
    const request = new Request(seen[0]?.url ?? '', {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    expect(request.method).toBe('POST');
    expect(seen[0]?.url).toBe(`${THREADS_API_BASE_URL}${CREATE_PATH}`);
    expect(request.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    const form = new URLSearchParams(bodyTextOf(init.body));
    expect(form.get('media_type')).toBe('TEXT');
    expect(form.get('text')).toBe(BODY);
    expect(form.get('access_token')).toBe(ACCESS_TOKEN);
  });

  it("#54 redirect は 'manual'、authorization ヘッダを付けない、signal を渡す", async () => {
    const { impl, seen } = replying(containerCreated());

    await postCreate(impl);
    await getStatus(impl);

    for (const entry of seen) {
      expect(entry.init.redirect).toBe('manual');
      expect(new Headers(entry.init.headers).has('authorization')).toBe(false);
      expect(entry.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('200 で JSON なら ok で、本体を JSON として持つ', async () => {
    const outcome = loose(await getStatus(replying(containerStatus('FINISHED')).impl));

    expect(outcome['kind']).toBe('ok');
    expect(outcome['body']).toEqual({ status: 'FINISHED', id: CONTAINER_ID });
  });

  it.each([
    ['200 で本体が HTML', htmlPage(200)],
    ['201（200 以外の 2xx）', { status: 201, body: { id: CONTAINER_ID } }],
    ['202（200 以外の 2xx）', { status: 202, body: { id: CONTAINER_ID } }],
  ] as const)('%s は malformed', async (_label, example) => {
    const outcome = loose(await getStatus(replying(example).impl));

    expect(outcome['kind']).toBe('malformed');
  });

  it.each([
    ['302（追わない）', redirectTo()],
    ['400 の Graph API のエラー', threadsError({ code: 100 })],
    ['500 の HTML', htmlPage(500)],
  ] as const)('%s は http', async (_label, example) => {
    const outcome = loose(await getStatus(replying(example).impl));

    expect(outcome['kind']).toBe('http');
  });

  it('400 の Graph API のエラーは、分類に使えるよう本体を JSON として持つ', async () => {
    const outcome = loose(await getStatus(replying(threadsError({ code: 190 })).impl));

    expect(outcome['kind']).toBe('http');
    expect(outcome['body']).toEqual(threadsError({ code: 190 }).body);
  });

  it('接続できない（TypeError で reject）は network', async () => {
    const outcome = loose(await getStatus(rejecting(new TypeError('fetch failed'))));

    expect(outcome['kind']).toBe('network');
  });

  it('自前の制限時間（TimeoutError で reject）は timeout', async () => {
    const outcome = loose(
      await getStatus(
        rejecting(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      ),
    );

    expect(outcome['kind']).toBe('timeout');
  });

  it('呼び出し側の signal の abort（AbortError）は aborted', async () => {
    const controller = new AbortController();
    const hanging = (async (_input: unknown, init: RequestInit = {}) =>
      await rejectOnAbort(init.signal ?? undefined)) as typeof globalThis.fetch;
    setTimeout(() => controller.abort(), 0);

    const outcome = loose(await getStatus(hanging, controller.signal));

    expect(outcome['kind']).toBe('aborted');
  });

  it('例外を投げない（fetch が Response でない値を返しても結果を返す）', async () => {
    const broken = (async () => null) as unknown as typeof globalThis.fetch;

    await expect(getStatus(broken)).resolves.toBeDefined();
  });

  const SECRET_FRAGMENTS: readonly string[] = [
    ACCESS_TOKEN,
    encodeURIComponent(ACCESS_TOKEN),
    new URLSearchParams({ t: ACCESS_TOKEN }).toString().slice(2),
    'graph.threads.net',
    'access_token',
  ];

  it.each([
    [
      '接続できない（例外の文面に URL とトークンが入る）',
      rejecting(
        new TypeError(
          `fetch failed: ${THREADS_API_BASE_URL}${STATUS_PATH}?fields=status&access_token=${encodeURIComponent(ACCESS_TOKEN)}`,
        ),
      ),
    ],
    [
      '制限時間（例外の文面にトークンが入る）',
      rejecting(new DOMException(`timeout access_token=${ACCESS_TOKEN}`, 'TimeoutError')),
    ],
    ['200 で JSON', replying(containerStatus('FINISHED')).impl],
    ['400 の Graph API のエラー', replying(threadsError({ code: 190 })).impl],
    ['302', replying(redirectTo()).impl],
    ['200 で HTML', replying(htmlPage(200)).impl],
  ] as const)(
    '%s：結果に要求の URL・トークン・例外の文面を持たない（R3 の URL にはトークンが入る）',
    async (_label, impl) => {
      const strings = stringsIn(await getStatus(impl));

      for (const fragment of SECRET_FRAGMENTS) {
        for (const value of strings) {
          expect(value).not.toContain(fragment);
        }
      }
      for (const value of strings) {
        expect(value).not.toContain('fetch failed');
        expect(value).not.toContain('timeout access_token');
      }
    },
  );

  it('POST の結果にも要求の本体（トークン入りの form）を持たない', async () => {
    const strings = stringsIn(await postCreate(replying(threadsError({ code: 100 })).impl));

    for (const value of strings) {
      expect(value).not.toContain(ACCESS_TOKEN);
      expect(value).not.toContain('media_type=');
      expect(value).not.toContain(BODY);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §10.7 publish()：正常系                                                       */
/* -------------------------------------------------------------------------- */

describe('publish()：テキストだけ（#45）', () => {
  it('#45 R1 → R3 → R4 → R5 の順で送り、media ID と permalink を返す', async () => {
    const { result, fake } = await run();

    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5']);
    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
  });

  it('#45 R1 は media_type=TEXT と text=composeThreadsText（本文そのもの）を持つ', async () => {
    const { fake } = await run();
    const form = only(fake, 'R1').form;

    expect(form.get('media_type')).toBe('TEXT');
    expect(form.get('text')).toBe(BODY);
  });

  it('#45 R1 は image_url / is_carousel_item / link_attachment / alt_text / children を持たない', async () => {
    const { fake } = await run();

    // 設計 §6.3 の表の TEXT の行（media_type・text）と、認証（access_token。§6.2）だけ。
    expect(keysOf(only(fake, 'R1').form)).toEqual(['access_token', 'media_type', 'text']);
  });

  it('#45 R3 は作った container を、R4 はその container を、R5 は公開した media を指す', async () => {
    const { fake } = await run();

    expect(targetIdOf(new URL(only(fake, 'R3').url))).toBe(CONTAINER_ID);
    expect(only(fake, 'R4').form.get('creation_id')).toBe(CONTAINER_ID);
    expect(keysOf(only(fake, 'R4').form)).toEqual(['access_token', 'creation_id']);
    expect(targetIdOf(new URL(only(fake, 'R5').url))).toBe(MEDIA_ID);
  });

  it('#45 期限が 40 日後なら R6 を呼ばず、rotatedCredential を返さない', async () => {
    const { result, fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: isoDaysFrom(START, 40) }),
    });

    expect(fake.of('R6')).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(rotatedOf(result)).toBeUndefined();
  });

  it('#45 本文の前後の空白と改行は削らずに送る', async () => {
    const body = '  前後の空白も\n改行もそのまま  ';
    const { fake } = await run({ post: postView({ body }) });

    expect(only(fake, 'R1').form.get('text')).toBe(body);
  });
});

describe('publish()：画像 1 枚（#46）', () => {
  it('#46 R1 は media_type=IMAGE・image_url・text・alt_text を持ち、is_carousel_item を持たない', async () => {
    const alt = 'Alt9-店頭に並んだ新作のマグカップ';
    const { result, fake } = await run({
      post: postView({ media: [{ url: mediaUrlOf(0), alt }] }),
    });
    const form = only(fake, 'R1').form;

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5']);
    expect(form.get('media_type')).toBe('IMAGE');
    expect(form.get('image_url')).toBe(mediaUrlOf(0));
    expect(form.get('text')).toBe(BODY);
    expect(form.get('alt_text')).toBe(alt);
    expect(keysOf(form)).toEqual(['access_token', 'alt_text', 'image_url', 'media_type', 'text']);
  });

  it.each([
    ['null', null],
    ['空文字', ''],
  ] as const)('#46 alt が %s のときは alt_text のキーが無い', async (_label, alt) => {
    const { fake } = await run({ post: postView({ media: [{ url: mediaUrlOf(0), alt }] }) });
    const form = only(fake, 'R1').form;

    expect(form.has('alt_text')).toBe(false);
    expect(keysOf(form)).toEqual(['access_token', 'image_url', 'media_type', 'text']);
  });

  it('#46 R3 は作った container を、R4 の creation_id はその container', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(1) }) });

    expect(targetIdOf(new URL(only(fake, 'R3').url))).toBe(CONTAINER_ID);
    expect(only(fake, 'R4').form.get('creation_id')).toBe(CONTAINER_ID);
  });
});

describe('publish()：carousel（#47〜#49）', () => {
  const ALT_LEFT = 'Alt9-左の棚';
  const ALT_RIGHT = 'Alt9-右の棚';

  function threeImages(): SocialPostView['media'] {
    return [
      { url: mediaUrlOf(0), alt: ALT_LEFT },
      { url: mediaUrlOf(1), alt: null },
      { url: mediaUrlOf(2), alt: ALT_RIGHT },
    ];
  }

  it('#47 画像 3 枚：子 R1 × 3 → 子の R3 → 親 R2 → 親の R3 → R4 → R5 の順', async () => {
    const { result, fake } = await run({ post: postView({ media: threeImages() }) });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(fake.kinds()).toEqual(['R1', 'R1', 'R1', 'R3', 'R3', 'R3', 'R2', 'R3', 'R4', 'R5']);
  });

  it('#47 子の R1 は media_type=IMAGE・image_url・is_carousel_item=true を持ち、text を持たない', async () => {
    const { fake } = await run({ post: postView({ media: threeImages() }) });
    const children = fake.of('R1');

    expect(children.map((call) => call.form.get('image_url')).sort()).toEqual(
      [mediaUrlOf(0), mediaUrlOf(1), mediaUrlOf(2)].sort(),
    );
    for (const call of children) {
      expect(call.form.get('media_type')).toBe('IMAGE');
      expect(call.form.get('is_carousel_item')).toBe('true');
      expect(call.form.has('text')).toBe(false);
      expect(call.form.has('children')).toBe(false);
    }
  });

  it('#47 子の alt_text は alt があるものだけに付く', async () => {
    const { fake } = await run({ post: postView({ media: threeImages() }) });
    const byIndex = (index: number): URLSearchParams =>
      fake.of('R1').find((call) => mediaIndexOf(call.form.get('image_url')) === index)?.form ??
      new URLSearchParams();

    expect(byIndex(0).get('alt_text')).toBe(ALT_LEFT);
    expect(byIndex(1).has('alt_text')).toBe(false);
    expect(byIndex(2).get('alt_text')).toBe(ALT_RIGHT);
    expect(keysOf(byIndex(1))).toEqual([
      'access_token',
      'image_url',
      'is_carousel_item',
      'media_type',
    ]);
  });

  it('#47 子の R3 は子の container を 1 本ずつ見る', async () => {
    const { fake } = await run({ post: postView({ media: threeImages() }) });
    const firstChecks = fake.of('R3').slice(0, 3);

    expect(firstChecks.map((call) => targetIdOf(new URL(call.url))).sort()).toEqual(
      [childContainerId(0), childContainerId(1), childContainerId(2)].sort(),
    );
  });

  it('#47 親 R2 は media_type=CAROUSEL・media の順の子 ID のカンマ連結・text を持つ', async () => {
    const { fake } = await run({ post: postView({ media: threeImages() }) });
    const form = only(fake, 'R2').form;

    expect(form.get('media_type')).toBe('CAROUSEL');
    expect(form.get('children')).toBe(
      [childContainerId(0), childContainerId(1), childContainerId(2)].join(','),
    );
    expect(form.get('text')).toBe(BODY);
    expect(keysOf(form)).toEqual(['access_token', 'children', 'media_type', 'text']);
  });

  it('#47 親の R3 は親 container を見て、R4 の creation_id は親 ID', async () => {
    const { fake } = await run({ post: postView({ media: threeImages() }) });

    expect(targetIdOf(new URL(fake.of('R3')[3]?.url ?? ''))).toBe(CAROUSEL_CONTAINER_ID);
    expect(only(fake, 'R4').form.get('creation_id')).toBe(CAROUSEL_CONTAINER_ID);
  });

  it('#48 子の作成の応答が逆順に返っても、children は media の順', async () => {
    const pending: { readonly mediaIndex: number; readonly resolve: () => void }[] = [];
    const fake = createFakeThreads({
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

  /** 保留して同時本数を数える経路。 */
  function counting(reply: (context: RouteContext) => RouteReply): {
    readonly route: Route;
    readonly max: () => number;
  } {
    let inFlight = 0;
    let maxInFlight = 0;
    return {
      route: async (context) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        await flush();
        inFlight -= 1;
        return reply(context);
      },
      max: () => maxInFlight,
    };
  }

  it('#49 画像 10 枚で、同時に飛んでいる R1 は 5 本を超えず、並行に 5 本まで使う', async () => {
    const r1 = counting(({ mediaIndex }) => containerCreated(childContainerId(mediaIndex)));
    const fake = createFakeThreads({ R1: r1.route });

    const { result } = await run({ fake, post: postView({ media: mediaOf(10) }) });

    expect(result.ok).toBe(true);
    expect(fake.of('R1')).toHaveLength(10);
    expect(r1.max()).toBe(CAROUSEL_CHILD_CONCURRENCY);
  });

  it('#49 画像 10 枚で、同時に飛んでいる R3 は 5 本を超えず、並行に 5 本まで使う', async () => {
    const r3 = counting(({ targetId }) => containerStatus('FINISHED', targetId));
    const fake = createFakeThreads({ R3: r3.route });

    const { result } = await run({ fake, post: postView({ media: mediaOf(10) }) });

    expect(result.ok).toBe(true);
    // 子 10 本 ＋ 親 1 本。
    expect(fake.of('R3')).toHaveLength(11);
    expect(r3.max()).toBe(CAROUSEL_CHILD_CONCURRENCY);
  });
});

describe('publish()：ポーリング（#50 / #51）', () => {
  it('#50 R3 が IN_PROGRESS → IN_PROGRESS → FINISHED なら、R3 を 3 回・wait を POLL_INTERVAL_MS で 2 回呼んでから R4 へ進む', async () => {
    const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const fake = createFakeThreads({
      R3: ({ index, targetId }) => containerStatus(statuses[index] ?? 'FINISHED', targetId),
    });

    const { result, wait } = await run({ fake });

    expect(fake.of('R3')).toHaveLength(3);
    expect(wait.calls).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(fake.kinds()).toEqual(['R1', 'R3', 'R3', 'R3', 'R4', 'R5']);
    expect(result.ok).toBe(true);
  });

  it('#50 30 秒の固定の待ちが無い（wait に 30000 以上が渡らない）', async () => {
    const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const fake = createFakeThreads({
      R3: ({ index, targetId }) => containerStatus(statuses[index] ?? 'FINISHED', targetId),
    });

    const { wait } = await run({ fake, post: postView({ media: mediaOf(2) }) });

    for (const ms of wait.calls) {
      expect(ms).toBeLessThan(30_000);
    }
  });

  it('#51 R1 の直後の最初の R3 が FINISHED なら、wait を 1 度も呼ばない', async () => {
    const { wait, fake } = await run();

    expect(fake.kinds().slice(0, 2)).toEqual(['R1', 'R3']);
    expect(wait.calls).toEqual([]);
  });

  it('#51 carousel でも、どの R3 も最初から FINISHED なら wait を呼ばない', async () => {
    const { wait } = await run({ post: postView({ media: mediaOf(3) }) });

    expect(wait.calls).toEqual([]);
  });
});

describe('publish()：要求の形（#52〜#55）', () => {
  /** 6 種類の要求がすべて出る配信（画像 2 枚の carousel・期限 29 日後）。 */
  function everyKind(): Promise<RunResult> {
    return run({ post: postView({ media: mediaOf(2) }), credential: nearExpiry() });
  }

  it('#52 R1 / R2 / R4 は form の本体に access_token を持ち、URL に access_token が無い', async () => {
    const { fake } = await everyKind();
    const posts = fake.calls.filter((call) => ['R1', 'R2', 'R4'].includes(call.kind));

    expect(new Set(posts.map((call) => call.kind))).toEqual(new Set(['R1', 'R2', 'R4']));
    for (const call of posts) {
      expect(call.form.get('access_token')).toBe(ACCESS_TOKEN);
      expect(new URL(call.url).searchParams.has('access_token')).toBe(false);
      expect(call.url).not.toContain(ACCESS_TOKEN);
      expect(call.url).not.toContain(encodeURIComponent(ACCESS_TOKEN));
    }
  });

  it('#52 R3 / R5 / R6 は URL のクエリに access_token を持ち、本体を持たない', async () => {
    const { fake } = await everyKind();
    const gets = fake.calls.filter((call) => ['R3', 'R5', 'R6'].includes(call.kind));

    expect(new Set(gets.map((call) => call.kind))).toEqual(new Set(['R3', 'R5', 'R6']));
    for (const call of gets) {
      expect(new URL(call.url).searchParams.get('access_token')).toBe(ACCESS_TOKEN);
      expect(call.hasBody).toBe(false);
    }
  });

  it('#52 どの要求にも authorization ヘッダが無い', async () => {
    const { fake } = await everyKind();

    expect(new Set(fake.kinds())).toEqual(new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']));
    for (const call of fake.calls) {
      expect(call.headers.has('authorization')).toBe(false);
    }
  });

  it('#53 宛先は graph.threads.net の定数', () => {
    expect(THREADS_API_BASE_URL).toBe(THREADS_API_ORIGIN);
  });

  it('#53 R1 / R2 / R4 の URL は https://graph.threads.net/<THREADS_API_VERSION>/<threadsUserId>/…（クエリなし）', async () => {
    const { fake } = await everyKind();
    const base = `${THREADS_API_BASE_URL}/${THREADS_API_VERSION}/${THREADS_USER_ID}`;

    for (const call of fake.of('R1')) {
      expect(call.url).toBe(`${base}/threads`);
    }
    expect(only(fake, 'R2').url).toBe(`${base}/threads`);
    expect(only(fake, 'R4').url).toBe(`${base}/threads_publish`);
  });

  it('#53 R3 は版の付いた /<containerId> で、クエリは fields=status と access_token だけ（error_message を取らない）', async () => {
    const { fake } = await run();
    const call = only(fake, 'R3');

    expect(pathOf(call.url)).toBe(`${THREADS_API_BASE_URL}/${THREADS_API_VERSION}/${CONTAINER_ID}`);
    expect(new URL(call.url).searchParams.get('fields')).toBe('status');
    expect(call.url).not.toContain('error_message');
    expect(queryKeysOf(call.url)).toEqual(['access_token', 'fields']);
  });

  it('#53 R5 は版の付いた /<mediaId> で、クエリは fields=permalink と access_token だけ', async () => {
    const { fake } = await run();
    const call = only(fake, 'R5');

    expect(pathOf(call.url)).toBe(`${THREADS_API_BASE_URL}/${THREADS_API_VERSION}/${MEDIA_ID}`);
    expect(new URL(call.url).searchParams.get('fields')).toBe('permalink');
    expect(queryKeysOf(call.url)).toEqual(['access_token', 'fields']);
  });

  it('#53 R6 は版の付かない https://graph.threads.net/refresh_access_token で、grant_type=th_refresh_token', async () => {
    const { fake } = await run({ credential: nearExpiry() });
    const call = only(fake, 'R6');

    expect(pathOf(call.url)).toBe(`${THREADS_API_BASE_URL}/refresh_access_token`);
    expect(new URL(call.url).searchParams.get('grant_type')).toBe('th_refresh_token');
    expect(queryKeysOf(call.url)).toEqual(['access_token', 'grant_type']);
  });

  it('#53 R1 / R2 / R4 は POST、R3 / R5 / R6 は GET', async () => {
    const { fake } = await everyKind();

    for (const call of fake.calls) {
      expect(call.method, call.kind).toBe(['R1', 'R2', 'R4'].includes(call.kind) ? 'POST' : 'GET');
    }
  });

  it('#53 POST の content-type は application/x-www-form-urlencoded', async () => {
    const { fake } = await everyKind();
    const posts = fake.calls.filter((call) => call.method === 'POST');

    expect(posts.map((call) => call.kind).sort()).toEqual(['R1', 'R1', 'R2', 'R4']);
    for (const call of posts) {
      expect(call.headers.get('content-type')).toMatch(/^application\/x-www-form-urlencoded/);
    }
  });

  it("#54 すべての要求の redirect が 'manual'", async () => {
    const { fake } = await everyKind();

    expect(new Set(fake.kinds())).toEqual(new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']));
    for (const call of fake.calls) {
      expect(call.redirect, call.kind).toBe('manual');
    }
  });

  it('#55 account の値を変えても要求は変わらない（account.handle を使わない）', async () => {
    const snapshot = (fake: FakeThreads): unknown =>
      fake.calls.map((call) => ({
        url: call.url,
        method: call.method,
        headers: [...call.headers.entries()],
        form: call.form.toString(),
      }));

    const first = await run({ account: accountView() });
    const second = await run({
      account: accountView({
        id: '0199aaaa-0000-7000-8000-00000000d999',
        handle: 'someone-else.example',
        displayName: '別の名前',
      }),
    });

    expect(snapshot(second.fake)).toEqual(snapshot(first.fake));
    for (const call of first.fake.calls) {
      expect(call.url).not.toContain('yamada.example');
      expect(call.form.toString()).not.toContain('yamada.example');
    }
  });

  it('#55 threads_publishing_limit も /me も呼ばない', async () => {
    const { fake } = await everyKind();

    for (const call of fake.calls) {
      expect(call.url).not.toContain('threads_publishing_limit');
      expect(new URL(call.url).pathname.split('/')).not.toContain('me');
    }
  });

  it('#55 媒体の URL へは要求を出さない（Meta が取りに行く）', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(3) }) });

    for (const call of fake.calls) {
      expect(new URL(call.url).origin).toBe(THREADS_API_ORIGIN);
    }
  });
});

describe('publish()：link（#56）', () => {
  const composed = `${BODY}\n${LINK}`;

  it('#56 テキストの R1 の text は body ＋ 改行 ＋ link', async () => {
    const { fake } = await run({ post: postView({ link: LINK }) });

    expect(only(fake, 'R1').form.get('text')).toBe(composed);
  });

  it('#56 画像 1 枚の R1 の text も body ＋ 改行 ＋ link', async () => {
    const { fake } = await run({ post: postView({ link: LINK, media: mediaOf(1) }) });

    expect(only(fake, 'R1').form.get('text')).toBe(composed);
  });

  it('#56 carousel の親 R2 の text も body ＋ 改行 ＋ link', async () => {
    const { fake } = await run({ post: postView({ link: LINK, media: mediaOf(2) }) });

    expect(only(fake, 'R2').form.get('text')).toBe(composed);
  });

  it('#56 どの要求にも link_attachment を送らない', async () => {
    const outcomes = await Promise.all([
      run({ post: postView({ link: LINK }) }),
      run({ post: postView({ link: LINK, media: mediaOf(1) }) }),
      run({ post: postView({ link: LINK, media: mediaOf(2) }) }),
    ]);

    for (const { fake } of outcomes) {
      for (const call of fake.calls) {
        expect(call.form.has('link_attachment')).toBe(false);
        expect(call.url).not.toContain('link_attachment');
      }
    }
  });

  it('#56 link が空文字なら本文そのもの', async () => {
    const { fake } = await run({ post: postView({ link: '' }) });

    expect(only(fake, 'R1').form.get('text')).toBe(BODY);
  });
});

/* -------------------------------------------------------------------------- */
/* #44 自動と手動で同じ本文                                                      */
/* -------------------------------------------------------------------------- */

describe('自動と手動で同じ本文（#44）', () => {
  /** 👍 U+1F44D。§9.4 の数え方で 4。 */
  const THUMBS_UP = '\u{1F44D}';
  /** 👨‍👩‍👧‍👦 ZWJ で繋いだ 4 人家族（25）。 */
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  /** 🇯🇵 地域指示子 2 つ（8）。 */
  const FLAG_JP = '\u{1F1EF}\u{1F1F5}';
  /** 1️⃣ キーキャップ（7）。 */
  const KEYCAP_ONE = '1\uFE0F\u20E3';
  /** ❤️ U+2764 U+FE0F（6）。 */
  const RED_HEART = '\u2764\uFE0F';

  const PAIRS: readonly (readonly [string, string, string | null])[] = [
    ['日本語だけ・link なし', 'こんにちは', null],
    ['link が空文字', 'こんにちは', ''],
    ['英語と link', 'Hello world', 'https://a.example/x'],
    ['日本語 200 文字', 'あ'.repeat(200), null],
    ['絵文字', `今日は${THUMBS_UP}`, null],
    ['ZWJ の絵文字', `家族${FAMILY}で`, null],
    ['国旗', `日本${FLAG_JP}`, null],
    ['キーキャップとハート', `${KEYCAP_ONE}番${RED_HEART}`, null],
    ['& # + %', 'A & B # C + D % E = 100%', null],
    ['改行（LF と CRLF）', 'line1\nline2\r\nline3', null],
    [
      '本文に URL（クエリと断片）と link',
      'see https://a.example/p?q=1&r=2#frag',
      'https://b.example/',
    ],
    ['§9.4 の数えで 500 ちょうど', `${'a'.repeat(496)}${THUMBS_UP}`, null],
    ['本文が空で link だけ', '', 'https://a.example/only'],
    ['前後の空白', '  spaces  ', null],
    ['タブ', 'a\tb', null],
    ['電話番号の +', '+81 90 0000 0000', null],
    ['分解された é', 'cafe\u0301', null],
    ['サロゲートペアの CJK', '\u{20BB7}野家', null],
    ['コピーライト記号', '\u00A9 2026', null],
    [
      '混在と link',
      `mixed 日本語 and English ${FLAG_JP} https://a.example/j`,
      'https://a.example/k',
    ],
    ['ハッシュタグとメンション', '#新作 @yamada.example', null],
    ['link に日本語のパス', '新作', 'https://a.example/商品/1?色=赤'],
  ];

  it('組は 20 通り以上ある', () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(PAIRS)(
    '#44 %s：publish() が R1 に送る text と manual() の URL の text が一致する',
    async (_label, body, link) => {
      const post = postView({ body, link });
      const registration = createThreadsPublisher();

      // 前提：どの組も validate() を通る（自動では P0、手動では置き換えが入る組を混ぜない）。
      expect(registration.validate?.({ post, account: accountView() })).toEqual([]);
      expect(
        registration.validate?.({
          post: { ...post, deliveryMode: 'manual' },
          account: accountView(),
        }),
      ).toEqual([]);

      const { fake } = await run({ post });
      const handoff = registration.manual?.({ post, account: accountView() });
      if (handoff === undefined || handoff instanceof Promise) {
        throw new Error('manual() が同期で値を返していない');
      }

      expect(only(fake, 'R1').form.get('text')).toBe(new URL(handoff.url).searchParams.get('text'));
    },
  );
});

/* -------------------------------------------------------------------------- */
/* §10.8 トークンの延長                                                          */
/* -------------------------------------------------------------------------- */

describe('publish()：トークンの延長（#57〜#64）', () => {
  it('#57 期限が 29 日後なら、R5 の後に R6 を呼ぶ', async () => {
    const { fake } = await run({ credential: nearExpiry() });

    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R5', 'R6']);
  });

  it('#57 rotatedCredential は threadsUserId（元のまま）・R6 の access_token・now + expires_in の 3 キーちょうど', async () => {
    const { result } = await run({ credential: nearExpiry() });

    expect(result).toEqual({
      ok: true,
      externalId: MEDIA_ID,
      externalUrl: PERMALINK,
      rotatedCredential: {
        threadsUserId: THREADS_USER_ID,
        accessToken: REFRESHED_ACCESS_TOKEN,
        accessTokenExpiresAt: new Date(START + REFRESHED_EXPIRES_IN * 1000).toISOString(),
      },
    });
  });

  it('#57 資格情報に余計なキーがあっても rotatedCredential に写さない（3 つを明示して組む）', async () => {
    const { result } = await run({ credential: { ...nearExpiry(), extra: 'x-value' } });

    expect(Object.keys(rotatedOf(result) ?? {}).sort()).toEqual(
      ['accessToken', 'accessTokenExpiresAt', 'threadsUserId'].sort(),
    );
  });

  it('#58 期限が 31 日後なら R6 を呼ばない', async () => {
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
  ])('#59 期限が %s なら R6 を呼ぶ', async (_label, expiresAt) => {
    const { result, fake } = await run({
      credential: credentialOf({ accessTokenExpiresAt: expiresAt }),
    });

    expect(fake.of('R6')).toHaveLength(1);
    expect(rotatedOf(result)?.['accessToken']).toBe(REFRESHED_ACCESS_TOKEN);
  });

  const refreshFailures: readonly (readonly [string, Route])[] = [
    ['400', () => threadsError({ status: 400, code: 190 })],
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
    '#60 R6 が %s なら ok: true のまま rotatedCredential を付けない',
    async (_label, route) => {
      const { result } = await run({
        fake: createFakeThreads({ R6: route }),
        credential: nearExpiry(),
      });

      expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    },
  );

  it.each(refreshFailures)(
    '#60 R6 が %s なら logger.warn が phase: refresh で出る',
    async (_label, route) => {
      const { log } = await run({
        fake: createFakeThreads({ R6: route }),
        credential: nearExpiry(),
      });

      expect(warnPhases(log)).toContain('refresh');
    },
  );

  it.each([
    ['改行を含む', 'Rv4Kx|mB7\ntQ'],
    ['空白を含む', 'Rv4Kx|mB7 tQ'],
    ['全角を含む', 'Rv4Kx|mB7ｔＱ'],
    ['2049 文字', 'a'.repeat(2049)],
    ['空', ''],
    ['文字列でない', 12345],
  ])('#61 R6 の access_token が %s なら rotatedCredential を返さない', async (_label, token) => {
    const { result, log } = await run({
      fake: createFakeThreads({ R6: () => tokenRefreshed(token) }),
      credential: nearExpiry(),
    });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: PERMALINK });
    expect(warnPhases(log)).toContain('refresh');
  });

  it('#61 R6 の access_token が 2048 文字ちょうどなら返す', async () => {
    const token = 'a'.repeat(2048);
    const { result } = await run({
      fake: createFakeThreads({ R6: () => tokenRefreshed(token) }),
      credential: nearExpiry(),
    });

    expect(rotatedOf(result)?.['accessToken']).toBe(token);
  });

  it('#61 R6 が元と同じ文字列を返しても rotatedCredential を返す（期限は更新する）', async () => {
    const { result } = await run({
      fake: createFakeThreads({ R6: () => tokenRefreshed(ACCESS_TOKEN) }),
      credential: nearExpiry(),
    });

    expect(rotatedOf(result)).toEqual({
      threadsUserId: THREADS_USER_ID,
      accessToken: ACCESS_TOKEN,
      accessTokenExpiresAt: new Date(START + REFRESHED_EXPIRES_IN * 1000).toISOString(),
    });
  });

  it.each([
    ['無い', OMIT_EXPIRES_IN],
    ['負', -1],
    ['0', 0],
    ['文字列', '5183944'],
    ['小数', 1.5],
    ['61 日を超える', 61 * 24 * 60 * 60 + 1],
  ])(
    '#62 R6 の expires_in が %s なら rotatedCredential を返し、期限は unknown',
    async (_label, expiresIn) => {
      const { result } = await run({
        fake: createFakeThreads({ R6: () => tokenRefreshed(REFRESHED_ACCESS_TOKEN, expiresIn) }),
        credential: nearExpiry(),
      });

      expect(rotatedOf(result)).toEqual({
        threadsUserId: THREADS_USER_ID,
        accessToken: REFRESHED_ACCESS_TOKEN,
        accessTokenExpiresAt: 'unknown',
      });
    },
  );

  it('#63 公開（R4）が 500 なら R6 を呼ばない', async () => {
    const { result, fake } = await run({
      fake: createFakeThreads({ R4: () => threadsError({ status: 500, code: 1 }) }),
      credential: nearExpiry(),
    });

    expect(result.ok).toBe(false);
    expect(fake.of('R6')).toHaveLength(0);
  });

  it('#63 container の作成（R1）で失敗しても R6 を呼ばない', async () => {
    const { result, fake } = await run({
      fake: createFakeThreads({ R1: () => threadsError({ code: 190 }) }),
      credential: nearExpiry(),
    });

    expect(result.ok).toBe(false);
    expect(fake.of('R6')).toHaveLength(0);
  });

  it('#63 R6 は R4 より後に呼ぶ（公開の前に延長しない）', async () => {
    const { fake } = await run({ credential: nearExpiry() });
    const kinds = fake.kinds();

    expect(kinds.indexOf('R6')).toBeGreaterThan(kinds.indexOf('R4'));
    expect(kinds.lastIndexOf('R6')).toBe(kinds.length - 1);
  });

  it('#64 R5 の後の残り時間が REFRESH_TIMEOUT_MS 未満なら R6 を呼ばず、ok: true', async () => {
    const clock = createClock();
    const fake = createFakeThreads({
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

  it('#64 残り時間がちょうど REFRESH_TIMEOUT_MS なら R6 を呼ぶ', async () => {
    const clock = createClock();
    const fake = createFakeThreads({
      R5: () => {
        clock.set(START + PUBLISH_TOTAL_BUDGET_MS - REFRESH_TIMEOUT_MS);
        return permalinkOf();
      },
    });

    await run({ fake, clock, credential: nearExpiry() });

    expect(fake.of('R6')).toHaveLength(1);
  });

  it('#64 rotatedCredential のキーの集合は credentialFields と一致し、Core の検査で問題 0 件', async () => {
    const registration = createThreadsPublisher();
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
/* §10.12 外部の文字列の形と長さ                                                  */
/* -------------------------------------------------------------------------- */

describe('外部の文字列の形と長さ（#84〜#86）', () => {
  it.each([
    ['65 桁の数字', '9'.repeat(65)],
    ['パスの移動（123/../456）', '123/../456'],
    ['数値型', 181000000001],
    ['空文字', ''],
  ] as const)(
    '#84 R4 の id が %s なら失敗にせず、externalId も externalUrl も付けずに ok: true。R5 を呼ばない',
    async (_label, id) => {
      const { result, fake } = await run({
        fake: createFakeThreads({ R4: () => threadsPublished(id) }),
      });

      expect(result).toEqual({ ok: true });
      expect(fake.of('R5')).toHaveLength(0);
    },
  );

  it('#84 R4 の id が形に合わなくても、期限が近ければ R6 で延長して rotatedCredential を返す（実装プラン §8 の 12）', async () => {
    // 延長は投稿の ID に依らない。形の合わない id で afterPublish を早く抜けると、トークンが延びないまま失効へ近づく。
    const { result, fake } = await run({
      fake: createFakeThreads({ R4: () => threadsPublished('123/../456') }),
      credential: nearExpiry(),
    });

    expect(result).toEqual({
      ok: true,
      rotatedCredential: {
        threadsUserId: THREADS_USER_ID,
        accessToken: REFRESHED_ACCESS_TOKEN,
        accessTokenExpiresAt: new Date(START + REFRESHED_EXPIRES_IN * 1000).toISOString(),
      },
    });
    expect(fake.kinds()).toEqual(['R1', 'R3', 'R4', 'R6']);
  });

  it('#84 R4 の id が 64 桁の数字なら externalId が付き、R5 はその media を指す', async () => {
    const id = '9'.repeat(64);
    const { result, fake } = await run({
      fake: createFakeThreads({ R4: () => threadsPublished(id) }),
    });

    expect(result.ok && result.externalId).toBe(id);
    expect(targetIdOf(new URL(only(fake, 'R5').url))).toBe(id);
  });

  function permalinkOfLength(length: number): string {
    const prefix = 'https://www.threads.net/@u/post/';
    return `${prefix}${'a'.repeat(length - prefix.length)}`;
  }

  it.each([
    'https://www.threads.net/@u/post/AbC',
    'https://www.threads.com/@u/post/AbC',
    'https://threads.com/@u/post/AbC',
  ])(
    '#85 permalink が %s なら返った値のまま付き、Core の isValidExternalUrl に通る',
    async (permalink) => {
      const { result } = await run({
        fake: createFakeThreads({ R5: () => permalinkOf(permalink) }),
      });

      expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: permalink });
      expect(isValidExternalUrl(permalink)).toBe(true);
    },
  );

  it('#85 permalink が 2048 文字ちょうどなら付く', async () => {
    const permalink = permalinkOfLength(2048);
    const { result } = await run({ fake: createFakeThreads({ R5: () => permalinkOf(permalink) }) });

    expect(permalink).toHaveLength(2048);
    expect(result).toEqual({ ok: true, externalId: MEDIA_ID, externalUrl: permalink });
  });

  it.each([
    ['http:', 'http://www.threads.net/@u/post/AbC'],
    ['別のホスト', 'https://evil.test/@u/post/AbC'],
    ['資格情報つき', 'https://user:pw@www.threads.net/@u/post/AbC'],
    ['threads.net で始まる別のホスト', 'https://threads.net.evil.test/'],
    ['Instagram', 'https://www.instagram.com/p/x/'],
    ['2049 文字', permalinkOfLength(2049)],
    ['URL でない', 'not a url'],
  ])(
    '#85 permalink が %s なら externalUrl を付けない（externalId は残す）',
    async (_label, permalink) => {
      const { result } = await run({
        fake: createFakeThreads({ R5: () => permalinkOf(permalink) }),
      });

      expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
    },
  );

  it('#85 permalink が文字列でなければ externalUrl を付けない', async () => {
    const { result } = await run({ fake: createFakeThreads({ R5: () => permalinkOf(12345) }) });

    expect(result).toEqual({ ok: true, externalId: MEDIA_ID });
  });

  it('#86 2048 文字のトークンを含めた rotatedCredential の JSON は Core の上限（4096 文字）を超えない', async () => {
    const { result } = await run({
      fake: createFakeThreads({ R6: () => tokenRefreshed('a'.repeat(2048)) }),
      credential: nearExpiry(),
    });
    const rotated = rotatedOf(result);

    expect(rotated).toBeDefined();
    expect(JSON.stringify(rotated).length).toBeLessThanOrEqual(CREDENTIAL_MAX_LENGTH);
  });
});
