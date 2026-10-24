import { CORE_EVENTS, type PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  approveSocialPost,
  createSocialAccount,
  createSocialPost,
  listSocialPostHistory,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 手動投稿の結果 `POST /api/v1/social/posts/{id}/manual-outcome`（055-social-pending-tab 設計 §5.6・§8.2・§10、
 * 受け入れ条件 #15〜#25・#31）。
 *
 * **ルートを直接叩く結合テスト（C）**（`social-post-bulk-publish-now.integration.test.ts` の形を写す。import はしない）。
 * 準備（設計 §13 の前書き）：`acc`（`manual` と `publish` を持つ偽物の provider）・`accAuto`（`publish` だけ）、
 * 管理者・編集者・閲覧者のセッション（CSRF トークン付き）、API トークン（`social.read` + `social.write`、所有者は管理者）。
 * 投稿は UseCase で作り（予約時刻の過ぎた予約も作れる）、UseCase で作れない状態（配信済み・失敗）は作った後に SQL で書く。
 * 要求の `expectedUpdatedAt` は `GET /social/posts/{id}` の `updatedAt`（画面が見た値の形）。
 *
 * 結果の操作は**セッションだけ**（`sessionOnly`）なので、既定は管理者のセッションで叩く。Rate Limit を避けるため
 * 要求ごとに `x-forwarded-for` を変える。「いま」の時刻は要求の直前と直後に取った時刻の間にあることで見る。
 *
 * ルート（`manual-outcome/route.ts`）はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-manual-outcome';
const PASSWORD = 'social manual outcome correct horse battery staple';

const BOTH_PROVIDER = 'mo_both';
const AUTO_PROVIDER = 'mo_auto';

const HOUR = 60 * 60_000;

/** 設計 §5.6・§13.1 #5 の固定の文言。 */
const MANUAL_NOT_POSTED_REASON = '手動投稿で『投稿しなかった』が選ばれました。';
/** 設計 §8.2 の 422 `status` の文言。 */
const NOT_MANUAL_SCHEDULED_MESSAGE = '手動投稿の予約ではありません。';

const MANUAL_OUTCOME_ROUTE: string = '@/app/api/v1/social/posts/[id]/manual-outcome/route';

let scratch: ScratchDatabase;
let admin: TestUser;
let adminSession: string;
let acc: string;
let accAuto: string;
/** `social.read` + `social.write`（外部アプリのトークンの形）。GET と #31 の Bearer に使う。 */
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
}

function nextIp(): string {
  ipSequence += 1;
  return `10.55.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return (result.body['data'] ?? {}) as Record<string, unknown>;
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
  };
}

async function createUser(roleNames: readonly string[]): Promise<TestUser> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `m${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social manual outcome test',
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
    displayName: 'social manual outcome test',
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

async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: nextIp(), userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

function bothPublisher(): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: () => ({ url: 'https://example.com/intent/post' }),
  };
}

function autoPublisher(): PublisherRegistration {
  return {
    provider: AUTO_PROVIDER,
    label: '自動だけ（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e2' }),
  };
}

type Auth =
  | { readonly kind: 'session'; readonly session: string; readonly csrf?: boolean }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

