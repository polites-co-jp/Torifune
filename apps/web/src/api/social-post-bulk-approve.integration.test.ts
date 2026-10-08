import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, listManualPendingPosts } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 一括承認 `POST /api/v1/social/posts/bulk/approve`（054-bulk-post-actions 設計 §5.1・§5.2・§8.1・§8.1.1・§8.2・§8.10・§8.11）。
 *
 * 受け入れ条件 #17〜#24・#47、#50・#52 の承認の分。
 *
 * **ルートを直接叩く結合テスト**（`social-post-approve.integration.test.ts` の叩き方を写す。import はしない）。
 * 承認待ちの投稿は外部アプリのトークン（`social.read` + `social.write`）の `POST /social/posts`
 * （`publishTiming: 'after_approval'`）で作る。一括の操作は**セッションだけ**なので、既定は管理者のセッションで叩く。
 * 偽の publisher は provider ごとに登録する（手動投稿だけ／両方）。
 *
 * Rate Limit（60 秒 30 回。操作 × 送信元 IP）に掛からないよう、#52 以外の要求は件ごとに `x-forwarded-for` を変える
 * （`api-token-site.integration.test.ts` の `nextIp()` を写す）。#52 だけは同じ IP で 31 回叩く。
 *
 * 一括承認のルート（`bulk/approve/route.ts`）はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （未作成の段階で `pnpm typecheck` を落とさない。053 実装プラン §8 の 19）。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-bulk-approve';
const PASSWORD = 'social bulk approve correct horse battery staple';

const MANUAL_ONLY_PROVIDER = 'bulk_appr_manual';
const BOTH_PROVIDER = 'bulk_appr_both';

const HOUR = 60 * 60_000;

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 1 件の承認の 422 `scheduledAt` の文言（048 設計 §6.4.5）。 */
const PAST_MESSAGE = '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。';
const MISSING_MESSAGE = '承認して予約するときは日時を指定してください。';
/** 1 件の 404 の文言（実装プラン §8 の 7）。 */
const NOT_FOUND_MESSAGE = '見つかりませんでした。';

const BULK_APPROVE_ROUTE: string = '@/app/api/v1/social/posts/bulk/approve/route';

let scratch: ScratchDatabase;
let admin: TestUser;
let adminSession: string;
let manualOnlyAccountId: string;
let bothAccountId: string;
/** `social.read` + `social.write`（外部アプリのトークンの形）。投稿の登録に使う。 */
let writeToken: string;
let ipSequence = 0;

interface TestUser {
  readonly id: string;
  readonly loginId: string;
  readonly context: AuthorizationContext;
}

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

interface BulkResult {
  readonly id: string;
  readonly ok: boolean;
  readonly effect?: string;
  readonly post?: Record<string, unknown> | null;
  readonly reason?: string;
  readonly message?: string;
  readonly field?: string | null;
}

