import { expect, test } from '@playwright/test';

test('Liveness が ok を返す', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
});

test('Readiness がデータベースへの到達性を返す', async ({ request }) => {
  const response = await request.get('/api/ready');
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({
    status: 'ready',
    checks: { database: true },
  });
});

test('Readiness のレスポンスに接続情報が含まれない', async ({ request }) => {
  const body = await (await request.get('/api/ready')).text();
  expect(body).not.toContain('postgres');
  expect(body).not.toContain('torifune:torifune');
});

/**
 * トップページは表示を持たず、状態に応じて振り分ける（016-home-routing）。
 *
 * 「管理者が0人のとき /setup へ送る」は、E2E の開始状態が管理者1人であるため
 * ここでは確かめられない。結合テスト（`home-destination.integration.test.ts`）で見る。
 */
test('未ログインでトップページを開くとログイン画面へ送られる', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel('ログインID')).toBeVisible();
});

test('ログイン済みでトップページを開くとダッシュボードへ送られる', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
});
