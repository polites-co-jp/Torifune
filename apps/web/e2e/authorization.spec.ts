import { expect, test, type APIRequestContext } from '@playwright/test';
import { SEEDED_ADMIN } from './global-setup';

/**
 * 認可の E2E。
 *
 * 開始状態は `global-setup.ts` が作る（管理者が1人だけいる状態）。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/login', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      loginId: SEEDED_ADMIN.loginId,
      password: SEEDED_ADMIN.password,
      csrfToken: token,
    },
  });
  expect(response.status()).toBe(200);
}

test('管理者は 12 種の permissions を持つ', async ({ request }) => {
  await loginAsAdmin(request);

  const me = await request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);

  const body = (await me.json()) as { data: { permissions: string[] } };
  expect(body.data.permissions).toHaveLength(12);
  expect(body.data.permissions).toContain('user.manage');
  // 並び順が安定していること（UI 側の比較を安定させるため）
  expect(body.data.permissions).toEqual([...body.data.permissions].sort());
});

test('管理者はロール一覧と権限一覧を見られる', async ({ request }) => {
  await loginAsAdmin(request);

  const roles = await request.get('/api/v1/roles');
  expect(roles.status()).toBe(200);
  const roleBody = (await roles.json()) as { data: { name: string }[] };
  expect(roleBody.data.map((r) => r.name)).toEqual(['administrator', 'editor', 'viewer']);

  const permissions = await request.get('/api/v1/permissions');
  expect(permissions.status()).toBe(200);
  const permissionBody = (await permissions.json()) as { data: unknown[] };
  expect(permissionBody.data).toHaveLength(12);
});

test('未認証では 401 になる', async ({ request }) => {
  expect((await request.get('/api/v1/roles', { headers: { Cookie: '' } })).status()).toBe(401);
  expect((await request.get('/api/v1/permissions', { headers: { Cookie: '' } })).status()).toBe(
    401,
  );
});

test('エラー応答に要求された Permission 名が含まれない', async ({ request }) => {
  // どの権限が足りないかを教えると、権限体系の探索に使える。
  const response = await request.get('/api/v1/roles', { headers: { Cookie: '' } });
  expect(await response.text()).not.toContain('user.manage');
});

test('リクエストヘッダで権限を主張しても通らない', async ({ request }) => {
  // クライアントから送られた値は判定に使われない（04_認証設計.md §28）。
  const response = await request.get('/api/v1/roles', {
    headers: { Cookie: '', 'X-Permissions': 'user.manage,system.manage' },
  });
  expect(response.status()).toBe(401);
});
