import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

/** Webサイト管理の E2E。API と画面の両方を確かめる。 */

const origin = 'http://127.0.0.1:3000';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

/**
 * 指定したロールの利用者を作り、その利用者でログインした request context を返す。
 * 使い終わったら `dispose()` する。
 */
async function loginAsNewUser(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
  roles: readonly string[],
): Promise<APIRequestContext> {
  const token = await csrf(request);
  const loginId = `e2e_site_${unique()}`;
  const password = 'e2e sites regenerate key user password';
  const created = await request.post('/api/v1/users', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles,
      csrfToken: token,
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const context = await playwright.request.newContext({ baseURL: origin });
  const loginToken = await csrf(context);
  const login = await context.post('/api/v1/auth/login', {
    headers: { 'X-CSRF-Token': loginToken, Origin: origin },
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(login.status(), await login.text()).toBe(200);
  return context;
}

/** 画面の計測タグから公開キーを読む（一般 API では返していない）。 */
async function publicKeyOf(page: Page, siteId: string): Promise<string> {
  await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
  const snippet = await page
    .locator(`[data-tracking-snippet][data-site-id="${siteId}"]`)
    .textContent();
  const publicKey = /data-site="([^"]+)"/.exec(snippet ?? '')?.[1];
  expect(publicKey).toBeDefined();
  return publicKey ?? '';
}

/** `POST /sites/{id}/public-key` を CSRF 付きで呼ぶ。 */
async function regeneratePublicKey(request: APIRequestContext, siteId: string) {
  const token = await csrf(request);
  return request.post(`/api/v1/sites/${siteId}/public-key`, {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { csrfToken: token },
  });
}

async function createSite(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; name: string }> {
  const token = await csrf(request);
  const name = `E2E ${unique()}`;
  const response = await request.post('/api/v1/sites', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      name,
      url: `https://${unique()}.example.com`,
      description: '',
      status: 'active',
      csrfToken: token,
      ...overrides,
    },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { data: { id: string; name: string } };
  return body.data;
}

test('サイトを作成して一覧・取得できる', async ({ request }) => {
  const created = await createSite(request);

  const got = await request.get(`/api/v1/sites/${created.id}`);
  expect(got.status()).toBe(200);
  const body = (await got.json()) as { data: Record<string, unknown> };
  expect(body.data['id']).toBe(created.id);
  // 内部の項目を出さない。
  expect(Object.keys(body.data).sort()).toEqual([
    'createdAt',
    'description',
    'id',
    'name',
    'status',
    'updatedAt',
    'url',
  ]);

  const list = await request.get('/api/v1/sites');
  expect(list.status()).toBe(200);
  const listBody = (await list.json()) as { data: unknown[]; meta: { total: number } };
  expect(listBody.data.length).toBeGreaterThan(0);
  expect(listBody.meta.total).toBeGreaterThan(0);

  // #49。公開キーを再発行した後も、一般の取得には publicKey が出ない。
  expect((await regeneratePublicKey(request, created.id)).status()).toBe(200);
  const after = (await (await request.get(`/api/v1/sites/${created.id}`)).json()) as {
    data: Record<string, unknown>;
  };
  expect(Object.keys(after.data)).not.toContain('publicKey');
});

test('入力エラーが 422 とフィールド単位の説明を返す', async ({ request }) => {
  const token = await csrf(request);

  const response = await request.post('/api/v1/sites', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { name: '', url: 'javascript:alert(1)', csrfToken: token },
  });

  expect(response.status()).toBe(422);
  const body = (await response.json()) as { error: { details: Record<string, string[]> } };
  expect(Object.keys(body.error.details)).toContain('name');
});

test('javascript: の URL を拒否する', async ({ request }) => {
  const token = await csrf(request);

  const response = await request.post('/api/v1/sites', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { name: 'x', url: 'javascript:alert(1)', csrfToken: token },
  });

  expect(response.status()).toBe(422);
});

test('未許可の sort を 422 で拒否する', async ({ request }) => {
  const response = await request.get('/api/v1/sites?sort=created_at');
  expect(response.status()).toBe(422);

  const secret = await request.get('/api/v1/sites?sort=created_by');
  expect(secret.status()).toBe(422);
});

