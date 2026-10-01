import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { POST as createWebhookRoute } from '@/app/api/v1/webhooks/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, listManualPendingPosts } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { generateApiToken } from '@/domain/api-token';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 承認 `POST /api/v1/social/posts/{id}/approve`（048-social-post-approval 設計 §6.4・§6.7・§6.8・§6.9・§8）。
 *
 * 受け入れ条件 #35〜#48・#52・#53。
 *
 * **ルートを直接叩く結合テスト。** 承認待ちの投稿は `POST /social/posts`（`publishTiming: 'after_approval'`）で作る
 * （実装プラン T13）。偽の publisher は provider ごとに登録する（手動投稿だけ／両方）。
 * 「いま」で決まる時刻は**要求の直前と直後に取った時刻の間**にあることで見る。
 *
 * 承認のルート（`approve/route.ts`）はまだ無いので、呼ぶ直前に動的に読む。静的に import すると、
 * 未実装の段階でこのファイル全体が読めなくなり、どの条件が落ちたのかを読めなくなる。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-approve';
const PASSWORD = 'social approve correct horse battery staple';

const MANUAL_ONLY_PROVIDER = 'apr_appr_manual';
const BOTH_PROVIDER = 'apr_appr_both';

const HOUR = 60 * 60_000;

const STALE_MESSAGE = '投稿の内容が変わっています。内容を確かめてから承認し直してください。';

let scratch: ScratchDatabase;
let admin: TestUser;
let manualOnlyAccountId: string;
let bothAccountId: string;
/** `social.read` + `social.write`（外部アプリのトークンの形）。 */
let writeToken: string;
/** `social.read` + `social.write` + `social.approve`（所有者は管理者）。 */
let approveToken: string;
/** 偽の publisher の `publish()` が呼ばれた回数。 */
let publishCalls: number;

interface TestUser {
  readonly id: string;
  readonly loginId: string;
  readonly context: AuthorizationContext;
}

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
}

function errorOf(result: JsonResult): {
  readonly code?: string;
  readonly details?: Record<string, readonly string[]>;
} {
  return (result.body['error'] ?? {}) as {
    readonly code?: string;
    readonly details?: Record<string, readonly string[]>;
  };
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  return errorOf(result).details ?? {};
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function createUser(roleNames: readonly string[]): Promise<TestUser> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `p${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social approve test',
        password_hash: passwordHash,
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
    loginId,
    displayName: 'social approve test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { id, loginId, context };
}

/** 利用者のロールを差し替える（#52 の「発行の後に所有者が閲覧者になった」トークン。実装プラン §8 の 10）。 */
async function replaceRoles(userId: string, roleNames: readonly string[]): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('user_roles').where('user_id', '=', userId).execute();
    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) throw new Error(`ロールが無い: ${roleName}`);
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: userId, role_id: role.id })
        .execute();
    }
  });
}

async function issueToken(owner: TestUser, scopes: readonly string[]): Promise<string> {
  const created = await createApiToken(owner.context, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return created.plaintext;
}

/** 実際にログインして、有効なセッショントークンを得る。 */
async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: '203.0.113.48', userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

function manualOnlyPublisher(): PublisherRegistration {
  return {
    provider: MANUAL_ONLY_PROVIDER,
    label: '手動投稿だけ（テスト）',
    credentialFields: [],
    manual: () => ({ url: 'https://example.com/intent/post' }),
  };
}

function bothPublisher(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
    publish: async () => {
      publishCalls += 1;
      return { ok: true, externalId: `e${publishCalls}` };
    },
    manual: () => ({ url: 'https://example.com/intent/post' }),
    ...overrides,
  };
}

/** 両方の publisher を差し替える（手動投稿だけの publisher は残す）。 */
function replaceBothPublisher(registration: PublisherRegistration): void {
  resetPublisherRegistry();
  registerPublisher('test-plugin', manualOnlyPublisher());
  registerPublisher('test-plugin', registration);
}

type Auth =
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'session'; readonly session: string; readonly csrf?: boolean }
  | { readonly kind: 'none' };

/** 承認のルートを呼ぶ（動的に読む。冒頭の注記）。 */
async function callApprove(id: string, body: unknown, auth?: Auth): Promise<JsonResult> {
  const { POST } = (await import('@/app/api/v1/social/posts/[id]/approve/route')) as {
    readonly POST: (
      request: Request,
      context: { params: Promise<{ id: string }> },
    ) => Promise<Response>;
  };
  const how: Auth = auth ?? { kind: 'token', token: approveToken };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (how.kind === 'token') {
    headers['authorization'] = `Bearer ${how.token}`;
  }
  if (how.kind === 'session') {
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['cookie'] = `torifune_session=${how.session}; torifune_csrf=${CSRF}`;
    if (how.csrf !== false) {
      headers['x-csrf-token'] = CSRF;
    }
  }
  const response = await POST(
    new Request(`${BASE}/${id}/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return toResult(response);
}

