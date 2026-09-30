import type { Plugin, PluginManifest, PublisherRegistration } from '@torifune/plugin-api';
import { PluginPublisherConflictError } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as updateSocialAccountRoute } from '@/app/api/v1/social/accounts/[id]/route';
import { PATCH as updateSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import {
  findPublisher,
  publisherLabels,
  resetPublisherRegistry,
} from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  resolveManualHandoff,
  updateSocialAccount,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { providerLabel } from '@/domain/social/social';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  IMAGE_ORIGIN,
  TWEET_ID,
  htmlPage,
  imageFetched,
  imageUrlOf,
  mediaUploaded,
  toResponse,
  tweetCreated,
  xProblem,
  type XResponseExample,
} from '@/test-support/x-api';
import { X_MANUAL_NOTE } from '../../../../plugins/sns-x-manual/x-text';
import type { DependencyCandidate } from './dependencies';
import { disablePlugin, enablePlugin, findPluginRecord, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * X 配信 Plugin（`sns-x-manual` / `sns-x-api`）を **Core のジョブ・UseCase・API ルートを通して**動かす
 * （037-sns-x 設計 §10.13「B / C」、§10.15 #91）。
 *
 * 受け入れ条件 #68〜#71（ジョブを通した配信）、#72〜#75（登録時の検査。ルートを直接叩く）、
 * #76（手動投稿の URL）、#77（無料版では `auto` が `no_publisher`）、
 * **#78〜#81（入れ替え。設計 §7.2 の手順そのもの）**、#82（同じ provider の第三の Plugin）、#83（表示名）、#91。
 *
 * **実装は増えない。** 2 つの Plugin が `035` の口（`publish()` を持たない publisher、同じ provider を奪い合う
 * 2 つの Plugin）を通して、Core の既存の規則のまま動くことを見る。
 *
 * **偽の X API を挿す口は `globalThis.fetch` だけ**である（実装プラン §2「B 群の偽 X API」）。
 * `plugins/sns-x-api/index.ts` は `fetch` を注入せず既定を使うので、ここを差し替えないと本物の X を叩く。
 * `beforeEach` で「呼ばれたら投げる」を置き（#89）、`afterEach` で必ず戻す。既定の時計（実時間）と
 * 既定の nonce（本物の乱数）を使う。
 *
 * **資格情報の値に `torifune` を含めない。** 結合テストの `DATABASE_URL` の password が `torifune` なので、
 * Core の `redactSecrets` が `failure_reason` の中のその綴りを伏せる。値を含めると「理由に値が出ない」の検査が
 * Plugin の振る舞いと無関係に通ってしまう（#70）。
 */

const PROVIDER = 'x';
const MANUAL_ID = 'sns-x-manual';
const API_ID = 'sns-x-api';
type XPluginId = typeof MANUAL_ID | typeof API_ID;

const X_API_ORIGIN = 'https://api.x.com';
const IMAGE_URL = imageUrlOf(0);

/** OAuth 1.0a の 4 値（設計 §5.1）。**`failure_reason` にも監査にも出てはならない**（#70）。 */
const INTEGRATION_CREDENTIAL: Readonly<
  Record<'apiKey' | 'apiKeySecret' | 'accessToken' | 'accessTokenSecret', string>
> = {
  apiKey: 'k8WintegConsumerKey0101',
  apiKeySecret: 'integConsumerSecretJf3Hs7Qa0102',
  accessToken: '1790000000000000002-integAccessTokenRw0103',
  accessTokenSecret: 'integAccessTokenSecretPx6Vc2Ld0104',
};
const CREDENTIAL_VALUES = Object.values(INTEGRATION_CREDENTIAL);

/** Core が伏せ字にしたときの印（`redactCredentialValues` / `redactSecrets`）。 */
const MASK = '***';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* 偽の X API（#91）                                                             */
/* -------------------------------------------------------------------------- */

type XRequestKind = 'R1' | 'R2' | 'R3';

interface XCall {
  readonly kind: XRequestKind;
  readonly url: string;
  readonly authorization: string | null;
}

type Route = () => XResponseExample;

/**
 * 偽の X API を用意していないテストが、**素の `globalThis.fetch` のまま走らない**ようにする（#89）。
 *
 * `useFakeXApi()` を呼んだテストだけが偽物を持つ形だと、**呼び忘れたテストは本物で走る。**
 * `beforeEach` で一律にこれを置き、`useFakeXApi()` がそのうえから上書きする。
 */
function throwingFetch(): typeof globalThis.fetch {
  return ((): never => {
    throw new Error('偽の X API を用意していない fetch が呼ばれた');
  }) as typeof globalThis.fetch;
}

/**
 * 要求を R1（画像の取得）/ R2（`POST /2/media/upload`）/ R3（`POST /2/tweets`）に分ける。
 * **それ以外の宛先では投げる**（#91）。`/2/users/me` も知らない宛先として投げる（設計 §3.2）。
 */
function kindOf(url: URL, method: string): XRequestKind {
  if (url.origin === IMAGE_ORIGIN && method === 'GET' && url.pathname.startsWith('/images/')) {
    return 'R1';
  }
  if (url.origin === X_API_ORIGIN && method === 'POST' && url.pathname === '/2/media/upload') {
    return 'R2';
  }
  if (url.origin === X_API_ORIGIN && method === 'POST' && url.pathname === '/2/tweets') {
    return 'R3';
  }
  throw new Error(`偽の X API が知らない宛先: ${method} ${url.origin}${url.pathname}`);
}

const DEFAULT_ROUTES: Readonly<Record<XRequestKind, Route>> = {
  R1: () => imageFetched(),
  R2: () => mediaUploaded(),
  R3: () => tweetCreated(),
};

/** `globalThis.fetch` を偽の X API に差し替える。要求の列を返す。 */
function useFakeXApi(routes: Partial<Record<XRequestKind, Route>> = {}): XCall[] {
  const calls: XCall[] = [];

  globalThis.fetch = ((input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    // **同期で投げる。** 知らない宛先へ出ようとした要求は、偽物が応答を作る前に止まる（#91）。
    const kind = kindOf(url, method);
    calls.push({
      kind,
      url: url.href,
      authorization: new Headers(init.headers).get('authorization'),
    });
    return Promise.resolve(toResponse((routes[kind] ?? DEFAULT_ROUTES[kind])(), init.signal));
  }) as typeof globalThis.fetch;

  return calls;
}

/* -------------------------------------------------------------------------- */
/* Plugin の導入・有効化・無効化（`sns-instagram.integration.test.ts` の流儀）       */
/* -------------------------------------------------------------------------- */

function entryOf(id: string): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === id);
  if (found === undefined) throw new Error(`Plugin が読み込めていない: ${id}`);
  return found;
}

