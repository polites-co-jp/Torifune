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
  EXTERNAL_ID_MAX_LENGTH,
  EXTERNAL_URL_MAX_LENGTH,
  isValidExternalUrl,
} from '@/domain/social/social';
import {
  ACCESS_TOKEN,
  ACCESS_TOKEN_SECRET,
  API_KEY,
  API_KEY_SECRET,
  CREDENTIAL,
  IMAGE_ORIGIN,
  TWEET_ID,
  htmlPage,
  imageBytesOf,
  imageFetched,
  imageIndexOf,
  imageUrlOf,
  leakyProblem,
  mediaIdOf,
  mediaUploaded,
  rateLimited,
  redirectTo,
  resetAfter,
  toHeldResponse,
  toResponse,
  tweetCreated,
  xProblem,
  type XResponseExample,
} from '@/test-support/x-api';
import { buildOAuth1Header } from '../../../../plugins/sns-x-api/oauth1';
import { createXApiPublisher } from '../../../../plugins/sns-x-api/social';
import { composeXText } from '../../../../plugins/sns-x-api/x-text';
import {
  CREATE_TWEET_TIMEOUT_MS,
  MEDIA_BUDGET_MS,
  MEDIA_FETCH_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
  MEDIA_UPLOAD_TIMEOUT_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  X_API_BASE_URL,
} from '../../../../plugins/sns-x-api/xapi';

/**
 * X 配信 Plugin（有料版・`sns-x-api`）の `publish()`（037-sns-x 設計 §6 / §10.6〜§10.8 / §10.10 / §10.11）。
 *
 * **実際の X を叩かない。** 偽の X API（このファイルに持つ）・可変の時計・決まった列を返す nonce を
 * `createXApiPublisher({ fetch, now, nonce })` に注入する（設計 §10.1）。応答の形は `test-support/x-api.ts` の
 * 1 か所から取る（#58）。偽の `fetch` は本物と同じく、signal の発火で `signal.reason` で reject し、
 * 本体は signal と結びついた stream で返す（#56 / #57 が本物との一致を確かめる）。
 *
 * 担当する受け入れ条件：#1（既定の経路）、#31〜#51、#60〜#67（#62 は時間の定数の側）。
 * **§6.8 の表を正として全行を書く**（実装プラン §8 の 11）。各行のテストは `logger.warn` の `fields.phase` を
 * アサートする（テスト名と通った分岐の一致。設計 §10.12 の型 5）。フェーズ名は実装プラン §8 の 6 の
 * `input` / `media` / `upload` / `prepare` / `create`。
 *
 * **#45 の後半（R3 を送った後の予期しない例外）はテストを作らない。** 今の設計では到達する経路が無い。
 *
 * #89：本物の `fetch` が呼ばれたらこのファイルのテストは落ちる。
 */

let realFetch: typeof globalThis.fetch;

/** 呼ばれたら投げる `fetch`（#89）。**共有ヘルパにしない**（静的検査が各ファイルの綴りを読む）。 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = throwingFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 宛先                                                                         */
/* -------------------------------------------------------------------------- */

const UPLOAD_URL = 'https://api.x.com/2/media/upload';
const TWEETS_URL = 'https://api.x.com/2/tweets';

function statusUrlOf(id: string): string {
  return `https://x.com/i/status/${id}`;
}

/* -------------------------------------------------------------------------- */
/* AbortSignal.timeout の差し替え（手で発火させる。実装プラン §2「手で発火させる」）   */
/* -------------------------------------------------------------------------- */

interface ProbedTimeout {
  readonly ms: number;
  readonly controller: AbortController;
}

/**
 * `AbortSignal.timeout` を差し替え、**作られた順に ms と controller を記録する**。
 * 返す signal は実時間では発火しない。**必ず `restore()` を `finally` で呼ぶ**（`run()` が呼ぶ）。
 */
interface TimeoutProbe {
  readonly created: ProbedTimeout[];
  latest(): ProbedTimeout | undefined;
  /** 指定の ms で最初に作られたものを `TimeoutError` で発火させる。 */
  fire(ms: number): void;
  restore(): void;
}

