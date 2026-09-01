import { expect, test, type APIRequestContext } from '@playwright/test';

/** API 基盤の E2E。既存 API の回帰と、OpenAPI / 応答形式を確認する。 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

test('OpenAPI 文書が取得できる', async ({ request }) => {
  const response = await request.get('/api/v1/openapi.json');
  expect(response.status()).toBe(200);

  const document = (await response.json()) as {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<string, Record<string, { operationId: string }>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  expect(document.openapi).toBe('3.1.0');
  expect(document.info.title).toBe('Torifune API');
  expect(document.components.securitySchemes['session']).toBeDefined();
});

test('OpenAPI に登録済みエンドポイントが含まれる', async ({ request }) => {
  const document = (await (await request.get('/api/v1/openapi.json')).json()) as {
    paths: Record<string, Record<string, { operationId: string }>>;
  };

  expect(Object.keys(document.paths).sort()).toEqual([
    '/analytics',
    '/analytics/rollup',
    '/api-tokens',
    '/api-tokens/{id}',
    '/auth/csrf',
    '/auth/login',
    '/auth/logout',
    '/auth/me',
    '/auth/password-reset/confirm',
    '/auth/password-reset/request',
    '/campaigns',
    '/campaigns/{id}',
    '/permissions',
    '/plugins',
    '/plugins/operations/{id}',
    '/plugins/package/inspect',
    '/plugins/package/install',
    '/plugins/registry',
    '/plugins/{id}',
    '/plugins/{id}/disable',
    '/plugins/{id}/enable',
    '/plugins/{id}/settings',
    '/roles',
    '/settings',
    '/setup',
    '/sites',
    '/sites/{id}',
    '/social/accounts',
    '/social/accounts/{id}',
    '/social/posts',
    '/social/posts/{id}',
    '/users',
    '/users/{id}',
    '/webhooks',
    '/webhooks/deliver',
    '/webhooks/{id}',
  ]);
});

test('OpenAPI に内部エンドポイントが含まれない', async ({ request }) => {
  const text = await (await request.get('/api/v1/openapi.json')).text();
  // ヘルスチェックは /api/v1 の外にあり、公開仕様に載せない。
  expect(text).not.toContain('/health');
  expect(text).not.toContain('/ready');
});

test('OpenAPI に Request スキーマが含まれる', async ({ request }) => {
  const document = (await (await request.get('/api/v1/openapi.json')).json()) as {
    paths: Record<string, Record<string, { requestBody?: unknown }>>;
  };

  expect(document.paths['/auth/login']?.['post']?.requestBody).toBeDefined();
});

test('OpenAPI に認可が必要なエンドポイントの security が入る', async ({ request }) => {
  const document = (await (await request.get('/api/v1/openapi.json')).json()) as {
    paths: Record<string, Record<string, { security?: unknown[] }>>;
  };

  expect(document.paths['/roles']?.['get']?.security).toBeDefined();
  expect(document.paths['/auth/login']?.['post']?.security).toBeUndefined();
});

test('入力エラーが 422 と details を返す', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/login', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { csrfToken: token },
  });

  expect(response.status()).toBe(422);
  const body = (await response.json()) as {
    error: { code: string; message: string; details: Record<string, string[]> };
  };
  expect(body.error.code).toBe('VALIDATION_ERROR');
  expect(Object.keys(body.error.details).sort()).toEqual(['loginId', 'password']);
});

test('型が違う入力が 422 になる', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/login', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { loginId: 12345, password: true, csrfToken: token },
  });

  expect(response.status()).toBe(422);
});

test('未知のフィールドを送っても拒否されない', async ({ request }) => {
  // 検証を通ることだけを見る。未知のフィールドで 422 にならなければよい。
  const token = await csrf(request);
  const response = await request.post('/api/v1/sites', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      name: `未知フィールド ${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://example.com',
      csrfToken: token,
      futureField: 'x',
    },
  });

  expect(response.status()).toBe(201);
});

test('既定では CORS ヘッダを返さない', async ({ request }) => {
  const response = await request.get('/api/v1/auth/csrf', {
    headers: { Origin: 'https://other.example.com' },
  });
  expect(response.headers()['access-control-allow-origin']).toBeUndefined();
});

test('一覧の応答が data のみを持つ（ページング未対応のエンドポイント）', async ({ request }) => {
  const response = await request.get('/api/v1/roles');
  const body = (await response.json()) as Record<string, unknown>;

  expect(Object.keys(body)).toEqual(['data']);
});

test('エラー応答に内部情報が含まれない', async ({ request }) => {
  const response = await request.get('/api/v1/roles', { headers: { Cookie: '' } });
  const text = await response.text();

  expect(text).not.toContain('postgres');
  expect(text).not.toContain('kysely');
  expect(text).not.toMatch(/at .*\.ts:\d+/);
});