async function callCreate(body: Record<string, unknown>): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

async function callGet(id: string): Promise<Record<string, unknown>> {
  const response = await getSocialPostRoute(
    new Request(`${BASE}/${id}`, { headers: { authorization: `Bearer ${writeToken}` } }),
    { params: Promise.resolve({ id }) },
  );
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

interface Awaiting {
  readonly id: string;
  readonly updatedAt: string;
}

/** 承認待ちの投稿を API で作り、`GET` の `updatedAt` を添えて返す。 */
async function makeAwaiting(overrides: Record<string, unknown> = {}): Promise<Awaiting> {
  const created = await callCreate({
    socialAccountId: bothAccountId,
    body: '新製品のお知らせです。',
    publishTiming: 'after_approval',
    ...overrides,
  });
  if (created.status !== 201) {
    throw new Error(`承認待ちの投稿を作れない: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = String(dataOf(created)['id']);
  const read = await callGet(id);
  return { id, updatedAt: String(read['updatedAt']) };
}

function future(offsetMs = HOUR): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function past(offsetMs = HOUR): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

interface PostRow {
  readonly status: string;
  readonly scheduled_at: Date | null;
  readonly approved_at: Date | null;
  readonly skip_count: number;
  readonly updated_at: Date;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, scheduled_at, approved_at, skip_count, updated_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

async function approvedAuditRows(): Promise<
  { actor_user_id: string | null; detail: Record<string, unknown> }[]
> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['actor_user_id', 'detail'])
      .where('resource_type', '=', 'social_post')
      .where('action', '=', 'approved')
      .execute(),
  );
}

function within(value: unknown, before: number, after: number): void {
  const time = Date.parse(String(value));
  expect(time).toBeGreaterThanOrEqual(before);
  expect(time).toBeLessThanOrEqual(after);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostapprove');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  publishCalls = 0;
  admin = await createUser(['administrator']);
  // 資格情報は登録された publisher の宣言で検査されるので、publisher を先に登録する。
  registerPublisher('test-plugin', manualOnlyPublisher());
  registerPublisher('test-plugin', bothPublisher());
  manualOnlyAccountId = (
    await createSocialAccount(admin.context, {
      provider: MANUAL_ONLY_PROVIDER,
      displayName: '手動投稿だけ',
      handle: '@approve',
      credential: null,
      status: 'connected',
    })
  ).id;
  bothAccountId = (
    await createSocialAccount(admin.context, {
      provider: BOTH_PROVIDER,
      displayName: '両方',
      handle: '@approve',
      credential: null,
      credentials: { token: 'secret-token' },
      status: 'connected',
    })
  ).id;
  writeToken = await issueToken(admin, ['social.read', 'social.write']);
  approveToken = await issueToken(admin, ['social.read', 'social.write', 'social.approve']);
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('webhooks').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #35 即投稿で承認する
// ---------------------------------------------------------------------------

describe('#35 publishTiming: now で承認する', () => {
  it('#35 200・status: scheduled・scheduledAt と approvedAt が要求の前後の間・nextAttemptAt: null', async () => {
    const post = await makeAwaiting({ scheduledAt: future() });

    const before = Date.now();
    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });
    const after = Date.now();

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', nextAttemptAt: null });
    within(dataOf(result)['scheduledAt'], before, after);
    within(dataOf(result)['approvedAt'], before, after);
  });

  it('#35 (B) 続けて publishDuePosts を回すと publish() が 1 回呼ばれ published になる', async () => {
    const post = await makeAwaiting();
    await callApprove(post.id, { publishTiming: 'now', expectedUpdatedAt: post.updatedAt });

    await withConnection((connection) => publishDuePosts(connection));

    expect(publishCalls).toBe(1);
    expect((await rowOf(post.id)).status).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// #36・#37 指定の時間に投稿で承認する
// ---------------------------------------------------------------------------

describe('#36 publishTiming: scheduled で承認する', () => {
  it('#36 登録の希望日時が未来 → その日時', async () => {
    const desired = future(2 * HOUR);
    const post = await makeAwaiting({ scheduledAt: desired });

    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt: desired });
  });

  it('#36 要求の scheduledAt が未来 → 要求の値（希望日時より優先）', async () => {
    const post = await makeAwaiting({ scheduledAt: future(2 * HOUR) });
    const requested = future(3 * HOUR);

    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      scheduledAt: requested,
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt: requested });
  });
});

describe('#37 publishTiming: scheduled の 422 scheduledAt', () => {
  it('#37 希望日時が過去で要求に日時なし → 422 scheduledAt・承認待ちのまま', async () => {
    const post = await makeAwaiting({ scheduledAt: past() });

    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('scheduledAt');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#37 希望日時が null で要求に日時なし → 422 scheduledAt・承認待ちのまま', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('scheduledAt');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#37 要求の日時が過去 → 422 scheduledAt・承認待ちのまま', async () => {
    const post = await makeAwaiting({ scheduledAt: future() });

    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      scheduledAt: past(),
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['scheduledAt']).toContain(
      '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。',
    );
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #38・#39 手動投稿
// ---------------------------------------------------------------------------

describe('#38 手動投稿だけの publisher の provider では承認が即投稿になる', () => {
  async function manualOnlyAwaiting(): Promise<Awaiting> {
    return makeAwaiting({
      socialAccountId: manualOnlyAccountId,
      deliveryMode: 'manual',
      publishTiming: 'scheduled',
      scheduledAt: future(),
    });
  }

  it('#38 scheduled ＋ 未来の日時 → 200・scheduledAt がいまの時刻', async () => {
    const post = await manualOnlyAwaiting();

    const before = Date.now();
    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      scheduledAt: future(2 * HOUR),
      expectedUpdatedAt: post.updatedAt,
    });
    const after = Date.now();

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('scheduled');
    within(dataOf(result)['scheduledAt'], before, after);
  });

  it('#38 (B) 直後の listManualPendingPosts に含まれる', async () => {
    const post = await manualOnlyAwaiting();
    await callApprove(post.id, {
      publishTiming: 'scheduled',
      scheduledAt: future(2 * HOUR),
      expectedUpdatedAt: post.updatedAt,
    });

    const pending = await listManualPendingPosts(admin.context, { limit: 50 });

    expect(pending.items.map((item) => item.id)).toContain(post.id);
  });
});

describe('#39 両方の publisher の手動投稿は指定の時間に回る', () => {
  it('#39 deliveryMode: manual ＋ scheduled ＋ 未来 → 200・scheduled・その日時・手動投稿待ちに含まれない', async () => {
    const post = await makeAwaiting({ deliveryMode: 'manual' });
    const requested = future(2 * HOUR);

    const result = await callApprove(post.id, {
      publishTiming: 'scheduled',
      scheduledAt: requested,
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt: requested });
    const pending = await listManualPendingPosts(admin.context, { limit: 50 });
    expect(pending.items.map((item) => item.id)).not.toContain(post.id);
  });
});

// ---------------------------------------------------------------------------
// #40 承認待ちでない投稿
// ---------------------------------------------------------------------------

describe('#40 承認待ちでない投稿は 422 status', () => {
  it.each([
    { status: 'draft', extra: {} },
    { status: 'scheduled', extra: { scheduledAt: new Date(Date.now() + HOUR).toISOString() } },
    { status: 'published', extra: {} },
  ])('#40 $status の投稿 → 422 status', async ({ status, extra }) => {
    const created = await callCreate({
      socialAccountId: bothAccountId,
      body: '承認待ちでない投稿',
      status,
      ...extra,
    });
    const id = String(dataOf(created)['id']);
    const read = await callGet(id);

    const result = await callApprove(id, {
      publishTiming: 'now',
      expectedUpdatedAt: read['updatedAt'],
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('status');
    expect((await rowOf(id)).status).toBe(status);
  });
});

// ---------------------------------------------------------------------------
// #41 expectedUpdatedAt
// ---------------------------------------------------------------------------

describe('#41 見た内容を承認する（expectedUpdatedAt）', () => {
  it('#41 1ms 違う → 409 CONFLICT・details.expectedUpdatedAt', async () => {
    const post = await makeAwaiting();
    const stale = new Date(Date.parse(post.updatedAt) - 1).toISOString();

    const result = await callApprove(post.id, { publishTiming: 'now', expectedUpdatedAt: stale });

    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('CONFLICT');
    expect(detailsOf(result)['expectedUpdatedAt']).toContain(STALE_MESSAGE);
  });

  it('#41 409 の後も行は変わらない', async () => {
    const post = await makeAwaiting();
    const before = await rowOf(post.id);

    await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: new Date(Date.parse(post.updatedAt) + 1).toISOString(),
    });

    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#41 欠落 → 422 expectedUpdatedAt', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(post.id, { publishTiming: 'now' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('expectedUpdatedAt');
  });

  it('#41 作成直後（updated_at がマイクロ秒を持つ）の投稿を GET の updatedAt で承認すると 200', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(200);
  });

  it('#41 対照：updated_at にマイクロ秒を書き込んだ行をミリ秒の ISO で承認すると 200', async () => {
    const post = await makeAwaiting();
    await withConnection(async (connection) => {
      await sql`UPDATE social_posts SET updated_at = '2026-10-01T09:00:00.123456Z' WHERE id = ${post.id}`.execute(
        connection.db,
      );
    });

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: '2026-10-01T09:00:00.123Z',
    });

    expect(result.status).toBe(200);
  });

  it('#41 書き換えられた後の承認：PATCH の後に古い updatedAt で承認すると 409', async () => {
    const post = await makeAwaiting();
    const { PATCH } = await import('@/app/api/v1/social/posts/[id]/route');
    await PATCH(
      new Request(`${BASE}/${post.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
        body: JSON.stringify({ body: '見た後に書き換えた本文' }),
      }),
      { params: Promise.resolve({ id: post.id }) },
    );

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(409);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #42 同時の承認（B）
// ---------------------------------------------------------------------------

describe('#42 同じ投稿を 2 本の承認で同時に呼ぶ', () => {
  it('#42 ちょうど 1 本が 200 で、もう 1 本は 422 status か 409', async () => {
    const post = await makeAwaiting();
    const body = { publishTiming: 'now', expectedUpdatedAt: post.updatedAt };

    const results = await Promise.all([callApprove(post.id, body), callApprove(post.id, body)]);

    const statuses = results.map((result) => result.status).sort();
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    const loser = results.find((result) => result.status !== 200);
    expect(loser).toBeDefined();
    if (loser !== undefined) {
      const ok =
        (loser.status === 422 && Object.keys(detailsOf(loser)).includes('status')) ||
        loser.status === 409;
      expect(ok, `負けた側の応答: ${loser.status} ${JSON.stringify(loser.body)}`).toBe(true);
    }
  });

  it('#42 approved_at は 1 回だけ入り、監査 approved も 1 行', async () => {
    const post = await makeAwaiting();
    const body = { publishTiming: 'now', expectedUpdatedAt: post.updatedAt };

    const results = await Promise.all([callApprove(post.id, body), callApprove(post.id, body)]);

    const winner = results.find((result) => result.status === 200);
    const row = await rowOf(post.id);
    expect(row.approved_at).not.toBeNull();
    expect(row.approved_at?.toISOString()).toBe(
      winner === undefined ? undefined : dataOf(winner)['approvedAt'],
    );
    expect(await approvedAuditRows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #43 publishTiming の形
// ---------------------------------------------------------------------------

describe('#43 承認の publishTiming の 422', () => {
  it('#43 after_approval → 422 publishTiming', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(post.id, {
      publishTiming: 'after_approval',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('publishTiming');
  });

  it('#43 欠落 → 422 publishTiming', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(post.id, { expectedUpdatedAt: post.updatedAt });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('publishTiming');
  });
});

// ---------------------------------------------------------------------------
// #44 承認の時点の配信 Plugin の検査
// ---------------------------------------------------------------------------

describe('#44 承認の時点で配信 Plugin の検査が掛かる', () => {
  it('#44 validate() が問題を返す publisher → 422（validate() のキー）で承認待ちのまま', async () => {
    const post = await makeAwaiting();
    replaceBothPublisher(
      bothPublisher({ validate: () => [{ field: 'body', message: '本文が規則に反します' }] }),
    );

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['body']).toContain('本文が規則に反します');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#44 deliveryMode: manual の投稿で publisher が manual を持たない → 422 deliveryMode', async () => {
    const post = await makeAwaiting({ deliveryMode: 'manual' });
    replaceBothPublisher({
      provider: BOTH_PROVIDER,
      label: '自動だけ（テスト）',
      credentialFields: [],
      publish: async () => ({ ok: true }),
    });

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('deliveryMode');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #45 ID
// ---------------------------------------------------------------------------

describe('#45 存在しない投稿', () => {
  it('#45 存在しない UUID → 404', async () => {
    const result = await callApprove(uuidv7(), {
      publishTiming: 'now',
      expectedUpdatedAt: new Date().toISOString(),
    });

    expect(result.status).toBe(404);
  });

  it('#45 UUID の形でない ID → 404', async () => {
    const result = await callApprove('not-a-uuid', {
      publishTiming: 'now',
      expectedUpdatedAt: new Date().toISOString(),
    });

    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// #46 イベント（B）
// ---------------------------------------------------------------------------

describe('#46 social.post.approved', () => {
  it('#46 承認が成功すると { postId, accountId, status: scheduled } で 1 回だけ発火する', async () => {
    const received: unknown[] = [];
    subscribe('social.post.approved' as never, (payload: unknown) => {
      received.push(payload);
    });
    const post = await makeAwaiting();

    await callApprove(post.id, { publishTiming: 'now', expectedUpdatedAt: post.updatedAt });

    expect(received).toEqual([{ postId: post.id, accountId: bothAccountId, status: 'scheduled' }]);
  });

  it('#46 422 / 409 では発火しない', async () => {
    const received: unknown[] = [];
    subscribe('social.post.approved' as never, (payload: unknown) => {
      received.push(payload);
    });
    const post = await makeAwaiting();

    await callApprove(post.id, { publishTiming: 'scheduled', expectedUpdatedAt: post.updatedAt });
    await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: new Date(Date.parse(post.updatedAt) - 1).toISOString(),
    });

    expect(received).toEqual([]);
  });

  it("#46 POST /api/v1/webhooks に events: ['social.post.approved'] を送ると 201", async () => {
    const session = await issueSessionToken(admin.loginId);

    const response = await createWebhookRoute(
      new Request('http://127.0.0.1:3000/api/v1/webhooks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-host': '127.0.0.1:3000',
          origin: ORIGIN,
          cookie: `torifune_session=${session}; torifune_csrf=${CSRF}`,
          'x-csrf-token': CSRF,
        },
        body: JSON.stringify({
          name: '承認の通知',
          url: 'https://hooks.example.com/torifune',
          events: ['social.post.approved'],
        }),
      }),
    );

    expect(response.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// #47 監査（B）
// ---------------------------------------------------------------------------

describe('#47 監査 approved', () => {
  it('#47 1 行、actorUserId が承認した人、detail が 6 つのキー（トークンは via: api_token）', async () => {
    const post = await makeAwaiting();
    const read = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });

    const rows = await approvedAuditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(admin.id);
    expect(Object.keys(rows[0]?.detail ?? {}).sort()).toEqual(
      [
        'requestedTiming',
        'effectiveTiming',
        'scheduledAt',
        'deliveryMode',
        'approvalForced',
        'via',
      ].sort(),
    );
    expect(rows[0]?.detail).toMatchObject({
      requestedTiming: 'now',
      effectiveTiming: 'now',
      scheduledAt: dataOf(read)['scheduledAt'],
      deliveryMode: 'auto',
      approvalForced: false,
      via: 'api_token',
    });
  });

  it("#47 条件 38 では requestedTiming: 'scheduled'・effectiveTiming: 'now'・approvalForced: true", async () => {
    const post = await makeAwaiting({
      socialAccountId: manualOnlyAccountId,
      deliveryMode: 'manual',
      publishTiming: 'scheduled',
      scheduledAt: future(),
    });

    await callApprove(post.id, {
      publishTiming: 'scheduled',
      scheduledAt: future(2 * HOUR),
      expectedUpdatedAt: post.updatedAt,
    });

    const rows = await approvedAuditRows();
    expect(rows[0]?.detail).toMatchObject({
      requestedTiming: 'scheduled',
      effectiveTiming: 'now',
      deliveryMode: 'manual',
      approvalForced: true,
    });
  });

  it("#47 セッションでの承認は via: 'session'、actorUserId は承認した編集者", async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const post = await makeAwaiting();

    await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'session', session },
    );

    const rows = await approvedAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(editor.id);
    expect(rows[0]?.detail['via']).toBe('session');
  });

  it('#47 422 では監査 approved を残さない', async () => {
    const post = await makeAwaiting();

    await callApprove(post.id, { publishTiming: 'scheduled', expectedUpdatedAt: post.updatedAt });

    expect(await approvedAuditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #48 飛ばした回数（B）
// ---------------------------------------------------------------------------

describe('#48 承認は飛ばした回数を触らない', () => {
  it('#48 skip_count: 2 を持った承認待ちの投稿を承認しても skip_count は 2 のまま', async () => {
    const post = await makeAwaiting();
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({ skip_count: 2, skip_reason: 'no_publisher' })
        .where('id', '=', post.id)
        .execute();
    });
    const read = await callGet(post.id);

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: read['updatedAt'],
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)['skipCount']).toBe(2);
    expect((await rowOf(post.id)).skip_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #52・#53 権限
// ---------------------------------------------------------------------------

describe('#52 トークンの Scope と所有者の Permission', () => {
  it('#52 Scope social.read + social.write のトークン（所有者は管理者）→ 403', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'token', token: writeToken },
    );

    expect(result.status).toBe(403);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#52 Scope に social.approve を含むトークン（所有者は管理者）→ 200', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(post.id, {
      publishTiming: 'now',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(200);
  });

  it('#52 Scope に social.approve を含むが所有者が閲覧者のトークン → 403', async () => {
    const owner = await createUser(['administrator']);
    const token = await issueToken(owner, ['social.read', 'social.write', 'social.approve']);
    await replaceRoles(owner.id, ['viewer']);
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'token', token },
    );

    expect(result.status).toBe(403);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

describe('#53 セッション・未認証', () => {
  it('#53 編集者のセッション → 200', async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'session', session },
    );

    expect(result.status).toBe(200);
  });

  it('#53 閲覧者のセッション → 403', async () => {
    const viewer = await createUser(['viewer']);
    const session = await issueSessionToken(viewer.loginId);
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'session', session },
    );

    expect(result.status).toBe(403);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#53 形の合った無効なトークン → 401', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'token', token: generateApiToken().plaintext },
    );

    expect(result.status).toBe(401);
  });

  it('#53 Authorization もセッションも無い → 403 CSRF_FAILED', async () => {
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'none' },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
  });

  it('#53 セッションでも CSRF トークンが無ければ 403 CSRF_FAILED', async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const post = await makeAwaiting();

    const result = await callApprove(
      post.id,
      { publishTiming: 'now', expectedUpdatedAt: post.updatedAt },
      { kind: 'session', session, csrf: false },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});
