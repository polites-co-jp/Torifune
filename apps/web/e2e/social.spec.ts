import { expect, test, type APIRequestContext } from '@playwright/test';

/** SNS管理の E2E。**資格情報が外へ出ないこと**を重点的に確かめる。 */

const origin = 'http://127.0.0.1:3000';
const CREDENTIAL = 'e2e-super-secret-token-value';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

async function createAccount(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; displayName: string }> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/social/accounts', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      provider: 'x',
      displayName: `E2E ${unique()}`,
      handle: `@${unique()}`,
      credential: CREDENTIAL,
      status: 'connected',
      csrfToken: token,
      ...overrides,
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: { id: string; displayName: string } };
  return body.data;
}

test('アカウントを作成でき、応答に資格情報が含まれない', async ({ request }) => {
  const account = await createAccount(request);

  const got = await request.get(`/api/v1/social/accounts/${account.id}`);
  expect(got.status()).toBe(200);

  const text = await got.text();
  // **平文が応答に出ないこと。**
  expect(text).not.toContain(CREDENTIAL);

  const body = JSON.parse(text) as { data: Record<string, unknown> };
  expect(Object.keys(body.data).sort()).toEqual([
    'createdAt',
    'credentialConfigured',
    'displayName',
    'handle',
    'id',
    'provider',
    'status',
    'updatedAt',
  ]);
  expect(body.data['credentialConfigured']).toBe(true);
});

test('一覧の応答にも資格情報が含まれない', async ({ request }) => {
  await createAccount(request);

  const list = await request.get('/api/v1/social/accounts?perPage=100');
  expect(await list.text()).not.toContain(CREDENTIAL);
});

test('Core が知らない provider でも登録できる', async ({ request }) => {
  // Plugin が新しいSNSを足せる必要がある。
  const account = await createAccount(request, { provider: 'mastodon' });

  const got = await request.get(`/api/v1/social/accounts/${account.id}`);
  const body = (await got.json()) as { data: { provider: string } };
  expect(body.data.provider).toBe('mastodon');
});

test('provider の形式が不正なら 422', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/social/accounts', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { provider: 'X.com', displayName: 'x', csrfToken: token },
  });
  expect(response.status()).toBe(422);
});

test('資格情報を指定しない更新で、既存の資格情報が消えない', async ({ request }) => {
  const account = await createAccount(request);

  const token = await csrf(request);
  const patched = await request.patch(`/api/v1/social/accounts/${account.id}`, {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { displayName: '新しい名前', csrfToken: token },
  });
  expect(patched.status()).toBe(200);

  const body = (await patched.json()) as { data: { credentialConfigured: boolean } };
  expect(body.data.credentialConfigured).toBe(true);
});

test('投稿を作成し、状態を進められる', async ({ request }) => {
  const account = await createAccount(request);

  const token = await csrf(request);
  const created = await request.post('/api/v1/social/posts', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      socialAccountId: account.id,
      body: 'E2E の投稿',
      status: 'draft',
      csrfToken: token,
    },
  });
  expect(created.status()).toBe(201);
  const post = ((await created.json()) as { data: { id: string } }).data;

  const patchToken = await csrf(request);
  const published = await request.patch(`/api/v1/social/posts/${post.id}`, {
    headers: { 'X-CSRF-Token': patchToken, Origin: origin },
    data: { status: 'published', csrfToken: patchToken },
  });
  expect(published.status()).toBe(200);
  const publishedBody = (await published.json()) as {
    data: { status: string; publishedAt: string | null };
  };
  expect(publishedBody.data.status).toBe('published');
  expect(publishedBody.data.publishedAt).not.toBeNull();
});

test('published から draft へ戻せない', async ({ request }) => {
  const account = await createAccount(request);

  const token = await csrf(request);
  const created = await request.post('/api/v1/social/posts', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      socialAccountId: account.id,
      body: 'x',
      status: 'published',
      csrfToken: token,
    },
  });
  const post = ((await created.json()) as { data: { id: string } }).data;

  const patchToken = await csrf(request);
  const response = await request.patch(`/api/v1/social/posts/${post.id}`, {
    headers: { 'X-CSRF-Token': patchToken, Origin: origin },
    data: { status: 'draft', csrfToken: patchToken },
  });
  expect(response.status()).toBe(422);
});

test('存在しないアカウントへの投稿は 422', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/social/posts', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      socialAccountId: '01900000-0000-7000-8000-0000000000ff',
      body: 'x',
      csrfToken: token,
    },
  });
  expect(response.status()).toBe(422);
});

test('アカウントを削除すると投稿も消える', async ({ request }) => {
  const account = await createAccount(request);

  const token = await csrf(request);
  await request.post('/api/v1/social/posts', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { socialAccountId: account.id, body: 'x', csrfToken: token },
  });

  const deleteToken = await csrf(request);
  const deleted = await request.delete(`/api/v1/social/accounts/${account.id}`, {
    headers: { 'X-CSRF-Token': deleteToken, Origin: origin },
    data: { csrfToken: deleteToken },
  });
  expect(deleted.status()).toBe(204);

  const posts = await request.get(`/api/v1/social/posts?accountId=${account.id}`);
  const body = (await posts.json()) as { data: unknown[] };
  expect(body.data).toHaveLength(0);
});

test('未認証では 401', async ({ request }) => {
  expect((await request.get('/api/v1/social/accounts', { headers: { Cookie: '' } })).status()).toBe(
    401,
  );
});

test('SNS画面が表示され、資格情報がマスクされる', async ({ page, request }) => {
  await createAccount(request);
  await page.goto('/social');

  await expect(page.getByRole('heading', { name: 'SNS' })).toBeVisible();

  const body = await page.locator('body').innerText();
  // 画面に平文が出ない。
  expect(body).not.toContain(CREDENTIAL);
  expect(body).toContain('••••••••');
});

test('SNS画面に「配信はプラグインが行う」旨が出る', async ({ page }) => {
  // 出さないと「投稿したつもりで配信されていない」という誤解が起きる。
  await page.goto('/social');

  await expect(page.getByText(/実際の配信は、連携プラグインが行います/)).toBeVisible();
});
