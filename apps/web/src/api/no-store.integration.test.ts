import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GET as readyRoute } from '@/app/api/ready/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { JobBusyError } from '@/domain/jobs/job';
import { ConflictError, NotFoundError } from '@/domain/repository';
import { resetLogger, setLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createdResponse, dataResponse, noContentResponse, pageResponse } from './response';
import { defineRoute } from './route';

/**
 * `defineRoute` の出口のすべてに `Cache-Control: no-store` が付く（058-api-no-store 設計 §5、受け入れ条件 #11〜#26）。
 *
 * - #11〜#16：成功の応答の部品（`dataResponse`・`pageResponse`・`createdResponse`・`noContentResponse`）、
 *   ハンドラが付けた `Cache-Control` の上書き（設計 §5.4）、ハンドラが自分で作る 302（`Location`・`Set-Cookie` は残る）
 * - #17〜#19：認可の出口（未認証の 401・Permission の無い 403 は `catch` の `authorizationErrorResponse`）と Bearer の 200
 * - #20〜#25：検査の 422（Zod・NUL）と、`catch` の 404・409・500
 * - #26：`defineRoute` を通らない `/api/ready` は今のまま（`Cache-Control` 無し）
 *
 * **テスト用のルートを定義して叩く**（`route-error-redaction.integration.test.ts` の形）。`documented: false`・一意な `operationId`。
 * 認可の文脈を作るのに DB が要るので結合テストにする。
 * POST・DELETE は `csrfExemptReason` を書き、CSRF を通さずにハンドラ・検査へ届かせる（実装プラン §8 の 6）。
 * Permission の要るルートは `site.read`（実装プラン §8 の 8）。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const PASSWORD = 'api no store correct horse battery staple';
const CSRF_EXEMPT = 'テスト用。CSRF の検査の外で出口だけを見る';
const REASON = '検証用のルート。認可の判断をしない';

let scratch: ScratchDatabase;
let adminContext: AuthorizationContext;
/** ロールを持たない利用者のセッション（`site.read` が無い）。 */
let noRoleSession: string;
/** `site.read` を Scope に持つ API トークン。 */
let siteReadToken: string;
let sequence = 0;
let ipSequence = 0;

function uniqueOperationId(label: string): string {
  sequence += 1;
  return `noStoreInt${label}${sequence}${Math.random().toString(36).slice(2, 8)}`;
}

function nextIp(): string {
  ipSequence += 1;
  return `192.0.2.${(ipSequence % 250) + 1}`;
}