function nextIp(): string {
  ipSequence += 1;
  return `10.56.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return (result.body['data'] ?? {}) as Record<string, unknown>;
}

function resultsOf(result: JsonResult): BulkResult[] {
  return (dataOf(result)['results'] ?? []) as BulkResult[];
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

function detailKeysOf(result: JsonResult): string[] {
  return Object.keys(errorOf(result).details ?? {}).sort();
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}

async function createUser(roleNames: readonly string[]): Promise<TestUser> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `b${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social bulk approve test',
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
    displayName: 'social bulk approve test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { id, loginId, context };
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
    request: { ipAddress: nextIp(), userAgent: 'vitest' },
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
    publish: async () => ({ ok: true, externalId: 'e1' }),
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
  | { readonly kind: 'session'; readonly session: string; readonly csrf?: boolean }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

/** 一括承認のルートを呼ぶ（動的に読む。冒頭の注記）。 */
async function callBulkApprove(
  body: unknown,
  options: { readonly auth?: Auth; readonly ip?: string } = {},
): Promise<JsonResult> {
  const { POST } = (await import(/* @vite-ignore */ BULK_APPROVE_ROUTE)) as {
    readonly POST: (request: Request) => Promise<Response>;
  };
  const how: Auth = options.auth ?? { kind: 'session', session: adminSession };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip ?? nextIp(),
  };
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
    new Request(`${BASE}/bulk/approve`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

async function callCreate(body: Record<string, unknown>): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(BASE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${writeToken}`,
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

async function callGet(id: string): Promise<Record<string, unknown>> {
  const response = await getSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      headers: { authorization: `Bearer ${writeToken}`, 'x-forwarded-for': nextIp() },
    }),
    { params: Promise.resolve({ id }) },
  );
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

interface Item {
  readonly id: string;
  readonly expectedUpdatedAt: string;
}

/** 投稿を API で作り、`GET` の `updatedAt` を添えて返す。 */
async function makePost(overrides: Record<string, unknown> = {}): Promise<Item> {
  const created = await callCreate({
    socialAccountId: bothAccountId,
    body: '新製品のお知らせです。',
    ...overrides,
  });
  if (created.status !== 201) {
    throw new Error(`投稿を作れない: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const id = String(dataOf(created)['id']);
  const read = await callGet(id);
  return { id, expectedUpdatedAt: String(read['updatedAt']) };
}

/** 承認待ちの投稿を作る。 */
async function makeAwaiting(overrides: Record<string, unknown> = {}): Promise<Item> {
  return makePost({ publishTiming: 'after_approval', ...overrides });
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
  readonly updated_at: Date;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, scheduled_at, approved_at, updated_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

async function approvedAuditRows(): Promise<
  { resource_id: string | null; detail: Record<string, unknown> }[]
> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['resource_id', 'detail'])
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
  scratch = await useScratchDatabase('socialpostbulkapprove');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await createUser(['administrator']);
  adminSession = await issueSessionToken(admin.loginId);
  // 資格情報は登録された publisher の宣言で検査されるので、publisher を先に登録する。
  registerPublisher('test-plugin', manualOnlyPublisher());
  registerPublisher('test-plugin', bothPublisher());
  manualOnlyAccountId = (
    await createSocialAccount(admin.context, {
      provider: MANUAL_ONLY_PROVIDER,
      displayName: '手動投稿だけ',
      handle: '@bulk',
      credential: null,
      status: 'connected',
    })
  ).id;
  bothAccountId = (
    await createSocialAccount(admin.context, {
      provider: BOTH_PROVIDER,
      displayName: '両方',
      handle: '@bulk',
      credential: null,
      credentials: { token: 'secret-token' },
      status: 'connected',
    })
  ).id;
  writeToken = await issueToken(admin, ['social.read', 'social.write']);
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #17 即投稿で 3 件
// ---------------------------------------------------------------------------

describe('#17 publishTiming: now で承認待ち 3 件を一括承認する', () => {
  async function threeAwaiting(): Promise<Item[]> {
    return [
      await makeAwaiting({ scheduledAt: future() }),
      await makeAwaiting(),
      await makeAwaiting({ scheduledAt: future(2 * HOUR) }),
    ];
  }

  it('#17 200・results は要求の順に 3 件で、すべて ok: true・effect: approved_now', async () => {
    const items = await threeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'now', items });

    expect(result.status).toBe(200);
    expect(resultsOf(result).map((entry) => [entry.id, entry.ok, entry.effect])).toEqual(
      items.map((item) => [item.id, true, 'approved_now']),
    );
  });

  it('#17 各項目の post は status: scheduled・approvedAt あり・scheduledAt が要求の前後の間', async () => {
    const items = await threeAwaiting();

    const before = Date.now();
    const result = await callBulkApprove({ publishTiming: 'now', items });
    const after = Date.now();

    for (const entry of resultsOf(result)) {
      expect(entry.post).toMatchObject({ status: 'scheduled' });
      expect(entry.post?.['approvedAt']).not.toBeNull();
      within(entry.post?.['scheduledAt'], before, after);
    }
    expect(resultsOf(result)).toHaveLength(3);
  });

  it('#17 応答の data は bulkId（文字列）と results', async () => {
    const items = await threeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'now', items });

    expect(typeof dataOf(result)['bulkId']).toBe('string');
    expect(String(dataOf(result)['bulkId'])).not.toBe('');
    expect(Object.keys(dataOf(result)).sort()).toEqual(['bulkId', 'results']);
  });

  it('#17 行は予約済み・承認済みになる', async () => {
    const items = await threeAwaiting();

    await callBulkApprove({ publishTiming: 'now', items });

    for (const item of items) {
      const row = await rowOf(item.id);
      expect(row.status).toBe('scheduled');
      expect(row.approved_at).not.toBeNull();
    }
  });

  it('#17 (B) social.post.approved が 3 回発火する', async () => {
    const received: unknown[] = [];
    subscribe('social.post.approved' as never, (payload: unknown) => {
      received.push(payload);
    });
    const items = await threeAwaiting();

    await callBulkApprove({ publishTiming: 'now', items });

    expect(received).toHaveLength(3);
    expect(received).toEqual(
      items.map((item) => ({ postId: item.id, accountId: bothAccountId, status: 'scheduled' })),
    );
  });

  it('#17 (B) 監査 approved が 3 行で、detail.bulkId がすべて応答の bulkId と同じ', async () => {
    const items = await threeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'now', items });

    const rows = await approvedAuditRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.resource_id).sort()).toEqual(items.map((item) => item.id).sort());
    for (const row of rows) {
      expect(row.detail['bulkId']).toBe(dataOf(result)['bulkId']);
    }
  });

  it('#17 (B) 監査の detail は 1 件の承認の 6 つのキーに bulkId を足したもの（via: session）', async () => {
    const items = await threeAwaiting();

    await callBulkApprove({ publishTiming: 'now', items });

    const rows = await approvedAuditRows();
    expect(Object.keys(rows[0]?.detail ?? {}).sort()).toEqual(
      [
        'requestedTiming',
        'effectiveTiming',
        'scheduledAt',
        'deliveryMode',
        'approvalForced',
        'via',
        'bulkId',
      ].sort(),
    );
    expect(rows[0]?.detail).toMatchObject({
      requestedTiming: 'now',
      effectiveTiming: 'now',
      via: 'session',
    });
  });
});