/** 結果の記録のルートを呼ぶ（動的に読む。冒頭の注記）。 */
async function callOutcome(
  id: string,
  body: unknown,
  options: { readonly auth?: Auth } = {},
): Promise<JsonResult> {
  const { POST } = (await import(/* @vite-ignore */ MANUAL_OUTCOME_ROUTE)) as {
    readonly POST: (
      request: Request,
      context: { readonly params: Promise<{ readonly id: string }> },
    ) => Promise<Response>;
  };
  const how: Auth = options.auth ?? { kind: 'session', session: adminSession };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': nextIp(),
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
    new Request(`${BASE}/${id}/manual-outcome`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
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

interface Seen {
  readonly id: string;
  /** 画面が見た投稿（`GET` の `data`）。 */
  readonly view: Record<string, unknown>;
  readonly updatedAt: string;
}

async function seen(id: string): Promise<Seen> {
  const view = await callGet(id);
  return { id, view, updatedAt: String(view['updatedAt']) };
}

interface MakeOptions {
  readonly accountId?: string;
  readonly deliveryMode?: 'auto' | 'manual';
  readonly scheduledAt?: Date | null;
  readonly kind?: 'scheduled' | 'awaiting' | 'draft';
}

/** 既定は「手動・予約時刻を 1 時間過ぎた予約」（手動投稿待ち）。 */
async function makePost(options: MakeOptions = {}): Promise<Seen> {
  const kind = options.kind ?? 'scheduled';
  const base = {
    socialAccountId: options.accountId ?? acc,
    body: '手動で投稿する本文です。',
    scheduledAt:
      options.scheduledAt === undefined ? new Date(Date.now() - HOUR) : options.scheduledAt,
    deliveryMode: options.deliveryMode ?? 'manual',
  };
  const input =
    kind === 'awaiting'
      ? { ...base, publishTiming: 'after_approval' as const }
      : { ...base, status: kind };
  const { post } = await createSocialPost(admin.context, input);
  return seen(post.id);
}

/** 承認済みの手動の予約（承認待ち → 1 件の承認の UseCase で `scheduled` の時機）。 */
async function makeApprovedManual(): Promise<Seen> {
  const awaiting = await makePost({ kind: 'awaiting', scheduledAt: new Date(Date.now() + HOUR) });
  await approveSocialPost(admin.context, {
    id: awaiting.id,
    publishTiming: 'scheduled',
    expectedUpdatedAt: new Date(awaiting.updatedAt),
  });
  return seen(awaiting.id);
}

async function rewrite(id: string, set: RawBuilder<unknown>): Promise<Seen> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
  return seen(id);
}

interface PostRow {
  readonly status: string;
  readonly delivery_mode: string;
  readonly scheduled_at: Date | null;
  readonly approved_at: Date | null;
  readonly published_at: Date | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly external_url: string | null;
  readonly next_attempt_at: Date | null;
  readonly updated_at: Date;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, delivery_mode, scheduled_at, approved_at, published_at, failed_at, failure_reason,
             external_url, next_attempt_at, updated_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

async function updatedAuditRows(
  id: string,
): Promise<{ resource_id: string | null; detail: Record<string, unknown> | null }[]> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['resource_id', 'detail'])
      .where('resource_type', '=', 'social_post')
      .where('action', '=', 'updated')
      .where('resource_id', '=', id)
      .execute(),
  );
}

/** すべての Core のイベントを数える（設計 §5.6：結果のイベントだけが出る）。 */
function recordEvents(): { readonly name: string; readonly payload: unknown }[] {
  const received: { name: string; payload: unknown }[] = [];
  for (const eventName of CORE_EVENTS) {
    subscribe(eventName, (payload: unknown) => {
      received.push({ name: eventName, payload });
    });
  }
  return received;
}

function within(value: unknown, before: number, after: number): void {
  const time = Date.parse(String(value));
  expect(time).toBeGreaterThanOrEqual(before);
  expect(time).toBeLessThanOrEqual(after);
}

