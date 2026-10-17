import { CORE_EVENTS, type PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DELETE as deleteSocialPostRoute,
  GET as getSocialPostRoute,
} from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 一括取り消し `POST /api/v1/social/posts/bulk/delete`（054-bulk-post-actions 設計 §5.5・§8.1・§8.1.1・§8.4・§8.10・§8.11）。
 *
 * 受け入れ条件 #38〜#41・#43・#44・#49、#50・#52 の取り消しの分（#42 は UseCase の結合テスト `bulk-post-use-cases.integration.test.ts`）。
 *
 * **ルートを直接叩く結合テスト**（`social-post-bulk-approve.integration.test.ts` と同じ形。import はしない）。
 * 投稿は外部アプリのトークン（`social.read` + `social.write`）の `POST /social/posts` で作り、配信済み・失敗・配信中は
 * 作った後に SQL で列を書き換えて作る。一括の操作は**セッションだけ**なので、既定は管理者のセッションで叩く。
 *
 * Rate Limit（60 秒 30 回。操作 × 送信元 IP）に掛からないよう、#52 以外の要求は件ごとに `x-forwarded-for` を変える。
 * #52 だけは同じ IP で 31 回叩く。
 *
 * 一括取り消しのルート（`bulk/delete/route.ts`）はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （未作成の段階で `pnpm typecheck` を落とさない。053 実装プラン §8 の 19）。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-bulk-delete';
const PASSWORD = 'social bulk delete correct horse battery staple';

const BOTH_PROVIDER = 'bulk_del_both';

const HOUR = 60 * 60_000;

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 1 件の 404 の文言（実装プラン §8 の 7）。 */
const NOT_FOUND_MESSAGE = '見つかりませんでした。';
/** 配信中の文言（既存の 1 件の更新と同じ文言。設計 §8.4 の 2）。 */
const PUBLISHING_MESSAGE =
  '配信を開始しているため変更できません。結果が記録されるまで待ってください。';
/** 配信済み・失敗の `not_applicable` の文言（設計 §8.4 の 2）。 */
const NOT_APPLICABLE_MESSAGE =
  '配信済み・失敗の投稿は一括取り消しの対象外です。1 件ずつ削除してください。';

const BULK_DELETE_ROUTE: string = '@/app/api/v1/social/posts/bulk/delete/route';

let scratch: ScratchDatabase;
let admin: TestUser;
let adminSession: string;
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
  return `10.58.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
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
  const loginId = `d${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social bulk delete test',
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
    displayName: 'social bulk delete test',
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

function bothPublisher(): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: () => ({ url: 'https://example.com/intent/post' }),
  };
}

type Auth =
  | { readonly kind: 'session'; readonly session: string; readonly csrf?: boolean }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

function headersFor(how: Auth, ip: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
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
  return headers;
}

/** 一括取り消しのルートを呼ぶ（動的に読む。冒頭の注記）。 */
async function callBulkDelete(
  body: unknown,
  options: { readonly auth?: Auth; readonly ip?: string } = {},
): Promise<JsonResult> {
  const { POST } = (await import(/* @vite-ignore */ BULK_DELETE_ROUTE)) as {
    readonly POST: (request: Request) => Promise<Response>;
  };
  const how: Auth = options.auth ?? { kind: 'session', session: adminSession };
  const response = await POST(
    new Request(`${BASE}/bulk/delete`, {
      method: 'POST',
      headers: headersFor(how, options.ip ?? nextIp()),
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

/** 1 件の `DELETE /social/posts/{id}`（管理者のセッション）。 */
async function callDeleteOne(id: string): Promise<JsonResult> {
  const response = await deleteSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      method: 'DELETE',
      headers: headersFor({ kind: 'session', session: adminSession }, nextIp()),
    }),
    { params: Promise.resolve({ id }) },
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

async function callGet(id: string): Promise<JsonResult> {
  const response = await getSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      headers: { authorization: `Bearer ${writeToken}`, 'x-forwarded-for': nextIp() },
    }),
    { params: Promise.resolve({ id }) },
  );
  return toResult(response);
}

/** 投稿を API で作り、ID を返す。 */
async function makePost(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await callCreate({
    socialAccountId: bothAccountId,
    body: '新製品のお知らせです。',
    ...overrides,
  });
  if (created.status !== 201) {
    throw new Error(`投稿を作れない: ${created.status} ${JSON.stringify(created.body)}`);
  }
  return String(dataOf(created)['id']);
}

async function makeDraft(): Promise<string> {
  return makePost();
}

async function makeAwaiting(): Promise<string> {
  return makePost({ publishTiming: 'after_approval' });
}

async function makeScheduled(overrides: Record<string, unknown> = {}): Promise<string> {
  return makePost({ publishTiming: 'scheduled', scheduledAt: future(), ...overrides });
}