// ---------------------------------------------------------------------------
// #18 それぞれの希望日時
// ---------------------------------------------------------------------------

describe('#18 publishTiming: scheduled（それぞれの希望日時）', () => {
  it('#18 希望日時が未来 → approved_scheduled・scheduledAt ＝ 希望日時', async () => {
    const desired = future(2 * HOUR);
    const post = await makeAwaiting({ scheduledAt: desired });

    const result = await callBulkApprove({ publishTiming: 'scheduled', items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toMatchObject({
      id: post.id,
      ok: true,
      effect: 'approved_scheduled',
    });
    expect(resultsOf(result)[0]?.post?.['scheduledAt']).toBe(desired);
  });

  it('#18 希望日時が過去 → ok: false・desired_time_passed・field: scheduledAt・1 件の承認の 422 と同じ文言', async () => {
    const post = await makeAwaiting({ scheduledAt: past() });

    const result = await callBulkApprove({ publishTiming: 'scheduled', items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'desired_time_passed',
      field: 'scheduledAt',
      message: PAST_MESSAGE,
    });
  });

  it('#18 希望日時が過去の行は承認待ちのまま', async () => {
    const post = await makeAwaiting({ scheduledAt: past() });

    await callBulkApprove({ publishTiming: 'scheduled', items: [post] });

    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
    expect((await rowOf(post.id)).approved_at).toBeNull();
  });

  it('#18 希望日時が NULL → no_desired_time・field: scheduledAt・1 件の承認と同じ文言、承認待ちのまま', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'scheduled', items: [post] });

    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'no_desired_time',
      field: 'scheduledAt',
      message: MISSING_MESSAGE,
    });
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#18 3 つを 1 要求に混ぜても、それぞれの結果になる（部分成功）', async () => {
    const desired = future(3 * HOUR);
    const futurePost = await makeAwaiting({ scheduledAt: desired });
    const pastPost = await makeAwaiting({ scheduledAt: past() });
    const nullPost = await makeAwaiting();

    const result = await callBulkApprove({
      publishTiming: 'scheduled',
      items: [pastPost, futurePost, nullPost],
    });

    expect(result.status).toBe(200);
    expect(
      resultsOf(result).map((entry) => [entry.id, entry.ok, entry.effect ?? entry.reason]),
    ).toEqual([
      [pastPost.id, false, 'desired_time_passed'],
      [futurePost.id, true, 'approved_scheduled'],
      [nullPost.id, false, 'no_desired_time'],
    ]);
    expect((await rowOf(futurePost.id)).status).toBe('scheduled');
    expect((await rowOf(pastPost.id)).status).toBe('awaiting_approval');
    expect((await rowOf(nullPost.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #19 手動投稿だけの SNS
// ---------------------------------------------------------------------------

describe('#19 手動投稿だけの publisher の SNS は希望日時を選んでも即投稿になる', () => {
  async function manualOnlyAwaiting(): Promise<Item> {
    return makeAwaiting({
      socialAccountId: manualOnlyAccountId,
      deliveryMode: 'manual',
      scheduledAt: future(),
    });
  }

  it('#19 scheduled・希望日時が未来 → approved_forced_now・scheduledAt がいま', async () => {
    const post = await manualOnlyAwaiting();

    const before = Date.now();
    const result = await callBulkApprove({ publishTiming: 'scheduled', items: [post] });
    const after = Date.now();

    expect(resultsOf(result)[0]).toMatchObject({
      id: post.id,
      ok: true,
      effect: 'approved_forced_now',
    });
    within(resultsOf(result)[0]?.post?.['scheduledAt'], before, after);
  });

  it('#19 (B) 直後の listManualPendingPosts に含まれる', async () => {
    const post = await manualOnlyAwaiting();

    await callBulkApprove({ publishTiming: 'scheduled', items: [post] });

    const pending = await listManualPendingPosts(admin.context, { limit: 50 });
    expect(pending.items.map((item) => item.id)).toContain(post.id);
  });
});

// ---------------------------------------------------------------------------
// #20 見た後に変わった
// ---------------------------------------------------------------------------

describe('#20 expectedUpdatedAt が違う項目だけ stale', () => {
  it('#20 1ms 違う項目 → stale（field: null）、同じ要求の他の項目は成功する', async () => {
    const stalePost = await makeAwaiting();
    const okPost = await makeAwaiting();
    const shifted = new Date(Date.parse(stalePost.expectedUpdatedAt) - 1).toISOString();

    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id: stalePost.id, expectedUpdatedAt: shifted }, okPost],
    });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toMatchObject({
      id: stalePost.id,
      ok: false,
      reason: 'stale',
      field: null,
    });
    expect(resultsOf(result)[1]).toMatchObject({ id: okPost.id, ok: true, effect: 'approved_now' });
  });

  it('#20 stale の行は変わらない（承認待ち・updated_at も同じ）', async () => {
    const post = await makeAwaiting();
    const before = await rowOf(post.id);
    const shifted = new Date(Date.parse(post.expectedUpdatedAt) + 1).toISOString();

    await callBulkApprove({
      publishTiming: 'now',
      items: [{ id: post.id, expectedUpdatedAt: shifted }],
    });

    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#20 stale の message は 1 件の承認の 409 と同じ文言', async () => {
    const post = await makeAwaiting();
    const shifted = new Date(Date.parse(post.expectedUpdatedAt) - 1).toISOString();

    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id: post.id, expectedUpdatedAt: shifted }],
    });

    expect(resultsOf(result)[0]?.message).toBe(
      '投稿の内容が変わっています。内容を確かめてから承認し直してください。',
    );
  });
});