function timeoutError(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
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
      entry.controller.abort(timeoutError());
    },
    restore: () => {
      AbortSignal.timeout = original as typeof AbortSignal.timeout;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 偽の X API（実装プラン §2「テストの方法」。このファイルに持つ）                    */
/* -------------------------------------------------------------------------- */

/** 時計の起点（整数秒）。 */
const START = Date.parse('2026-09-23T12:00:00.000Z');

type RequestKind = 'R1' | 'R2' | 'R3';

interface FakeCall {
  readonly kind: RequestKind;
  readonly url: string;
  readonly method: string;
  /** `init.headers` そのもの（Plugin が自分で付けたヘッダ）。 */
  readonly headers: Headers;
  readonly redirect: RequestRedirect | undefined;
  readonly signal: AbortSignal | undefined;
  /** 呼ばれた瞬間に「直前に作られていた」`AbortSignal.timeout`（差し替え中だけ）。 */
  readonly timeout: ProbedTimeout | undefined;
  /** `fetch` が実際に送る `content-type`（`Request` を組み立てて読む。FormData なら boundary つき）。 */
  readonly sentContentType: string | null;
  /** R2：multipart の `media_category`。 */
  readonly mediaCategory: string | null;
  /** R2：multipart の `media` のバイト列と種別。 */
  readonly upload: { readonly bytes: Uint8Array; readonly type: string } | null;
  /** R3：本体の文字列。 */
  readonly text: string | null;
}

interface Clock {
  readonly now: () => Date;
  advance(ms: number): void;
}

function createClock(start = START): Clock {
  let current = start;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

interface RouteContext {
  readonly call: FakeCall;
  /** 同じ種類の要求の何本目か（0 始まり）。 */
  readonly index: number;
  readonly clock: Clock;
}

type RouteReply = XResponseExample | Response;
type Route = (context: RouteContext) => RouteReply | Promise<RouteReply>;
type Routes = Partial<Record<RequestKind, Route>>;

interface FakeX {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: FakeCall[];
  /** 偽の X API が知らない宛先（R1 / R2 / R3 のどれでもない要求）。 */
  readonly unknown: string[];
  kinds(): RequestKind[];
  of(kind: RequestKind): FakeCall[];
}

function kindOf(url: string, method: string): RequestKind | null {
  if (method === 'GET' && url.startsWith(`${IMAGE_ORIGIN}/`)) {
    return 'R1';
  }
  if (method === 'POST' && url === UPLOAD_URL) {
    return 'R2';
  }
  if (method === 'POST' && url === TWEETS_URL) {
    return 'R3';
  }
  return null;
}

function imageIndexOfUrl(url: string): number {
  const matched = /\/images\/([0-9]+)\.png$/.exec(url);
  return matched?.[1] === undefined ? -1 : Number(matched[1]);
}

function defaultRoute(kind: RequestKind, context: RouteContext): RouteReply {
  switch (kind) {
    case 'R1':
      return imageFetched(imageBytesOf(imageIndexOfUrl(context.call.url)), 'image/png');
    case 'R2':
      // 上がってきたバイト列から「何枚目の画像か」を読み、その添字の媒体 ID を返す。
      return mediaUploaded(mediaIdOf(imageIndexOf(context.call.upload?.bytes ?? new Uint8Array())));
    case 'R3':
      return tweetCreated(TWEET_ID);
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

/** 解決しない（signal の発火でだけ止まる）。偽の X API が `rejectOnAbort` と競わせる。 */
function hang(): Promise<never> {
  return new Promise<never>(() => {});
}

async function readBody(
  kind: RequestKind,
  url: string,
  method: string,
  init: RequestInit,
): Promise<Pick<FakeCall, 'sentContentType' | 'mediaCategory' | 'upload' | 'text'>> {
  const empty = { sentContentType: null, mediaCategory: null, upload: null, text: null };
  if (init.body === undefined || init.body === null) {
    return { ...empty, sentContentType: new Headers(init.headers).get('content-type') };
  }
  const request = new Request(url, {
    method,
    headers: init.headers,
    body: init.body,
    duplex: 'half',
  } as RequestInit);
  const sentContentType = request.headers.get('content-type');
  if (kind !== 'R2') {
    return { ...empty, sentContentType, text: await request.text() };
  }
  try {
    const form = await request.formData();
    const media = form.get('media');
    const category = form.get('media_category');
    return {
      ...empty,
      sentContentType,
      mediaCategory: typeof category === 'string' ? category : null,
      upload:
        media instanceof Blob
          ? { bytes: new Uint8Array(await media.arrayBuffer()), type: media.type }
          : null,
    };
  } catch {
    return { ...empty, sentContentType };
  }
}

function createFakeX(routes: Routes, clock: Clock, probe: TimeoutProbe | undefined): FakeX {
  const calls: FakeCall[] = [];
  const unknown: string[] = [];
  const counters: Record<RequestKind, number> = { R1: 0, R2: 0, R3: 0 };

  const impl = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    // **呼ばれた瞬間の「直前に作られた」制限時間**。`await` を挟む前に読む（#60）。
    const timeout = probe?.latest();
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const kind = kindOf(url, method);
    if (kind === null) {
      unknown.push(`${method} ${url}`);
      throw new TypeError(`偽の X API が知らない宛先: ${method} ${url}`);
    }
    const signal = init.signal ?? undefined;
    const index = counters[kind];
    counters[kind] += 1;
    const call: FakeCall = {
      kind,
      url,
      method,
      headers: new Headers(init.headers),
      redirect: init.redirect,
      signal,
      timeout,
      ...(await readBody(kind, url, method, init)),
    };
    calls.push(call);

    if (signal?.aborted === true) {
      throw signal.reason;
    }
    const route = routes[kind];
    const context: RouteContext = { call, index, clock };
    const reply = await Promise.race([
      Promise.resolve(route === undefined ? defaultRoute(kind, context) : route(context)),
      rejectOnAbort(signal),
    ]);
    return reply instanceof Response ? reply : toResponse(reply, signal);
  };

  return {
    fetch: impl as unknown as typeof globalThis.fetch,
    calls,
    unknown,
    kinds: () => calls.map((call) => call.kind),
    of: (kind) => calls.filter((call) => call.kind === kind),
  };
}

/* -------------------------------------------------------------------------- */
/* nonce・ログ・入力                                                             */
/* -------------------------------------------------------------------------- */

interface NonceSource {
  readonly next: () => string;
  readonly issued: string[];
}

/** 呼ばれるたびに `nonce-0001`, `nonce-0002`, … を返す（実装プラン §2「nonce の注入」）。 */
function createNonce(): NonceSource {
  const issued: string[] = [];
  return {
    issued,
    next: () => {
      const value = `nonce-${String(issued.length + 1).padStart(4, '0')}`;
      issued.push(value);
      return value;
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

/** 本文。ログと `reason` に出てはならない値（#50）。 */
const BODY = 'とりふねから秋のお知らせ Kx9Qw';
const LINK = 'https://example.com/torifune-news-Lp3';
const HANDLE = 'torifune_handle_Zr7';

function postView(overrides: Partial<SocialPostView> = {}): SocialPostView {
  return {
    id: '0199bbbb-0000-7000-8000-00000000d001',
    socialAccountId: '0199aaaa-0000-7000-8000-00000000d001',
    body: BODY,
    scheduledAt: '2026-09-23T12:00:00.000Z',
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

function accountView(overrides: Partial<SocialAccountView> = {}): SocialAccountView {
  return {
    id: '0199aaaa-0000-7000-8000-00000000d001',
    provider: 'x',
    displayName: 'とりふね',
    handle: HANDLE,
    status: 'active',
    credentialConfigured: true,
    ...overrides,
  };
}

function mediaOf(count: number): SocialPostView['media'] {
  return Array.from({ length: count }, (_, index) => ({ url: imageUrlOf(index), alt: null }));
}

function credentialWith(overrides: Record<string, string | undefined>): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...CREDENTIAL, ...overrides };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
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
  readonly routes?: Routes;
  readonly post?: SocialPostView;
  readonly account?: SocialAccountView;
  readonly credential?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly logger?: PluginLogger;
  readonly clock?: Clock;
  readonly nonce?: () => string;
  /** 差し替えた `AbortSignal.timeout`。`run()` が終わりに必ず戻す。 */
  readonly probe?: TimeoutProbe;
  /** 偽の `fetch` を包む（ヘッダの後に何かを起こすとき）。 */
  readonly wrap?: (impl: typeof globalThis.fetch) => typeof globalThis.fetch;
}

interface RunResult {
  readonly result: PublishResult;
  readonly fake: FakeX;
  readonly clock: Clock;
  readonly log: LogEntry[];
  readonly nonces: string[];
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  try {
    const clock = options.clock ?? createClock();
    const fake = createFakeX(options.routes ?? {}, clock, options.probe);
    const nonce = createNonce();
    const captured = captureLogger();
    const publish = publishOf(
      createXApiPublisher({
        fetch: options.wrap === undefined ? fake.fetch : options.wrap(fake.fetch),
        now: clock.now,
        nonce: options.nonce ?? nonce.next,
      }),
    );
    const result = await publish({
      post: options.post ?? postView(),
      account: options.account ?? accountView(),
      credential: options.credential ?? { ...CREDENTIAL },
      attempt: 1,
      signal: options.signal ?? new AbortController().signal,
      logger: options.logger ?? captured.logger,
    });
    return { result, fake, clock, log: captured.entries, nonces: nonce.issued };
  } finally {
    options.probe?.restore();
  }
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

type Phase = 'input' | 'media' | 'upload' | 'prepare' | 'create';

/** `logger.warn` に渡った `fields.phase` の列。 */
function warnPhasesOf(log: readonly LogEntry[]): unknown[] {
  return log.filter((entry) => entry.level === 'warn').map((entry) => entry.fields?.['phase']);
}

/**
 * **通った分岐のフェーズ**を確かめる（テスト名と通った分岐の一致。設計 §10.12 の型 5）。
 * `logger.warn` が 1 回以上あり、そのすべてが `phase` である。
 */
function expectWarnedAt(log: readonly LogEntry[], phase: Phase): void {
  const phases = warnPhasesOf(log);

  expect(phases.length, 'logger.warn が 1 度も呼ばれていない').toBeGreaterThan(0);
  expect(new Set(phases)).toEqual(new Set([phase]));
}

/* -------------------------------------------------------------------------- */
/* 経路の部品                                                                    */
/* -------------------------------------------------------------------------- */

const reply =
  (example: XResponseExample): Route =>
  () =>
    example;
const html = (status: number): Route => reply(htmlPage(status));
const problem = (status: number): Route => reply(xProblem(status));

/** 要求が届かなかった（接続できない）。本物の `fetch` は `TypeError` で reject する。 */
const networkDown: Route = () => {
  throw new TypeError('fetch failed');
};

/**
 * 解決させず、**この要求の直前に作られた制限時間**（要求ごとの `AbortSignal.timeout`）を発火させる。
 * `probe` を渡した `run()` でだけ使う。
 */
const timesOut: Route = ({ call }) => {
  setTimeout(() => call.timeout?.controller.abort(timeoutError()), 0);
  return hang();
};

/** R1 が返す画像（添字ごとに中身が違う）。 */
function imageRoute(contentType: string | null, headers: Record<string, string> = {}): Route {
  return ({ call }) => imageFetched(imageBytesOf(imageIndexOfUrl(call.url)), contentType, headers);
}

interface StreamStats {
  pulls: number;
  sent: number;
  cancelled: boolean;
}

/**
 * `Content-Length` の無い画像を 64 KiB ずつ流す R1。**終わりのある stream**（打ち切りが壊れていても
 * テストが OOM にならずに落ちるように）。`pull` の回数と `cancel` の呼び出しを記録する。
 */
function streamedImage(total: number): { readonly route: Route; readonly stats: StreamStats } {
  const CHUNK = 64 * 1024;
  const stats: StreamStats = { pulls: 0, sent: 0, cancelled: false };
  const route: Route = () =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (stats.sent >= total) {
              controller.close();
              return;
            }
            const size = Math.min(CHUNK, total - stats.sent);
            stats.pulls += 1;
            stats.sent += size;
            controller.enqueue(new Uint8Array(size).fill(0x42));
          },
          cancel() {
            stats.cancelled = true;
          },
        },
        // 読まれるまで次を用意しない。先読みで閉じてしまうと、打ち切りの cancel が観測できない。
        { highWaterMark: 0 },
      ),
      { status: 200, headers: { 'content-type': 'image/png' } },
    );
  return { route, stats };
}

/* -------------------------------------------------------------------------- */
/* §6.8 の表（17 行）                                                           */
/* -------------------------------------------------------------------------- */

interface Scenario {
  readonly label: string;
  readonly phase: Phase;
  readonly retryable: boolean;
  /** R3 を送ったか。P0〜P3 は送らない、P4 は送った。 */
  readonly r3Sent: boolean;
  readonly options: () => RunOptions;
}

const ONE_IMAGE = { post: postView({ media: mediaOf(1) }) } as const;

/**
 * 失敗する配信の一覧。**§6.8 の表の 17 行をすべて含む**（#41 の箇条書きは部分集合）。
 * #39 / #42 / #46 / #50 / #51 もこの一覧の全件に掛ける。どれも実行のたびに新しい偽物を作る。
 */
const SCENARIOS: readonly Scenario[] = [
  // ---- P0 入口（外へ 1 本も出さない）----
  {
    label: 'P0 apiKey が空白を含む',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ credential: credentialWith({ apiKey: 'q7Z torifune' }) }),
  },
  {
    label: 'P0 accessTokenSecret が改行を含む',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ credential: credentialWith({ accessTokenSecret: 'secret\nvalue' }) }),
  },
  {
    label: 'P0 apiKeySecret が全角を含む',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ credential: credentialWith({ apiKeySecret: 'secret\uFF21value' }) }),
  },
  {
    label: 'P0 accessToken が 257 文字',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ credential: credentialWith({ accessToken: 'a'.repeat(257) }) }),
  },
  {
    label: 'P0 apiKey が空文字',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ credential: credentialWith({ apiKey: '' }) }),
  },
  {
    label: 'P0 accessToken が欠けている',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ credential: credentialWith({ accessToken: undefined }) }),
  },
  {
    label: 'P0 media が 5 件',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ post: postView({ media: mediaOf(5) }) }),
  },
  {
    label: 'P0 重み 281 の本文',
    phase: 'input',
    retryable: false,
    r3Sent: false,
    options: () => ({ post: postView({ body: 'a'.repeat(281) }) }),
  },
  // ---- P1 画像の取得 ----
  {
    label: 'P1 R1 が reject（接続できない）',
    phase: 'media',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: networkDown } }),
  },
  {
    label: 'P1 R1 が 503',
    phase: 'media',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: html(503) } }),
  },
  {
    label: 'P1 R1 が自前の制限時間で打ち切られる',
    phase: 'media',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, probe: probeTimeouts(), routes: { R1: timesOut } }),
  },
  {
    label: 'P1 R1 が 404',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: html(404) } }),
  },
  {
    label: 'P1 R1 が 302（追わない）',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: reply(redirectTo()) } }),
  },
  {
    label: 'P1 R1 が text/html',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: imageRoute('text/html; charset=utf-8') } }),
  },
  {
    label: 'P1 R1 が image/gif',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: imageRoute('image/gif') } }),
  },
  {
    label: 'P1 R1 が image/svg+xml',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: imageRoute('image/svg+xml') } }),
  },
  {
    label: 'P1 R1 に Content-Type が無い',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: imageRoute(null) } }),
  },
  {
    label: 'P1 R1 の Content-Length が 5000001',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({
      ...ONE_IMAGE,
      routes: { R1: imageRoute('image/png', { 'content-length': '5000001' }) },
    }),
  },
  {
    label: 'P1 R1 が Content-Length なしで 5,000,001 バイト',
    phase: 'media',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R1: streamedImage(5_000_001).route } }),
  },
  {
    label: 'P1 媒体の合計時間を使い切る（budget）',
    phase: 'media',
    retryable: true,
    r3Sent: false,
    options: () => ({
      post: postView({ media: mediaOf(2) }),
      routes: {
        R2: (context) => {
          if (context.index === 0) {
            context.clock.advance(MEDIA_BUDGET_MS + 1_000);
          }
          return defaultRoute('R2', context);
        },
      },
    }),
  },
  // ---- P2 画像のアップロード ----
  {
    label: 'P2 R2 が reject（接続できない）',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: networkDown } }),
  },
  {
    label: 'P2 R2 が自前の制限時間で打ち切られる',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, probe: probeTimeouts(), routes: { R2: timesOut } }),
  },
  {
    label: 'P2 R2 が 503',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: html(503) } }),
  },
  {
    label: 'P2 R2 が 429',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({
      ...ONE_IMAGE,
      routes: { R2: reply(rateLimited(resetAfter(new Date(START), 60_000))) },
    }),
  },
  {
    label: 'P2 R2 が 401',
    phase: 'upload',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: problem(401) } }),
  },
  {
    label: 'P2 R2 が 403',
    phase: 'upload',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: problem(403) } }),
  },
  {
    label: 'P2 R2 が 400',
    phase: 'upload',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: problem(400) } }),
  },
  {
    label: 'P2 R2 が 302',
    phase: 'upload',
    retryable: false,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: reply(redirectTo()) } }),
  },
  {
    label: 'P2 R2 が 200 で data.id なし',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: reply({ status: 200, body: { data: {} } }) } }),
  },
  {
    label: "P2 R2 の data.id が 'x/1'",
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: reply(mediaUploaded('x/1')) } }),
  },
  {
    label: 'P2 R2 の data.id が 21 桁',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: reply(mediaUploaded('1'.repeat(21))) } }),
  },
  {
    label: 'P2 R2 の data.id が数値型',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: reply(mediaUploaded(17100000)) } }),
  },
  {
    label: 'P2 R2 の本体が HTML（200）',
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({ ...ONE_IMAGE, routes: { R2: html(200) } }),
  },
  {
    label: "P2 R2 の processing_info.state が 'pending'",
    phase: 'upload',
    retryable: true,
    r3Sent: false,
    options: () => ({
      ...ONE_IMAGE,
      routes: {
        R2: reply(
          mediaUploaded(mediaIdOf(0), {
            processing_info: { state: 'pending', check_after_secs: 1 },
          }),
        ),
      },
    }),
  },
  // ---- P3 準備 ----
  {
    label: 'P3 R2 の後の残りが CREATE_TWEET_TIMEOUT_MS 未満（budget）',
    phase: 'prepare',
    retryable: true,
    r3Sent: false,
    options: () => ({
      ...ONE_IMAGE,
      routes: {
        R2: (context) => {
          // 経過 15.5 秒：残り 9.5 秒 < 10 秒。媒体の合計（15 秒）の判定は次の画像が無いので掛からない。
          context.clock.advance(PUBLISH_TOTAL_BUDGET_MS - CREATE_TWEET_TIMEOUT_MS + 500);
          return defaultRoute('R2', context);
        },
      },
    }),
  },
  // ---- P4 投稿 ----
  {
    label: 'P4 R3 が 429',
    phase: 'create',
    retryable: true,
    r3Sent: true,
    options: () => ({ routes: { R3: reply(rateLimited(resetAfter(new Date(START), 60_000))) } }),
  },
  {
    label: 'P4 R3 が 401',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: problem(401) } }),
  },
  {
    label: 'P4 R3 が 403',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: problem(403) } }),
  },
  {
    label: 'P4 R3 が 400',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: problem(400) } }),
  },
  {
    label: 'P4 R3 が 302',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: reply(redirectTo()) } }),
  },
  {
    label: 'P4 R3 が 500',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: html(500) } }),
  },
  {
    label: 'P4 R3 が 503',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: html(503) } }),
  },
  {
    label: 'P4 R3 が reject（接続断）',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: networkDown } }),
  },
  {
    label: 'P4 R3 が自前の制限時間で打ち切られる',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ probe: probeTimeouts(), routes: { R3: timesOut } }),
  },
  {
    label: 'P4 R3 の本体が HTML（201）',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: html(201) } }),
  },
  {
    label: 'P4 R3 が 201 で data.id なし',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => ({ routes: { R3: reply({ status: 201, body: { data: {} } }) } }),
  },
  {
    label: 'P4 R3 のヘッダの後・本体を読み切る前に合計の期限が発火する',
    phase: 'create',
    retryable: false,
    r3Sent: true,
    options: () => {
      const probe = probeTimeouts();
      return {
        probe,
        routes: {
          R3: ({ call }) => {
            // ヘッダ（201）は返すが本体は保留する。本体を読んでいる間に合計の期限を発火させる。
            setTimeout(() => probe.fire(PUBLISH_TOTAL_BUDGET_MS), 0);
            return toHeldResponse(tweetCreated(), call.signal ?? new AbortController().signal);
          },
        },
      };
    },
  },
];

