import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import '@/api/endpoints';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { GET as currentUserRoute } from '@/app/api/v1/auth/me/route';
import { DELETE as deleteCampaignRoute } from '@/app/api/v1/campaigns/[id]/route';
import { GET as getPluginSettingsRoute } from '@/app/api/v1/plugins/[id]/settings/route';
import { POST as setupRoute } from '@/app/api/v1/setup/route';
import { GET as getSiteRoute } from '@/app/api/v1/sites/[id]/route';
import { GET as getUserRoute, PATCH as updateUserRoute } from '@/app/api/v1/users/[id]/route';
import { POST as createUserRoute } from '@/app/api/v1/users/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { buildOpenApiDocument } from './openapi';

/**
 * OpenAPI の追加の応答の宣言と、実際に返る応答の一致（043-api-input-fixes-rest 設計 §6.4、受け入れ条件 #42）。
 *
 * 設計 §6.4 の表の代表 9 件を**ルートを直接叩いて**確かめ、返った status がその操作の OpenAPI の
 * `responses` に宣言されていることも見る（1 件 = 「宣言と実態の一致」1 つ）。
 * 既存のテストの流用はしない（実装プラン §8 の 7）。
 *
 * 認証は Bearer の API Token。Bearer を付けない POST（`/auth/login`・`/setup`）は CSRF を通すヘッダを付ける
 * （付けないと 403 になり、確かめたい status に届かない）。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const PASSWORD = 'additional responses correct horse battery staple';
const CSRF_TOKEN = 'csrf-token-for-additional-responses';

let scratch: ScratchDatabase;
let admin: { readonly context: AuthorizationContext; readonly identity: UserIdentity };
let token: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface OpenApiOperation {
  readonly operationId: string;
  readonly responses: Record<string, unknown>;
}

function declaredStatusesOf(operationId: string): readonly string[] {
  const document = buildOpenApiDocument() as {
    readonly paths: Record<string, Record<string, OpenApiOperation>>;
  };
  const found = Object.values(document.paths)
    .flatMap((methods) => Object.values(methods))
    .find((candidate) => candidate.operationId === operationId);
  if (found === undefined) throw new Error(`OpenAPI に ${operationId} が無い`);
  return Object.keys(found.responses);
}

async function createUser(
  roleNames: readonly string[],
): Promise<{ readonly context: AuthorizationContext; readonly identity: UserIdentity }> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `a${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'additional responses test',
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
    displayName: 'additional responses test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { context, identity };
}

type Route = (
  request: Request,
  args?: { params?: Promise<Record<string, string>> },
) => Promise<Response>;

interface CallOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly params?: Record<string, string>;
  readonly body?: unknown;
  /** `true` なら Bearer を付ける。`false` なら付けず、CSRF を通すヘッダを付ける。 */
  readonly bearer: boolean;
}

async function call(route: Route, options: CallOptions): Promise<JsonResult> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.bearer) {
    headers['authorization'] = `Bearer ${token}`;
  } else {
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
    headers['x-csrf-token'] = CSRF_TOKEN;
  }

  const response = await route(
    new Request(`${BASE}${options.path}`, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    { params: Promise.resolve(options.params ?? {}) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** 返った status を確かめ、その status がその操作の OpenAPI に宣言されていることを確かめる。 */
function expectDeclared(result: JsonResult, operationId: string, status: number): void {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  expect(declaredStatusesOf(operationId), `${operationId} の responses`).toContain(String(status));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('additionalresponses');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await createUser(['administrator']);
  const created = await createApiToken(admin.context, {
    name: 'additional responses test',
    scopes: ['site.read', 'user.manage', 'campaign.delete', 'plugin.manage'],
    expiresAt: null,
  });
  token = created.plaintext;
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('auth_audit_logs').execute();
    await connection.db.deleteFrom('login_attempts').execute();
    await connection.db.deleteFrom('sessions').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#42 404 の宣言と実態', () => {
  it('#42 GET /sites/abc → 404（getSite に 404 が宣言されている）', async () => {
    const result = await call(getSiteRoute, {
      method: 'GET',
      path: '/sites/abc',
      params: { id: 'abc' },
      bearer: true,
    });

    expectDeclared(result, 'getSite', 404);
  });

  it('#42 GET /users/<存在しない UUID> → 404（getUser に 404 が宣言されている）', async () => {
    const id = uuidv7();

    const result = await call(getUserRoute, {
      method: 'GET',
      path: `/users/${id}`,
      params: { id },
      bearer: true,
    });

    expectDeclared(result, 'getUser', 404);
  });

  it('#42 DELETE /campaigns/<存在しない UUID> → 404（deleteCampaign に 404 が宣言されている）', async () => {
    const id = uuidv7();

    const result = await call(deleteCampaignRoute, {
      method: 'DELETE',
      path: `/campaigns/${id}`,
      params: { id },
      body: {},
      bearer: true,
    });

    expectDeclared(result, 'deleteCampaign', 404);
  });

  it('#42 GET /plugins/not-installed/settings → 404（getPluginSettings に 404 が宣言されている）', async () => {
    const result = await call(getPluginSettingsRoute, {
      method: 'GET',
      path: '/plugins/not-installed/settings',
      params: { id: 'not-installed' },
      bearer: true,
    });

    expectDeclared(result, 'getPluginSettings', 404);
  });

  it('#42 管理者がいる状態で POST /setup → 404（completeSetup に 404 が宣言されている）', async () => {
    const result = await call(setupRoute, {
      method: 'POST',
      path: '/setup',
      body: {
        loginId: 'setupadmin',
        displayName: 'セットアップ',
        email: 'setupadmin@example.com',
        password: PASSWORD,
      },
      bearer: false,
    });

    expectDeclared(result, 'completeSetup', 404);
  });
});

describe('#42 409 の宣言と実態', () => {
  it('#42 既存と同じ loginId で POST /users → 409（createUser に 409 が宣言されている）', async () => {
    const result = await call(createUserRoute, {
      method: 'POST',
      path: '/users',
      body: {
        loginId: admin.identity.loginId,
        displayName: '重複',
        email: `dup-${uuidv7().slice(-12)}@example.com`,
        password: PASSWORD,
        roles: [],
      },
      bearer: true,
    });

    expectDeclared(result, 'createUser', 409);
  });

  it('#42 他のユーザーのメールアドレスへの PATCH /users/{id} → 409（updateUser に 409 が宣言されている）', async () => {
    const other = await createUser([]);

    const result = await call(updateUserRoute, {
      method: 'PATCH',
      path: `/users/${other.identity.userId}`,
      params: { id: other.identity.userId },
      body: { email: admin.identity.email },
      bearer: true,
    });

    expectDeclared(result, 'updateUser', 409);
  });
});

describe('#42 401 の宣言と実態（認可の無い操作）', () => {
  it('#42 誤ったパスワードで POST /auth/login → 401（login に 401 が宣言されている）', async () => {
    const result = await call(loginRoute, {
      method: 'POST',
      path: '/auth/login',
      body: { loginId: admin.identity.loginId, password: 'wrong password for 043' },
      bearer: false,
    });

    expectDeclared(result, 'login', 401);
  });

  it('#42 認証なしで GET /auth/me → 401（getCurrentUser に 401 が宣言されている）', async () => {
    const response = await currentUserRoute(new Request(`${BASE}/auth/me`, { method: 'GET' }));
    const text = await response.text();
    const result: JsonResult = {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };

    expectDeclared(result, 'getCurrentUser', 401);
  });
});