// ---------------------------------------------------------------------------
// #21 承認待ちでない
// ---------------------------------------------------------------------------

describe('#21 承認待ちでない投稿は not_applicable', () => {
  async function publishedPost(): Promise<Item> {
    const post = await makePost({ publishTiming: 'scheduled', scheduledAt: future() });
    await withConnection(async (connection) => {
      await sql`UPDATE social_posts
                   SET status = 'published', published_at = now(), updated_at = now()
                 WHERE id = ${post.id}`.execute(connection.db);
    });
    const read = await callGet(post.id);
    return { id: post.id, expectedUpdatedAt: String(read['updatedAt']) };
  }

  it.each([
    ['下書き', async (): Promise<Item> => makePost()],
    [
      '予約済み',
      async (): Promise<Item> => makePost({ publishTiming: 'scheduled', scheduledAt: future() }),
    ],
    ['配信済み', publishedPost],
  ] as const)('#21 %s → not_applicable（field: null）', async (_label, make) => {
    const post = await make();

    const result = await callBulkApprove({ publishTiming: 'now', items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toMatchObject({
      id: post.id,
      ok: false,
      reason: 'not_applicable',
      field: null,
    });
  });

  it('#21 message に「承認待ちの投稿ではありません」を含む', async () => {
    const post = await makePost();

    const result = await callBulkApprove({ publishTiming: 'now', items: [post] });

    expect(resultsOf(result)[0]?.message ?? '').toContain('承認待ちの投稿ではありません');
  });
});

// ---------------------------------------------------------------------------
// #22 無い ID
// ---------------------------------------------------------------------------

describe('#22 存在しない・UUID の形でない ID は not_found（要求全体は 200）', () => {
  it.each([
    ['存在しない UUID', (): string => uuidv7()],
    ['UUID の形でない ID', (): string => 'abc'],
  ] as const)('#22 %s → not_found（field: null）', async (_label, idOf) => {
    const id = idOf();

    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id, expectedUpdatedAt: new Date().toISOString() }],
    });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toEqual([
      expect.objectContaining({ id, ok: false, reason: 'not_found', field: null }),
    ]);
  });

  it('#22 not_found の message は 1 件の 404 の文言', async () => {
    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id: uuidv7(), expectedUpdatedAt: new Date().toISOString() }],
    });

    expect(resultsOf(result)[0]?.message).toBe(NOT_FOUND_MESSAGE);
  });

  it('#22 無い ID を混ぜても、他の項目は成功する', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id: 'abc', expectedUpdatedAt: new Date().toISOString() }, post],
    });

    expect(resultsOf(result).map((entry) => entry.ok)).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// #23 配信 Plugin の検査