function scenario(label: string): Scenario {
  const found = SCENARIOS.find((candidate) => candidate.label === label);
  if (found === undefined) {
    throw new Error(`シナリオが無い: ${label}`);
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/* #1 既定の経路                                                                 */
/* -------------------------------------------------------------------------- */

describe('既定の経路（#1）', () => {
  it('#1 引数なしで作った publisher は globalThis.fetch と実時間と既定の nonce で 1 件を送る', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    // `index.ts` は何も注入しない。既定の `fetch` は呼ばれた時点の globalThis.fetch を見る。
    globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init.headers).get('authorization'),
      });
      return toResponse(tweetCreated(), init.signal);
    }) as typeof globalThis.fetch;
    const before = Date.now();

    const result = await publishOf(createXApiPublisher())({
      post: postView(),
      account: accountView(),
      credential: { ...CREDENTIAL },
      attempt: 1,
      signal: new AbortController().signal,
      logger: captureLogger().logger,
    });
    const after = Date.now();

    expect(result).toEqual({ ok: true, externalId: TWEET_ID, externalUrl: statusUrlOf(TWEET_ID) });
    expect(calls.map((call) => call.url)).toEqual([TWEETS_URL]);
    const oauth = parseOAuth(calls[0]?.authorization ?? '');
    // 既定の nonce は crypto.getRandomValues の 32 バイトを 16 進にしたもの（64 文字。設計 §6.3）。
    expect(oauth.get('oauth_nonce') ?? '').toMatch(/^[0-9a-fA-F]{64}$/);
    // 既定の時計は現在時刻（UNIX 秒）。
    const timestamp = Number(oauth.get('oauth_timestamp'));
    expect(timestamp).toBeGreaterThanOrEqual(Math.floor(before / 1000));
    expect(timestamp).toBeLessThanOrEqual(Math.ceil(after / 1000));
  });

  it('#1 既定の nonce は呼ぶたびに違う', async () => {
    const nonces: string[] = [];
    globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
      nonces.push(
        parseOAuth(new Headers(init.headers).get('authorization') ?? '').get('oauth_nonce') ?? '',
      );
      return toResponse(tweetCreated(), init.signal);
    }) as typeof globalThis.fetch;
    const publish = publishOf(createXApiPublisher());

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await publish({
        post: postView(),
        account: accountView(),
        credential: { ...CREDENTIAL },
        attempt,
        signal: new AbortController().signal,
        logger: captureLogger().logger,
      });
    }

    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

/* -------------------------------------------------------------------------- */
/* OAuth のヘッダを読む                                                          */
/* -------------------------------------------------------------------------- */

/** `OAuth k="v", …` を読み、値をパーセントデコードして返す。 */
function parseOAuth(header: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!header.startsWith('OAuth ')) {
    return entries;
  }
  for (const match of header.slice('OAuth '.length).matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) {
    entries.set(match[1] ?? '', decodeURIComponent(match[2] ?? ''));
  }
  return entries;
}