async function createUser(roleNames: readonly string[]): Promise<{ id: string; loginId: string }> {
  const id = uuidv7();
  const loginId = `ns${id.replaceAll('-', '').slice(-12)}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'api no store test',
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

type Handle = ReturnType<typeof defineRoute>;

/** Permission の要らないテスト用ルート。 */
function openRoute(
  method: 'GET' | 'POST' | 'DELETE',
  handler: () => Promise<Response>,
  extra: { successStatus?: 200 | 201 | 204 } = {},
): Handle {
  return defineRoute({
    operationId: uniqueOperationId(method),
    method,
    path: '/__test/no-store',
    summary: '検証用',
    permission: null,
    reason: REASON,
    documented: false,
    rateLimit: 'none',
    ...(method === 'GET' ? {} : { csrfExemptReason: CSRF_EXEMPT }),
    ...extra,
    handler,
  });
}

/** `site.read` の要るテスト用ルート。 */
function siteReadRoute(): Handle {
  return defineRoute({
    operationId: uniqueOperationId('SiteRead'),
    method: 'GET',
    path: '/__test/no-store/site-read',
    summary: '検証用',
    permission: 'site.read',
    documented: false,
    rateLimit: 'none',
    handler: async () => dataResponse({ ok: true }),
  });
}

/** 本文の検査があるテスト用ルート（#20・#21）。 */
function bodyRoute(): Handle {
  return defineRoute({
    operationId: uniqueOperationId('Body'),
    method: 'POST',
    path: '/__test/no-store/body',
    summary: '検証用',
    permission: null,
    reason: REASON,
    documented: false,
    rateLimit: 'none',
    csrfExemptReason: CSRF_EXEMPT,
    body: z.object({ name: z.string() }),
    handler: async () => dataResponse({ ok: true }),
  });
}

function throwingRoute(error: unknown): Handle {
  return openRoute('GET', () => {
    throw error;
  });
}

function call(handle: Handle, init: RequestInit & { path?: string } = {}): Promise<Response> {
  const { path = '/__test/no-store', ...rest } = init;
  return handle(new Request(`${API}${path}`, rest));
}

function postJson(handle: Handle, body: string): Promise<Response> {
  return call(handle, {
    path: '/__test/no-store/body',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('apinostore');

  const admin = await createUser(['administrator']);
  adminContext = await withConnection((connection) =>
    authorizationContextFor(connection, {
      userId: admin.id,
      loginId: admin.loginId,
      displayName: 'api no store test',
      email: `${admin.loginId}@example.com`,
      providerId: 'local',
      externalUserId: null,
    }),
  );
  const created = await createApiToken(adminContext, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes: ['site.read'],
    expiresAt: null,
  });
  siteReadToken = created.plaintext;

  const noRole = await createUser([]);
  noRoleSession = await issueSessionToken(noRole.loginId);
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(() => {
  resetLogger();
  resetEventHandlers();
});

describe('成功の応答（§10.3）', () => {
  /** #11 */
  it('#11 dataResponse を返す GET の 200 に no-store が付く', async () => {
    const response = await call(openRoute('GET', async () => dataResponse({ value: 1 })));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #12 */
  it('#12 pageResponse を返す GET の 200 に no-store が付く', async () => {
    const response = await call(
      openRoute('GET', async () =>
        pageResponse([{ value: 1 }], { page: 1, perPage: 20, total: 1 }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #13 */
  it('#13 createdResponse を返す POST の 201 に no-store が付く', async () => {
    const response = await call(
      openRoute('POST', async () => createdResponse({ id: 'x' }), { successStatus: 201 }),
      { method: 'POST' },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #14 */
  it('#14 noContentResponse を返す DELETE の 204 に no-store が付く', async () => {
    const response = await call(
      openRoute('DELETE', async () => noContentResponse(), { successStatus: 204 }),
      { method: 'DELETE' },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #15（設計 §5.4） */
  it('#15 ハンドラが Cache-Control: public, max-age=60 を付けても応答は no-store になる', async () => {
    const response = await call(
      openRoute('GET', async () =>
        dataResponse({ value: 1 }, { headers: { 'Cache-Control': 'public, max-age=60' } }),
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #16（実装プラン §8 の 7） */
  it('#16 ハンドラが返す 302 の Location・Set-Cookie は残り、no-store が付く', async () => {
    const cookie = 'torifune_probe=1; Path=/; HttpOnly; SameSite=Lax';
    const response = await call(
      openRoute(
        'POST',
        async () =>
          new Response(null, {
            status: 302,
            headers: { Location: '/dashboard', 'Set-Cookie': cookie },
          }),
      ),
      { method: 'POST' },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/dashboard');
    expect(response.headers.get('set-cookie')).toBe(cookie);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('認可の出口（§10.3）', () => {
  /** #17 */
  it('#17 Permission の要るルートを未認証で叩いた 401 に no-store が付く', async () => {
    const response = await call(siteReadRoute(), { path: '/__test/no-store/site-read' });

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #18 */
  it('#18 Permission を持たない利用者の 403 に no-store が付く', async () => {
    const response = await call(siteReadRoute(), {
      path: '/__test/no-store/site-read',
      headers: { cookie: `torifune_session=${noRoleSession}` },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #19 */
  it('#19 Bearer（API トークン）で認証した 200 に no-store が付く', async () => {
    const response = await call(siteReadRoute(), {
      path: '/__test/no-store/site-read',
      headers: { authorization: `Bearer ${siteReadToken}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('検査と例外の出口（§10.3）', () => {
  /** #20 */
  it('#20 Zod の検査に落ちた 422 に no-store が付く', async () => {
    const response = await postJson(bodyRoute(), JSON.stringify({ name: 1 }));

    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #21。ソースに NUL を置かない（エスケープで書く）。 */
  it('#21 保存できない文字（NUL）を含む本文の 422 に no-store が付く', async () => {
    const response = await postJson(bodyRoute(), JSON.stringify({ name: 'a\u0000b' }));

    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #22 */
  it('#22 ハンドラが NotFoundError を投げた 404 に no-store が付く', async () => {
    const response = await call(throwingRoute(new NotFoundError('Probe', 'x')));

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #23 */
  it('#23 ハンドラが ConflictError を投げた 409 に no-store が付く', async () => {
    const response = await call(throwingRoute(new ConflictError('Probe', 'name')));

    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #24 */
  it('#24 ハンドラが JobBusyError を投げた 409 に no-store が付き、Retry-After: 10 は今のまま', async () => {
    const response = await call(throwingRoute(new JobBusyError('social.publish')));

    expect(response.status).toBe(409);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  /** #25。ログは捕まえて出力を抑えるだけで、中身は見ない（実装プラン §8 の 9）。 */
  it('#25 ハンドラが想定外の例外を投げた 500 に no-store が付き、本文は INTERNAL_ERROR のまま', async () => {
    setLogger({ log() {} });

    const response = await call(throwingRoute(new Error('no-store probe secret detail')));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(text).not.toContain('no-store probe secret detail');
  });
});

describe('defineRoute を通らないルートは今のまま（設計 §5.5）', () => {
  /** #26 */
  it('#26 GET /api/ready の応答に Cache-Control が無い（今のまま）', async () => {
    const response = await readyRoute();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