/** ミリ秒の ISO を 1ms ずらす。 */
function shifted(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostmanualoutcome');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await createUser(['administrator']);
  adminSession = await issueSessionToken(admin.loginId);
  registerPublisher('test-plugin', bothPublisher());
  registerPublisher('test-plugin', autoPublisher());
  acc = (
    await createSocialAccount(admin.context, {
      provider: BOTH_PROVIDER,
      displayName: '両方',
      handle: '@manual',
      credential: null,
      status: 'connected',
    })
  ).id;
  accAuto = (
    await createSocialAccount(admin.context, {
      provider: AUTO_PROVIDER,
      displayName: '自動だけ',
      handle: '@auto',
      credential: null,
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
// #15 予約時刻の後の posted
// ---------------------------------------------------------------------------

describe('#15 予約時刻の後の手動の予約に posted', () => {
  it('#15 200・status: published・publishedAt がいま', async () => {
    const post = await makePost();

    const before = Date.now();
    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
    });
    const after = Date.now();

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('published');
    within(dataOf(result)['publishedAt'], before, after);
  });

  it('#15 scheduledAt は変わらない（応答と行）', async () => {
    const post = await makePost();
    const rowBefore = await rowOf(post.id);

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(dataOf(result)['scheduledAt']).toBe(post.view['scheduledAt']);
    expect((await rowOf(post.id)).scheduled_at).toEqual(rowBefore.scheduled_at);
  });

  it('#15 行も published で published_at が入り、next_attempt_at が NULL', async () => {
    const post = await makePost();

    const before = Date.now();
    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });
    const after = Date.now();

    const row = await rowOf(post.id);
    expect(row.status).toBe('published');
    within(row.published_at?.toISOString(), before, after);
    expect(row.next_attempt_at).toBeNull();
  });

  it('#15 GET /social/posts/{id} でも published', async () => {
    const post = await makePost();

    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });

    expect((await callGet(post.id))['status']).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// #16 予約時刻の前の posted（externalUrl）
// ---------------------------------------------------------------------------

describe('#16 予約時刻の前の手動の予約に posted（externalUrl）', () => {
  it('#16 200・externalUrl が入る', async () => {
    const post = await makePost({ scheduledAt: new Date(Date.now() + HOUR) });

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
      externalUrl: 'https://x.com/i/status/1',
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)['externalUrl']).toBe('https://x.com/i/status/1');
    expect((await rowOf(post.id)).external_url).toBe('https://x.com/i/status/1');
  });

  it('#16 scheduledAt は未来のまま、publishedAt はいま', async () => {
    const post = await makePost({ scheduledAt: new Date(Date.now() + HOUR) });

    const before = Date.now();
    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
      externalUrl: 'https://x.com/i/status/1',
    });
    const after = Date.now();

    expect(dataOf(result)['scheduledAt']).toBe(post.view['scheduledAt']);
    expect(Date.parse(String(dataOf(result)['scheduledAt']))).toBeGreaterThan(after);
    within(dataOf(result)['publishedAt'], before, after);
  });
});

// ---------------------------------------------------------------------------
// #17 承認済みの手動の予約
// ---------------------------------------------------------------------------

describe('#17 承認済み（approvedAt あり）の手動の予約に posted', () => {
  it('#17 200・approvedAt は変わらない', async () => {
    const post = await makeApprovedManual();
    expect(post.view['approvedAt']).not.toBeNull();
    const rowBefore = await rowOf(post.id);

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('published');
    expect(dataOf(result)['approvedAt']).toBe(post.view['approvedAt']);
    expect((await rowOf(post.id)).approved_at).toEqual(rowBefore.approved_at);
  });
});

// ---------------------------------------------------------------------------
// #18 not_posted
// ---------------------------------------------------------------------------

describe('#18 not_posted', () => {
  it('#18 200・status: failed・failedAt がいま', async () => {
    const post = await makePost();

    const before = Date.now();
    const result = await callOutcome(post.id, {
      outcome: 'not_posted',
      expectedUpdatedAt: post.updatedAt,
    });
    const after = Date.now();

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('failed');
    within(dataOf(result)['failedAt'], before, after);
  });

  it('#18 failureReason が MANUAL_NOT_POSTED_REASON（応答と行）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'not_posted',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(dataOf(result)['failureReason']).toBe(MANUAL_NOT_POSTED_REASON);
    expect((await rowOf(post.id)).failure_reason).toBe(MANUAL_NOT_POSTED_REASON);
  });

  it('#18 scheduledAt は変わらず、publishedAt は null のまま', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'not_posted',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(dataOf(result)['scheduledAt']).toBe(post.view['scheduledAt']);
    expect(dataOf(result)['publishedAt']).toBeNull();
    expect((await rowOf(post.id)).next_attempt_at).toBeNull();
  });

  it('#18 listSocialPostHistory（失敗）に出る', async () => {
    const post = await makePost();

    await callOutcome(post.id, { outcome: 'not_posted', expectedUpdatedAt: post.updatedAt });

    const history = await listSocialPostHistory(admin.context, {
      page: 1,
      perPage: 20,
      status: 'failed',
    });
    expect(history.items.map((item) => item.id)).toContain(post.id);
  });
});

