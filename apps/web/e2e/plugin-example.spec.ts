import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * サンプル Plugin の E2E（013-example-plugin）。
 *
 * **導入 → 有効化で拡張がすべて現れ、無効化で消えることを、実際の画面で確かめる。**
 *
 * この Plugin を有効にすると本体の画面が変わるため、
 * 最後に必ず無効化して削除する。残すと他のテストの前提を壊す。
 */

const PLUGIN_ID = 'example-plugin';
const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

async function post(request: APIRequestContext, path: string, data: object = {}) {
  const token = await csrf(request);
  return request.post(path, {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: { ...data, csrfToken: token },
  });
}

test.beforeAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: origin,
    storageState: './e2e/.auth/admin.json',
  });

  const installed = await post(request, '/api/v1/plugins', {
    pluginId: PLUGIN_ID,
    acknowledgedPermissions: true,
  });
  expect(installed.status(), await installed.text()).toBe(201);

  const enabled = await post(request, `/api/v1/plugins/${PLUGIN_ID}/enable`);
  const body = (await enabled.json()) as { data?: { ok?: boolean; reason?: string } };
  expect(body.data?.reason ?? null).toBeNull();
  expect(body.data?.ok).toBe(true);

  await request.dispose();
});

test.afterAll(async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: origin,
    storageState: './e2e/.auth/admin.json',
  });

  await post(request, `/api/v1/plugins/${PLUGIN_ID}/disable`);

  const token = await csrf(request);
  await request.delete(`/api/v1/plugins/${PLUGIN_ID}`, {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    // ファイルは残す。リポジトリに置いてあるサンプルを消してはいけない。
    data: { deleteData: true, deleteFiles: false, confirm: PLUGIN_ID, csrfToken: token },
  });

  await request.dispose();
});

test('左ナビに項目が増える', async ({ page }) => {
  await page.goto('/dashboard');

  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await expect(nav.getByRole('link', { name: 'サンプルPlugin' })).toBeVisible();
});

test('ダッシュボードに Widget が出る', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page.getByTestId('example-widget')).toBeVisible();
  await expect(page.locator('[data-plugin-widgets="dashboard"]')).toBeVisible();
});

test('Plugin のページが開き、Data API でWebサイトを読める', async ({ page }) => {
  await page.goto('/plugins/example-plugin');

  await expect(page.getByRole('heading', { name: 'サンプルPlugin' })).toBeVisible();
  // Data API は Plugin が宣言した Permission を通る。
  await expect(page.getByTestId('example-site-total')).toBeVisible();
});

test('Webサイト一覧に Action が出る', async ({ page }) => {
  await page.goto('/sites');

  await expect(page.getByTestId('example-site-action')).toBeVisible();
});

test('Webサイト編集の拡張点に差し込まれる', async ({ page, request }) => {
  const token = await csrf(request);
  const created = await request.post('/api/v1/sites', {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: {
      name: 'サンプル拡張点の確認',
      url: 'https://example.com/extension-point',
      csrfToken: token,
    },
  });
  const body = (await created.json()) as { data: { id: string } };

  await page.goto(`/sites/${body.data.id}/edit`);

  await expect(page.getByTestId('example-site-sidebar')).toBeVisible();
  await expect(page.locator('[data-extension-point="site.edit.sidebar"]')).toBeVisible();

  await request.delete(`/api/v1/sites/${body.data.id}`, {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: { csrfToken: token },
  });
});

test('設定画面で一般設定と Secret を扱える', async ({ page }) => {
  await page.goto(`/plugins/${PLUGIN_ID}/settings`);

  await expect(page.getByRole('heading', { name: 'サンプルPlugin の設定' })).toBeVisible();
  await expect(page.getByLabel('あいさつ')).toHaveValue('こんにちは');
  await expect(page.getByTestId('secret-state-api-token')).toHaveText('未設定');

  await page.getByLabel('あいさつ').fill('やあ');
  await page.getByLabel('APIトークン').fill('とても秘密');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByTestId('secret-state-api-token')).toHaveText('設定済み');
});

test('Secret の平文が画面にもレスポンスにも出ない', async ({ page }) => {
  // 06_画面設計.md §38。
  await page.goto(`/plugins/${PLUGIN_ID}/settings`);

  expect(await page.content()).not.toContain('とても秘密');
  await expect(page.getByLabel('APIトークン')).toHaveValue('');

  const body = await page.evaluate(async () => {
    const response = await fetch('/api/v1/plugins/example-plugin/settings');
    return response.text();
  });
  expect(body).not.toContain('とても秘密');
});

test('宣言されていない設定項目は保存できない', async ({ request }) => {
  // フォームを細工して Plugin の任意のキーを書き換えられないようにする。
  const token = await csrf(request);
  const response = await request.put(`/api/v1/plugins/${PLUGIN_ID}/settings`, {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: { values: { 'not-declared': 'x' }, csrfToken: token },
  });

  expect(response.status()).toBe(422);
});

test('Plugin管理画面に導入済みとして出る', async ({ page }) => {
  await page.goto('/plugins');

  await expect(page.getByText('サンプルPlugin  1.0.0')).toBeVisible();
  await expect(page.getByText('example-plugin.report.read')).toBeVisible();
});

test('無効化すると拡張がすべて消える', async ({ page, request }) => {
  await post(request, `/api/v1/plugins/${PLUGIN_ID}/disable`);

  await page.goto('/dashboard');
  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  await expect(nav.getByRole('link', { name: 'サンプルPlugin' })).toHaveCount(0);
  await expect(page.getByTestId('example-widget')).toHaveCount(0);

  await page.goto('/sites');
  await expect(page.getByTestId('example-site-action')).toHaveCount(0);

  // 無効な Plugin のページは存在しないものとして扱う。
  const response = await page.goto('/plugins/example-plugin');
  expect(response?.status()).toBe(404);

  // 元へ戻しておく。afterAll が無効化と削除を行う。
  await post(request, `/api/v1/plugins/${PLUGIN_ID}/enable`);
});
