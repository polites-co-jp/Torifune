import { expect, test } from '@playwright/test';

test('ヘルスチェックが ok を返す', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({ status: 'ok' });
});

test('トップページが「とりふね」を表示する', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'とりふね' })).toBeVisible();
});
