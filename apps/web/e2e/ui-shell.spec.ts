import { expect, test, type Page } from '@playwright/test';
import { SEEDED_ADMIN } from './global-setup';

/** UI 基盤の E2E。画面から実際に操作して確かめる。 */

/** ログインの流れそのものを試すとき用。他のテストは storageState で既にログイン済み。 */
async function loginViaUi(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByLabel('ログインID').fill(SEEDED_ADMIN.loginId);
  await page.getByLabel('パスワード').fill(SEEDED_ADMIN.password);
  await page.getByRole('button', { name: 'ログイン' }).click();
  // ログイン後は `/` へ戻り、`/` が状態を見て `/dashboard` へ送る（016-home-routing）。
  await page.waitForURL('**/dashboard');
}

test('ログイン画面からログインしてダッシュボードへ行ける', async ({ page }) => {
  await loginViaUi(page);

  await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();
});

test('共通レイアウトにサービス名とユーザー名が出る', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page.getByRole('link', { name: 'とりふね' })).toBeVisible();
  await expect(page.getByText('E2E Admin')).toBeVisible();
  await expect(page.getByRole('link', { name: 'ログアウト' })).toBeVisible();
});

test('管理者にはすべてのナビゲーション項目が見える', async ({ page }) => {
  await page.goto('/dashboard');

  const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
  for (const label of ['ダッシュボード', 'Webサイト', 'SNS', '設定', 'プラグイン']) {
    await expect(nav.getByRole('link', { name: label })).toBeVisible();
  }
});

test('未ログインでダッシュボードを開くとログイン画面へ送られる', async ({ page }) => {
  await page.context().clearCookies();

  await page.goto('/dashboard');

  await expect(page).toHaveURL(/\/login$/);
});

test('ログイン失敗時にエラーが表示される', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');

  await page.getByLabel('ログインID').fill(SEEDED_ADMIN.loginId);
  await page.getByLabel('パスワード').fill('definitely wrong password');
  await page.getByRole('button', { name: 'ログイン' }).click();

  // Next.js の route announcer も role="alert" を持つため、フォーム内に限定する。
  const alert = page.getByRole('main').getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('ログインIDまたはパスワードが正しくありません');
});

test('エラー表示に内部情報が含まれない', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');

  await page.getByLabel('ログインID').fill('ghost-user');
  await page.getByLabel('パスワード').fill('wrong');
  await page.getByRole('button', { name: 'ログイン' }).click();

  const body = await page.locator('body').innerText();
  expect(body).not.toContain('argon2');
  expect(body).not.toContain('postgres');
  expect(body).not.toMatch(/\.ts:\d+/);
});

test('ログアウトするとログイン画面へ戻り、認証が切れる', async ({ page }) => {
  // **自前のセッションでログインしてからログアウトする。**
  // 共有セッション（storageState）でログアウトすると、サーバー側でそれが失効し、
  // 他のテストファイルまで巻き添えになる。
  await loginViaUi(page);
  await page.goto('/dashboard');

  await page.getByRole('link', { name: 'ログアウト' }).click();
  await page.waitForURL('**/login');

  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});

test('トークンを差し替えるだけで見た目が変わる（トークン集約の確認）', async ({ page }) => {
  await page.goto('/dashboard');

  const header = page.getByRole('banner');
  const before = await header.evaluate((node) => getComputedStyle(node).backgroundColor);

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--tf-color-bg', 'rgb(1, 2, 3)');
  });

  const after = await header.evaluate((node) => getComputedStyle(node).backgroundColor);

  expect(before).not.toBe(after);
  expect(after).toBe('rgb(1, 2, 3)');
});
