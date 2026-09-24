import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DELETE as revokeApiTokenRoute } from '@/app/api/v1/api-tokens/[id]/route';
import { GET as getPluginOperationRoute } from '@/app/api/v1/plugins/operations/[id]/route';
import { DELETE as deleteWebhookRoute } from '@/app/api/v1/webhooks/[id]/route';
import { login } from '@/application/auth/login';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { apiTokenRepository } from '@/infrastructure/api-token-repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { webhookRepository } from '@/infrastructure/webhook-repository';
import { findOperation } from '@/plugin/operations';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * UUID の形でない ID で 500 になっていた 3 操作（043-api-input-fixes-rest 設計 §6.6・§8、受け入れ条件 #43〜#45）。
 *
 * - `DELETE /api-tokens/{id}`（`revokeApiToken`。セッションのみ・`token.manage`）
 * - `DELETE /webhooks/{id}`（`deleteWebhook`。`system.manage`）
 * - `GET /plugins/operations/{id}`（`getPluginOperation`。`plugin.manage`）
 *
 * UUID の形でない ID は「存在しない」と同じ 404 になる（#43）。UUID の形で存在しない ID の 404 と、
 * 自分の Token の 204 は従来どおり（#44）。読み書きの関数は例外を投げずに `null` / `0` を返す（#45）。
 *
 * **セッションで叩く**（`revokeApiToken` は Bearer を受けない）。Cookie と CSRF の組み方は
 * `social-account-credential-reset.integration.test.ts` の `issueSessionToken` を写した。
 * 権限の検査（401・403）は ID の検査より先であることも、形の誤った ID で確かめる（CLAUDE.md の必須項目）。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const PASSWORD = 'non uuid id correct horse battery staple';
const CSRF_TOKEN = 'csrf-token-for-non-uuid-id';

let scratch: ScratchDatabase;
/** 管理者（すべての Permission を持つ）。 */
let admin: { readonly context: AuthorizationContext; readonly loginId: string };
/** ロールを 1 つも持たない利用者。 */
let nobody: { readonly context: AuthorizationContext; readonly loginId: string };

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function errorCodeOf(result: JsonResult): string | undefined {
  return (result.body['error'] as { readonly code?: string } | undefined)?.code;
}

async function createUser(
  roleNames: readonly string[],
): Promise<{ readonly context: AuthorizationContext; readonly loginId: string }> {
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
        display_name: 'non uuid id test',
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
    displayName: 'non uuid id test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { context, loginId };
}

/** 実際にログインして、有効なセッショントークンを得る。 */
async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: '203.0.113.43', userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

type IdRoute = (
  request: Request,
  args?: { params?: Promise<Record<string, string>> },
) => Promise<Response>;

interface Auth {
  /** セッショントークン。省略すると Cookie のセッションを付けない（CSRF は付ける）。 */
  readonly session?: string;
  /** Bearer の平文。 */
  readonly bearer?: string;
}