/** 投稿の列を SQL で書き換える。 */
async function rewrite(id: string, set: RawBuilder<unknown>): Promise<string> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
  return id;
}

async function makePublished(): Promise<string> {
  return rewrite(
    await makeScheduled(),
    sql`status = 'published', published_at = now(), updated_at = now()`,
  );
}

async function makeFailed(): Promise<string> {
  return rewrite(
    await makeScheduled(),
    sql`status = 'failed', failed_at = now(), failure_reason = '配信に失敗した', updated_at = now()`,
  );
}

/** 配信中（`auto` の予約で着手印あり）。 */
async function makePublishing(): Promise<string> {
  return rewrite(await makeScheduled(), sql`publish_started_at = now()`);
}

function future(offsetMs = HOUR): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface PostRow {
  readonly status: string;
  readonly updated_at: Date;
  readonly publish_started_at: Date | null;
}

async function rowOf(id: string): Promise<PostRow | null> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, updated_at, publish_started_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    return result.rows[0] ?? null;
  });
}

async function deletedAuditRows(): Promise<
  { resource_id: string | null; detail: Record<string, unknown> | null }[]
> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['resource_id', 'detail'])
      .where('resource_type', '=', 'social_post')
      .where('action', '=', 'deleted')
      .execute(),
  );
}

