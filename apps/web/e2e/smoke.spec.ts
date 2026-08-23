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

test('トップページが「とりふね」を表示する', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'とりふね' })).toBeVisible();
});