async function call(
  route: IdRoute,
  method: 'GET' | 'DELETE',
  path: string,
  id: string,
  auth: Auth,
): Promise<JsonResult> {
  const headers: Record<string, string> = {};
  if (auth.bearer !== undefined) {
    headers['authorization'] = `Bearer ${auth.bearer}`;
  } else {
    // Bearer が無い経路は CSRF を通らないと 403 になり、401 や 404 を確かめられない。
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['x-csrf-token'] = CSRF_TOKEN;
    headers['cookie'] = [
      ...(auth.session === undefined ? [] : [`torifune_session=${auth.session}`]),
      `torifune_csrf=${CSRF_TOKEN}`,
    ].join('; ');
  }

  const response = await route(new Request(`${BASE}${path}/${id}`, { method, headers }), {
    params: Promise.resolve({ id }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function revokeToken(id: string, auth: Auth): Promise<JsonResult> {
  return call(revokeApiTokenRoute, 'DELETE', '/api-tokens', id, auth);
}

function deleteWebhook(id: string, auth: Auth): Promise<JsonResult> {
  return call(deleteWebhookRoute, 'DELETE', '/webhooks', id, auth);
}

function getOperation(id: string, auth: Auth): Promise<JsonResult> {
  return call(getPluginOperationRoute, 'GET', '/plugins/operations', id, auth);
}

/** 3 操作を同じ表で回す。 */
const OPERATIONS = [
  { name: 'DELETE /api-tokens/{id}', send: revokeToken },
  { name: 'DELETE /webhooks/{id}', send: deleteWebhook },
  { name: 'GET /plugins/operations/{id}', send: getOperation },
] as const;

beforeAll(async () => {
  scratch = await useScratchDatabase('nonuuidid');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await createUser(['administrator']);
  nobody = await createUser([]);
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('webhooks').execute();
    await connection.db.deleteFrom('plugin_operations').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('sessions').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #43 UUID の形でない ID → 404                                                  */
/* -------------------------------------------------------------------------- */

describe('#43 UUID の形でない ID は 500 ではなく 404', () => {
  it.each(OPERATIONS)('#43 セッションで $name の id=abc → 404 NOT_FOUND', async ({ send }) => {
    const session = await issueSessionToken(admin.loginId);

    const result = await send('abc', { session });

    expect(result.status, JSON.stringify(result.body)).toBe(404);
    expect(errorCodeOf(result)).toBe('NOT_FOUND');
  });
});

/* -------------------------------------------------------------------------- */
/* #44 従来どおりの応答                                                           */
/* -------------------------------------------------------------------------- */

describe('#44 UUID の形で存在しない ID は従来どおり 404', () => {
  it.each(OPERATIONS)('#44 セッションで $name の存在しない UUID → 404', async ({ send }) => {
    const session = await issueSessionToken(admin.loginId);

    const result = await send(uuidv7(), { session });

    expect(result.status, JSON.stringify(result.body)).toBe(404);
  });
});

describe('#44 自分の Token は従来どおり失効できる', () => {
  it('#44 自分の Token の UUID で DELETE /api-tokens/{id} → 204', async () => {
    const own = await createApiToken(admin.context, {
      name: 'own token',
      scopes: ['site.read'],
      expiresAt: null,
    });
    const session = await issueSessionToken(admin.loginId);

    const result = await revokeToken(own.token.id, { session });

    expect(result.status, JSON.stringify(result.body)).toBe(204);
  });
});

/* -------------------------------------------------------------------------- */
/* 他の利用者のデータ・権限（CLAUDE.md の必須項目）                                  */
/* -------------------------------------------------------------------------- */

describe('ID を差し替えても他の利用者の Token は失効できない', () => {
  it('他の管理者の Token の UUID で DELETE /api-tokens/{id} → 404（形の誤りと同じ応答）', async () => {
    const other = await createUser(['administrator']);
    const othersToken = await createApiToken(other.context, {
      name: 'others token',
      scopes: ['site.read'],
      expiresAt: null,
    });
    const session = await issueSessionToken(admin.loginId);

    const result = await revokeToken(othersToken.token.id, { session });

    expect(result.status).toBe(404);
    expect(errorCodeOf(result)).toBe('NOT_FOUND');
  });
});

describe('認可は ID の形の検査より先（形の誤った ID でも 401・403）', () => {
  it.each(OPERATIONS)('未認証で $name の id=abc → 401 UNAUTHENTICATED', async ({ send }) => {
    const result = await send('abc', {});

    expect(result.status).toBe(401);
    expect(errorCodeOf(result)).toBe('UNAUTHENTICATED');
  });

  it.each(OPERATIONS)(
    'Permission を持たない利用者のセッションで $name の id=abc → 403 FORBIDDEN',
    async ({ send }) => {
      const session = await issueSessionToken(nobody.loginId);

      const result = await send('abc', { session });

      expect(result.status).toBe(403);
      expect(errorCodeOf(result)).toBe('FORBIDDEN');
    },
  );

  it('DELETE /webhooks/{id}：system.manage を持たない Token で id=abc → 403 FORBIDDEN', async () => {
    const token = await createApiToken(admin.context, {
      name: 'plugin manage only',
      scopes: ['plugin.manage'],
      expiresAt: null,
    });

    const result = await deleteWebhook('abc', { bearer: token.plaintext });

    expect(result.status).toBe(403);
    expect(errorCodeOf(result)).toBe('FORBIDDEN');
  });

  it('GET /plugins/operations/{id}：plugin.manage を持たない Token で id=abc → 403 FORBIDDEN', async () => {
    const token = await createApiToken(admin.context, {
      name: 'system manage only',
      scopes: ['system.manage'],
      expiresAt: null,
    });

    const result = await getOperation('abc', { bearer: token.plaintext });

    expect(result.status).toBe(403);
    expect(errorCodeOf(result)).toBe('FORBIDDEN');
  });

  it('DELETE /api-tokens/{id}：Bearer では token.manage を持っていても 401（セッションのみ）', async () => {
    const token = await createApiToken(admin.context, {
      name: 'token manage',
      scopes: ['token.manage'],
      expiresAt: null,
    });

    const result = await revokeToken('abc', { bearer: token.plaintext });

    expect(result.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* #45 読み書きの関数                                                             */
/* -------------------------------------------------------------------------- */

describe('#45 UUID の形でない ID では読み書きの関数が例外を投げない', () => {
  it("#45 apiTokenRepository.findById(connection, 'abc') → null", async () => {
    await expect(
      withConnection((connection) => apiTokenRepository.findById(connection, 'abc')),
    ).resolves.toBeNull();
  });

  it("#45 webhookRepository.delete(connection, 'abc') → 0", async () => {
    await expect(
      withConnection((connection) => webhookRepository.delete(connection, 'abc')),
    ).resolves.toBe(0);
  });

  it("#45 findOperation(connection, 'abc') → null", async () => {
    await expect(
      withConnection((connection) => findOperation(connection, 'abc')),
    ).resolves.toBeNull();
  });
});
