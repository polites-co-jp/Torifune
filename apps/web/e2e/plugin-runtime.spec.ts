import { expect, test } from '@playwright/test';

/**
 * Plugin ランタイムの E2E。
 *
 * **Plugin を実際に入れた状態の描画は `013-example-plugin` で確かめる。**
 * ここでは、Plugin が入っていない状態でも本体が正しく振る舞うことを見る
 * （入っていない Plugin の URL を叩かれても何も漏らさない、など）。
 */

test('入っていない Plugin の URL は 404 になる', async ({ page }) => {
  const response = await page.goto('/plugins/not-installed');

  expect(response?.status()).toBe(404);
});

test('404 の中身から Plugin の状態を推測できない', async ({ page }) => {
  // 「無効です」と返すと、どの Plugin が入っているかを未認可の相手へ教える。
  // URL そのものは要求した側が知っているので、そこは問題にしない。
  await page.goto('/plugins/not-installed');
  const visible = (await page.locator('body').innerText()) ?? '';

  for (const word of ['無効', '有効', '導入', '権限', 'disabled', 'enabled']) {
    expect(visible).not.toContain(word);
  }
});

test('未導入と権限不足で応答が変わらない', async ({ page }) => {
  // 応答が違うと、権限の無いユーザーでも「その Plugin はある」と分かる。
  const missing = await page.goto('/plugins/not-installed');
  const missingText = await page.locator('body').innerText();

  const other = await page.goto('/plugins/also-not-installed');
  const otherText = await page.locator('body').innerText();

  expect(missing?.status()).toBe(other?.status());
  expect(missingText).toBe(otherText);
});

test('深い階層の Plugin URL も 404 になる', async ({ page }) => {
  const response = await page.goto('/plugins/not-installed/reports/2026/08');

  expect(response?.status()).toBe(404);
});

test('未ログインで Plugin の URL を開くとログイン画面へ送られる', async ({ page }) => {
  // 未認証のまま Plugin の有無を試せると、入っている Plugin を数え上げられる。
  await page.context().clearCookies();
  await page.goto('/plugins/not-installed');

  await expect(page).toHaveURL(/\/login/);
});

test('誰も使っていない拡張枠は描かれない', async ({ page }) => {
  // 空の枠を描くと、余白だけが残って見た目が崩れる。
  //
  // 「Plugin が1つも無い」ことに頼らない。同じサーバーで
  // サンプル Plugin を有効にするテストが動くため、
  // **誰も登録していない置き場**で確かめる。
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
  await expect(page.locator('[data-plugin-widgets="site.detail"]')).toHaveCount(0);
  await expect(page.locator('[data-extension-point="settings.tabs"]')).toHaveCount(0);
});

test('本体の項目が Plugin に押しのけられない', async ({ page }) => {
  // Plugin の項目は Core の項目のあとに並ぶ（011-plugin-runtime）。
  await page.goto('/dashboard');

  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  const links = await nav.getByRole('link').allTextContents();

  expect(links.slice(0, 4)).toEqual(['ダッシュボード', 'Webサイト', 'SNS', 'プラグイン']);
});