function candidatesOf(
  manifest: PluginManifest,
  enabled: boolean,
): Map<string, DependencyCandidate> {
  return new Map([[manifest.id, { manifest, enabled }]]);
}

/** `/plugins` の「導入」と「有効化」。 */
async function activate(id: XPluginId): Promise<{ ok: boolean; reason?: string }> {
  const { manifest, plugin } = entryOf(id);
  return withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    return enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, false),
    });
  });
}

/** `/plugins` の「無効化」。 */
async function deactivate(id: XPluginId): Promise<void> {
  const { manifest, plugin } = entryOf(id);
  await withConnection((connection) =>
    disablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, true),
    }),
  );
}

async function statusOf(id: string): Promise<string | null> {
  const record = await withConnection((connection) => findPluginRecord(connection, id));
  return record?.status ?? null;
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `x${suffix}`,
        email: `x${suffix}@example.com`,
        display_name: 'sns x test',
      })
      .execute();

    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) throw new Error(`ロールが無い: ${roleName}`);
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: id, role_id: role.id })
        .execute();
    }
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `x${suffix}`,
    displayName: 'sns x test',
    email: `x${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/* -------------------------------------------------------------------------- */
/* アカウントと投稿                                                             */
/* -------------------------------------------------------------------------- */

async function accountFor(
  credentials: Readonly<Record<string, string>> | null = INTEGRATION_CREDENTIAL,
): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'X 公式',
    handle: '@x_integration_handle',
    credential: null,
    ...(credentials === null ? {} : { credentials }),
    status: 'connected',
  });
  return account.id;
}

interface PostOverrides {
  readonly body?: string;
  readonly deliveryMode?: 'auto' | 'manual';
  readonly withImage?: boolean;
}

/** 期限の来た予約（既定は画像なしの `auto`）。 */
async function makePost(accountId: string, overrides: PostOverrides = {}): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: overrides.body ?? 'X へ届く本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: overrides.deliveryMode ?? 'auto',
    ...(overrides.withImage === true ? { media: [{ url: IMAGE_URL, alt: null }] } : {}),
  });
  return post.id;
}

interface PostRow {
  readonly social_account_id: string;
  readonly status: string;
  readonly failure_reason: string | null;
  readonly external_id: string | null;
  readonly external_url: string | null;
  readonly next_attempt_at: Date | null;
  readonly skip_reason: string | null;
}

async function postRow(id: string): Promise<PostRow> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_posts')
      .select([
        'social_account_id',
        'status',
        'failure_reason',
        'external_id',
        'external_url',
        'next_attempt_at',
        'skip_reason',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

/** 後ろへ送られた予定を過去へ戻す（実時間で待たないため）。 */
async function rewindNextAttempt(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ next_attempt_at: new Date(Date.now() - 1_000) })
      .where('id', '=', id)
      .execute();
  });
}

/** `social_accounts.credential`（暗号文）。 */
async function storedCredential(accountId: string): Promise<string | null> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential'])
      .where('id', '=', accountId)
      .executeTakeFirst(),
  );
  return (row as { credential: string | null } | undefined)?.credential ?? null;
}

async function accountIds(): Promise<readonly string[]> {
  const rows = await withConnection((connection) =>
    connection.db.selectFrom('social_accounts').select(['id']).execute(),
  );
  return rows.map((row) => row.id);
}

async function auditRows(action: string): Promise<
  {
    readonly resource_type: string;
    readonly resource_id: string | null;
    readonly detail: Record<string, unknown>;
  }[]
> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['resource_type', 'resource_id', 'detail'])
      .where('action', '=', action)
      .execute();
    return rows as {
      readonly resource_type: string;
      readonly resource_id: string | null;
      readonly detail: Record<string, unknown>;
    }[];
  });
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

/** `resolveManualHandoff` の URL（`ok: false` なら落とす）。 */
async function handoffUrl(postId: string): Promise<string> {
  const outcome = await resolveManualHandoff(admin, { id: postId });
  if (!outcome.ok) throw new Error(`手動投稿の URL が得られない: ${outcome.reason}`);
  return outcome.url;
}

/* -------------------------------------------------------------------------- */
/* API（ルートを直接叩く。036 #67・038 #87 と同じ）                                 */
/* -------------------------------------------------------------------------- */

const BASE = 'http://127.0.0.1:3000/api/v1/social';

interface ApiOutcome {
  readonly status: number;
  readonly details: Record<string, readonly string[]>;
  readonly id: string | null;
}

async function writeToken(): Promise<string> {
  const token = await createApiToken(admin, {
    name: `x-${uuidv7().slice(-8)}`,
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  return token.plaintext;
}

async function outcomeOf(response: Response): Promise<ApiOutcome> {
  const text = await response.text();
  const parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  const error = parsed['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  const data = parsed['data'] as { readonly id?: string } | undefined;
  return { status: response.status, details: error?.details ?? {}, id: data?.id ?? null };
}

function jsonRequest(url: string, method: string, token: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** `POST /api/v1/social/posts`。`deliveryMode` は `fields` に書いたときだけ送る（省略の検査のため）。 */
async function createViaApi(
  accountId: string,
  fields: Record<string, unknown>,
): Promise<ApiOutcome> {
  const token = await writeToken();
  const response = await createSocialPostRoute(
    jsonRequest(`${BASE}/posts`, 'POST', token, {
      socialAccountId: accountId,
      body: 'X へ届く本文',
      scheduledAt: new Date(Date.now() + 600_000).toISOString(),
      status: 'scheduled',
      ...fields,
    }),
  );
  return outcomeOf(response);
}

/** `PATCH /api/v1/social/posts/{id}`。 */
async function updatePostViaApi(id: string, fields: Record<string, unknown>): Promise<ApiOutcome> {
  const token = await writeToken();
  const response = await updateSocialPostRoute(
    jsonRequest(`${BASE}/posts/${id}`, 'PATCH', token, fields),
    { params: Promise.resolve({ id }) },
  );
  return outcomeOf(response);
}

/** `PATCH /api/v1/social/accounts/{id}`。 */
async function updateAccountViaApi(
  id: string,
  fields: Record<string, unknown>,
): Promise<ApiOutcome> {
  const token = await writeToken();
  const response = await updateSocialAccountRoute(
    jsonRequest(`${BASE}/accounts/${id}`, 'PATCH', token, fields),
    { params: Promise.resolve({ id }) },
  );
  return outcomeOf(response);
}

function futureIso(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

/* -------------------------------------------------------------------------- */
/* 準備と後始末                                                                 */
/* -------------------------------------------------------------------------- */

beforeAll(async () => {
  scratch = await useScratchDatabase('snsxswap');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  // **偽の X API を置く前に、まず投げる `fetch` を置く**（#89）。`useFakeXApi()` がこれを上書きする。
  globalThis.fetch = throwingFetch();
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  // **戻し忘れると後続のテストが道連れになる**（実装プラン §7 の 16）。
  globalThis.fetch = realFetch;
  resetPluginRuntime();
  resetPublisherRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #91 偽 X API は未知の宛先で投げる                                               */
/* -------------------------------------------------------------------------- */

describe('#91 結合テストの偽 X API は未知の宛先で投げる', () => {
  it('#91 知らないホスト（https://example.test/）への要求は同期で投げる', () => {
    useFakeXApi();

    expect(() => globalThis.fetch('https://example.test/')).toThrow(/知らない宛先/);
  });

  it('#91 api.x.com でも知らないパス（GET /2/users/me）は投げる', () => {
    // `/2/users/me` を呼ばない（設計 §3.2）。呼べば偽物が止める。
    useFakeXApi();

    expect(() => globalThis.fetch(`${X_API_ORIGIN}/2/users/me`)).toThrow(/知らない宛先/);
  });

  it('#91 知らない宛先で投げた要求は、要求の列に積まれない', () => {
    const calls = useFakeXApi();

    expect(() => globalThis.fetch('https://example.test/')).toThrow();
    expect(calls).toHaveLength(0);
  });

  it('#91 知っている宛先（POST /2/tweets）には応答を返す（対の条件）', async () => {
    const calls = useFakeXApi();

    const response = await globalThis.fetch(`${X_API_ORIGIN}/2/tweets`, { method: 'POST' });

    expect(response.status).toBe(201);
    expect(calls.map((call) => call.kind)).toEqual(['R3']);
  });
});

/* -------------------------------------------------------------------------- */
/* #68〜#71 Core のジョブを通した配信（sns-x-api）                                 */
/* -------------------------------------------------------------------------- */

describe('#68 sns-x-api をジョブを通して配信できる（画像 1 枚）', () => {
  async function publishOnce(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly calls: readonly XCall[];
  }> {
    const calls = useFakeXApi();
    await activate(API_ID);
    const accountId = await accountFor();
    const postId = await makePost(accountId, { withImage: true });

    const summary = await run();
    return { postId, summary, calls };
  }

  it('#68 summary.published が 1', async () => {
    const { summary } = await publishOnce();

    expect(summary.published).toBe(1);
  });

  it('#68 投稿が published になる', async () => {
    const { postId } = await publishOnce();

    expect((await postRow(postId)).status).toBe('published');
  });

  it('#68 external_id に tweet id、external_url に https://x.com/i/status/<id> が入る', async () => {
    const { postId } = await publishOnce();

    const row = await postRow(postId);
    expect(row.external_id).toBe(TWEET_ID);
    expect(row.external_url).toBe(`https://x.com/i/status/${TWEET_ID}`);
  });

  it('#68 audit_logs に credential_read が 1 行入る', async () => {
    await publishOnce();

    expect(await auditRows('credential_read')).toHaveLength(1);
  });

  it('#68 外へ出た要求は R1 → R2 → R3 の 3 本だけ', async () => {
    const { calls } = await publishOnce();

    expect(calls.map((call) => call.kind)).toEqual(['R1', 'R2', 'R3']);
  });

  it('#68 R2 / R3 の Authorization に、Core が復号した apiKey と accessToken が入る', async () => {
    // Core の経路（復号 → `publish()` の `credential`）で 4 値が Plugin に届いたことの証。
    const { calls } = await publishOnce();

    for (const call of calls.filter((c) => c.kind !== 'R1')) {
      expect(call.authorization ?? '', call.kind).toContain(
        `oauth_consumer_key="${INTEGRATION_CREDENTIAL.apiKey}"`,
      );
      expect(call.authorization ?? '', call.kind).toContain(
        `oauth_token="${INTEGRATION_CREDENTIAL.accessToken}"`,
      );
    }
  });
});

