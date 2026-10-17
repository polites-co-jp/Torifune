import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { ALL_SCOPE } from '@/domain/social/access-scope';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 登録したトークンの名前の写し（054-bulk-post-actions 設計 §7.2・§7.3、受け入れ条件 #16）。
 *
 * `POST /api/v1/social/posts` を直接叩く（C・B）。トークンで登録した投稿の行の `created_by_token_name` が
 * トークンの名前、セッションで登録した投稿は NULL、`externalRef` の再送は既存の行のまま（名前も同じ）。
 * 加えて Repository の `findPostById` の Domain の値に `createdByTokenName` が載る。
 *
 * 列 `created_by_token_name` はまだ無いので、行は生の SQL で読む（Kysely の型に掛けない）。
 * Domain の値の `createdByTokenName` も型にまだ無いので、`Record<string, unknown>` として読む。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-token-name';
const PASSWORD = 'social token name correct horse battery staple';
const TOKEN_NAME = 'ブログ連携';

let scratch: ScratchDatabase;
let admin: TestUser;
let accountId: string;
/** 名前「ブログ連携」・Scope `social.read` + `social.write`（所有者は管理者）。 */
let blogToken: string;
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
  return `10.54.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
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
  const loginId = `n${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social token name test',
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
    displayName: 'social token name test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { id, loginId, context };
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

async function createWithToken(token: string, body: Record<string, unknown>): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(BASE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-forwarded-for': nextIp(),
      },
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

async function createWithSession(
  session: string,
  body: Record<string, unknown>,
): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(BASE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-host': '127.0.0.1:3000',
        'x-forwarded-for': nextIp(),
        origin: ORIGIN,
        cookie: `torifune_session=${session}; torifune_csrf=${CSRF}`,
        'x-csrf-token': CSRF,
      },
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

interface TokenColumns {
  readonly created_by_token_id: string | null;
  readonly created_by_token_name: string | null;
}

/** 行の 2 列を生の SQL で読む（列はまだ Kysely の型に無い）。 */
async function tokenColumnsOf(id: string): Promise<TokenColumns> {
  return withConnection(async (connection) => {
    const result = await sql<TokenColumns>`
      SELECT created_by_token_id, created_by_token_name
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

async function postCount(): Promise<number> {
  return withConnection(async (connection) => {
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count FROM social_posts`.execute(connection.db);
    return Number(result.rows[0]?.count ?? '0');
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialposttokenname');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await createUser(['administrator']);
  accountId = (
    await createSocialAccount(admin.context, {
      provider: 'x',
      displayName: 'とりふね公式',
      handle: '@torifune',
      credential: 'account-credential',
      status: 'connected',
    })
  ).id;
  blogToken = (
    await createApiToken(admin.context, {
      name: TOKEN_NAME,
      scopes: ['social.read', 'social.write'],
      expiresAt: null,
    })
  ).plaintext;
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

describe('#16 登録したトークンの名前を投稿に写す', () => {
  it('#16 トークンで POST /social/posts → 行の created_by_token_name がトークンの名前', async () => {
    const created = await createWithToken(blogToken, {
      socialAccountId: accountId,
      body: 'トークンから',
    });

    expect(created.status).toBe(201);
    const columns = await tokenColumnsOf(String(dataOf(created)['id']));
    expect(columns.created_by_token_id).not.toBeNull();
    expect(columns.created_by_token_name).toBe(TOKEN_NAME);
  });

  it('#16 セッションで POST /social/posts → created_by_token_id も created_by_token_name も NULL', async () => {
    const session = await issueSessionToken(admin.loginId);

    const created = await createWithSession(session, {
      socialAccountId: accountId,
      body: '画面から',
    });

    expect(created.status).toBe(201);
    expect(await tokenColumnsOf(String(dataOf(created)['id']))).toEqual({
      created_by_token_id: null,
      created_by_token_name: null,
    });
  });

  it('#16 同じ externalRef の再送は 200 で既存の行のまま（行は増えず、名前も同じ）', async () => {
    const first = await createWithToken(blogToken, {
      socialAccountId: accountId,
      body: '冪等の確認',
      externalRef: 'ref-054-16',
    });
    const id = String(dataOf(first)['id']);
    const before = await tokenColumnsOf(id);

    const again = await createWithToken(blogToken, {
      socialAccountId: accountId,
      body: '冪等の確認',
      externalRef: 'ref-054-16',
    });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(dataOf(again)['id']).toBe(id);
    expect(await postCount()).toBe(1);
    expect(before.created_by_token_name).toBe(TOKEN_NAME);
    expect(await tokenColumnsOf(id)).toEqual(before);
  });

  it('#16 findPostById の Domain の値の createdByTokenName がトークンの名前', async () => {
    const created = await createWithToken(blogToken, {
      socialAccountId: accountId,
      body: 'Domain の値',
    });
    const id = String(dataOf(created)['id']);

    const post = await withConnection((connection) =>
      socialRepository.findPostById(connection, id, ALL_SCOPE),
    );

    expect(post).not.toBeNull();
    expect((post as unknown as Record<string, unknown>)['createdByTokenName']).toBe(TOKEN_NAME);
  });

  it('#16 セッションで登録した投稿の Domain の値の createdByTokenName は null', async () => {
    const session = await issueSessionToken(admin.loginId);
    const created = await createWithSession(session, {
      socialAccountId: accountId,
      body: '画面の Domain の値',
    });
    const id = String(dataOf(created)['id']);

    const post = await withConnection((connection) =>
      socialRepository.findPostById(connection, id, ALL_SCOPE),
    );

    expect(post).not.toBeNull();
    expect((post as unknown as Record<string, unknown>)['createdByTokenName']).toBeNull();
  });

  it('#16 投稿の応答（postResponseSchema の形）には createdByTokenName が出ない', async () => {
    const created = await createWithToken(blogToken, {
      socialAccountId: accountId,
      body: '応答の形',
    });

    expect(created.status).toBe(201);
    expect(Object.keys(dataOf(created))).not.toContain('createdByTokenName');
  });
});