/** 同じ入力（同じ nonce・同じ時刻・`params: {}`）で `buildOAuth1Header` を呼んだ値。 */
async function expectedAuthorization(url: string, header: string): Promise<string> {
  const oauth = parseOAuth(header);
  return await buildOAuth1Header({
    method: 'POST',
    url,
    params: {},
    credential: CREDENTIAL,
    nonce: oauth.get('oauth_nonce') ?? '',
    timestamp: Number(oauth.get('oauth_timestamp')),
  });
}

/* -------------------------------------------------------------------------- */
/* §10.6 正常系（#31〜#40）                                                      */
/* -------------------------------------------------------------------------- */

describe('正常系：画像なし（#31〜#33 / #38）', () => {
  it('#31 R3 の 1 本だけで、{ ok, externalId, externalUrl } を返す', async () => {
    const { result, fake } = await run();

    expect(fake.kinds()).toEqual(['R3']);
    expect(result).toStrictEqual({
      ok: true,
      externalId: TWEET_ID,
      externalUrl: statusUrlOf(TWEET_ID),
    });
  });

  it('#31 rotatedCredential を返さない', async () => {
    const { result } = await run();

    expect(result.ok && result.rotatedCredential).toBeUndefined();
  });

  it('#31 R3 が 200（201 でない）でも data.id があれば成功', async () => {
    const { result } = await run({
      routes: { R3: reply({ status: 200, body: { data: { id: TWEET_ID, text: 'posted' } } }) },
    });

    expect(result).toEqual({ ok: true, externalId: TWEET_ID, externalUrl: statusUrlOf(TWEET_ID) });
  });

  it('#32 R3 は POST https://api.x.com/2/tweets', async () => {
    const [r3] = (await run()).fake.of('R3');

    expect(r3?.method).toBe('POST');
    expect(r3?.url).toBe(TWEETS_URL);
  });

  it('#32 R3 の content-type は application/json', async () => {
    const [r3] = (await run()).fake.of('R3');

    expect((r3?.headers.get('content-type') ?? '').split(';')[0]?.trim()).toBe('application/json');
  });

  it('#32 R3 の本体は { text: composeXText(post) } ちょうどで、media のキーが無い', async () => {
    const post = postView();
    const [r3] = (await run({ post })).fake.of('R3');
    const body = JSON.parse(r3?.text ?? 'null') as Record<string, unknown>;

    expect(body).toStrictEqual({ text: composeXText(post) });
    expect('media' in body).toBe(false);
  });

  it('#33 R3 の Authorization は同じ now / nonce / 資格情報で buildOAuth1Header（params: {}）を呼んだ値と一致する', async () => {
    const { fake, nonces } = await run();
    const header = fake.of('R3')[0]?.headers.get('authorization') ?? '';
    const oauth = parseOAuth(header);

    expect(nonces).toContain(oauth.get('oauth_nonce'));
    expect(oauth.get('oauth_timestamp')).toBe(String(Math.floor(START / 1000)));
    expect(header).toBe(await expectedAuthorization(TWEETS_URL, header));
  });

  it('#33 本体を署名に含めない（本文を変えても、同じ nonce・時刻なら Authorization が同じ）', async () => {
    const first = (await run({ post: postView({ body: '一つ目の本文' }) })).fake.of('R3')[0];
    const second = (await run({ post: postView({ body: '二つ目の本文' }) })).fake.of('R3')[0];

    expect(first?.text).not.toBe(second?.text);
    expect(first?.headers.get('authorization')).toBe(second?.headers.get('authorization'));
  });

  it('#38 link のある投稿で、R3 の text が body + 改行 + link', async () => {
    const [r3] = (await run({ post: postView({ link: LINK }) })).fake.of('R3');

    expect(JSON.parse(r3?.text ?? 'null')).toStrictEqual({ text: `${BODY}\n${LINK}` });
  });
});

describe('正常系：画像あり（#34〜#37）', () => {
  it('#34 画像 2 枚：R1 → R2 → R1 → R2 → R3 の順（1 件ずつ順に）', async () => {
    const { fake, result } = await run({ post: postView({ media: mediaOf(2) }) });

    expect(result.ok).toBe(true);
    expect(fake.kinds()).toEqual(['R1', 'R2', 'R1', 'R2', 'R3']);
    expect(fake.of('R1').map((call) => call.url)).toEqual([imageUrlOf(0), imageUrlOf(1)]);
  });

  it('#34 R1 は GET で、画像の URL そのものへ出る', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(1) }) });

    expect(fake.of('R1').map((call) => [call.method, call.url])).toEqual([['GET', imageUrlOf(0)]]);
  });

  it('#34 R2 は POST https://api.x.com/2/media/upload', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });

    expect(fake.of('R2').map((call) => [call.method, call.url])).toEqual([
      ['POST', UPLOAD_URL],
      ['POST', UPLOAD_URL],
    ]);
  });

  it('#34 R2 は multipart/form-data で送られ、content-type（boundary つき）は fetch に任せる', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(1) }) });
    const [r2] = fake.of('R2');

    expect(r2?.sentContentType ?? '').toMatch(/^multipart\/form-data; boundary=/);
    // 自分で content-type を付けると boundary が合わなくなる（設計 §6.5）。
    expect(r2?.headers.get('content-type')).toBeNull();
  });

  it('#34 R2 の multipart に media_category=tweet_image と、R1 で得た画像のバイト列がある', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });

    expect(fake.of('R2').map((call) => call.mediaCategory)).toEqual(['tweet_image', 'tweet_image']);
    expect(fake.of('R2').map((call) => [...(call.upload?.bytes ?? [])])).toEqual([
      [...imageBytesOf(0)],
      [...imageBytesOf(1)],
    ]);
  });

  it('#34 R3 の media.media_ids は media の順の R2 の data.id', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });
    const body = JSON.parse(fake.of('R3')[0]?.text ?? 'null') as unknown;

    expect(body).toStrictEqual({
      text: BODY,
      media: { media_ids: [mediaIdOf(0), mediaIdOf(1)] },
    });
  });

  it('#34 R3 の media_ids は各画像の R2 が返した id を、その画像の順に並べたもの（決まった値を入れていない）', async () => {
    // 1 枚目の R2 に 7 番の ID を、2 枚目の R2 に 3 番の ID を返させる。
    const { fake } = await run({
      post: postView({ media: mediaOf(2) }),
      routes: { R2: ({ index }) => mediaUploaded(mediaIdOf(index === 0 ? 7 : 3)) },
    });
    const body = JSON.parse(fake.of('R3')[0]?.text ?? 'null') as {
      readonly media?: { readonly media_ids?: unknown };
    };

    expect(body.media?.media_ids).toEqual([mediaIdOf(7), mediaIdOf(3)]);
  });

  it('#34 画像 4 枚（mediaMax ちょうど）でも最後まで通る', async () => {
    const { fake, result } = await run({ post: postView({ media: mediaOf(4) }) });

    expect(result.ok).toBe(true);
    expect(fake.of('R2')).toHaveLength(4);
    const body = JSON.parse(fake.of('R3')[0]?.text ?? 'null') as {
      readonly media?: { readonly media_ids?: unknown };
    };
    expect(body.media?.media_ids).toEqual([0, 1, 2, 3].map(mediaIdOf));
  });

  it('#35 R1 に Authorization が付かない', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });

    for (const call of fake.of('R1')) {
      expect(call.headers.get('authorization')).toBeNull();
    }
  });

  it('#35 R2 / R3 には Authorization が付き、それぞれ自分の URL（params: {}）で署名されている', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(1) }) });

    for (const call of [...fake.of('R2'), ...fake.of('R3')]) {
      const header = call.headers.get('authorization') ?? '';

      expect(header.startsWith('OAuth '), call.url).toBe(true);
      expect(header, call.url).toBe(await expectedAuthorization(call.url, header));
    }
  });

  it('#35 R2 と R3 は別々の nonce で署名される', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(1) }) });
    const nonces = [...fake.of('R2'), ...fake.of('R3')].map((call) =>
      parseOAuth(call.headers.get('authorization') ?? '').get('oauth_nonce'),
    );

    expect(new Set(nonces).size).toBe(2);
  });

  it('#36 R1 の Content-Type が image/png; charset=utf-8 なら、R2 の media の種別は image/png', async () => {
    const { fake } = await run({
      post: postView({ media: mediaOf(1) }),
      routes: { R1: imageRoute('image/png; charset=utf-8') },
    });

    expect(fake.of('R2')[0]?.upload?.type).toBe('image/png');
  });

  it.each(['image/jpeg', 'image/png', 'image/webp'])(
    '#36 R1 の種別 %s は受け付け、R2 の media の種別にその値が入る',
    async (type) => {
      const { fake, result } = await run({
        post: postView({ media: mediaOf(1) }),
        routes: { R1: imageRoute(type) },
      });

      expect(result.ok).toBe(true);
      expect(fake.of('R2')[0]?.upload?.type).toBe(type);
    },
  );

  it('#37 すべての要求の init.redirect が manual（R1 / R2 / R3）', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2) }) });

    expect(fake.calls).toHaveLength(5);
    for (const call of fake.calls) {
      expect(call.redirect, `${call.kind} ${call.url}`).toBe('manual');
    }
  });
});