describe('#69 retryable の違いが Core の記録に写る', () => {
  async function publishWith(routes: Partial<Record<XRequestKind, Route>>): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly calls: readonly XCall[];
  }> {
    const calls = useFakeXApi(routes);
    await activate(API_ID);
    const accountId = await accountFor();
    const postId = await makePost(accountId, { withImage: true });

    const summary = await run();
    return { postId, summary, calls };
  }

  it('#69 R3 が 503 なら投稿は failed になる', async () => {
    const { postId } = await publishWith({ R3: () => htmlPage(503) });

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#69 R3 が 503 なら再試行しない（summary.failed が 1、retried が 0、next_attempt_at なし）', async () => {
    const { postId, summary } = await publishWith({ R3: () => htmlPage(503) });

    expect(summary.failed).toBe(1);
    expect(summary.retried).toBe(0);
    expect((await postRow(postId)).next_attempt_at).toBeNull();
  });

  it('#69 R2 が 503 なら投稿は scheduled のまま、next_attempt_at が入る', async () => {
    const { postId } = await publishWith({ R2: () => htmlPage(503) });

    const row = await postRow(postId);
    expect(row.status).toBe('scheduled');
    expect(row.next_attempt_at).toBeInstanceOf(Date);
  });

  it('#69 R2 が 503 なら summary.retried が 1', async () => {
    const { summary } = await publishWith({ R2: () => htmlPage(503) });

    expect(summary.retried).toBe(1);
  });

  it('#69 R2 が 503 なら R3 を送っていない', async () => {
    const { calls } = await publishWith({ R2: () => htmlPage(503) });

    expect(calls.map((call) => call.kind)).toEqual(['R1', 'R2']);
  });
});

