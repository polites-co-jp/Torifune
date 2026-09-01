import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * 設定画面の 一般 / 認証 / API タブ（06_画面設計.md §16、015b-settings）。
 *
 * ユーザー・権限タブは `settings.spec.ts` で見ている。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

/** 表示名を戻す。テストの順序に依存させない。 */
test.afterEach(async ({ request }) => {
  const token = await csrf(request);
  await request.put('/api/v1/settings', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { serviceName: 'とりふね', rememberMeEnabled: true, csrfToken: token },
  });
});

test('5つのタブが出る', async ({ page }) => {
  await page.goto('/settings');

  const tabs = page.getByRole('navigation', { name: '設定のタブ' });
  for (const label of ['一般', 'ユーザー', '権限', '認証', 'API']) {
    await expect(tabs.getByRole('link', { name: label })).toBeVisible();
  }
});

test('一般タブでサービス表示名を変えるとヘッダに反映される', async ({ page }) => {
  await page.goto('/settings?tab=general');

  await page.getByLabel('サービス表示名').fill('検証環境');
  await page.getByRole('button', { name: '保存する' }).click();

  // ヘッダはサーバー側で描画しているため、保存後に読み込み直している。
  await expect(page.getByRole('banner').getByRole('link', { name: '検証環境' })).toBeVisible();
  await expect(page).toHaveTitle('検証環境');
});

test('認証タブに現在の認証方式とセッション方針が出る', async ({ page }) => {
  await page.goto('/settings?tab=auth');

  await expect(page.getByText('local')).toBeVisible();
  // 期間は表示のみ。画面から変えられないことを明記している。
  await expect(page.getByText('これらの値は画面からは変更できません。')).toBeVisible();
});

test('認証タブで長期ログインを無効にすると、ログイン画面から選択肢が消える', async ({
  page,
  request,
}) => {
  await page.goto('/settings?tab=auth');

  const toggle = page.getByLabel('ログイン画面で「ログインしたままにする」を選べるようにする');
  await expect(toggle).toBeChecked();

  // `uncheck()` は「押したあと外れていること」を即座に確かめる。
  // この項目は保存が成功してから状態を反転させる（保存中は操作を止める）ため、
  // 押す操作と結果の確認を分ける。
  await toggle.click();
  await expect(page.getByText('保存しました。')).toBeVisible();
  await expect(toggle).not.toBeChecked();

  await page.context().clearCookies();
  await page.goto('/login');
  await expect(page.getByLabel('ログインしたままにする')).toHaveCount(0);

  // 後始末は afterEach が行うが、Cookie を消したので API から戻す。
  const token = await csrf(request);
  await request.put('/api/v1/settings', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: { rememberMeEnabled: true, csrfToken: token },
  });
});

test('ログイン画面に長期ログインの選択肢が出る', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');

  await expect(page.getByLabel('ログインしたままにする')).toBeVisible();
});

test('API タブでトークンを発行でき、平文が一度だけ出る', async ({ page }) => {
  await page.goto('/settings?tab=api');

  await page.getByLabel('名前').fill('e2e settings');
  await page.getByRole('button', { name: '発行する' }).click();

  const issued = page.locator('[data-issued-token]');
  await expect(issued).toBeVisible();
  await expect(await issued.textContent()).toMatch(/^tfp_/);

  // 一度きりであることを画面で明言する。
  await expect(page.getByText('この値はこの画面でしか表示されません。')).toBeVisible();

  // 閉じたら二度と出ない。
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(issued).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-issued-token]')).toHaveCount(0);
});

test('API タブに CORS が読み取り専用で出る', async ({ page }) => {
  await page.goto('/settings?tab=api');

  await expect(page.getByText('画面からは変更できません', { exact: false })).toBeVisible();
});

/** 表示制御ではなく認可。URL で直接指しても中身を出さない。 */
test('未認証では設定画面に入れない', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/settings?tab=general');

  await expect(page).toHaveURL(/\/login$/);
});