describe('正常系：使わないもの（#39 / #40）', () => {
  it.each([
    ['画像なし', {}],
    ['画像 2 枚', { post: postView({ media: mediaOf(2) }) }],
    ['link あり', { post: postView({ link: LINK }) }],
  ] as const)('#39 成功（%s）の戻り値に rotatedCredential が無い', async (_label, options) => {
    const { result } = await run(options);

    expect(result.ok).toBe(true);
    expect(result.ok && result.rotatedCredential).toBeUndefined();
  });

  it.each(SCENARIOS)('#39 失敗（$label）の戻り値に rotatedCredential が無い', async (row) => {
    const { result } = await run(row.options());

    expect('rotatedCredential' in result).toBe(false);
  });

  it('#40 account.handle を変えても、要求と戻り値が変わらない', async () => {
    const post = postView({ media: mediaOf(1), link: LINK });
    const first = await run({ post, account: accountView() });
    const second = await run({
      post,
      account: accountView({ handle: 'another_handle_Q1', displayName: '別の名前' }),
    });
    const shape = (fake: FakeX) =>
      fake.calls.map((call) => ({
        url: call.url,
        method: call.method,
        authorization: call.headers.get('authorization'),
        text: call.text,
        upload: [...(call.upload?.bytes ?? [])],
      }));

    expect(second.result).toEqual(first.result);
    expect(shape(second.fake)).toEqual(shape(first.fake));
  });

  it('#40 /2/users/me を呼ばない（宛先は画像の URL・/2/media/upload・/2/tweets だけ）', async () => {
    const { fake } = await run({ post: postView({ media: mediaOf(2), link: LINK }) });

    expect(fake.unknown).toEqual([]);
    for (const call of fake.calls) {
      expect(call.url).not.toContain('/2/users/me');
      expect([UPLOAD_URL, TWEETS_URL, imageUrlOf(0), imageUrlOf(1)]).toContain(call.url);
    }
  });

  it('#40 どの失敗の配信でも、偽の X API が知らない宛先へ出ない', async () => {
    for (const row of SCENARIOS) {
      const { fake } = await run(row.options());

      expect(fake.unknown, row.label).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* §10.7 異常系と retryable（#41〜#45）                                          */
/* -------------------------------------------------------------------------- */

describe('§6.8 の表を 1 行ずつ（#41）', () => {
  it('表の前提：P0〜P4 のすべてのフェーズと 17 行の種類が一覧にある', () => {
    expect(new Set(SCENARIOS.map((row) => row.phase))).toEqual(
      new Set(['input', 'media', 'upload', 'prepare', 'create']),
    );
    // 17 行のうち「どこでも」の 2 行（予期しない例外・input.signal）は下の describe で見る。
    for (const prefix of [
      'P0 apiKey',
      'P0 media',
      'P0 重み',
      'P1 R1 が reject',
      'P1 R1 が 404',
      'P1 媒体の合計',
      'P2 R2 が reject',
      'P2 R2 が 401',
      'P2 R2 が 400',
      'P2 R2 が 200',
      'P3',
      'P4 R3 が 429',
      'P4 R3 が 401',
      'P4 R3 が 403',
      'P4 R3 が 500',
    ]) {
      expect(
        SCENARIOS.some((row) => row.label.startsWith(prefix)),
        prefix,
      ).toBe(true);
    }
  });

  it.each(SCENARIOS)('#41 $label → retryable: $retryable（phase: $phase）', async (row) => {
    const { result, log } = await run(row.options());

    expect(retryableOf(result)).toBe(row.retryable);
    expectWarnedAt(log, row.phase);
  });

  it.each(SCENARIOS.filter((row) => row.phase === 'input'))(
    '#41 $label は外へ 1 本も出さない（fetch 0 本）',
    async (row) => {
      const { fake } = await run(row.options());

      expect(fake.calls).toHaveLength(0);
      expect(fake.unknown).toHaveLength(0);
    },
  );

  it.each(SCENARIOS.filter((row) => !row.r3Sent))('#41 $label では R3 を送らない', async (row) => {
    const { fake } = await run(row.options());

    expect(fake.of('R3')).toHaveLength(0);
  });

  it.each(SCENARIOS.filter((row) => row.r3Sent))(
    '#41 $label は R3 を 1 本だけ送った後の失敗',
    async (row) => {
      const { fake } = await run(row.options());

      expect(fake.of('R3')).toHaveLength(1);
    },
  );
});

describe('P0 入口の境界（#41 / 設計 §6.9）', () => {
  it('P0 4 値がどれも 256 文字（上限ちょうど）なら外へ出て成功する', async () => {
    const long = (prefix: string) => `${prefix}${'z'.repeat(256 - prefix.length)}`;
    const { result, fake } = await run({
      credential: {
        apiKey: long('k'),
        apiKeySecret: long('s'),
        accessToken: long('t'),
        accessTokenSecret: long('u'),
      },
    });

    expect(result.ok).toBe(true);
    expect(fake.of('R3')).toHaveLength(1);
  });

  it('P0 印字可能な ASCII の記号（!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~）を含む値は通る', async () => {
    const symbols = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
    const { result } = await run({ credential: credentialWith({ apiKeySecret: `s${symbols}` }) });

    expect(result.ok).toBe(true);
  });

  it('P0 DEL（\\u007f）を含む値は外へ出さずに retryable: false', async () => {
    const { result, fake, log } = await run({
      credential: credentialWith({ accessToken: 'token\u007fvalue' }),
    });

    expect(retryableOf(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expectWarnedAt(log, 'input');
  });

  it('P0 media が 4 件なら入口で止めない（Core の mediaMax と同じ上限）', async () => {
    const { result } = await run({ post: postView({ media: mediaOf(4) }) });

    expect(result.ok).toBe(true);
  });

  it('P0 重み 280 ちょうどの本文は入口で止めない', async () => {
    const { result, fake } = await run({ post: postView({ body: 'a'.repeat(280) }) });

    expect(result.ok).toBe(true);
    expect(fake.of('R3')).toHaveLength(1);
  });

  it('P0 link 込みで重み 281 になる本文は入口で止める（link を足した後の文字列を数える）', async () => {
    const { result, fake, log } = await run({
      post: postView({ body: 'a'.repeat(257), link: LINK }),
    });

    expect(retryableOf(result)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expectWarnedAt(log, 'input');
  });
});

describe('P1 画像の取得の細部（#41）', () => {
  it('P1 Content-Length なしの 5,000,001 バイトは読みながら打ち切り、stream を cancel する', async () => {
    const streamed = streamedImage(5_000_001);

    const { result } = await run({ ...ONE_IMAGE, routes: { R1: streamed.route } });

    expect(retryableOf(result)).toBe(false);
    // 最後まで読んで done を見た後なら cancel は呼ばれない。上限を超えた時点で打ち切っている。
    expect(streamed.stats.cancelled).toBe(true);
  });

  it('P1 Content-Length なしの 8,000,000 バイトは上限を超えた所で読むのをやめる（最後まで pull しない）', async () => {
    const streamed = streamedImage(8_000_000);

    const { result } = await run({ ...ONE_IMAGE, routes: { R1: streamed.route } });

    expect(retryableOf(result)).toBe(false);
    expect(streamed.stats.cancelled).toBe(true);
    // 上限（5,000,000）を超えるのは 77 塊目。先読みの 2〜3 塊を除き、それより先を読んでいない。
    expect(streamed.stats.pulls).toBeLessThanOrEqual(Math.ceil(MEDIA_MAX_BYTES / (64 * 1024)) + 3);
    expect(streamed.stats.sent).toBeLessThan(8_000_000);
  });

  it('P1 Content-Length なしでちょうど 5,000,000 バイトなら受け付け、R2 へそのまま上げる', async () => {
    const streamed = streamedImage(5_000_000);

    const { result, fake } = await run({ ...ONE_IMAGE, routes: { R1: streamed.route } });

    expect(result.ok).toBe(true);
    expect(fake.of('R2')[0]?.upload?.bytes.byteLength).toBe(5_000_000);
  });

  it('P1 Content-Length: 5000000（上限ちょうど）なら受け付ける', async () => {
    const { result } = await run({
      ...ONE_IMAGE,
      // 本体は小さいまま。Content-Length の値（上限ちょうど）だけで断っていないことを見る。
      routes: { R1: imageRoute('image/png', { 'content-length': '5000000' }) },
    });

    expect(result.ok).toBe(true);
  });

  it('P1 Content-Length: 5000001 なら本体を読まずに断る（先に Content-Length を見る）', async () => {
    // 本体は小さいまま。本体の長さで判定していればここは通ってしまう。
    const { result, fake } = await run(scenario('P1 R1 の Content-Length が 5000001').options());

    expect(retryableOf(result)).toBe(false);
    expect(fake.of('R2')).toHaveLength(0);
  });

  it('P1 媒体の合計時間を使い切ったら、残りの画像を取りに行かず R3 も送らない', async () => {
    const { result, fake, log } = await run({
      post: postView({ media: mediaOf(3) }),
      routes: {
        R2: (context) => {
          if (context.index === 0) {
            context.clock.advance(MEDIA_BUDGET_MS + 1_000);
          }
          return defaultRoute('R2', context);
        },
      },
    });

    expect(retryableOf(result)).toBe(true);
    expect(fake.kinds()).toEqual(['R1', 'R2']);
    expectWarnedAt(log, 'media');
  });

  it('P1 2 枚目の R1 が失敗したら、2 枚目の R2 と R3 を送らない', async () => {
    const { result, fake, log } = await run({
      post: postView({ media: mediaOf(2) }),
      routes: {
        R1: (context) => (context.index === 1 ? htmlPage(404) : defaultRoute('R1', context)),
      },
    });

    expect(retryableOf(result)).toBe(false);
    expect(fake.kinds()).toEqual(['R1', 'R2', 'R1']);
    expectWarnedAt(log, 'media');
  });
});

describe('P2 画像のアップロードの細部（#41 / #67）', () => {
  it('#67 R2 の data.id が形に合わなければ R3 を送らない（2 枚目だけ合わなくても）', async () => {
    const { result, fake, log } = await run({
      post: postView({ media: mediaOf(2) }),
      routes: {
        R2: ({ index }) => mediaUploaded(index === 0 ? mediaIdOf(0) : '1/../2'),
      },
    });

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R3')).toHaveLength(0);
    expectWarnedAt(log, 'upload');
  });

  it.each(['x/1', '1'.repeat(21), '', '12 34', '١٢٣'])(
    '#67 R2 の data.id が %j なら R3 に届かない（そのまま入れていない）',
    async (id) => {
      const { result, fake } = await run({
        ...ONE_IMAGE,
        routes: { R2: reply(mediaUploaded(id)) },
      });

      expect(retryableOf(result)).toBe(true);
      expect(fake.of('R3')).toHaveLength(0);
    },
  );

  it.each(['1', '1'.repeat(20), mediaIdOf(0)])(
    '#67 R2 の data.id が形に合う %j なら R3 の media_ids にその値が入る',
    async (id) => {
      const { result, fake } = await run({
        ...ONE_IMAGE,
        routes: { R2: reply(mediaUploaded(id)) },
      });
      const body = JSON.parse(fake.of('R3')[0]?.text ?? 'null') as {
        readonly media?: { readonly media_ids?: unknown };
      };

      expect(result.ok).toBe(true);
      expect(body.media?.media_ids).toEqual([id]);
    },
  );

  it("P2 R2 の processing_info.state が 'succeeded' なら R3 へ進む", async () => {
    const { result, fake } = await run({
      ...ONE_IMAGE,
      routes: {
        R2: reply(mediaUploaded(mediaIdOf(0), { processing_info: { state: 'succeeded' } })),
      },
    });

    expect(result.ok).toBe(true);
    expect(fake.of('R3')).toHaveLength(1);
  });

  it('P2 R2 が 429 なら x-rate-limit-reset から retryAfterMs を付ける', async () => {
    const { result } = await run(scenario('P2 R2 が 429').options());

    expect(retryAfterOf(result)).toBe(60_000);
  });
});

describe('P3 準備の境界（#41）', () => {
  it('P3 R2 の後の残りがちょうど CREATE_TWEET_TIMEOUT_MS なら R3 を送る（以上あれば送る）', async () => {
    const { result, fake } = await run({
      ...ONE_IMAGE,
      routes: {
        R2: (context) => {
          context.clock.advance(PUBLISH_TOTAL_BUDGET_MS - CREATE_TWEET_TIMEOUT_MS);
          return defaultRoute('R2', context);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(fake.of('R3')).toHaveLength(1);
  });
});

describe('P4 投稿の細部（#41 / #57 の単体側）', () => {
  it('P4 R3 の応答のヘッダを受け取った直後に合計の期限が発火すると、本体が届いていても retryable: false', async () => {
    // 本物の fetch は、ヘッダの後で signal が発火すると本体の読み込みも reject する（#57）。
    // 偽物の本体も signal と結びついているので、201・id ありの応答でも本体が読めない。
    const probe = probeTimeouts();
    const { result, log } = await run({
      probe,
      wrap: (impl) =>
        (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const response = await impl(input, init);
          if (String(input) === TWEETS_URL) {
            probe.fire(PUBLISH_TOTAL_BUDGET_MS);
          }
          return response;
        }) as typeof globalThis.fetch,
    });

    expect(retryableOf(result)).toBe(false);
    expectWarnedAt(log, 'create');
  });
});

describe('どこでも：予期しない例外と input.signal（#44 / #45）', () => {
  it('#45 R3 を送る前の予期しない例外（nonce() が投げる）→ retryable: true', async () => {
    const { result, fake, log } = await run({
      nonce: () => {
        throw new Error('nonce の生成に失敗した');
      },
    });

    expect(retryableOf(result)).toBe(true);
    expect(fake.of('R3')).toHaveLength(0);
    // 例外はその時点のフェーズで記録される（画像なしなら R3 の署名を作る所）。水準は warn / error のどちらか。
    const phases = log
      .filter((entry) => entry.level === 'warn' || entry.level === 'error')
      .map((entry) => entry.fields?.['phase']);
    expect(phases.length).toBeGreaterThan(0);
    expect(['prepare', 'create']).toEqual(expect.arrayContaining(phases as string[]));
  });

  it('#45 画像のアップロードの署名で nonce() が投げる → retryable: true、R2 も R3 も送らない（phase: upload）', async () => {
    const { result, fake, log } = await run({
      ...ONE_IMAGE,
      nonce: () => {
        throw new Error('nonce の生成に失敗した');
      },
    });

    expect(retryableOf(result)).toBe(true);
    expect(fake.kinds()).toEqual(['R1']);
    const phases = log
      .filter((entry) => entry.level === 'warn' || entry.level === 'error')
      .map((entry) => entry.fields?.['phase']);
    expect(phases.length).toBeGreaterThan(0);
    expect(new Set(phases)).toEqual(new Set(['upload']));
  });

  it('#44 input.signal が既に abort 済みなら fetch を 1 度も呼ばずに戻る', async () => {
    const controller = new AbortController();
    controller.abort();

    const { fake } = await run({
      signal: controller.signal,
      post: postView({ media: mediaOf(1) }),
    });

    expect(fake.calls).toHaveLength(0);
    expect(fake.unknown).toHaveLength(0);
  });

  it('#44 R3 の要求中に input.signal が発火したら、R3 の signal が止まり publish() がすぐ戻る', async () => {
    // 要求ごとの制限時間（10 秒）を待たずに戻る。input.signal が R3 の signal に混ざっていなければ
    // このテストは vitest の制限時間で落ちる。
    const controller = new AbortController();
    const started = performance.now();

    const { fake } = await run({
      signal: controller.signal,
      routes: {
        R3: () => {
          setTimeout(() => controller.abort(), 0);
          return hang();
        },
      },
    });

    expect(fake.of('R3')[0]?.signal?.aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('例外を投げない（#42）', () => {
  it.each(SCENARIOS)('#42 $label でも publish() は例外を投げない', async (row) => {
    await expect(run(row.options())).resolves.toBeDefined();
  });

  it('#42 logger が投げても publish() は例外を投げず、結果が変わらない（成功は ok: true、R3 の 401 は retryable: false）', async () => {
    const throwing: PluginLogger = {
      debug: () => {
        throw new Error('logger');
      },
      info: () => {
        throw new Error('logger');
      },
      warn: () => {
        throw new Error('logger');
      },
      error: () => {
        throw new Error('logger');
      },
    };

    const success = await run({ logger: throwing, post: postView({ media: mediaOf(1) }) });
    const failure = await run({ logger: throwing, routes: { R3: problem(401) } });

    expect(success.result).toEqual({
      ok: true,
      externalId: TWEET_ID,
      externalUrl: statusUrlOf(TWEET_ID),
    });
    expect(retryableOf(failure.result)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* retryAfterMs（#43 / 設計 §9.7）                                               */
/* -------------------------------------------------------------------------- */

describe('retryAfterMs（#43）', () => {
  const nowSeconds = Math.floor(START / 1000);
  const in60s = String(nowSeconds + 60);

  function r3With(reset?: string): RunOptions {
    return { routes: { R3: reply(rateLimited(reset)) } };
  }

  it('#43 x-rate-limit-reset が now() の 60 秒後 → 60000', async () => {
    const { result } = await run(r3With(in60s));

    expect(retryableOf(result)).toBe(true);
    expect(retryAfterOf(result)).toBe(60_000);
  });

  it('#43 now() を進めてあれば、その時刻から数える', async () => {
    const clock = createClock(START + 30_000);

    const { result } = await run({ ...r3With(in60s), clock });

    expect(retryAfterOf(result)).toBe(30_000);
  });

  it('#43 48 時間後でも Plugin 側で丸めない（24 時間で切り詰めるのは Core）', async () => {
    const { result } = await run(r3With(String(nowSeconds + 48 * 60 * 60)));

    expect(retryAfterOf(result)).toBe(48 * 60 * 60 * 1000);
  });

  it('#43 64 文字（上限ちょうど）の整数なら使う', async () => {
    const { result } = await run(r3With(in60s.padStart(64, '0')));

    expect(retryAfterOf(result)).toBe(60_000);
  });

  it.each([
    ['ヘッダなし', undefined],
    ["'abc'", 'abc'],
    ['過去', String(nowSeconds - 60)],
    ['ちょうど now()（結果が 0）', String(nowSeconds)],
    ['65 文字（値は 60 秒後でも）', in60s.padStart(65, '0')],
    ['小数', `${in60s}.5`],
    ['負の数', `-${in60s}`],
    ['空文字', ''],
  ] as const)(
    '#43 %s → retryAfterMs を付けない（retryable: true のまま）',
    async (_label, reset) => {
      const { result } = await run(r3With(reset));

      expect(retryableOf(result)).toBe(true);
      expect(retryAfterOf(result)).toBeUndefined();
    },
  );

  it('#43 R2 の 429 でも同じ規則（60 秒後 → 60000、ヘッダなし → 付けない）', async () => {
    const withReset = await run({ ...ONE_IMAGE, routes: { R2: reply(rateLimited(in60s)) } });
    const withoutReset = await run({ ...ONE_IMAGE, routes: { R2: reply(rateLimited()) } });

    expect(retryAfterOf(withReset.result)).toBe(60_000);
    expect(retryAfterOf(withoutReset.result)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* §10.8 reason と logger（#46〜#51）                                            */
/* -------------------------------------------------------------------------- */

const CREDENTIAL_VALUES = [API_KEY, API_KEY_SECRET, ACCESS_TOKEN, ACCESS_TOKEN_SECRET];

describe('reason と logger（#46〜#51）', () => {
  it('前提：禁止語はどれも固定の文言の部分文字列にならない（検査が空振りしない）', () => {
    // どの値も 12 文字以上の固有の文字列で、「HTTP」「API Key」「X」のような短い語ではない。
    for (const value of [...CREDENTIAL_VALUES, BODY, LINK, HANDLE, TWEET_ID, mediaIdOf(0)]) {
      expect(value.length, value).toBeGreaterThanOrEqual(12);
    }
    expect(API_KEY.slice(0, 3)).toBe('q7Z');
  });

  it.each(SCENARIOS)('#46 $label の reason に資格情報の 4 値が現れない', async (row) => {
    const { result } = await run(row.options());
    const reason = reasonOf(result);

    for (const value of CREDENTIAL_VALUES) {
      expect(reason).not.toContain(value);
    }
  });

  const LEAKY_FRAGMENT = 'Kx9秋のお知らせQw';

  it.each([
    ['R2', 403],
    ['R2', 400],
    ['R3', 403],
    ['R3', 400],
    ['R3', 401],
  ] as const)(
    '#47 %s が %i で要求の値を混ぜ返す problem を返しても、reason に title / detail / type / errors の値が出ず、status は出る',
    async (kind, status) => {
      const example = leakyProblem(status, LEAKY_FRAGMENT);
      const { result } = await run({
        post: postView({ body: `本文 ${LEAKY_FRAGMENT}`, media: kind === 'R2' ? mediaOf(1) : [] }),
        routes: { [kind]: reply(example) },
      });
      const reason = reasonOf(result);
      const body = example.body as {
        readonly title: string;
        readonly detail: string;
        readonly type: string;
        readonly errors: readonly { readonly message: string; readonly detail: string }[];
      };

      for (const leaked of [
        body.title,
        body.detail,
        API_KEY.slice(0, 3),
        body.type,
        'problems',
        ...body.errors.flatMap((error) => [error.message, error.detail]),
      ]) {
        expect(reason, leaked).not.toContain(leaked);
      }
      expect(reason).toContain(String(status));
    },
  );

  it.each([
    [404, false],
    [403, false],
    [500, true],
  ] as const)(
    '#48 R1 が %i：reason に status が出ず（数字も（…）の形も）、logger の fields に status の項目が無い。retryable は %s',
    async (status, retryable) => {
      const { result, log } = await run({ ...ONE_IMAGE, routes: { R1: html(status) } });
      const reason = reasonOf(result);

      expect(retryableOf(result)).toBe(retryable);
      expect(reason).not.toContain(String(status));
      expect(reason).not.toMatch(/HTTP\s*[0-9]/);
      expect(reason).not.toMatch(/[（(][^）)]*[0-9]{3}[^）)]*[）)]/);
      for (const entry of log) {
        expect(entry.fields === undefined || !('status' in entry.fields), entry.message).toBe(true);
        expect(entry.message).not.toContain(String(status));
      }
      expectWarnedAt(log, 'media');
    },
  );

  it.each([
    ['R2', 503, ONE_IMAGE, 'upload'],
    ['R2', 401, ONE_IMAGE, 'upload'],
    ['R3', 401, {}, 'create'],
    ['R3', 403, {}, 'create'],
    ['R3', 500, {}, 'create'],
  ] as const)(
    '#49 %s が %i で失敗したら logger の fields.status に status が入る',
    async (kind, status, base, phase) => {
      const { log } = await run({ ...base, routes: { [kind]: html(status) } });

      expect(
        log.some(
          (entry) =>
            entry.level === 'warn' &&
            entry.fields?.['phase'] === phase &&
            entry.fields?.['status'] === status,
        ),
      ).toBe(true);
    },
  );

  /** ログのどこにも出てはならない値（#50）。要求ごとに変わる値は偽物の記録から集める。 */
  function forbiddenInLog(fake: FakeX, nonces: readonly string[]): string[] {
    return [
      ...CREDENTIAL_VALUES,
      BODY,
      LINK,
      HANDLE,
      TWEET_ID,
      ...[0, 1, 2, 3].map(mediaIdOf),
      ...[0, 1, 2, 3].map(imageUrlOf),
      resetAfter(new Date(START), 60_000),
      ...nonces,
      ...fake.calls
        .map((call) => call.headers.get('authorization'))
        .filter((value): value is string => value !== null),
    ];
  }

  function expectCleanLog(log: readonly LogEntry[], forbidden: readonly string[]): void {
    const dumped = JSON.stringify(log.map((entry) => [entry.message, entry.fields ?? null]));
    for (const value of forbidden) {
      expect(dumped, value).not.toContain(value);
    }
  }

  it.each(SCENARIOS)('#50 $label の logger に秘匿すべき値が 1 つも出ない', async (row) => {
    const options = row.options();
    const { fake, log, nonces } = await run({
      ...options,
      post: options.post ?? postView({ link: LINK }),
      account: accountView(),
    });

    expectCleanLog(log, forbiddenInLog(fake, nonces));
  });

  it('#50 成功（画像 2 枚・link あり）の logger にも秘匿すべき値が出ない', async () => {
    const { fake, log, nonces } = await run({
      post: postView({ media: mediaOf(2), link: LINK }),
    });

    expectCleanLog(log, forbiddenInLog(fake, nonces));
  });

  it.each(SCENARIOS)('#51 $label の reason は空でない', async (row) => {
    const { result } = await run(row.options());

    expect(reasonOf(result).trim().length).toBeGreaterThan(0);
  });

  it('#51 R3 の 401 の reason に「API Key」と「時計」が現れる', async () => {
    const reason = reasonOf((await run({ routes: { R3: problem(401) } })).result);

    expect(reason).toContain('API Key');
    expect(reason).toContain('時計');
  });

  it('#51 R3 の 403 の reason に「Read and write」が現れる', async () => {
    const reason = reasonOf((await run({ routes: { R3: problem(403) } })).result);

    expect(reason).toContain('Read and write');
  });

  it.each([
    'P1 R1 が 404',
    'P1 R1 が 302（追わない）',
    'P1 R1 が image/gif',
    'P1 R1 の Content-Length が 5000001',
    'P1 R1 が Content-Length なしで 5,000,001 バイト',
  ])('#51 %s（R1 の retryable: false）の reason に「5MB」が現れる', async (label) => {
    const reason = reasonOf((await run(scenario(label).options())).result);

    expect(reason).toContain('5MB');
  });

  it.each(['P1 R1 が reject（接続できない）', 'P1 R1 が 503'])(
    '設計 §6.9 の例：%s（R1 の retryable: true）の reason は「一時的な失敗」を伝える',
    async (label) => {
      const reason = reasonOf((await run(scenario(label).options())).result);

      expect(reason).toContain('一時的な失敗');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* §10.10 制限時間の結線（#60〜#63）                                              */
/* -------------------------------------------------------------------------- */

describe('制限時間の定数（#62 の時間の側 / 設計 §6.6）', () => {
  it('設計 §6.6 の値：合計 25 秒・媒体 15 秒・R1 / R2 / R3 は 10 秒', () => {
    expect(PUBLISH_TOTAL_BUDGET_MS).toBe(25_000);
    expect(MEDIA_BUDGET_MS).toBe(15_000);
    expect(MEDIA_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(MEDIA_UPLOAD_TIMEOUT_MS).toBe(10_000);
    expect(CREATE_TWEET_TIMEOUT_MS).toBe(10_000);
  });

  it('#62 MEDIA_BUDGET_MS + CREATE_TWEET_TIMEOUT_MS <= PUBLISH_TOTAL_BUDGET_MS', () => {
    expect(MEDIA_BUDGET_MS + CREATE_TWEET_TIMEOUT_MS).toBeLessThanOrEqual(PUBLISH_TOTAL_BUDGET_MS);
  });

  it('#62 PUBLISH_TOTAL_BUDGET_MS + 5000 <= Core の PUBLISH_TIMEOUT_MS（30 秒）', () => {
    expect(PUBLISH_TOTAL_BUDGET_MS + 5_000).toBeLessThanOrEqual(PUBLISH_TIMEOUT_MS);
  });

  it('設計 §6.5 / §6.2：画像の上限は 5,000,000 バイト、宛先は https://api.x.com', () => {
    expect(MEDIA_MAX_BYTES).toBe(5_000_000);
    expect(X_API_BASE_URL).toBe('https://api.x.com');
  });
});

describe('制限時間の結線（#60 / #61 / #63）', () => {
  /** 画像 1 枚の配信を、`AbortSignal.timeout` を差し替えたまま最後まで通す。 */
  async function wiredSingleImage(routes: Routes = {}): Promise<{
    readonly probe: TimeoutProbe;
    readonly result: PublishResult;
    readonly fake: FakeX;
  }> {
    const probe = probeTimeouts();
    const { result, fake } = await run({ ...ONE_IMAGE, probe, routes });
    return { probe, result, fake };
  }

  it('#60 画像 1 枚の配信が最後まで通る（差し替えた AbortSignal.timeout のまま）', async () => {
    const { result } = await wiredSingleImage();

    expect(result).toEqual({ ok: true, externalId: TWEET_ID, externalUrl: statusUrlOf(TWEET_ID) });
  });

  it('#60 要求の URL と、その要求の直前に作られた制限時間の ms の組が R1 / R2 / R3 の定数と一致する', async () => {
    const { fake } = await wiredSingleImage();

    expect(fake.calls.map((call) => ({ url: call.url, ms: call.timeout?.ms }))).toEqual([
      { url: imageUrlOf(0), ms: MEDIA_FETCH_TIMEOUT_MS },
      { url: UPLOAD_URL, ms: MEDIA_UPLOAD_TIMEOUT_MS },
      { url: TWEETS_URL, ms: CREATE_TWEET_TIMEOUT_MS },
    ]);
  });

  it('#60 publish() 全体に PUBLISH_TOTAL_BUDGET_MS、画像の処理に MEDIA_BUDGET_MS が、どの要求よりも先に 1 度ずつ掛かる', async () => {
    const { probe, fake } = await wiredSingleImage();

    expect(probe.created.slice(0, 2).map((entry) => entry.ms)).toEqual([
      PUBLISH_TOTAL_BUDGET_MS,
      MEDIA_BUDGET_MS,
    ]);
    // 残りはすべて要求ごと（要求 1 本につき 1 つ）。
    expect(probe.created).toHaveLength(2 + fake.calls.length);
  });

  it('#60 要求ごとの制限時間は要求ごとに別のもので、合計・媒体の期限を流用していない', async () => {
    // 3 つの要求の定数は同じ 10 秒なので、値だけでは結線を確かめられない（実装プラン §7 の 3）。
    // 「直前に作られたもの」が要求ごとに別の controller で、先頭 2 つ（合計・媒体）でないことを見る。
    const { probe, fake } = await wiredSingleImage();
    const controllers = fake.calls.map((call) => call.timeout?.controller);

    expect(new Set(controllers).size).toBe(3);
    for (const head of probe.created.slice(0, 2)) {
      expect(controllers).not.toContain(head.controller);
    }
  });

  it('#60 組にした制限時間は、実際にその要求の signal に混ぜられている（発火させるとその要求だけが止まる）', async () => {
    const { fake } = await wiredSingleImage();

    for (const call of fake.calls) {
      const others = fake.calls.filter((other) => other !== call);
      const before = others.map((other) => other.signal?.aborted);

      expect(call.signal?.aborted, call.url).toBe(false);
      call.timeout?.controller.abort(timeoutError());
      expect(call.signal?.aborted, call.url).toBe(true);
      // 他の要求の signal はこの発火で変わらない。
      expect(
        others.map((other) => other.signal?.aborted),
        call.url,
      ).toEqual(before);
    }
  });

  it('#60 合計の期限は R1 / R2 / R3 のすべての signal に、媒体の期限は R1 / R2 にだけ混ぜられている', async () => {
    const { probe, fake } = await wiredSingleImage();
    const [total, media] = probe.created;

    media?.controller.abort(timeoutError());
    expect(fake.calls.map((call) => call.signal?.aborted)).toEqual([true, true, false]);
    total?.controller.abort(timeoutError());
    expect(fake.calls.map((call) => call.signal?.aborted)).toEqual([true, true, true]);
  });

  it('#61 R3 の要求中に媒体の期限（MEDIA_BUDGET_MS）が発火しても、R3 の signal は aborted にならない', async () => {
    let r3Aborted: boolean | undefined;
    const probe = probeTimeouts();
    const { result, fake } = await run({
      ...ONE_IMAGE,
      probe,
      routes: {
        R3: ({ call }) => {
          probe.fire(MEDIA_BUDGET_MS);
          r3Aborted = call.signal?.aborted;
          return tweetCreated();
        },
      },
    });

    expect(r3Aborted).toBe(false);
    expect(result).toEqual({ ok: true, externalId: TWEET_ID, externalUrl: statusUrlOf(TWEET_ID) });
    // 発火そのものは効いている：媒体の signal の下にあった R1 / R2 の signal は止まっている。
    expect(fake.of('R1')[0]?.signal?.aborted).toBe(true);
    expect(fake.of('R2')[0]?.signal?.aborted).toBe(true);
  });

  it('#61 R3 の要求中に合計の期限が発火すれば、R3 の signal は aborted になる（対の条件）', async () => {
    let r3Aborted: boolean | undefined;
    const probe = probeTimeouts();
    await run({
      ...ONE_IMAGE,
      probe,
      routes: {
        R3: ({ call }) => {
          probe.fire(PUBLISH_TOTAL_BUDGET_MS);
          r3Aborted = call.signal?.aborted;
          return tweetCreated();
        },
      },
    });

    expect(r3Aborted).toBe(true);
  });

  /**
   * #63。指定のフェーズの要求を解決させず、飛んでいる最中に
   * **合計の期限（`PUBLISH_TOTAL_BUDGET_MS` の `AbortSignal.timeout`）を手で発火させる。**
   */
  async function fireTotalDuring(kind: RequestKind): Promise<RunResult> {
    const probe = probeTimeouts();
    return await run({
      ...ONE_IMAGE,
      probe,
      routes: {
        [kind]: () => {
          setTimeout(() => probe.fire(PUBLISH_TOTAL_BUDGET_MS), 0);
          return hang();
        },
      },
    });
  }

  it.each(['R1', 'R2', 'R3'] as const)(
    '#63 %s の最中に合計の期限が発火すると、飛んでいる要求の signal がすべて aborted になり publish() が戻る',
    async (kind) => {
      const { fake } = await fireTotalDuring(kind);
      const inflight = fake.of(kind);

      expect(inflight).toHaveLength(1);
      for (const call of inflight) {
        expect(call.signal?.aborted).toBe(true);
      }
    },
  );

  it.each([
    ['R1', 'media'],
    ['R2', 'upload'],
  ] as const)(
    '#63 %s の最中なら retryable: true（R3 を送っていない。phase: %s）',
    async (kind, phase) => {
      const { result, fake, log } = await fireTotalDuring(kind);

      expect(retryableOf(result)).toBe(true);
      expect(fake.of('R3')).toHaveLength(0);
      expectWarnedAt(log, phase);
    },
  );

  it('#63 R3 の最中なら retryable: false（届いたか分からない。phase: create）', async () => {
    const { result, log } = await fireTotalDuring('R3');

    expect(retryableOf(result)).toBe(false);
    expectWarnedAt(log, 'create');
  });
});

/* -------------------------------------------------------------------------- */
/* §10.11 外部の文字列の形と長さ（#64〜#66）                                       */
/* -------------------------------------------------------------------------- */

describe('tweet id の形と長さ（#64〜#66）', () => {
  function withTweetId(id: unknown): RunOptions {
    return { routes: { R3: reply(tweetCreated(id)) } };
  }

  it("#64 data.id が '1800000000000000000' → externalId と externalUrl（https://x.com/i/status/…）が付く", async () => {
    const { result } = await run(withTweetId('1800000000000000000'));

    expect(result).toEqual({
      ok: true,
      externalId: '1800000000000000000',
      externalUrl: 'https://x.com/i/status/1800000000000000000',
    });
  });

  it('#64 externalUrl は Core の isValidExternalUrl に通る', async () => {
    const { result } = await run(withTweetId('1800000000000000000'));

    expect(isValidExternalUrl(result.ok ? (result.externalUrl ?? '') : '')).toBe(true);
  });

  it.each([
    ['21 桁', '1'.repeat(21)],
    ["'1/../2'", '1/../2'],
    ["'abc'", 'abc'],
    ['数値型', 18000000],
    ['空文字', ''],
  ] as const)(
    '#65 data.id が %s → 失敗にせず { ok: true }、externalId も externalUrl も付けない',
    async (_label, id) => {
      const { result } = await run(withTweetId(id));

      expect(result).toEqual({ ok: true });
      expect(result.ok && result.externalId).toBeUndefined();
      expect(result.ok && result.externalUrl).toBeUndefined();
    },
  );

  it('#66 20 桁の数字 → 両方付き、externalId は 200 文字以内・externalUrl は 2048 文字以内', async () => {
    const id = '9'.repeat(20);

    const { result } = await run(withTweetId(id));

    expect(result).toEqual({ ok: true, externalId: id, externalUrl: statusUrlOf(id) });
    expect((result.ok ? (result.externalId ?? '') : '').length).toBeLessThanOrEqual(
      EXTERNAL_ID_MAX_LENGTH,
    );
    expect((result.ok ? (result.externalUrl ?? '') : '').length).toBeLessThanOrEqual(
      EXTERNAL_URL_MAX_LENGTH,
    );
    expect(isValidExternalUrl(result.ok ? (result.externalUrl ?? '') : '')).toBe(true);
  });

  it('#66 1 桁の数字でも両方付く（下限）', async () => {
    const { result } = await run(withTweetId('7'));

    expect(result).toEqual({ ok: true, externalId: '7', externalUrl: statusUrlOf('7') });
  });
});