describe('#70 R3 が 401 なら failed になり、理由に案内はあっても資格情報の値は無い', () => {
  async function failWith401(): Promise<string> {
    useFakeXApi({
      // X API の自由文が要求の値を混ぜ返す場合（設計 §6.9）。
      R3: () =>
        xProblem(401, {
          title: INTEGRATION_CREDENTIAL.accessToken,
          detail: `invalid ${INTEGRATION_CREDENTIAL.apiKey}`,
          errors: [{ message: INTEGRATION_CREDENTIAL.apiKeySecret }],
        }),
    });
    await activate(API_ID);
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();
    return postId;
  }

  it('#70 投稿が failed になる', async () => {
    const postId = await failWith401();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#70 failure_reason に「API Key」がある', async () => {
    // 運用者が次に何をすればよいかが読める文言でなければ、履歴を見ても直せない。
    const postId = await failWith401();

    expect((await postRow(postId)).failure_reason).toContain('API Key');
  });

  it('#70 failure_reason に 4 値のどれも含まれない', async () => {
    const postId = await failWith401();

    const reason = (await postRow(postId)).failure_reason ?? '';
    for (const value of CREDENTIAL_VALUES) {
      expect(reason).not.toContain(value);
    }
  });

  it('#70 failure_reason に Core の伏せ字（***）も無い（伏せ字に頼らず、値を最初から載せていない）', async () => {
    // Core は `failure_reason` の中の 4 値の完全一致を伏せる。**伏せ字があれば Plugin が値を載せていた。**
    const postId = await failWith401();

    expect((await postRow(postId)).failure_reason ?? '').not.toContain(MASK);
  });
});