async function campaignLinkCount(postIds: readonly string[]): Promise<number> {
  return withConnection(async (connection) => {
    const row = await connection.db
      .selectFrom('campaign_social_posts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('social_post_id', 'in', [...postIds])
      .executeTakeFirst();
    return Number(row?.count ?? '0');
  });
}

async function campaignExists(id: string): Promise<boolean> {
  return withConnection(async (connection) => {
    const row = await connection.db
      .selectFrom('campaigns')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    return row !== undefined;
  });
}

async function linkToCampaign(postIds: readonly string[]): Promise<string> {
  const campaign = await createCampaign(admin.context, {
    name: '春の施策',
    description: '',
    status: 'draft',
    startsOn: '2026-04-01',
    endsOn: '2026-04-30',
    siteIds: [],
    socialPostIds: postIds,
  });
  return campaign.id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostbulkdelete');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
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
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #38 消せる状態をまとめて消す
// ---------------------------------------------------------------------------

describe('#38 下書き・承認待ち・予約済み（auto・manual、配信中でない）を 1 要求で取り消す', () => {
  async function fourDeletable(): Promise<{ readonly id: string; readonly status: string }[]> {
    return [
      { id: await makeDraft(), status: 'draft' },
      { id: await makeAwaiting(), status: 'awaiting_approval' },
      { id: await makeScheduled(), status: 'scheduled' },
      { id: await makeScheduled({ deliveryMode: 'manual' }), status: 'scheduled' },
    ];
  }

  it('#38 200・results は要求の順に 4 件で、すべて ok: true・effect: deleted・post: null', async () => {
    const posts = await fourDeletable();

    const result = await callBulkDelete({ ids: posts.map((post) => post.id) });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toEqual(
      posts.map((post) => ({ id: post.id, ok: true, effect: 'deleted', post: null })),
    );
  });

  it('#38 応答の data は bulkId（文字列）と results', async () => {
    const id = await makeDraft();

    const result = await callBulkDelete({ ids: [id] });

    expect(typeof dataOf(result)['bulkId']).toBe('string');
    expect(String(dataOf(result)['bulkId'])).not.toBe('');
    expect(Object.keys(dataOf(result)).sort()).toEqual(['bulkId', 'results']);
  });

  it('#38 行が消え、GET は 404 になる', async () => {
    const posts = await fourDeletable();

    await callBulkDelete({ ids: posts.map((post) => post.id) });

    for (const post of posts) {
      expect(await rowOf(post.id)).toBeNull();
      expect((await callGet(post.id)).status).toBe(404);
    }
  });

  it('#38 キャンペーンとの紐づけ（campaign_social_posts）も消え、キャンペーンは残る', async () => {
    const posts = await fourDeletable();
    const ids = posts.map((post) => post.id);
    const campaignId = await linkToCampaign([ids[0] ?? '', ids[2] ?? '']);
    expect(await campaignLinkCount(ids)).toBe(2);

    await callBulkDelete({ ids });

    expect(await campaignLinkCount(ids)).toBe(0);
    expect(await campaignExists(campaignId)).toBe(true);
  });

  it('#38 (B) 監査 deleted が項目ごとに 1 行で、detail がちょうど { status（消す前）, bulkId }', async () => {
    const posts = await fourDeletable();

    const result = await callBulkDelete({ ids: posts.map((post) => post.id) });

    const rows = await deletedAuditRows();
    expect(rows).toHaveLength(4);
    const bulkId = dataOf(result)['bulkId'];
    for (const post of posts) {
      const row = rows.find((candidate) => candidate.resource_id === post.id);
      expect(row?.detail).toEqual({ status: post.status, bulkId });
    }
  });

  it('#38 取り消しではイベントを出さない（設計 §8.11）', async () => {
    const posts = await fourDeletable();
    const received: string[] = [];
    for (const eventName of CORE_EVENTS) {
      subscribe(eventName, () => {
        received.push(eventName);
      });
    }

    await callBulkDelete({ ids: posts.map((post) => post.id) });

    expect(received).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #39 配信済み・失敗
// ---------------------------------------------------------------------------

describe('#39 配信済み・失敗は not_applicable で、行は残る（ユーザー裁定 6）', () => {
  it.each([
    ['配信済み', makePublished, 'published'],
    ['失敗', makeFailed, 'failed'],
  ] as const)(
    '#39 %s → not_applicable（field: null・設計の文言）',
    async (_label, make, status) => {
      const id = await make();

      const result = await callBulkDelete({ ids: [id] });

      expect(result.status).toBe(200);
      expect(resultsOf(result)).toEqual([
        { id, ok: false, reason: 'not_applicable', field: null, message: NOT_APPLICABLE_MESSAGE },
      ]);
      expect((await rowOf(id))?.status).toBe(status);
    },
  );

  it('#39 対象外を混ぜても、他の項目は消える（部分成功）', async () => {
    const published = await makePublished();
    const draft = await makeDraft();

    const result = await callBulkDelete({ ids: [published, draft] });

    expect(resultsOf(result).map((entry) => [entry.ok, entry.effect ?? entry.reason])).toEqual([
      [false, 'not_applicable'],
      [true, 'deleted'],
    ]);
    expect(await rowOf(published)).not.toBeNull();
    expect(await rowOf(draft)).toBeNull();
  });

  it('#39 対象外の項目は監査 deleted を残さない', async () => {
    const id = await makePublished();

    await callBulkDelete({ ids: [id] });

    expect(await deletedAuditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #40 配信中
// ---------------------------------------------------------------------------

describe('#40 配信中は publishing で、行は残る', () => {
  it('#40 auto の予約で着手印あり → publishing（field: null・配信中の文言）、行と着手印は残る', async () => {
    const id = await makePublishing();
    const before = await rowOf(id);

    const result = await callBulkDelete({ ids: [id] });

    expect(resultsOf(result)).toEqual([
      { id, ok: false, reason: 'publishing', field: null, message: PUBLISHING_MESSAGE },
    ]);
    expect(await rowOf(id)).toEqual(before);
    expect(before?.publish_started_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #41 無い ID
// ---------------------------------------------------------------------------

describe('#41 存在しない・UUID の形でない ID は not_found（要求全体は 200）', () => {
  it.each([
    ['存在しない UUID', (): string => uuidv7()],
    ['UUID の形でない ID', (): string => 'abc'],
  ] as const)('#41 %s → not_found（field: null・1 件の 404 の文言）', async (_label, idOf) => {
    const id = idOf();

    const result = await callBulkDelete({ ids: [id] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toEqual([
      { id, ok: false, reason: 'not_found', field: null, message: NOT_FOUND_MESSAGE },
    ]);
  });

  it('#41 無い ID を混ぜても、他の項目は消える', async () => {
    const draft = await makeDraft();

    const result = await callBulkDelete({ ids: ['abc', draft] });

    expect(resultsOf(result).map((entry) => entry.ok)).toEqual([false, true]);
    expect(await rowOf(draft)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #43 要求の形の誤り（422・何も変わらない）
// ---------------------------------------------------------------------------

describe('#43 要求の形の誤りは 422（キーは ids）で、何も処理しない', () => {
  function ids(count: number): string[] {
    return Array.from({ length: count }, () => uuidv7());
  }

  it('#43 ids が空 → 422（キーは ids）', async () => {
    const result = await callBulkDelete({ ids: [] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['ids']);
  });

  it('#43 ids が無い → 422（キーは ids）', async () => {
    const result = await callBulkDelete({});

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['ids']);
  });

  it('#43 ids が 101 件 → 422（キーは ids）', async () => {
    const result = await callBulkDelete({ ids: ids(101) });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['ids']);
  });

  it('#43 ids が 100 件なら 200（境界）', async () => {
    const result = await callBulkDelete({ ids: ids(100) });

    expect(result.status).toBe(200);
    expect(resultsOf(result)).toHaveLength(100);
    expect(resultsOf(result).every((entry) => entry.reason === 'not_found')).toBe(true);
  });

  it('#43 同じ ID が 2 回 → 422（キーは ids）、行は残る', async () => {
    const draft = await makeDraft();

    const result = await callBulkDelete({ ids: [draft, draft] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['ids']);
    expect(await rowOf(draft)).not.toBeNull();
  });

  it('#43 要素が文字列でない → 422（キーは ids）、他の項目も処理しない', async () => {
    const draft = await makeDraft();

    const result = await callBulkDelete({ ids: [draft, 123] });

    expect(result.status).toBe(422);
    expect(detailKeysOf(result)).toEqual(['ids']);
    expect(await rowOf(draft)).not.toBeNull();
  });

  it('#43 422 では監査 deleted を残さない', async () => {
    const draft = await makeDraft();

    await callBulkDelete({ ids: [draft, draft] });

    expect(await deletedAuditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #44 1 件の DELETE は変わらない
// ---------------------------------------------------------------------------

describe('#44 1 件の DELETE /social/posts/{id} は変わらない', () => {
  it('#44 配信済みも 204 で消える', async () => {
    const id = await makePublished();

    const result = await callDeleteOne(id);

    expect(result.status).toBe(204);
    expect(await rowOf(id)).toBeNull();
  });

  it("#44 (B) 監査 deleted の detail がちょうど { status: 'published' }（bulkId なし）", async () => {
    const id = await makePublished();

    await callDeleteOne(id);

    const rows = await deletedAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(id);
    expect(rows[0]?.detail).toEqual({ status: 'published' });
  });

  it("#44 (B) 下書きの 1 件の削除の detail は { status: 'draft' }", async () => {
    const id = await makeDraft();

    await callDeleteOne(id);

    expect((await deletedAuditRows())[0]?.detail).toEqual({ status: 'draft' });
  });

  it('#44 存在しない UUID は 404 のまま', async () => {
    const result = await callDeleteOne(uuidv7());

    expect(result.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// #49 権限
// ---------------------------------------------------------------------------

describe('#49 一括取り消しの権限', () => {
  it('#49 管理者のセッション → 200', async () => {
    const id = await makeDraft();

    const result = await callBulkDelete({ ids: [id] });

    expect(result.status).toBe(200);
    expect(resultsOf(result)[0]?.ok).toBe(true);
  });

  it('#49 編集者のセッション → 403（social.delete が無い）、行は残る', async () => {
    const editor = await createUser(['editor']);
    const session = await issueSessionToken(editor.loginId);
    const id = await makeDraft();

    const result = await callBulkDelete({ ids: [id] }, { auth: { kind: 'session', session } });

    expect(result.status).toBe(403);
    expect(await rowOf(id)).not.toBeNull();
  });

  it('#49 閲覧者のセッション → 403、行は残る', async () => {
    const viewer = await createUser(['viewer']);
    const session = await issueSessionToken(viewer.loginId);
    const id = await makeDraft();

    const result = await callBulkDelete({ ids: [id] }, { auth: { kind: 'session', session } });

    expect(result.status).toBe(403);
    expect(await rowOf(id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #50 セッションだけ・CSRF
// ---------------------------------------------------------------------------

describe('#50 一括取り消しはセッションだけ（Bearer は 401）・CSRF を検証する', () => {
  it('#50 Scope に social.* をすべて含む有効なトークン（所有者は管理者）の Bearer → 401、行は残る', async () => {
    const token = await issueToken(admin, SNS_SCOPES);
    const id = await makeDraft();

    const result = await callBulkDelete({ ids: [id] }, { auth: { kind: 'token', token } });

    expect(result.status).toBe(401);
    expect(await rowOf(id)).not.toBeNull();
  });

  it('#50 Authorization もセッションも無い → 403 CSRF_FAILED、行は残る', async () => {
    const id = await makeDraft();

    const result = await callBulkDelete({ ids: [id] }, { auth: { kind: 'none' } });

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect(await rowOf(id)).not.toBeNull();
  });

  it('#50 セッションでも csrfToken が無ければ 403 CSRF_FAILED、行は残る', async () => {
    const id = await makeDraft();

    const result = await callBulkDelete(
      { ids: [id] },
      { auth: { kind: 'session', session: adminSession, csrf: false } },
    );

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
    expect(await rowOf(id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #52 Rate Limit
// ---------------------------------------------------------------------------

describe('#52 一括取り消しの Rate Limit（60 秒 30 回）', () => {
  it('#52 同じ送信元 IP から 31 回目が 429 TOO_MANY_ATTEMPTS・Retry-After あり', async () => {
    const ip = '10.252.0.3';
    const body = { ids: [uuidv7()] };

    const statuses: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      statuses.push((await callBulkDelete(body, { ip })).status);
    }
    const last = await callBulkDelete(body, { ip });

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(last.status).toBe(429);
    expect(errorOf(last).code).toBe('TOO_MANY_ATTEMPTS');
    expect(last.headers.get('retry-after')).not.toBeNull();
  });
});
