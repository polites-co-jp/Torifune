import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

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

/**
 * 「一般」タブの定期実行の区画（029-scheduled-jobs 設計 §7.2、受け入れ条件 #61、#62）。
 *
 * E2E は定期実行が有効（`TORIFUNE_ROLLUP_INTERVAL_MINUTES=1`）で走る。初回遅延 15 秒 + 間隔 1 分なので、
 * サーバー起動から 60 秒以内に「アクセス解析の集計」の前回の実行が `ok` になる。
 * `global-setup.ts` が `job_runs` を消すので、前回の E2E 実行の行で空振りしない。
 */
test.describe('定期実行の区画', () => {
  /** 「アクセス解析の集計」の行。 */
  function rollupRow(page: Page): Locator {
    return page.getByRole('row', { name: /アクセス解析の集計/ });
  }

  /** #61（032-timezone-setting で洗い替えが増え、行は 3 つになった）。 */
  test('管理者で開くと「定期実行」の見出しと 3 つのジョブの行が出る', async ({ page }) => {
    await page.goto('/settings?tab=general');

    await expect(page.getByRole('heading', { name: '定期実行' })).toBeVisible();
    await expect(rollupRow(page)).toBeVisible();
    await expect(page.getByRole('row', { name: /Webhook 配信/ })).toBeVisible();
    // タブは増えない（06 §16）。「定期実行」というタブは無く、「一般」の中の区画。
    const tabs = page.getByRole('navigation', { name: '設定のタブ' });
    await expect(tabs.getByRole('link', { name: '定期実行' })).toHaveCount(0);
    await expect(tabs.getByRole('link', { name: '一般' })).toHaveAttribute('aria-current', 'page');
  });

  /** #61。起動から 60 秒以内に前回の実行が埋まる。 */
  test('サーバー起動から 60 秒以内に「アクセス解析の集計」の前回の実行が ok になり、「次回」が日時', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto('/settings?tab=general');

    await expect
      .poll(
        async () => {
          await page.reload();
          return rollupRow(page).locator('[data-job-status="ok"]').count();
        },
        { timeout: 60_000, intervals: [5_000] },
      )
      .toBeGreaterThanOrEqual(1);

    await expect(rollupRow(page)).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    // 「前回の実行」と「次回」の 2 つ以上の日時（前回の成功を含めると 3 つ）。
    const dateTimes = ((await rollupRow(page).textContent()) ?? '').match(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g,
    );
    expect(dateTimes?.length ?? 0).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('定期実行は有効です', { exact: false })).toBeVisible();
  });

  /** #62。表示制御（区画を出さない）と認可（API が 403）の両方。 */
  test('system.manage を持たない利用者は一般タブを開けるが「定期実行」が無く、GET /api/v1/jobs は 403', async ({
    browser,
    request,
  }) => {
    // viewer を作ってログインした別の browser context。
    const token = await csrf(request);
    const loginId = `e2e_jobs_${Math.random().toString(36).slice(2, 10)}`;
    const password = 'e2e settings jobs viewer password';
    const created = await request.post('/api/v1/users', {
      headers: { 'X-CSRF-Token': token, Origin: origin },
      data: {
        loginId,
        displayName: `E2E ${loginId}`,
        email: `${loginId}@example.com`,
        password,
        roles: ['viewer'],
        csrfToken: token,
      },
    });
    expect(created.status(), await created.text()).toBe(201);

    const context = await browser.newContext({ baseURL: origin });
    try {
      const loginToken = await csrf(context.request);
      const login = await context.request.post('/api/v1/auth/login', {
        headers: { 'X-CSRF-Token': loginToken, Origin: origin },
        data: { loginId, password, csrfToken: loginToken },
      });
      expect(login.status(), await login.text()).toBe(200);

      const page = await context.newPage();
      const response = await page.goto('/settings?tab=general');
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('navigation', { name: '設定のタブ' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '定期実行' })).toHaveCount(0);
      await expect(page.getByText('アクセス解析の集計', { exact: true })).toHaveCount(0);

      const jobs = await context.request.get('/api/v1/jobs');
      expect(jobs.status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});

/** 表示制御ではなく認可。URL で直接指しても中身を出さない。 */
test('未認証では設定画面に入れない', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/settings?tab=general');

  await expect(page).toHaveURL(/\/login$/);
});