describe('#71 sns-x-api は資格情報を書き換えない', () => {
  async function publishAndCompare(): Promise<{
    readonly before: string | null;
    readonly after: string | null;
  }> {
    useFakeXApi();
    await activate(API_ID);
    const accountId = await accountFor();
    const before = await storedCredential(accountId);
    const postId = await makePost(accountId, { withImage: true });

    await run();
    expect((await postRow(postId)).status).toBe('published');
    return { before, after: await storedCredential(accountId) };
  }

  it('#71 配信の前後で social_accounts.credential の暗号文が同じ', async () => {
    const { before, after } = await publishAndCompare();

    expect(before).not.toBeNull();
    expect(after).toBe(before);
  });

  it('#71 audit_logs に rotated: true の行が無い', async () => {
    await publishAndCompare();

    const rotated = (await auditRows('updated')).filter((row) => row.detail['rotated'] === true);
    expect(rotated).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #72〜#75 登録時の検査（API）                                                  */
/* -------------------------------------------------------------------------- */

describe('#72 sns-x-api が有効な状態で、validate() と Core の mediaMax が登録時に効く', () => {
  async function prepare(): Promise<string> {
    useFakeXApi();
    await activate(API_ID);
    return accountFor();
  }

  it('#72 重み 281 の本文は 422（details.body）', async () => {
    const accountId = await prepare();

    const result = await createViaApi(accountId, { deliveryMode: 'auto', body: 'a'.repeat(281) });

    expect(result.status).toBe(422);
    expect(result.details['body']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#72 重み 280 ちょうどなら登録できる（対の条件）', async () => {
    const accountId = await prepare();

    const result = await createViaApi(accountId, { deliveryMode: 'auto', body: 'a'.repeat(280) });

    expect(result.status).toBe(201);
  });

  it('#72 providerOptions: { replyTo: "1" } は 422（details["providerOptions.replyTo"]）', async () => {
    const accountId = await prepare();

    const result = await createViaApi(accountId, {
      deliveryMode: 'auto',
      providerOptions: { replyTo: '1' },
    });

    expect(result.status).toBe(422);
    expect(result.details['providerOptions.replyTo']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#72 media 5 件は 422（details.media。Core の k）', async () => {
    const accountId = await prepare();
    const media = Array.from({ length: 5 }, (_, index) => ({ url: imageUrlOf(index), alt: null }));

    const result = await createViaApi(accountId, { deliveryMode: 'auto', media });

    expect(result.status).toBe(422);
    // **文言は比べない**（Core の文言。実装プラン T21 の注意）。
    expect(result.details['media']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#72 media 4 件なら登録できる（対の条件）', async () => {
    const accountId = await prepare();
    const media = Array.from({ length: 4 }, (_, index) => ({ url: imageUrlOf(index), alt: null }));

    const result = await createViaApi(accountId, { deliveryMode: 'auto', media });

    expect(result.status).toBe(201);
  });
});

describe('#73 sns-x-manual が有効な状態では auto の登録を断る', () => {
  async function prepare(): Promise<string> {
    await activate(MANUAL_ID);
    return accountFor(null);
  }

  it('#73 deliveryMode を省略して登録すると 422（details.deliveryMode）', async () => {
    // Core の既定の deliveryMode は auto（設計 §9.3）。省略しただけで 24 時間待たされる道に入らない。
    const accountId = await prepare();

    const result = await createViaApi(accountId, {});

    expect(result.status).toBe(422);
    expect(result.details['deliveryMode']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#73 details.deliveryMode の文言が manual の指定と sns-x-api を案内する（設計 §9.3）', async () => {
    const accountId = await prepare();

    const result = await createViaApi(accountId, {});

    const message = (result.details['deliveryMode'] ?? []).join('\n');
    expect(message).toContain('manual');
    expect(message).toContain('sns-x-api');
  });

  it('#73 status: draft でも 422（details.deliveryMode）', async () => {
    // validate() に status が渡らないので、下書きも断る（設計 §9.3 / §11 #1）。
    const accountId = await prepare();

    const result = await createViaApi(accountId, { status: 'draft', scheduledAt: null });

    expect(result.status).toBe(422);
    expect(result.details['deliveryMode']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#73 deliveryMode: manual なら 201', async () => {
    const accountId = await prepare();

    const result = await createViaApi(accountId, { deliveryMode: 'manual' });

    expect(result.status).toBe(201);
  });
});

describe('#74 sns-x-manual が有効な状態で、既存の auto の予約を PATCH する', () => {
  /** どちらの Plugin も無効な間に auto の予約を置き、その後で sns-x-manual を有効化する。 */
  async function autoRegisteredWhileDisabled(): Promise<string> {
    const accountId = await accountFor(null);
    const registered = await createViaApi(accountId, { deliveryMode: 'auto' });
    expect(registered.status).toBe(201);

    await activate(MANUAL_ID);
    return registered.id ?? '';
  }

  it('#74 PATCH { status: "draft" }（取りやめ）は 200', async () => {
    // 取りやめは validate() を通らない（`035` 裁定 #12 の R-6）。出口を塞がない。
    const postId = await autoRegisteredWhileDisabled();

    const result = await updatePostViaApi(postId, { status: 'draft' });

    expect(result.status).toBe(200);
  });

  it('#74 PATCH { scheduledAt: <未来> }（予約し直し）は 422（details.deliveryMode）', async () => {
    const postId = await autoRegisteredWhileDisabled();

    const result = await updatePostViaApi(postId, { scheduledAt: futureIso() });

    expect(result.status).toBe(422);
    expect(result.details['deliveryMode']?.length ?? 0).toBeGreaterThan(0);
  });

  it('#74 PATCH { scheduledAt: <未来>, deliveryMode: "manual" } は 200', async () => {
    const postId = await autoRegisteredWhileDisabled();

    const result = await updatePostViaApi(postId, {
      scheduledAt: futureIso(),
      deliveryMode: 'manual',
    });

    expect(result.status).toBe(200);
  });
});

describe('#75 手動投稿に媒体は付けられない（Core の f が先）', () => {
  it.each([MANUAL_ID, API_ID] as const)(
    '#75 %s が有効な状態で manual ＋ media 1 件は 422（details.media）',
    async (id) => {
      useFakeXApi();
      await activate(id);
      const accountId = await accountFor(id === API_ID ? INTEGRATION_CREDENTIAL : null);

      const result = await createViaApi(accountId, {
        deliveryMode: 'manual',
        media: [{ url: IMAGE_URL, alt: null }],
      });

      expect(result.status).toBe(422);
      expect(result.details['media']?.length ?? 0).toBeGreaterThan(0);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #76 手動投稿の URL                                                           */
/* -------------------------------------------------------------------------- */

describe('#76 sns-x-manual の手動投稿の受け渡し', () => {
  const BODY = '予約した X の投稿 #テスト & 100%';

  async function handoff() {
    await activate(MANUAL_ID);
    const accountId = await accountFor(null);
    const postId = await makePost(accountId, { deliveryMode: 'manual', body: BODY });
    return resolveManualHandoff(admin, { id: postId });
  }

  it('#76 resolveManualHandoff が ok: true を返す', async () => {
    expect(await handoff()).toMatchObject({ ok: true });
  });

  it('#76 url が https://x.com/intent/tweet?text=<本文を encodeURIComponent したもの>', async () => {
    const outcome = await handoff();

    expect(outcome.ok ? outcome.url : '').toBe(
      `https://x.com/intent/tweet?text=${encodeURIComponent(BODY)}`,
    );
  });

  it('#76 note が X_MANUAL_NOTE', async () => {
    const outcome = await handoff();

    expect(outcome.ok ? outcome.note : null).toBe(X_MANUAL_NOTE);
  });
});

/* -------------------------------------------------------------------------- */
/* #77 無料版では auto は配信されず、資格情報も読まれない                             */
/* -------------------------------------------------------------------------- */

describe('#77 sns-x-manual が有効な状態の期限の来た auto の予約は no_publisher で飛ばされる', () => {
  /** 資格情報を持つアカウントに、どちらの Plugin も無効な間に auto の予約を置き、sns-x-manual を有効化して走らせる。 */
  async function runWithManual(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const accountId = await accountFor(INTEGRATION_CREDENTIAL);
    const postId = await makePost(accountId);
    await activate(MANUAL_ID);

    const summary = await run();
    return { postId, summary };
  }

  it('#77 summary.skipped が 1', async () => {
    const { summary } = await runWithManual();

    expect(summary.skipped).toBe(1);
  });

  it('#77 skip_reason が no_publisher', async () => {
    const { postId } = await runWithManual();

    expect((await postRow(postId)).skip_reason).toBe('no_publisher');
  });

  it('#77 資格情報を持つアカウントでも audit_logs に credential_read が 1 行も無い', async () => {
    await runWithManual();

    expect(await auditRows('credential_read')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #78〜#81 入れ替え（設計 §7.2）                                                */
/* -------------------------------------------------------------------------- */

/** 理由の文に、Plugin ID とは別に provider の `x` が語として現れるか。 */
function mentionsProviderX(reason: string): boolean {
  const withoutIds = reason.replaceAll(MANUAL_ID, '').replaceAll(API_ID, '');
  return /(^|[^\w-])x([^\w-]|$)/.test(withoutIds);
}

describe('#78 入れ替え（無料 → 有料）の順序を間違えると sns-x-api が disabled になり、何も失われない', () => {
  /** 1. sns-x-manual を有効化 → アカウントと manual の予約 → 2 を飛ばして sns-x-api を有効化しようとする。 */
  async function enableApiWhileManualIsEnabled(): Promise<{
    readonly outcome: { ok: boolean; reason?: string };
    readonly accountId: string;
    readonly postId: string;
    readonly urlBefore: string;
  }> {
    await activate(MANUAL_ID);
    const accountId = await accountFor(null);
    const postId = await makePost(accountId, { deliveryMode: 'manual', body: '入れ替えの前後' });
    const urlBefore = await handoffUrl(postId);

    const outcome = await activate(API_ID);
    return { outcome, accountId, postId, urlBefore };
  }

  it('#78 sns-x-api の有効化は失敗する', async () => {
    const { outcome } = await enableApiWhileManualIsEnabled();

    expect(outcome.ok).toBe(false);
  });

  it('#78 sns-x-api が disabled に保存される', async () => {
    await enableApiWhileManualIsEnabled();

    expect(await statusOf(API_ID)).toBe('disabled');
  });

  it('#78 失敗の理由に sns-x-manual と provider の x が現れる', async () => {
    const { outcome } = await enableApiWhileManualIsEnabled();

    const reason = outcome.reason ?? '';
    expect(reason).toContain(MANUAL_ID);
    expect(mentionsProviderX(reason), reason).toBe(true);
  });

  it('#78 findPublisher("x") は sns-x-manual のまま', async () => {
    await enableApiWhileManualIsEnabled();

    expect(findPublisher(PROVIDER)?.pluginId).toBe(MANUAL_ID);
  });

  it('#78 sns-x-manual は enabled のまま動き続け、手動投稿の URL も変わらない', async () => {
    const { postId, urlBefore } = await enableApiWhileManualIsEnabled();

    expect(await statusOf(MANUAL_ID)).toBe('enabled');
    expect(await handoffUrl(postId)).toBe(urlBefore);
  });
});

describe('#78 入れ替え（無料 → 有料）の正しい手順で、同じアカウントと同じ予約がそのまま使える', () => {
  /** 設計 §7.2 の 2〜3：sns-x-manual を無効化してから sns-x-api を有効化する。 */
  async function swapToApi(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly urlBefore: string;
    readonly afterDisable: string | null;
    readonly outcome: { ok: boolean; reason?: string };
  }> {
    await activate(MANUAL_ID);
    const accountId = await accountFor(null);
    const postId = await makePost(accountId, { deliveryMode: 'manual', body: '入れ替えの前後' });
    const urlBefore = await handoffUrl(postId);

    await deactivate(MANUAL_ID);
    const afterDisable = findPublisher(PROVIDER)?.pluginId ?? null;
    const outcome = await activate(API_ID);
    return { accountId, postId, urlBefore, afterDisable, outcome };
  }

  it('#78 sns-x-manual を無効化すると findPublisher("x") が null になる', async () => {
    const { afterDisable } = await swapToApi();

    expect(afterDisable).toBeNull();
  });

  it('#78 その後の sns-x-api の有効化は成功する', async () => {
    const { outcome } = await swapToApi();

    expect(outcome).toEqual({ ok: true });
  });

  it('#78 findPublisher("x") の pluginId が sns-x-api になる', async () => {
    await swapToApi();

    expect(findPublisher(PROVIDER)?.pluginId).toBe(API_ID);
  });

  it('#78 アカウントは作り直されない（同じアカウント ID が 1 件だけ）', async () => {
    const { accountId } = await swapToApi();

    expect(await accountIds()).toEqual([accountId]);
  });

  it('#78 予約は同じ投稿 ID のまま、同じアカウントに結びついている', async () => {
    const { accountId, postId } = await swapToApi();

    const row = await postRow(postId);
    expect(row.social_account_id).toBe(accountId);
    expect(row.status).toBe('scheduled');
  });

  it('#78 同じ投稿の resolveManualHandoff の URL が、入れ替え前と同じ文字列', async () => {
    const { postId, urlBefore } = await swapToApi();

    expect(await handoffUrl(postId)).toBe(urlBefore);
  });
});

describe('#79 入れ替えの後、資格情報を入れる前の auto は待たされ、入れた後に配信される', () => {
  /** #78 の手順で sns-x-api へ入れ替え、資格情報の無いアカウントに auto の予約を置いて 1 周期走らせる。 */
  async function swapThenRunWithoutCredential(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly calls: readonly XCall[];
  }> {
    const calls = useFakeXApi();
    await activate(MANUAL_ID);
    const accountId = await accountFor(null);
    await deactivate(MANUAL_ID);
    await activate(API_ID);
    const postId = await makePost(accountId);

    const summary = await run();
    return { accountId, postId, summary, calls };
  }

  it('#79 資格情報を入れる前は skip_reason = credential_missing で飛ばされる', async () => {
    const { postId, summary } = await swapThenRunWithoutCredential();

    expect(summary.skipped).toBe(1);
    expect((await postRow(postId)).skip_reason).toBe('credential_missing');
  });

  it('#79 資格情報を入れる前は X へ 1 本も要求が出ない', async () => {
    const { calls } = await swapThenRunWithoutCredential();

    expect(calls).toHaveLength(0);
  });

  it('#79 同じアカウントに 4 値を入れた後の周期で、同じ投稿が published になる', async () => {
    const { accountId, postId } = await swapThenRunWithoutCredential();

    await updateSocialAccount(admin, { id: accountId, credentials: INTEGRATION_CREDENTIAL });
    await rewindNextAttempt(postId);
    const summary = await run();

    expect(summary.published).toBe(1);
    const row = await postRow(postId);
    expect(row.status).toBe('published');
    expect(row.social_account_id).toBe(accountId);
  });
});

describe('#80 無料版の間に資格情報を先に入れておける', () => {
  it('#80 sns-x-manual が有効な状態で PATCH /api/v1/social/accounts/{id} に 4 値の credentials → 200', async () => {
    // sns-x-manual の credentialFields は空なので、Core は突き合わせずに保存する（`035` §5.6.3）。
    await activate(MANUAL_ID);
    const accountId = await accountFor(null);

    const result = await updateAccountViaApi(accountId, { credentials: INTEGRATION_CREDENTIAL });

    expect(result.status).toBe(200);
  });

  it('#80 その後 sns-x-api へ入れ替えると、資格情報を入れ直さずに auto の予約が配信される', async () => {
    const calls = useFakeXApi();
    await activate(MANUAL_ID);
    const accountId = await accountFor(null);
    const patched = await updateAccountViaApi(accountId, { credentials: INTEGRATION_CREDENTIAL });
    expect(patched.status).toBe(200);

    await deactivate(MANUAL_ID);
    await activate(API_ID);
    const postId = await makePost(accountId);
    const summary = await run();

    expect(summary.published).toBe(1);
    expect((await postRow(postId)).status).toBe('published');
    // 無料版の間に入れた 4 値で署名されている。
    const r3 = calls.find((call) => call.kind === 'R3');
    expect(r3?.authorization ?? '').toContain(
      `oauth_consumer_key="${INTEGRATION_CREDENTIAL.apiKey}"`,
    );
  });
});

describe('#81 入れ替え（有料 → 無料）', () => {
  /** sns-x-api の auto の予約を置いたまま、sns-x-api を無効化して sns-x-manual を有効化し、1 周期走らせる。 */
  async function swapToManualThenRun(): Promise<{
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    readonly calls: readonly XCall[];
  }> {
    const calls = useFakeXApi();
    await activate(API_ID);
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await deactivate(API_ID);
    await activate(MANUAL_ID);
    const summary = await run();
    return { postId, summary, calls };
  }

  it('#81 入れ替えた後の findPublisher("x") が sns-x-manual', async () => {
    await swapToManualThenRun();

    expect(findPublisher(PROVIDER)?.pluginId).toBe(MANUAL_ID);
  });

  it('#81 残った auto の予約は no_publisher で飛ばされる', async () => {
    const { postId, summary } = await swapToManualThenRun();

    expect(summary.skipped).toBe(1);
    expect((await postRow(postId)).skip_reason).toBe('no_publisher');
  });

  it('#81 残った auto の予約のために X へ要求が出ない', async () => {
    const { calls } = await swapToManualThenRun();

    expect(calls).toHaveLength(0);
  });

  it('#81 sns-x-manual を有効にしたまま sns-x-api を有効化しようとすると sns-x-api が disabled', async () => {
    await activate(MANUAL_ID);

    const outcome = await activate(API_ID);

    expect(outcome.ok).toBe(false);
    expect(await statusOf(API_ID)).toBe('disabled');
    expect(findPublisher(PROVIDER)?.pluginId).toBe(MANUAL_ID);
  });
});

/* -------------------------------------------------------------------------- */
/* #82 同じ provider の第三の Plugin                                             */
/* -------------------------------------------------------------------------- */

describe('#82 同じ provider: x を第三の Plugin が登録できない', () => {
  const RIVAL_ID = 'rival-x-plugin';

  function rivalRegistration(): PublisherRegistration {
    return { provider: PROVIDER, label: 'x', credentialFields: [] };
  }

  async function enableRival(enabledFirst: XPluginId): Promise<{
    readonly outcome: { ok: boolean; reason?: string };
    readonly captured: unknown;
  }> {
    await activate(enabledFirst);

    const manifest: PluginManifest = {
      id: RIVAL_ID,
      name: RIVAL_ID,
      version: '1.0.0',
      apiVersion: 1,
      extensions: ['social'],
    };
    let captured: unknown = null;
    const plugin: Plugin = {
      activate(context) {
        try {
          context.social.registerPublisher(rivalRegistration());
        } catch (error) {
          captured = error;
          throw error;
        }
      },
    };

    const outcome = await withConnection(async (connection) => {
      await installPlugin(connection, manifest);
      return enablePlugin({
        connection,
        manifest,
        plugin,
        authorization: admin,
        candidates: candidatesOf(manifest, false),
      });
    });

    return { outcome, captured };
  }

  it.each([MANUAL_ID, API_ID] as const)(
    '#82 %s が有効なとき、PluginPublisherConflictError が投げられ、その registeredBy が有効な側の ID',
    async (id) => {
      const { captured } = await enableRival(id);

      expect(captured).toBeInstanceOf(PluginPublisherConflictError);
      expect((captured as PluginPublisherConflictError).registeredBy).toBe(id);
    },
  );

  it.each([MANUAL_ID, API_ID] as const)(
    '#82 %s が有効なとき、第三の Plugin の有効化は失敗し、有効な側の登録が残る',
    async (id) => {
      const { outcome } = await enableRival(id);

      expect(outcome.ok).toBe(false);
      expect(findPublisher(PROVIDER)?.pluginId).toBe(id);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #83 表示名                                                                   */
/* -------------------------------------------------------------------------- */

describe('#83 入れ替えても provider の表示名は X', () => {
  it('#83 sns-x-manual が有効なとき providerLabel("x", publisherLabels()) が X', async () => {
    await activate(MANUAL_ID);

    expect(findPublisher(PROVIDER)?.pluginId).toBe(MANUAL_ID);
    expect(providerLabel(PROVIDER, publisherLabels())).toBe('X');
  });

  it('#83 sns-x-api へ入れ替えた後も providerLabel("x", publisherLabels()) が X', async () => {
    await activate(MANUAL_ID);
    await deactivate(MANUAL_ID);
    await activate(API_ID);

    expect(findPublisher(PROVIDER)?.pluginId).toBe(API_ID);
    expect(providerLabel(PROVIDER, publisherLabels())).toBe('X');
  });

  it('#83 どちらも無効なときも providerLabel("x", publisherLabels()) が X（Core の PROVIDER_LABELS）', async () => {
    await activate(API_ID);
    await deactivate(API_ID);

    expect(findPublisher(PROVIDER)).toBeNull();
    expect(providerLabel(PROVIDER, publisherLabels())).toBe('X');
  });
});