test('許可された sort は通る', async ({ request }) => {
  expect((await request.get('/api/v1/sites?sort=name')).status()).toBe(200);
  expect((await request.get('/api/v1/sites?sort=-createdAt')).status()).toBe(200);
});

test('archived は既定の一覧に出ない', async ({ request }) => {
  const archived = await createSite(request, { status: 'archived' });

  const list = await request.get('/api/v1/sites?perPage=100');
  const body = (await list.json()) as { data: { id: string }[] };
  expect(body.data.map((s) => s.id)).not.toContain(archived.id);

  const explicit = await request.get('/api/v1/sites?status=archived&perPage=100');
  const explicitBody = (await explicit.json()) as { data: { id: string }[] };
  expect(explicitBody.data.map((s) => s.id)).toContain(archived.id);
});

test('存在しないIDと不正なIDは 404', async ({ request }) => {
  expect((await request.get('/api/v1/sites/01900000-0000-7000-8000-0000000000ff')).status()).toBe(
    404,
  );
  // 不正な形式でも 500 にしない。
  expect((await request.get('/api/v1/sites/not-a-uuid')).status()).toBe(404);
});

test('更新と削除ができる', async ({ request }) => {
  const created = await createSite(request);

  const patchToken = await csrf(request);
  const patched = await request.patch(`/api/v1/sites/${created.id}`, {
    headers: { 'X-CSRF-Token': patchToken, Origin: origin },
    data: { name: '更新後', csrfToken: patchToken },
  });
  expect(patched.status()).toBe(200);
  const patchedBody = (await patched.json()) as { data: { name: string; url: string } };
  expect(patchedBody.data.name).toBe('更新後');
  // 指定しなかった項目が変わらない。
  expect(patchedBody.data.url).toBeTruthy();

  const deleteToken = await csrf(request);
  const deleted = await request.delete(`/api/v1/sites/${created.id}`, {
    headers: { 'X-CSRF-Token': deleteToken, Origin: origin },
    data: { csrfToken: deleteToken },
  });
  expect(deleted.status()).toBe(204);

  expect((await request.get(`/api/v1/sites/${created.id}`)).status()).toBe(404);
});

test('未認証では 401', async ({ request }) => {
  expect((await request.get('/api/v1/sites', { headers: { Cookie: '' } })).status()).toBe(401);
});

test('CSRF なしの作成は 403', async ({ request }) => {
  const response = await request.post('/api/v1/sites', {
    headers: { Origin: origin },
    data: { name: 'x', url: 'https://example.com' },
  });
  expect(response.status()).toBe(403);
});

/**
 * 公開キーの再発行 API（028 設計 §6.6、受け入れ条件 #48・#49）。
 *
 * `POST /api/v1/sites/{id}/public-key`（`operationId: regenerateSitePublicKey`、`site.write`）。
 */