// ---------------------------------------------------------------------------

describe('#23 validate() が問題を返す publisher → validation', () => {
  it('#23 field と message は validate() のもの', async () => {
    const post = await makeAwaiting();
    replaceBothPublisher(
      bothPublisher({ validate: () => [{ field: 'body', message: '本文が規則に反します' }] }),
    );

    const result = await callBulkApprove({ publishTiming: 'now', items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'validation',
      field: 'body',
      message: '本文が規則に反します',
    });
  });

  it('#23 行は承認待ちのまま', async () => {
    const post = await makeAwaiting();
    replaceBothPublisher(
      bothPublisher({ validate: () => [{ field: 'body', message: '本文が規則に反します' }] }),
    );

    await callBulkApprove({ publishTiming: 'now', items: [post] });

    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #24 要求の形の誤り（422・何も変わらない）
// ---------------------------------------------------------------------------

describe('#24 要求の形の誤りは 422 で、何も処理しない', () => {
  function items(count: number): Item[] {
    return Array.from({ length: count }, () => ({
      id: uuidv7(),
      expectedUpdatedAt: new Date().toISOString(),
    }));
  }

  it('#24 items が空 → 422（キーは items）', async () => {
    const result = await callBulkApprove({ publishTiming: 'now', items: [] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });

  it('#24 items が 101 件 → 422（キーは items）', async () => {
    const result = await callBulkApprove({ publishTiming: 'now', items: items(101) });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });

  it('#24 items が 100 件なら 200（境界）', async () => {
    const result = await callBulkApprove({ publishTiming: 'now', items: items(100) });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toHaveLength(100);
  });

  it('#24 同じ id が 2 回 → 422（キーは items）、行は承認待ちのまま', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'now', items: [post, post] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#24 expectedUpdatedAt が ISO でない → 422（キーは items）、他の項目も処理しない', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [post, { id: uuidv7(), expectedUpdatedAt: 'yesterday' }],
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#24 id が空文字 → 422（キーは items。id は 1 文字以上）', async () => {
    const result = await callBulkApprove({
      publishTiming: 'now',
      items: [{ id: '', expectedUpdatedAt: new Date().toISOString() }],
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });

  it('#24 publishTiming が無い → 422（キーは publishTiming）、行は承認待ちのまま', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({ items: [post] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['publishTiming']);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it("#24 publishTiming: 'after_approval' → 422（キーは publishTiming）", async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'after_approval', items: [post] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['publishTiming']);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#24 422 では監査 approved を残さない', async () => {
    const post = await makeAwaiting();

    await callBulkApprove({ publishTiming: 'now', items: [post, post] });

    expect(await approvedAuditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #47 権限
// ---------------------------------------------------------------------------

describe('#47 一括承認の権限', () => {
  it('#47 管理者のセッション → 200', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove({ publishTiming: 'now', items: [post] });

    expect(result.status).toBe(200);
  });

  it('#47 編集者のセッション → 200', async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const post = await makeAwaiting();

    const result = await callBulkApprove(
      { publishTiming: 'now', items: [post] },
      { auth: { kind: 'session', session } },
    );

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]?.ok).toBe(true);
  });

  it('#47 閲覧者のセッション → 403、行は承認待ちのまま', async () => {
    const viewer = await createUser(['viewer']);
    const session = await issueSessionToken(viewer.loginId);
    const post = await makeAwaiting();

    const result = await callBulkApprove(
      { publishTiming: 'now', items: [post] },
      { auth: { kind: 'session', session } },
    );

    expect(result.status).toBe(403);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #50 セッションだけ・CSRF
// ---------------------------------------------------------------------------

describe('#50 一括承認はセッションだけ（Bearer は 401）・CSRF を検証する', () => {
  it('#50 Scope に social.* をすべて含む有効なトークン（所有者は管理者）の Bearer → 401、行は承認待ちのまま', async () => {
    const token = await issueToken(admin, SNS_SCOPES);
    const post = await makeAwaiting();

    const result = await callBulkApprove(
      { publishTiming: 'now', items: [post] },
      { auth: { kind: 'token', token } },
    );

    expect(result.status).toBe(401);
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#50 Authorization もセッションも無い → 403 CSRF_FAILED、行は承認待ちのまま', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove(
      { publishTiming: 'now', items: [post] },
      { auth: { kind: 'none' } },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });

  it('#50 セッションでも csrfToken が無ければ 403 CSRF_FAILED、行は承認待ちのまま', async () => {
    const post = await makeAwaiting();

    const result = await callBulkApprove(
      { publishTiming: 'now', items: [post] },
      { auth: { kind: 'session', session: adminSession, csrf: false } },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #52 Rate Limit
// ---------------------------------------------------------------------------

describe('#52 一括承認の Rate Limit（60 秒 30 回）', () => {
  it('#52 同じ送信元 IP から 31 回目が 429 TOO_MANY_ATTEMPTS・Retry-After あり', async () => {
    const ip = '10.252.0.1';
    const body = {
      publishTiming: 'now',
      items: [{ id: uuidv7(), expectedUpdatedAt: new Date().toISOString() }],
    };

    const statuses: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      statuses.push((await callBulkApprove(body, { ip })).status);
    }
    const last = await callBulkApprove(body, { ip });

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(last.status).toBe(429);
    expect(errorOf(last).code).toBe('TOO_MANY_ATTEMPTS');
    expect(last.headers.get('retry-after')).not.toBeNull();
  });
});
