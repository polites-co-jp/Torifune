import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * 設定画面（015-settings）の E2E。
 *
 * **無効化した利用者が本当にログインできなくなること**を、
 * 実際のログインで確かめるのがこのファイルの主眼。
 */

const origin = 'http://127.0.0.1:3000';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

interface CreatedUser {
  readonly id: string;
  readonly loginId: string;
  readonly password: string;
}

async function createUser(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
): Promise<CreatedUser> {
  const token = await csrf(request);
  const loginId = `e2e_${unique()}`;
  const password = 'e2e settings correct horse battery staple';

  const response = await request.post('/api/v1/users', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles: ['viewer'],
      csrfToken: token,
      ...overrides,
    },
  });

  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data: { id: string } };
  return { id: body.data.id, loginId, password };
}

test('ユーザーを作成でき、応答にパスワードハッシュが含まれない', async ({ request }) => {
  const token = await csrf(request);
  const loginId = `e2e_${unique()}`;

  const response = await request.post('/api/v1/users', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      loginId,
      displayName: 'API から作った人',
      email: `${loginId}@example.com`,
      password: 'e2e correct horse battery staple',
      roles: ['editor'],
      csrfToken: token,
    },
  });

  expect(response.status()).toBe(201);
  const text = await response.text();
  // **応答本文を全文で見る**（05_API設計.md §15）。
  expect(text).not.toContain('passwordHash');
  expect(text).not.toContain('password_hash');
  expect(text).not.toContain('$argon2');

  const body = (await response.json()) as { data: Record<string, unknown> };
  expect(Object.keys(body.data).sort()).toEqual([
    'createdAt',
    'displayName',
    'email',
    'id',
    'lastLoginAt',
    'loginId',
    'roles',
    'status',
    'updatedAt',
  ]);
});

test('一覧の応答にもパスワードハッシュが含まれない', async ({ request }) => {
  await createUser(request);
  const response = await request.get('/api/v1/users');

  expect(response.status()).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('passwordHash');
  expect(text).not.toContain('$argon2');
});

test('未許可の並び替えは 422', async ({ request }) => {
  const response = await request.get('/api/v1/users?sort=password_hash');
  expect(response.status()).toBe(422);
});

test('存在しないIDで 404、不正な形式のIDでも 404', async ({ request }) => {
  expect((await request.get('/api/v1/users/01900000-0000-7000-8000-0000000000ff')).status()).toBe(
    404,
  );
  // 500 にしない。
  expect((await request.get('/api/v1/users/not-a-uuid')).status()).toBe(404);
});

test('未認証では 401', async ({ request }) => {
  expect((await request.get('/api/v1/users', { headers: { Cookie: '' } })).status()).toBe(401);
});

test('**無効化した利用者はログインできない**', async ({ request, playwright }) => {
  const user = await createUser(request);

  // まずログインできることを確かめる。
  const before = await playwright.request.newContext({ baseURL: origin });
  try {
    const token = await csrf(before);
    const login = await before.post('/api/v1/auth/login', {
      headers: { 'X-CSRF-Token': token, Origin: origin },
      data: { loginId: user.loginId, password: user.password, csrfToken: token },
    });
    expect(login.status()).toBe(200);
  } finally {
    await before.dispose();
  }

  const patchToken = await csrf(request);
  const disabled = await request.patch(`/api/v1/users/${user.id}`, {
    headers: { 'X-CSRF-Token': patchToken, Origin: origin },
    data: { status: 'disabled', csrfToken: patchToken },
  });
  expect(disabled.status()).toBe(200);

  const after = await playwright.request.newContext({ baseURL: origin });
  try {
    const token = await csrf(after);
    const login = await after.post('/api/v1/auth/login', {
      headers: { 'X-CSRF-Token': token, Origin: origin },
      data: { loginId: user.loginId, password: user.password, csrfToken: token },
    });
    // 「無効だから」とは返さない。資格情報の誤りと同じ扱い。
    expect(login.status()).toBe(401);
  } finally {
    await after.dispose();
  }
});

test('**自分自身は無効化も削除もできない**', async ({ request }) => {
  const me = await request.get('/api/v1/auth/me');
  const body = (await me.json()) as { data: { id: string } };

  const patchToken = await csrf(request);
  const disabled = await request.patch(`/api/v1/users/${body.data.id}`, {
    headers: { 'X-CSRF-Token': patchToken, Origin: origin },
    data: { status: 'disabled', csrfToken: patchToken },
  });
  expect(disabled.status()).toBe(422);

  const deleteToken = await csrf(request);
  const removed = await request.delete(`/api/v1/users/${body.data.id}`, {
    headers: { 'X-CSRF-Token': deleteToken, Origin: origin },
    data: { csrfToken: deleteToken },
  });
  expect(removed.status()).toBe(422);
});

test('**存在しないロールは割り当てられない**', async ({ request }) => {
  const token = await csrf(request);
  const loginId = `e2e_${unique()}`;

  const response = await request.post('/api/v1/users', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      loginId,
      displayName: '昇格を試みる人',
      email: `${loginId}@example.com`,
      password: 'e2e correct horse battery staple',
      roles: ['superuser'],
      csrfToken: token,
    },
  });

  expect(response.status()).toBe(422);
});

test('設定画面のユーザータブに一覧が出る', async ({ page, request }) => {
  const user = await createUser(request);
  await page.goto('/settings?tab=users');

  await expect(page.getByRole('heading', { name: 'ユーザー', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: user.loginId, exact: true })).toBeVisible();

  // **画面にもハッシュが出ない。**
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('$argon2');
});

test('画面からユーザーを作成できる', async ({ page }) => {
  const loginId = `e2e_${unique()}`;
  await page.goto('/settings?tab=users');

  await page.getByRole('button', { name: '+ ユーザーを追加' }).click();
  await page.getByLabel('ログインID').fill(loginId);
  await page.getByLabel('表示名').fill('画面から作った人');
  await page.getByLabel('メールアドレス').fill(`${loginId}@example.com`);
  await page.getByLabel('パスワード').fill('e2e correct horse battery staple');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByRole('cell', { name: loginId, exact: true })).toBeVisible();
});

test('削除に確認ダイアログが出て、キャンセルすると消えない', async ({ page, request }) => {
  const user = await createUser(request);
  await page.goto('/settings?tab=users');

  const row = page.getByRole('row').filter({ hasText: user.loginId });
  await row.getByRole('button', { name: '削除' }).click();

  await expect(page.getByText('この操作は取り消せません')).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByRole('cell', { name: user.loginId, exact: true })).toBeVisible();

  await row.getByRole('button', { name: '削除' }).click();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(page.getByRole('cell', { name: user.loginId, exact: true })).toHaveCount(0);
});

test('権限タブに対応表が出て、操作用のボタンが無い', async ({ page }) => {
  await page.goto('/settings?tab=permissions');

  const matrix = page.getByTestId('permission-matrix');
  await expect(matrix).toBeVisible();
  await expect(matrix.getByText('user.manage')).toBeVisible();
  await expect(page.getByText('ロールの作成・編集はこの画面では行えません')).toBeVisible();

  // 参照のみ。表の中に操作用のボタンを置かない。
  await expect(matrix.getByRole('button')).toHaveCount(0);
});
