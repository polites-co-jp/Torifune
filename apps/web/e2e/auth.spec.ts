import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * 認証の E2E。
 *
 * `/setup` は「管理者が0人」を前提にするため、このファイルは**直列で実行する**。
 * 並列だと、あるテストが作った管理者で別のテストの前提が崩れる。
 */
test.describe.configure({ mode: 'serial' });

const password = 'correct horse battery staple';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

/**
 * ブラウザと同じ条件で POST する。
 *
 * Playwright の API クライアントは Origin を送らない。実ブラウザは POST に必ず
 * Origin を付けるため、送らないクライアントは CSRF 検証で弾かれるのが正しい挙動。
 * ここでは「ブラウザとして振る舞う」ことを明示する。
 */
function browserHeaders(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: 'http://127.0.0.1:3000' };
}

test('初回セットアップ → ログイン → ログアウトが通る', async ({ request }) => {
  const suffix = unique();
  const loginId = `admin${suffix}`;

  // --- セットアップが開いている ---
  const setupPage = await request.get('/setup');
  expect(setupPage.status()).toBe(200);

  // --- 最初の管理者を作る ---
  const token = await csrf(request);
  const created = await request.post('/api/v1/setup', {
    headers: browserHeaders(token),
    data: {
      loginId,
      displayName: 'E2E Admin',
      email: `${loginId}@example.com`,
      password,
      csrfToken: token,
    },
  });
  expect(created.status()).toBe(201);

  // --- セットアップが閉じる ---
  expect((await request.get('/setup')).status()).toBe(404);

  const second = await request.post('/api/v1/setup', {
    headers: browserHeaders(token),
    data: {
      loginId: `other${suffix}`,
      displayName: 'Other',
      email: `other${suffix}@example.com`,
      password,
      csrfToken: token,
    },
  });
  expect(second.status()).toBe(404);

  // --- ログインできる ---
  const loginToken = await csrf(request);
  const loggedIn = await request.post('/api/v1/auth/login', {
    headers: browserHeaders(loginToken),
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(loggedIn.status()).toBe(200);

  // セッション Cookie が HttpOnly である
  const setCookie = loggedIn.headers()['set-cookie'] ?? '';
  expect(setCookie).toContain('torifune_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite');

  // --- 認証済みとして扱われる ---
  const me = await request.get('/api/v1/auth/me');
  expect(me.status()).toBe(200);
  const meBody = (await me.json()) as { data: Record<string, unknown> };
  expect(meBody.data['loginId']).toBe(loginId);
  expect(Object.keys(meBody.data).sort()).toEqual(['displayName', 'email', 'id', 'loginId']);

  // --- ログアウトすると認証が切れる ---
  const logoutToken = await csrf(request);
  const loggedOut = await request.post('/api/v1/auth/logout', {
    headers: browserHeaders(logoutToken),
    data: { csrfToken: logoutToken },
  });
  expect(loggedOut.status()).toBe(204);

  expect((await request.get('/api/v1/auth/me')).status()).toBe(401);
});

test('CSRF トークンが無い POST は拒否される', async ({ request }) => {
  const response = await request.post('/api/v1/auth/login', {
    headers: { Origin: 'http://127.0.0.1:3000' },
    data: { loginId: 'someone', password: 'whatever' },
  });
  expect(response.status()).toBe(403);
});

test('Origin が無い POST は拒否される', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/login', {
    headers: { 'X-CSRF-Token': token },
    data: { loginId: 'someone', password: 'whatever', csrfToken: token },
  });
  expect(response.status()).toBe(403);
});

test('別オリジンからの POST は拒否される', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/login', {
    headers: { 'X-CSRF-Token': token, Origin: 'https://evil.example.com' },
    data: { loginId: 'someone', password: 'whatever', csrfToken: token },
  });
  expect(response.status()).toBe(403);
});

test('未認証で /api/v1/auth/me を呼ぶと 401', async ({ request }) => {
  const response = await request.get('/api/v1/auth/me');
  expect(response.status()).toBe(401);
});

test('存在しないIDと誤ったパスワードの応答が同じ', async ({ request }) => {
  const tokenA = await csrf(request);
  const noSuchUser = await request.post('/api/v1/auth/login', {
    headers: browserHeaders(tokenA),
    data: { loginId: `ghost${unique()}`, password: 'wrong', csrfToken: tokenA },
  });

  const tokenB = await csrf(request);
  const wrongPassword = await request.post('/api/v1/auth/login', {
    headers: browserHeaders(tokenB),
    data: { loginId: `ghost2${unique()}`, password: 'also wrong', csrfToken: tokenB },
  });

  expect(noSuchUser.status()).toBe(wrongPassword.status());
  expect(await noSuchUser.text()).toBe(await wrongPassword.text());
});

test('パスワードリセット要求は、登録の有無にかかわらず 204', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/password-reset/request', {
    headers: browserHeaders(token),
    data: { email: `nobody${unique()}@example.com`, csrfToken: token },
  });
  expect(response.status()).toBe(204);
});

test('ログイン画面が表示される', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'とりふね' })).toBeVisible();
  await expect(page.getByLabel('ログインID')).toBeVisible();
  await expect(page.getByLabel('パスワード')).toBeVisible();
});

test('エラー応答に内部情報が含まれない', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/auth/login', {
    headers: browserHeaders(token),
    data: { loginId: `ghost${unique()}`, password: 'wrong', csrfToken: token },
  });

  const body = await response.text();
  expect(body).not.toContain('argon2');
  expect(body).not.toContain('postgres');
  expect(body).not.toMatch(/at .*\.ts:\d+/);
});
