import { CORE_EVENTS, type PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET as getSocialPostRoute,
  PATCH as updateSocialPostRoute,
} from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  approveSocialPost,
  createSocialAccount,
  listManualPendingPosts,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 今すぐ送る `POST /api/v1/social/posts/bulk/publish-now`（054-bulk-post-actions 設計 §5.4・§8.1・§8.1.1・§8.3・§8.3.1・§8.10・§8.11）。
 *
 * 受け入れ条件 #26・#27・#29〜#37・#48、#50・#52 の今すぐ送るの分（#28 は UseCase の結合テスト `bulk-post-use-cases.integration.test.ts`）。
 *
 * **ルートを直接叩く結合テスト**（`social-post-bulk-approve.integration.test.ts` と同じ形。import はしない）。
 * 予約の投稿は外部アプリのトークン（`social.read` + `social.write`）の `POST /social/posts`
 * （`publishTiming: 'scheduled'`・未来の `scheduledAt`）で作る。期限の来た・再試行待ち・配信中・`scheduledAt` が NULL の
 * 予約は、作った後に SQL で列を書き換えて作る（API では作れない形）。一括の操作は**セッションだけ**なので、既定は管理者の
 * セッションで叩く。
 *
 * Rate Limit（60 秒 30 回。操作 × 送信元 IP）に掛からないよう、#52 以外の要求は件ごとに `x-forwarded-for` を変える。
 * #52 だけは同じ IP で 31 回叩く。
 *
 * 今すぐ送るのルート（`bulk/publish-now/route.ts`）はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （未作成の段階で `pnpm typecheck` を落とさない。053 実装プラン §8 の 19）。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-bulk-publish-now';
const PASSWORD = 'social bulk publish now correct horse battery staple';

const BOTH_PROVIDER = 'bulk_now_both';

const HOUR = 60 * 60_000;

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 1 件の 404 の文言（実装プラン §8 の 7）。 */
const NOT_FOUND_MESSAGE = '見つかりませんでした。';
/** 配信中の文言（設計 §8.3 の表。既存の 1 件の更新と同じ文言）。 */
const PUBLISHING_MESSAGE =
  '配信を開始しているため変更できません。結果が記録されるまで待ってください。';
/** `already_due` の文言（設計 §8.3 の表）。 */
const ALREADY_DUE_MESSAGE = '予約日時を過ぎているため、既に配信の順番を待っています。';
/** 今すぐ送るの `stale` の文言（1 件の操作が無いので承認の文言ではない。実装プラン §8 の 7）。 */
const PUBLISH_NOW_STALE_MESSAGE =
  '投稿の内容が変わっています。読み込み直してから操作し直してください。';

const BULK_PUBLISH_NOW_ROUTE: string = '@/app/api/v1/social/posts/bulk/publish-now/route';

let scratch: ScratchDatabase;
let admin: TestUser;
let adminSession: string;
let bothAccountId: string;
/** `social.read` + `social.write`（外部アプリのトークンの形）。投稿の登録と PATCH に使う。 */
let writeToken: string;
let ipSequence = 0;
let publishCalls = 0;

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
  return `10.57.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
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
  const loginId = `n${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social bulk publish now test',
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
    displayName: 'social bulk publish now test',
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

function bothPublisher(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
    publish: async () => {
      publishCalls += 1;
      return { ok: true, externalId: 'e1' };
    },
    manual: () => ({ url: 'https://example.com/intent/post' }),
    ...overrides,
  };
}

function replaceBothPublisher(registration: PublisherRegistration): void {
  resetPublisherRegistry();
  registerPublisher('test-plugin', registration);
}

type Auth =
  | { readonly kind: 'session'; readonly session: string; readonly csrf?: boolean }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