// ---------------------------------------------------------------------------
// #19 イベント
// ---------------------------------------------------------------------------

describe('#19 イベント', () => {
  it('#19 posted → social.post.published が { postId, accountId, status: published } で 1 回、他は出ない', async () => {
    const post = await makePost();
    const received = recordEvents();

    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });

    expect(received).toEqual([
      {
        name: 'social.post.published',
        payload: { postId: post.id, accountId: acc, status: 'published' },
      },
    ]);
  });

  it('#19 not_posted → social.post.failed が { postId, accountId, status: failed } で 1 回、他は出ない', async () => {
    const post = await makePost();
    const received = recordEvents();

    await callOutcome(post.id, { outcome: 'not_posted', expectedUpdatedAt: post.updatedAt });

    expect(received).toEqual([
      {
        name: 'social.post.failed',
        payload: { postId: post.id, accountId: acc, status: 'failed' },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #20 監査
// ---------------------------------------------------------------------------

describe('#20 監査 updated', () => {
  it("#20 posted → 1 行、detail.manualOutcome: 'posted'・detail.status: 'published'", async () => {
    const post = await makePost();

    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });

    const rows = await updatedAuditRows(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(post.id);
    expect(rows[0]?.detail).toMatchObject({ manualOutcome: 'posted', status: 'published' });
  });

  it("#20 not_posted → 1 行、detail.manualOutcome: 'not_posted'・detail.status: 'failed'", async () => {
    const post = await makePost();

    await callOutcome(post.id, { outcome: 'not_posted', expectedUpdatedAt: post.updatedAt });

    const rows = await updatedAuditRows(post.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ manualOutcome: 'not_posted', status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// #21 見た後に変わった（1ms 違う）
// ---------------------------------------------------------------------------

describe('#21 expectedUpdatedAt が 1ms 違う → 409', () => {
  it.each([1, -1])('#21 %dms ずれ → 409 CONFLICT', async (ms) => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: shifted(post.updatedAt, ms),
    });

    expect(result.status).toBe(409);
  });

  it('#21 409 の後も行・監査・イベントは変わらない', async () => {
    const post = await makePost();
    const rowBefore = await rowOf(post.id);
    const received = recordEvents();

    await callOutcome(post.id, {
      outcome: 'not_posted',
      expectedUpdatedAt: shifted(post.updatedAt, 1),
    });

    expect(await rowOf(post.id)).toEqual(rowBefore);
    expect(await updatedAuditRows(post.id)).toEqual([]);
    expect(received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #22 2 回目
// ---------------------------------------------------------------------------

describe('#22 2 回目の記録', () => {
  it('#22 同じ expectedUpdatedAt でもう一度 posted → 409', async () => {
    const post = await makePost();
    const first = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
    });
    expect(first.status).toBe(200);

    const second = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(second.status).toBe(409);
  });

  it('#22 2 回目の後も publishedAt は 1 回目のまま、イベントは増えない', async () => {
    const post = await makePost();
    const received = recordEvents();
    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });
    const rowAfterFirst = await rowOf(post.id);

    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });

    expect((await rowOf(post.id)).published_at).toEqual(rowAfterFirst.published_at);
    expect(received.map((entry) => entry.name)).toEqual(['social.post.published']);
    expect(await updatedAuditRows(post.id)).toHaveLength(1);
  });

  it('#22 今の updatedAt で送り直すと 422（キー status）', async () => {
    const post = await makePost();
    await callOutcome(post.id, { outcome: 'posted', expectedUpdatedAt: post.updatedAt });
    const now = await seen(post.id);

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: now.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(errorOf(result).details?.['status']).toEqual([NOT_MANUAL_SCHEDULED_MESSAGE]);
  });
});

// ---------------------------------------------------------------------------
// #23 対象外
// ---------------------------------------------------------------------------

describe('#23 手動の予約でない投稿 → 422 status', () => {
  const cases: readonly (readonly [string, () => Promise<Seen>])[] = [
    ['承認待ちの手動投稿', async () => makePost({ kind: 'awaiting', scheduledAt: null })],
    ['下書きの手動投稿', async () => makePost({ kind: 'draft', scheduledAt: null })],
    [
      '自動配信の予約',
      async () =>
        makePost({
          accountId: accAuto,
          deliveryMode: 'auto',
          scheduledAt: new Date(Date.now() + HOUR),
        }),
    ],
    [
      '配信済み',
      async () => {
        const post = await makePost({ kind: 'draft', scheduledAt: null });
        return rewrite(post.id, sql`status = 'published', published_at = now()`);
      },
    ],
    [
      '失敗',
      async () => {
        const post = await makePost({ kind: 'draft', scheduledAt: null });
        return rewrite(
          post.id,
          sql`status = 'failed', failed_at = now(), failure_reason = '配信に失敗しました'`,
        );
      },
    ],
  ];

  it.each(cases)(
    '#23 %s（今の updatedAt）→ 422・キー status「手動投稿の予約ではありません。」',
    async (_title, make) => {
      const post = await make();

      const result = await callOutcome(post.id, {
        outcome: 'posted',
        expectedUpdatedAt: post.updatedAt,
      });

      expect(result.status).toBe(422);
      expect(errorOf(result).details?.['status']).toEqual([NOT_MANUAL_SCHEDULED_MESSAGE]);
    },
  );

  it.each(cases)('#23 %s：422 の後も行は変わらない', async (_title, make) => {
    const post = await make();
    const rowBefore = await rowOf(post.id);

    await callOutcome(post.id, { outcome: 'not_posted', expectedUpdatedAt: post.updatedAt });

    expect(await rowOf(post.id)).toEqual(rowBefore);
    expect(await updatedAuditRows(post.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #24 要求の形の誤り
// ---------------------------------------------------------------------------

describe('#24 要求の誤り → 422', () => {
  it('#24 not_posted に externalUrl → 422（キー externalUrl）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'not_posted',
      expectedUpdatedAt: post.updatedAt,
      externalUrl: 'https://x.com/i/status/1',
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['externalUrl']);
  });

  it('#24 posted に http の externalUrl → 422（キー externalUrl）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
      externalUrl: 'http://x.com/i/status/1',
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['externalUrl']);
  });

  it('#24 posted に長すぎる externalUrl（2049 字）→ 422（キー externalUrl）', async () => {
    const post = await makePost();
    const url = `https://x.com/${'a'.repeat(2049 - 'https://x.com/'.length)}`;
    expect(url).toHaveLength(2049);

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
      externalUrl: url,
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['externalUrl']);
  });

  it("#24 outcome: 'skip' → 422（キー outcome）", async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'skip',
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toContain('outcome');
  });

  it('#24 outcome なし → 422（キー outcome）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, { expectedUpdatedAt: post.updatedAt });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toContain('outcome');
  });

  it('#24 expectedUpdatedAt なし → 422（キー expectedUpdatedAt）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, { outcome: 'posted' });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toContain('expectedUpdatedAt');
  });

  it('#24 expectedUpdatedAt が ISO 8601 でない → 422（キー expectedUpdatedAt）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: '2026/10/23 09:00',
    });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toContain('expectedUpdatedAt');
  });

  it('#24 未知のキー → 422（strict）', async () => {
    const post = await makePost();

    const result = await callOutcome(post.id, {
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
      status: 'published',
    });

    expect(result.status).toBe(422);
  });

  it('#24 形の誤りの後も行は変わらない', async () => {
    const post = await makePost();
    const rowBefore = await rowOf(post.id);

    await callOutcome(post.id, { outcome: 'skip', expectedUpdatedAt: post.updatedAt });
    await callOutcome(post.id, {
      outcome: 'not_posted',
      expectedUpdatedAt: post.updatedAt,
      externalUrl: 'https://x.com/i/status/1',
    });

    expect(await rowOf(post.id)).toEqual(rowBefore);
  });
});