test.describe('公開キーの再発行 API', () => {
  const HEX_64 = /^[0-9a-f]{64}$/;

  /** #48 */
  test('200 で { data: { siteId, publicKey } } を返す', async ({ request }) => {
    const created = await createSite(request);

    const response = await regeneratePublicKey(request, created.id);

    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['publicKey', 'siteId']);
    expect(body.data['siteId']).toBe(created.id);
    expect(body.data['publicKey']).toMatch(HEX_64);
  });

  /** #48。以前の計測タグに埋まっていた値と異なる。 */
  test('再発行したキーが以前の計測タグの値と異なる', async ({ page, request }) => {
    const created = await createSite(request);
    const before = await publicKeyOf(page, created.id);

    const response = await regeneratePublicKey(request, created.id);

    expect(response.status()).toBe(200);
    const body = (await response.json()) as { data: { publicKey: string } };
    expect(body.data.publicKey).not.toBe(before);
    // 画面の計測タグも新しいキーに切り替わる。
    expect(await publicKeyOf(page, created.id)).toBe(body.data.publicKey);
  });

  /** #48 */
  test('未認証では 401', async ({ request, playwright }) => {
    const created = await createSite(request);

    // ログインしていない context。`playwright.config.ts` の `storageState`（管理者セッション）を
    // 継承しないよう空の storageState を明示する。CSRF トークンだけは付けて、認証の判定に到達させる。
    const anonymous = await playwright.request.newContext({
      baseURL: origin,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const token = await csrf(anonymous);
      const response = await anonymous.post(`/api/v1/sites/${created.id}/public-key`, {
        headers: { 'X-CSRF-Token': token, Origin: origin },
        data: { csrfToken: token },
      });
      expect(response.status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });

  /** #48。`viewer` は `site.read` を持つが `site.write` を持たない。 */
  test('viewer ロールでは 403', async ({ request, playwright }) => {
    const created = await createSite(request);

    const viewer = await loginAsNewUser(request, playwright, ['viewer']);
    try {
      const response = await regeneratePublicKey(viewer, created.id);
      expect(response.status()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  /** #48。`editor` は `site.write` を持つ。 */
  test('editor ロールでは 200', async ({ request, playwright }) => {
    const created = await createSite(request);

    const editor = await loginAsNewUser(request, playwright, ['editor']);
    try {
      const response = await regeneratePublicKey(editor, created.id);
      expect(response.status(), await response.text()).toBe(200);
    } finally {
      await editor.dispose();
    }
  });

  /** #48 */
  test('存在しない ID は 404', async ({ request }) => {
    const response = await regeneratePublicKey(request, '01900000-0000-7000-8000-0000000000ff');
    expect(response.status()).toBe(404);
  });

  /** #48。不正な形式でも 500 にしない。 */
  test('UUID でない ID は 404', async ({ request }) => {
    const response = await regeneratePublicKey(request, 'not-a-uuid');
    expect(response.status()).toBe(404);
  });

  /** #48 */
  test('CSRF トークン無しは 403', async ({ request }) => {
    const created = await createSite(request);

    const response = await request.post(`/api/v1/sites/${created.id}/public-key`, {
      headers: { Origin: origin },
      data: {},
    });
    expect(response.status()).toBe(403);
  });

  /** #48。他のサイトの ID を指定しても、そのサイトのキーだけが変わる。 */
  test('他のサイトのキーは変わらない', async ({ page, request }) => {
    const target = await createSite(request);
    const other = await createSite(request);
    const otherBefore = await publicKeyOf(page, other.id);

    expect((await regeneratePublicKey(request, target.id)).status()).toBe(200);

    expect(await publicKeyOf(page, other.id)).toBe(otherBefore);
  });
});

test('画面から作成・編集・削除ができる', async ({ page }) => {
  const name = `UI ${unique()}`;

  // 作成
  await page.goto('/sites/new');
  await page.getByLabel('名前').fill(name);
  await page.getByLabel('URL').fill(`https://${unique()}.example.com`);
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForURL('**/sites');
  await expect(page.getByRole('cell', { name })).toBeVisible();

  // 編集
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: '編集' })
    .click();
  await page.waitForURL(/\/sites\/[0-9a-f-]+\/edit$/);
  await page.getByLabel('名前').fill(`${name} 改`);
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForURL('**/sites');
  await expect(page.getByRole('cell', { name: `${name} 改` })).toBeVisible();

  // 削除（確認ダイアログをキャンセルすると消えない）
  await page
    .getByRole('row', { name: new RegExp(`${name} 改`) })
    .getByRole('button', { name: '削除' })
    .click();
  await page.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.getByRole('cell', { name: `${name} 改` })).toBeVisible();

  // 削除（確認すると消える）
  await page
    .getByRole('row', { name: new RegExp(`${name} 改`) })
    .getByRole('button', { name: '削除' })
    .click();
  await page.getByRole('button', { name: '削除する' }).click();
  await expect(page.getByRole('cell', { name: `${name} 改` })).toBeHidden();
});

test('一覧画面が表示される', async ({ page }) => {
  await page.goto('/sites');

  await expect(page.getByRole('heading', { name: 'Webサイト' })).toBeVisible();
});