/** 今すぐ送るのルートを呼ぶ（動的に読む。冒頭の注記）。 */
async function callPublishNow(
  body: unknown,
  options: { readonly auth?: Auth; readonly ip?: string } = {},
): Promise<JsonResult> {
  const { POST } = (await import(/* @vite-ignore */ BULK_PUBLISH_NOW_ROUTE)) as {
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
    new Request(`${BASE}/bulk/publish-now`, {
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

/** 外部アプリの `PATCH /social/posts/{id}`（割り込みに使う）。 */
async function callUpdate(id: string, body: unknown): Promise<JsonResult> {
  const response = await updateSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${writeToken}`,
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return toResult(response);
}

interface Item {
  readonly id: string;
  readonly expectedUpdatedAt: string;
}

/** 今の `updatedAt` を読み直して項目にする（SQL で書き換えた後に使う）。 */
async function itemOf(id: string): Promise<Item> {
  const read = await callGet(id);
  return { id, expectedUpdatedAt: String(read['updatedAt']) };
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
  return itemOf(String(dataOf(created)['id']));
}

/** 承認を経ていない未来の予約（`auto`）を作る。 */
async function makeScheduled(overrides: Record<string, unknown> = {}): Promise<Item> {
  return makePost({ publishTiming: 'scheduled', scheduledAt: future(), ...overrides });
}

/** 承認済みの未来の予約を作る（承認待ち → 1 件の承認の UseCase で `scheduled` の時機）。 */
async function makeApprovedScheduled(desired = future(2 * HOUR)): Promise<Item> {
  const awaiting = await makePost({ publishTiming: 'after_approval', scheduledAt: desired });
  await approveSocialPost(admin.context, {
    id: awaiting.id,
    publishTiming: 'scheduled',
    expectedUpdatedAt: new Date(awaiting.expectedUpdatedAt),
  });
  return itemOf(awaiting.id);
}

/** 投稿の列を SQL で書き換えて、読み直した項目を返す。 */
async function rewrite(id: string, set: RawBuilder<unknown>): Promise<Item> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
  return itemOf(id);
}

function future(offsetMs = HOUR): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface PostRow {
  readonly status: string;
  readonly scheduled_at: Date | null;
  readonly approved_at: Date | null;
  readonly updated_at: Date;
  readonly next_attempt_at: Date | null;
  readonly attempt_count: number;
  readonly failure_reason: string | null;
  readonly skip_count: number;
  readonly skip_reason: string | null;
  readonly publish_started_at: Date | null;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, scheduled_at, approved_at, updated_at, next_attempt_at, attempt_count,
             failure_reason, skip_count, skip_reason, publish_started_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

async function updatedAuditRows(): Promise<
  { resource_id: string | null; detail: Record<string, unknown> | null }[]
> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['resource_id', 'detail'])
      .where('resource_type', '=', 'social_post')
      .where('action', '=', 'updated')
      .execute(),
  );
}

function within(value: unknown, before: number, after: number): void {
  const time = Date.parse(String(value));
  expect(time).toBeGreaterThanOrEqual(before);
  expect(time).toBeLessThanOrEqual(after);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostbulkpublishnow');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  publishCalls = 0;
  admin = await createUser(['administrator']);
  adminSession = await issueSessionToken(admin.loginId);
  // 資格情報は登録された publisher の宣言で検査されるので、publisher を先に登録する。
  registerPublisher('test-plugin', bothPublisher());
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
  vi.restoreAllMocks();
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
// #26 未来の予約
// ---------------------------------------------------------------------------

describe('#26 auto・未来の予約（承認を経ていない）を今すぐ送る', () => {
  it('#26 200・ok: true・effect: queued', async () => {
    const post = await makeScheduled();

    const result = await callPublishNow({ items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toEqual([
      expect.objectContaining({ id: post.id, ok: true, effect: 'queued' }),
    ]);
  });

  it('#26 post は status: scheduled・approvedAt: null・nextAttemptAt: null・scheduledAt が要求の前後の間', async () => {
    const post = await makeScheduled();

    const before = Date.now();
    const result = await callPublishNow({ items: [post] });
    const after = Date.now();

    const entry = resultsOf(result)[0];
    expect(entry?.post).toMatchObject({
      status: 'scheduled',
      approvedAt: null,
      nextAttemptAt: null,
    });
    within(entry?.post?.['scheduledAt'], before, after);
  });

  it('#26 行の scheduled_at がいまになり、承認待ちにも承認済みにもならない', async () => {
    const post = await makeScheduled();

    const before = Date.now();
    await callPublishNow({ items: [post] });
    const after = Date.now();

    const row = await rowOf(post.id);
    expect(row.status).toBe('scheduled');
    expect(row.approved_at).toBeNull();
    within(row.scheduled_at?.toISOString(), before, after);
  });

  it('#26 skipCount・skipReason・attemptCount は変わらない（予約日時と待ち時刻だけを書く）', async () => {
    const created = await makeScheduled();
    const post = await rewrite(
      created.id,
      sql`skip_count = 2, skip_reason = 'credential_missing', attempt_count = 0`,
    );

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]?.post).toMatchObject({
      skipCount: 2,
      skipReason: 'credential_missing',
      attemptCount: 0,
    });
    const row = await rowOf(post.id);
    expect([row.skip_count, row.skip_reason, row.attempt_count]).toEqual([
      2,
      'credential_missing',
      0,
    ]);
  });

  it('#26 未来の予約に待ち時刻（next_attempt_at）が付いていれば消す', async () => {
    const created = await makeScheduled({ scheduledAt: future(2 * HOUR) });
    const post = await rewrite(created.id, sql`next_attempt_at = now() + interval '3 hours'`);

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]).toMatchObject({ ok: true, effect: 'queued' });
    expect((await rowOf(post.id)).next_attempt_at).toBeNull();
  });

  it('#26 (B) 続けて publishDuePosts を回すと publish() が 1 回呼ばれ published になる', async () => {
    const post = await makeScheduled();
    await callPublishNow({ items: [post] });

    await withConnection((connection) => publishDuePosts(connection));

    expect(publishCalls).toBe(1);
    expect((await rowOf(post.id)).status).toBe('published');
  });

  it('#26 判別力：今すぐ送らなければ、未来の予約は publishDuePosts で配信されない', async () => {
    const post = await makeScheduled();

    await withConnection((connection) => publishDuePosts(connection));

    expect(publishCalls).toBe(0);
    expect((await rowOf(post.id)).status).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
// #27 承認済みの未来の予約
// ---------------------------------------------------------------------------

describe('#27 承認済みの未来の予約を管理者のセッションで今すぐ送る', () => {
  it('#27 queued・status: scheduled（承認待ちに戻らない）', async () => {
    const post = await makeApprovedScheduled();

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]).toMatchObject({ id: post.id, ok: true, effect: 'queued' });
    expect(resultsOf(result)[0]?.post).toMatchObject({ status: 'scheduled' });
    expect((await rowOf(post.id)).status).toBe('scheduled');
  });

  it('#27 approvedAt が操作の前と同じ値（承認を外さない・付け直さない）', async () => {
    const post = await makeApprovedScheduled();
    const approvedBefore = (await rowOf(post.id)).approved_at;
    expect(approvedBefore).not.toBeNull();

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]?.post?.['approvedAt']).toBe(approvedBefore?.toISOString());
    expect((await rowOf(post.id)).approved_at).toEqual(approvedBefore);
  });
});

// ---------------------------------------------------------------------------
// #29 手動投稿
// ---------------------------------------------------------------------------

describe('#29 manual・未来の予約を今すぐ送る', () => {
  it('#29 effect: manual_pending・scheduledAt がいま', async () => {
    const post = await makeScheduled({ deliveryMode: 'manual' });

    const before = Date.now();
    const result = await callPublishNow({ items: [post] });
    const after = Date.now();

    expect(resultsOf(result)[0]).toMatchObject({ id: post.id, ok: true, effect: 'manual_pending' });
    within(resultsOf(result)[0]?.post?.['scheduledAt'], before, after);
  });

  it('#29 (B) 直後の listManualPendingPosts に含まれる', async () => {
    const post = await makeScheduled({ deliveryMode: 'manual' });

    await callPublishNow({ items: [post] });

    const pending = await listManualPendingPosts(admin.context, { limit: 50 });
    expect(pending.items.map((item) => item.id)).toContain(post.id);
  });

  it('#29 判別力：今すぐ送る前の未来の手動投稿は手動投稿待ちに無い', async () => {
    const post = await makeScheduled({ deliveryMode: 'manual' });

    const pending = await listManualPendingPosts(admin.context, { limit: 50 });

    expect(pending.items.map((item) => item.id)).not.toContain(post.id);
  });
});

// ---------------------------------------------------------------------------
// #30 予約日時が過去（再試行待ち）
// ---------------------------------------------------------------------------

describe('#30 予約日時が過去の予約（再試行待ち）は already_due', () => {
  async function retryWaiting(): Promise<Item> {
    const created = await makeScheduled();
    return rewrite(
      created.id,
      sql`scheduled_at = now() - interval '1 hour',
          failure_reason = '一時的な失敗',
          next_attempt_at = now() + interval '1 hour',
          attempt_count = 1`,
    );
  }

  it('#30 ok: false・already_due・field: null・設計の文言', async () => {
    const post = await retryWaiting();

    const result = await callPublishNow({ items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'already_due',
      field: null,
      message: ALREADY_DUE_MESSAGE,
    });
  });

  it('#30 scheduled_at・next_attempt_at・attempt_count は変わらない', async () => {
    const post = await retryWaiting();
    const before = await rowOf(post.id);

    await callPublishNow({ items: [post] });

    const after = await rowOf(post.id);
    expect([after.scheduled_at, after.next_attempt_at, after.attempt_count]).toEqual([
      before.scheduled_at,
      before.next_attempt_at,
      before.attempt_count,
    ]);
  });
});

// ---------------------------------------------------------------------------
// #31 配信中
// ---------------------------------------------------------------------------

describe('#31 配信中（auto・着手印あり）は publishing', () => {
  it('#31 ok: false・publishing・field: null・配信中の文言、行は変わらない', async () => {
    const created = await makeScheduled();
    const post = await rewrite(created.id, sql`publish_started_at = now()`);
    const before = await rowOf(post.id);

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'publishing',
      field: null,
      message: PUBLISHING_MESSAGE,
    });
    expect(await rowOf(post.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// #32 予約でない
// ---------------------------------------------------------------------------

describe('#32 下書き・承認待ち・配信済み・失敗は not_applicable', () => {
  it.each([
    ['下書き', async (): Promise<Item> => makePost()],
    ['承認待ち', async (): Promise<Item> => makePost({ publishTiming: 'after_approval' })],
    [
      '配信済み',
      async (): Promise<Item> => {
        const created = await makeScheduled();
        return rewrite(
          created.id,
          sql`status = 'published', published_at = now(), updated_at = now()`,
        );
      },
    ],
    [
      '失敗',
      async (): Promise<Item> => {
        const created = await makeScheduled();
        return rewrite(
          created.id,
          sql`status = 'failed', failed_at = now(), failure_reason = '配信に失敗した', updated_at = now()`,
        );
      },
    ],
  ] as const)('#32 %s → not_applicable（field: null）、行は変わらない', async (_label, make) => {
    const post = await make();
    const before = await rowOf(post.id);

    const result = await callPublishNow({ items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toMatchObject({
      id: post.id,
      ok: false,
      reason: 'not_applicable',
      field: null,
    });
    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#32 下書きの message は「予約済みの投稿ではありません（いまの状態：draft）。」', async () => {
    const post = await makePost();

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]?.message).toBe(
      '予約済みの投稿ではありません（いまの状態：draft）。',
    );
  });
});

// ---------------------------------------------------------------------------
// #33 見た後に変わった
// ---------------------------------------------------------------------------

/**
 * 今すぐ送るが投稿を読んだ後（アカウントを引くところ。設計 §8.3 の 5）で、元の関数を呼んだ**後に** `interrupt` を差し込む
 * （読んでから書くまでの間。`social-post-approval-update.integration.test.ts` の spy と同じ流儀）。
 * 割り込みの中で同じ関数が呼ばれても（PATCH の経路）、差し込むのは 1 回目だけ。
 */
function interruptAfterAccountRead(interrupt: () => Promise<void>): void {
  const original = socialRepository.findAccountById.bind(socialRepository);
  let calls = 0;
  vi.spyOn(socialRepository, 'findAccountById').mockImplementation(async (...args) => {
    calls += 1;
    const account = await original(...args);
    if (calls === 1) {
      await interrupt();
    }
    return account;
  });
}

describe('#33 expectedUpdatedAt が違う・読んでから書くまでに変わった', () => {
  it('#33 expectedUpdatedAt が 1ms 違う → stale（field: null・今すぐ送るの文言）、行は変わらない', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);
    const shifted = new Date(Date.parse(post.expectedUpdatedAt) - 1).toISOString();

    const result = await callPublishNow({ items: [{ id: post.id, expectedUpdatedAt: shifted }] });

    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'stale',
      field: null,
      message: PUBLISH_NOW_STALE_MESSAGE,
    });
    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#33 stale の項目があっても、同じ要求の他の項目は成功する', async () => {
    const stalePost = await makeScheduled();
    const okPost = await makeScheduled();
    const shifted = new Date(Date.parse(stalePost.expectedUpdatedAt) + 1).toISOString();

    const result = await callPublishNow({
      items: [{ id: stalePost.id, expectedUpdatedAt: shifted }, okPost],
    });

    expect(resultsOf(result).map((entry) => [entry.ok, entry.effect ?? entry.reason])).toEqual([
      [false, 'stale'],
      [true, 'queued'],
    ]);
  });

  it('#33 (B) 読んでから書くまでに外部アプリの PATCH で予約日時が変わる → stale か publishing、行は PATCH の後のまま', async () => {
    const post = await makeScheduled();
    const patched = future(5 * HOUR);
    let patchStatus = 0;
    interruptAfterAccountRead(async () => {
      patchStatus = (await callUpdate(post.id, { scheduledAt: patched })).status;
    });

    const result = await callPublishNow({ items: [post] });

    expect(patchStatus).toBe(200);
    expect(resultsOf(result)[0]?.ok).toBe(false);
    expect(['stale', 'publishing']).toContain(resultsOf(result)[0]?.reason);
    expect((await rowOf(post.id)).scheduled_at?.toISOString()).toBe(patched);
  });

  it('#33 (B) 読んでから書くまでに配信ジョブが着手する → stale か publishing、着手印と予約日時は割り込みの後のまま', async () => {
    const post = await makeScheduled();
    const scheduledBefore = (await rowOf(post.id)).scheduled_at;
    interruptAfterAccountRead(async () => {
      await withConnection(async (connection) => {
        await sql`UPDATE social_posts SET publish_started_at = now() WHERE id = ${post.id}`.execute(
          connection.db,
        );
      });
    });

    const result = await callPublishNow({ items: [post] });

    expect(resultsOf(result)[0]?.ok).toBe(false);
    expect(['stale', 'publishing']).toContain(resultsOf(result)[0]?.reason);
    const row = await rowOf(post.id);
    expect(row.publish_started_at).not.toBeNull();
    expect(row.scheduled_at).toEqual(scheduledBefore);
  });

  it('#33 (B) 割り込みで失敗した項目は監査 updated を残さない（PATCH の 1 行だけ）', async () => {
    const post = await makeScheduled();
    interruptAfterAccountRead(async () => {
      await callUpdate(post.id, { scheduledAt: future(5 * HOUR) });
    });

    await callPublishNow({ items: [post] });

    const rows = await updatedAuditRows();
    expect(rows.filter((row) => row.detail?.['operation'] === 'publish_now')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #34 配信 Plugin の検査
// ---------------------------------------------------------------------------

describe('#34 validate() が問題を返す publisher → validation', () => {
  it('#34 field と message は validate() のもの、行は変わらない', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);
    replaceBothPublisher(
      bothPublisher({ validate: () => [{ field: 'body', message: '本文が規則に反します' }] }),
    );

    const result = await callPublishNow({ items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'validation',
      field: 'body',
      message: '本文が規則に反します',
    });
    expect(await rowOf(post.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// #35 scheduledAt が NULL の予約
// ---------------------------------------------------------------------------

describe('#35 scheduledAt が NULL の予約（022 より前の形）', () => {
  it('#35 queued・scheduledAt がいまになる', async () => {
    const created = await makeScheduled();
    const post = await rewrite(created.id, sql`scheduled_at = NULL`);

    const before = Date.now();
    const result = await callPublishNow({ items: [post] });
    const after = Date.now();

    expect(resultsOf(result)[0]).toMatchObject({ id: post.id, ok: true, effect: 'queued' });
    within(resultsOf(result)[0]?.post?.['scheduledAt'], before, after);
    within((await rowOf(post.id)).scheduled_at?.toISOString(), before, after);
  });
});

// ---------------------------------------------------------------------------
// #36 監査とイベント
// ---------------------------------------------------------------------------

describe('#36 (B) 監査 updated とイベント', () => {
  it('#36 監査 updated が 1 行で、detail がちょうど設計 §8.10 の形（承認を経ていない auto の予約）', async () => {
    const desired = future(3 * HOUR);
    const post = await makeScheduled({ scheduledAt: desired });

    const result = await callPublishNow({ items: [post] });

    const rows = await updatedAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(post.id);
    expect(rows[0]?.detail).toEqual({
      operation: 'publish_now',
      changed: ['scheduledAt'],
      status: 'scheduled',
      previousScheduledAt: desired,
      approvalKept: false,
      deliveryMode: 'auto',
      bulkId: dataOf(result)['bulkId'],
    });
  });

  it('#36 条件 27（承認済みの予約）では approvalKept: true', async () => {
    const desired = future(4 * HOUR);
    const post = await makeApprovedScheduled(desired);
    const approvedAudit = (await updatedAuditRows()).length;

    await callPublishNow({ items: [post] });

    const rows = await updatedAuditRows();
    expect(rows).toHaveLength(approvedAudit + 1);
    const publishNow = rows.find((row) => row.detail?.['operation'] === 'publish_now');
    expect(publishNow?.detail).toMatchObject({
      approvalKept: true,
      previousScheduledAt: desired,
    });
  });

  it('#36 手動投稿では deliveryMode: manual、scheduledAt が NULL だった予約では previousScheduledAt: null', async () => {
    const created = await makeScheduled({ deliveryMode: 'manual' });
    const post = await rewrite(created.id, sql`scheduled_at = NULL`);

    await callPublishNow({ items: [post] });

    const rows = await updatedAuditRows();
    expect(rows[0]?.detail).toMatchObject({ deliveryMode: 'manual', previousScheduledAt: null });
  });

  it('#36 イベントは何も出ない', async () => {
    const posts = [await makeScheduled(), await makeScheduled({ deliveryMode: 'manual' })];
    const received: string[] = [];
    for (const eventName of CORE_EVENTS) {
      subscribe(eventName, () => {
        received.push(eventName);
      });
    }

    const result = await callPublishNow({ items: posts });

    expect(resultsOf(result).every((entry) => entry.ok)).toBe(true);
    expect(received).toEqual([]);
  });

  it('#36 失敗した項目は監査を残さない', async () => {
    const post = await makePost();

    await callPublishNow({ items: [post] });

    expect(await updatedAuditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #37 要求の形の誤り（422・何も変わらない）
// ---------------------------------------------------------------------------

describe('#37 要求の形の誤りは 422（キーは items。条件 24 と同じ）で、何も処理しない', () => {
  function items(count: number): Item[] {
    return Array.from({ length: count }, () => ({
      id: uuidv7(),
      expectedUpdatedAt: new Date().toISOString(),
    }));
  }

  it('#37 items が空 → 422（キーは items）', async () => {
    const result = await callPublishNow({ items: [] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });

  it('#37 items が無い → 422（キーは items）', async () => {
    const result = await callPublishNow({});

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });

  it('#37 items が 101 件 → 422（キーは items）', async () => {
    const result = await callPublishNow({ items: items(101) });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });

  it('#37 items が 100 件なら 200（境界）', async () => {
    const result = await callPublishNow({ items: items(100) });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toHaveLength(100);
    expect(resultsOf(result).every((entry) => entry.reason === 'not_found')).toBe(true);
  });

  it('#37 同じ id が 2 回 → 422（キーは items）、行は変わらない', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);

    const result = await callPublishNow({ items: [post, post] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#37 expectedUpdatedAt が ISO でない → 422（キーは items）、他の項目も処理しない', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);

    const result = await callPublishNow({
      items: [post, { id: uuidv7(), expectedUpdatedAt: 'yesterday' }],
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#37 id が空文字 → 422（キーは items）', async () => {
    const result = await callPublishNow({
      items: [{ id: '', expectedUpdatedAt: new Date().toISOString() }],
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['items']);
  });
});

// ---------------------------------------------------------------------------
// #22 相当：無い ID（設計 §8.1 の not_found は 3 操作に共通）
// ---------------------------------------------------------------------------

describe('今すぐ送るの not_found（設計 §8.1・§8.3 の 1）', () => {
  it.each([
    ['存在しない UUID', (): string => uuidv7()],
    ['UUID の形でない ID', (): string => 'abc'],
  ] as const)('%s → not_found（field: null・1 件の 404 の文言）', async (_label, idOf) => {
    const id = idOf();

    const result = await callPublishNow({
      items: [{ id, expectedUpdatedAt: new Date().toISOString() }],
    });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toEqual([
      { id, ok: false, reason: 'not_found', field: null, message: NOT_FOUND_MESSAGE },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #48 権限
// ---------------------------------------------------------------------------

describe('#48 今すぐ送るの権限', () => {
  it('#48 管理者のセッション → 200', async () => {
    const post = await makeScheduled();

    const result = await callPublishNow({ items: [post] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]?.ok).toBe(true);
  });

  it('#48 編集者のセッション → 200', async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const post = await makeScheduled();

    const result = await callPublishNow({ items: [post] }, { auth: { kind: 'session', session } });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]?.ok).toBe(true);
  });

  it('#48 閲覧者のセッション → 403、行は変わらない', async () => {
    const viewer = await createUser(['viewer']);
    const session = await issueSessionToken(viewer.loginId);
    const post = await makeScheduled();
    const before = await rowOf(post.id);

    const result = await callPublishNow({ items: [post] }, { auth: { kind: 'session', session } });

    expect(result.status).toBe(403);
    expect(await rowOf(post.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// #50 セッションだけ・CSRF
// ---------------------------------------------------------------------------

describe('#50 今すぐ送るはセッションだけ（Bearer は 401）・CSRF を検証する', () => {
  it('#50 Scope に social.* をすべて含む有効なトークン（所有者は管理者）の Bearer → 401、行は変わらない', async () => {
    const token = await issueToken(admin, SNS_SCOPES);
    const post = await makeScheduled();
    const before = await rowOf(post.id);

    const result = await callPublishNow({ items: [post] }, { auth: { kind: 'token', token } });

    expect(result.status).toBe(401);
    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#50 Authorization もセッションも無い → 403 CSRF_FAILED、行は変わらない', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);

    const result = await callPublishNow({ items: [post] }, { auth: { kind: 'none' } });

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#50 セッションでも csrfToken が無ければ 403 CSRF_FAILED、行は変わらない', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);

    const result = await callPublishNow(
      { items: [post] },
      { auth: { kind: 'session', session: adminSession, csrf: false } },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect(await rowOf(post.id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// #52 Rate Limit
// ---------------------------------------------------------------------------

describe('#52 今すぐ送るの Rate Limit（60 秒 30 回）', () => {
  it('#52 同じ送信元 IP から 31 回目が 429 TOO_MANY_ATTEMPTS・Retry-After あり', async () => {
    const ip = '10.252.0.2';
    const body = { items: [{ id: uuidv7(), expectedUpdatedAt: new Date().toISOString() }] };

    const statuses: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      statuses.push((await callPublishNow(body, { ip })).status);
    }
    const last = await callPublishNow(body, { ip });

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(last.status).toBe(429);
    expect(errorOf(last).code).toBe('TOO_MANY_ATTEMPTS');
    expect(last.headers.get('retry-after')).not.toBeNull();
  });
});