// ---------------------------------------------------------------------------
// #25 存在しない投稿
// ---------------------------------------------------------------------------

describe('#25 存在しない投稿', () => {
  it('#25 存在しない UUID → 404', async () => {
    const result = await callOutcome(uuidv7(), {
      outcome: 'posted',
      expectedUpdatedAt: new Date().toISOString(),
    });

    expect(result.status).toBe(404);
  });

  it('#25 UUID の形でない {id} → 404', async () => {
    const result = await callOutcome('abc', {
      outcome: 'posted',
      expectedUpdatedAt: new Date().toISOString(),
    });

    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// #31 権限・未認証
// ---------------------------------------------------------------------------

describe('#31 manual-outcome はセッションだけ（Bearer は 401）・social.write・CSRF', () => {
  it('#31 編集者のセッション → 200', async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const post = await makePost();

    const result = await callOutcome(
      post.id,
      { outcome: 'posted', expectedUpdatedAt: post.updatedAt },
      { auth: { kind: 'session', session } },
    );

    expect(result.status).toBe(200);
  });

  it('#31 閲覧者のセッション → 403、行は変わらない', async () => {
    const viewer = await createUser(['viewer']);
    const session = await issueSessionToken(viewer.loginId);
    const post = await makePost();
    const rowBefore = await rowOf(post.id);

    const result = await callOutcome(
      post.id,
      { outcome: 'posted', expectedUpdatedAt: post.updatedAt },
      { auth: { kind: 'session', session } },
    );

    expect(result.status).toBe(403);
    expect(await rowOf(post.id)).toEqual(rowBefore);
  });

  it('#31 Scope に social.read + social.write を含む有効なトークン（所有者は管理者）の Bearer → 401、行は変わらない', async () => {
    const post = await makePost();
    const rowBefore = await rowOf(post.id);

    const result = await callOutcome(
      post.id,
      { outcome: 'posted', expectedUpdatedAt: post.updatedAt },
      { auth: { kind: 'token', token: writeToken } },
    );

    expect(result.status).toBe(401);
    expect(await rowOf(post.id)).toEqual(rowBefore);
  });

  it('#31 Authorization もセッションも無い → 403 CSRF_FAILED、行は変わらない', async () => {
    const post = await makePost();
    const rowBefore = await rowOf(post.id);

    const result = await callOutcome(
      post.id,
      { outcome: 'posted', expectedUpdatedAt: post.updatedAt },
      { auth: { kind: 'none' } },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect(await rowOf(post.id)).toEqual(rowBefore);
  });

  it('#31 セッションでも csrfToken が無ければ 403 CSRF_FAILED、行は変わらない', async () => {
    const post = await makePost();
    const rowBefore = await rowOf(post.id);

    const result = await callOutcome(
      post.id,
      { outcome: 'posted', expectedUpdatedAt: post.updatedAt },
      { auth: { kind: 'session', session: adminSession, csrf: false } },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect(await rowOf(post.id)).toEqual(rowBefore);
  });
});
