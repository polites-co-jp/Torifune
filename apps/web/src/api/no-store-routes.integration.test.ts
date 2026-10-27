import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GET as csrfRoute } from '@/app/api/v1/auth/csrf/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { GET as meRoute } from '@/app/api/v1/auth/me/route';
import { POST as collectRoute } from '@/app/api/v1/collect/route';
import { GET as listSocialPostsRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 実際のルートの応答に `Cache-Control: no-store` が付く（058-api-no-store 設計 §10.4、受け入れ条件 #27〜#32）。
 *
 * - #27〜#29：`GET /social/posts`（投稿の本文が載る）。セッションの 200・API トークンの 200・未認証の 401・`social.read` の無い 403
 *   （権限の必須の 3 つ。設計 §10 の末尾）
 * - #30：`GET /auth/me`（200・401）と `GET /auth/csrf`（200）
 * - #31：`POST /auth/login` の成功（`Set-Cookie` は今のまま）と、誤った資格情報の 401
 * - #32：`POST /collect`（計測。認証なし）。ステータスと本文は今のまま（204・本文なし）
 *
 * ルートを直接叩く（`nul-public-input.integration.test.ts` の形）。ログイン・計測の Rate Limit に当たらないよう、
 * 要求ごとに `X-Forwarded-For` を変える（実装プラン §7 の 6）。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const API = `${ORIGIN}/api/v1`;
const CSRF_TOKEN = 'csrf-token-for-api-no-store-routes';
const PASSWORD = 'api no store routes correct horse battery staple';
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let scratch: ScratchDatabase;
let adminLoginId: string;
let adminSession: string;
let noRoleSession: string;
let socialReadToken: string;
let publicKey: string;
let ipSequence = 0;

function nextIp(): string {
  ipSequence += 1;
  return `198.18.${Math.floor(ipSequence / 250) % 250}.${(ipSequence % 250) + 1}`;
}

async function createUser(roleNames: readonly string[]): Promise<{ id: string; loginId: string }> {
  const id = uuidv7();
  const loginId = `nr${id.replaceAll('-', '').slice(-12)}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'api no store routes test',
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
  return { id, loginId };
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

function contextOf(user: { id: string; loginId: string }): Promise<AuthorizationContext> {
  return withConnection((connection) =>
    authorizationContextFor(connection, {
      userId: user.id,
      loginId: user.loginId,
      displayName: 'api no store routes test',
      email: `${user.loginId}@example.com`,
      providerId: 'local',
      externalUserId: null,
    }),
  );
}

function getWith(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${API}${path}`, {
    headers: { 'x-forwarded-for': nextIp(), 'user-agent': BROWSER, ...headers },
  });
}

/** CSRF を通すヘッダを付けた POST（`/collect` は CSRF を見ないので `csrf = false`）。 */
function postWith(path: string, body: unknown, csrf = true): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': nextIp(),
    'user-agent': BROWSER,
  };
  if (csrf) {
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['x-csrf-token'] = CSRF_TOKEN;
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
  }
  return new Request(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function session(token: string): Record<string, string> {
  return { cookie: `torifune_session=${token}` };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('apinostoreroutes');

  const admin = await createUser(['administrator']);
  adminLoginId = admin.loginId;
  adminSession = await issueSessionToken(admin.loginId);
  const adminContext = await contextOf(admin);

  const created = await createApiToken(adminContext, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes: ['social.read'],
    expiresAt: null,
  });
  socialReadToken = created.plaintext;

  const noRole = await createUser([]);
  noRoleSession = await issueSessionToken(noRole.loginId);

  const site = await createSite(adminContext, {
    name: '計測するサイト',
    url: 'https://no-store.example.com',
    description: '',
    status: 'active',
  });
  publicKey = await withConnection(async (connection) => {
    const row = await connection.db
      .selectFrom('sites')
      .select('public_key')
      .where('id', '=', site.id)
      .executeTakeFirstOrThrow();
    return row.public_key;
  });
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(() => {
  resetEventHandlers();
});

describe('GET /social/posts（§10.4）', () => {
  /** #27 */
  it('#27 セッションで叩いた 200 に no-store が付く', async () => {
    const response = await listSocialPostsRoute(getWith('/social/posts', session(adminSession)));

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #28 */
  it('#28 API トークンで叩いた 200 に no-store が付く', async () => {
    const response = await listSocialPostsRoute(
      getWith('/social/posts', { authorization: `Bearer ${socialReadToken}` }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #29 */
  it('#29 未認証で叩いた 401 に no-store が付く', async () => {
    const response = await listSocialPostsRoute(getWith('/social/posts'));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #29 */
  it('#29 social.read を持たない利用者の 403 に no-store が付く', async () => {
    const response = await listSocialPostsRoute(getWith('/social/posts', session(noRoleSession)));

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /auth/me・GET /auth/csrf（§10.4）', () => {
  /** #30 */
  it('#30 GET /auth/me のセッションの 200 に no-store が付く', async () => {
    const response = await meRoute(getWith('/auth/me', session(adminSession)));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #30 */
  it('#30 GET /auth/me の未認証の 401 に no-store が付く', async () => {
    const response = await meRoute(getWith('/auth/me'));

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #30 */
  it('#30 GET /auth/csrf の 200 に no-store が付く', async () => {
    const response = await csrfRoute(getWith('/auth/csrf'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /auth/login（§10.4）', () => {
  /** #31 */
  it('#31 ログインの成功に no-store が付き、Set-Cookie は今のまま', async () => {
    const response = await loginRoute(
      postWith('/auth/login', { loginId: adminLoginId, password: PASSWORD }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('torifune_session=');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #31 */
  it('#31 誤った資格情報の 401 に no-store が付く', async () => {
    const response = await loginRoute(
      postWith('/auth/login', { loginId: adminLoginId, password: `${PASSWORD} wrong` }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /collect（§10.4）', () => {
  /** #32 */
  it('#32 計測の応答に no-store が付き、ステータス（204）と本文（なし）は今のまま', async () => {
    const response = await collectRoute(
      postWith(
        '/collect',
        { key: publicKey, path: '/landing', referrer: 'https://ref.example.com/page' },
        false,
      ),
    );

    expect(response.status).toBe(204);
    expect(await response.clone().text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
