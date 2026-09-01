import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * API Token（05_API設計.md §37-38、docs/設計/021-api-token/設計.md）。
 *
 * 既定でログイン済み（`playwright.config.ts` の storageState）。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

/** セッション認証で Token を発行し、平文を返す。 */
async function issueToken(
  request: APIRequestContext,
  scopes: readonly string[],
): Promise<{ token: string; id: string }> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/api-tokens', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { name: `e2e ${Math.random().toString(36).slice(2, 8)}`, scopes, csrfToken: token },
  });

  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: { token: string; id: string } };
  return { token: body.data.token, id: body.data.id };
}

test('発行時にだけ平文が返る', async ({ request }) => {
  const issued = await issueToken(request, ['site.read']);
  expect(issued.token).toMatch(/^tfp_/);

  // 一覧には平文が出ない。
  const list = await request.get('/api/v1/api-tokens');
  expect(await list.text()).not.toContain(issued.token);
});

test('Token で保護APIを読める', async ({ request }) => {
  const issued = await issueToken(request, ['site.read']);

  const response = await request.get('/api/v1/sites', {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  expect(response.status()).toBe(200);
});

test('Scope 外の操作は 403', async ({ request }) => {
  // 所有者は administrator なので site.write を持つが、Scope に入れていない。
  const issued = await issueToken(request, ['site.read']);

  const response = await request.post('/api/v1/sites', {
    headers: { Authorization: `Bearer ${issued.token}` },
    data: { name: 'とりふね', url: 'https://example.com', description: '', status: 'active' },
  });
  expect(response.status()).toBe(403);
});

/**
 * CSRF は「ブラウザが Cookie を自動送信すること」への対策。
 * Authorization ヘッダは自動送信されないため検証しない。
 * 検証したままだと、API クライアントが更新系を一切呼べない（設計 §2.5）。
 */
test('Bearer 認証では CSRF ヘッダ無しで更新できる', async ({ request }) => {
  const issued = await issueToken(request, ['site.read', 'site.write']);

  const response = await request.post('/api/v1/sites', {
    headers: { Authorization: `Bearer ${issued.token}` },
    data: { name: 'トークン経由', url: 'https://example.com', description: '', status: 'active' },
  });
  expect(response.status()).toBe(201);
});

test('失効した Token は 401', async ({ request }) => {
  const issued = await issueToken(request, ['site.read']);

  const token = await csrf(request);
  const revoked = await request.delete(`/api/v1/api-tokens/${issued.id}`, {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { csrfToken: token },
  });
  expect(revoked.status()).toBe(204);

  const response = await request.get('/api/v1/sites', {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  expect(response.status()).toBe(401);
});

test('でたらめな Token は 401', async ({ request }) => {
  const response = await request.get('/api/v1/sites', {
    headers: { Authorization: 'Bearer tfp_definitely-not-real' },
  });
  expect(response.status()).toBe(401);
});

/**
 * Token から Token を作れると、Scope を絞った Token より広い Token を
 * 発行できてしまう（設計 §5）。
 */
test('Token 認証では Token を発行できない', async ({ request }) => {
  const issued = await issueToken(request, ['token.manage']);

  const response = await request.post('/api/v1/api-tokens', {
    headers: { Authorization: `Bearer ${issued.token}` },
    data: { name: 'より広い Token', scopes: [] },
  });
  expect(response.status()).toBe(401);
});

/**
 * Cookie と Bearer が両方あるとき Bearer を優先する。
 * 「どちらでも通る」にすると、CSRF 検証を Bearer で迂回できてしまう。
 */
test('Cookie と Bearer が両方あるとき Bearer が使われる', async ({ request }) => {
  // Scope を空にした Token。セッションは administrator なので、
  // セッションが使われたなら 200、Bearer が使われたなら 403 になる。
  const issued = await issueToken(request, []);

  const response = await request.get('/api/v1/sites', {
    headers: { Authorization: `Bearer ${issued.token}` },
  });
  expect(response.status()).toBe(403);
});

test('自分が持たない権限を Scope に指定できない', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/api-tokens', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { name: 'ng', scopes: ['not.a.real.permission'], csrfToken: token },
  });

  expect(response.status()).toBe(422);
});
