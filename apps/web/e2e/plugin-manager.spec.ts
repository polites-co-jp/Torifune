import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Plugin 管理画面の E2E。
 *
 * Plugin が入っていない状態を前提にする。
 * **実際に Plugin を導入する流れは `013-example-plugin` で確かめる。**
 * ここでは、認可と危険な操作の作りを見る。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

test('管理画面が開き、Plugin管理の見出しが出る', async ({ page }) => {
  await page.goto('/plugins');

  await expect(page.getByRole('heading', { name: 'Plugin管理' })).toBeVisible();
});

test('Plugin が無ければ、追加への導線が出る', async ({ page }) => {
  await page.goto('/plugins');

  await expect(page.getByRole('button', { name: 'Pluginを追加' })).toBeVisible();
  await expect(page.getByText('plugins/ へ置いてください')).toBeVisible();
});

/**
 * 036 Bluesky 配信 Plugin 受け入れ条件 #72（035 #103 / #104 と同じ場所）。
 *
 * **導入前に読めることが要点。** 資格情報を受け取る拡張点を握る Plugin かどうかは、
 * 入れてしまった後に分かるのでは遅い。
 *
 * **ここでは導入も有効化もしない。** 外部への通信を1本も出さない（#73）。
 */
test('検出済みに「Bluesky配信」が導入前から並び、握る拡張点が読める', async ({ page }) => {
  await page.goto('/plugins');

  const detected = page.locator('section[aria-labelledby="detected-heading"]');
  await expect(detected.getByRole('heading', { name: /Bluesky配信/ })).toBeVisible();

  const card = detected.locator('section').filter({ hasText: 'Bluesky配信' });
  await expect(card.getByText('SNS配信（SNSアカウントの資格情報を受け取ります）')).toBeVisible();
  await expect(card.getByText('画面の拡張')).toBeVisible();
});

/**
 * 038 Instagram 配信 Plugin 受け入れ条件 #95。
 *
 * **画面の拡張点を宣言しない**ので、握る拡張点は「SNS配信」だけが読める。
 * 行は Manifest の `name`（「Instagram配信」）で絞る。**ここでは導入も有効化もしない**（#93）。
 */
test('検出済みに「Instagram配信」が導入前から並び、SNS配信だけを握ると読める', async ({ page }) => {
  await page.goto('/plugins');

  const detected = page.locator('section[aria-labelledby="detected-heading"]');
  await expect(detected.getByRole('heading', { name: /Instagram配信/ })).toBeVisible();

  const card = detected.locator('section').filter({ hasText: 'Instagram配信' });
  await expect(card.getByText('SNS配信（SNSアカウントの資格情報を受け取ります）')).toBeVisible();
  await expect(card.getByText('画面の拡張')).toHaveCount(0);
});

/**
 * 037 X 配信 Plugin 受け入れ条件 #87。
 *
 * 2 つの Plugin（無料版と有料版）が導入前から別々の行で並び、どちらも「SNS配信」だけを握ると読める。
 * **2 つの Manifest の `name` は「X配信」を共有する**ので、行は `name` の全体（括弧は全角）で絞り、
 * 各ロケータが 1 件だけに当たることを確かめる（strict mode に触れない。`.first()` で黙って解決しない）。
 * spec に Plugin ID を書かない（#85）。**ここでは導入も有効化もしない。**
 */
for (const name of ['X配信（手動投稿）', 'X配信（X API）']) {
  test(`検出済みに「${name}」が導入前から並び、SNS配信だけを握ると読める`, async ({ page }) => {
    await page.goto('/plugins');

    const detected = page.locator('section[aria-labelledby="detected-heading"]');
    const heading = detected.getByRole('heading', { name });
    await expect(heading).toHaveCount(1);
    await expect(heading).toBeVisible();

    const card = detected.locator('section').filter({ hasText: name });
    await expect(card).toHaveCount(1);
    await expect(card.getByText('SNS配信（SNSアカウントの資格情報を受け取ります）')).toBeVisible();
    await expect(card.getByText('画面の拡張')).toHaveCount(0);
  });
}

/**
 * 040 Threads 配信 Plugin 受け入れ条件 #103。
 *
 * **画面の拡張点を宣言しない**ので、握る拡張点は「SNS配信」だけが読める。
 * 行は Manifest の `name` の全体（「Threads配信」）で絞り、各ロケータが 1 件だけに当たることを確かめる
 * （037 #87 と同じ。`.first()` で黙って解決しない）。spec に Plugin ID を書かない（#104）。
 * **ここでは導入も有効化もしない。**
 */
test('検出済みに「Threads配信」が導入前から並び、SNS配信だけを握ると読める', async ({ page }) => {
  await page.goto('/plugins');

  const detected = page.locator('section[aria-labelledby="detected-heading"]');
  const heading = detected.getByRole('heading', { name: 'Threads配信' });
  await expect(heading).toHaveCount(1);
  await expect(heading).toBeVisible();

  const card = detected.locator('section').filter({ hasText: 'Threads配信' });
  await expect(card).toHaveCount(1);
  await expect(card.getByText('SNS配信（SNSアカウントの資格情報を受け取ります）')).toBeVisible();
  await expect(card.getByText('画面の拡張')).toHaveCount(0);
});

/**
 * Registry タブ（020-plugin-registry 設計 §2.7）。
 *
 * E2E の環境では Registry を設定していない。
 * **設定していないことと、何を設定すればよいかが画面に出る**ことを見る。
 */
test('Registry タブが開き、未設定なら設定の仕方が出る', async ({ page }) => {
  await page.goto('/plugins?tab=registry');

  await expect(page.getByRole('heading', { name: 'Registry' })).toBeVisible();
  await expect(page.getByText('TORIFUNE_PLUGIN_REGISTRY_URL')).toBeVisible();
});

test('Registry タブからでも zip の導線は残る', async ({ page }) => {
  // 署名を求めないローカル導入（設計 §2.2）を塞がない。
  await page.goto('/plugins?tab=registry');

  await expect(page.getByRole('button', { name: 'Pluginを追加' })).toBeVisible();
});

test('自動で再起動しない環境ではその旨が出る', async ({ page }) => {
  // 押したあとに何も起きないように見えると、壊れたと思われる。
  await page.goto('/plugins');

  await expect(page.getByText('自動で再起動しません')).toBeVisible();
});

test('未ログインで開くとログイン画面へ送られる', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/plugins');

  await expect(page).toHaveURL(/\/login/);
});

test('未認証では一覧 API が 401', async ({ request }) => {
  const response = await request.get('/api/v1/plugins', { headers: { Cookie: '' } });

  expect(response.status()).toBe(401);
});

test('未認証では導入 API が通らない', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/plugins', {
    headers: { Cookie: '', Origin: origin, 'X-CSRF-Token': token },
    data: { pluginId: 'evil-plugin', acknowledgedPermissions: true, csrfToken: token },
  });

  // Cookie が無ければ CSRF も通らない。どちらで落ちても導入されなければよい。
  expect([401, 403]).toContain(response.status());
});

test('未認証では Package を送り込めない', async ({ request }) => {
  const response = await request.post('/api/v1/plugins/package/install', {
    headers: { Cookie: '', Origin: origin },
    multipart: {
      pluginId: 'evil-plugin',
      file: { name: 'evil.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') },
    },
  });

  expect([401, 403]).toContain(response.status());
});

test('存在しない Plugin の有効化は 404', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/plugins/not-installed/enable', {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: { csrfToken: token },
  });

  expect(response.status()).toBe(404);
});

test('Plugin一覧 API が導入済み・検出済み・問題を返す', async ({ request }) => {
  const response = await request.get('/api/v1/plugins');
  const body = (await response.json()) as {
    data: { installed: unknown[]; detected: unknown[]; problems: unknown[] };
  };

  expect(response.status()).toBe(200);
  expect(Array.isArray(body.data.installed)).toBe(true);
  expect(Array.isArray(body.data.detected)).toBe(true);
  expect(Array.isArray(body.data.problems)).toBe(true);
});

test('壊れた Package はビルドに入る前に拒否される', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/plugins/package/inspect', {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    multipart: {
      file: {
        name: 'broken.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('これは zip ではない'),
      },
    },
  });

  expect(response.status()).toBe(422);
});

test('確認が一致しない削除は拒否される', async ({ request }) => {
  // 押し間違いで消えるものを作らない。
  const token = await csrf(request);
  const response = await request.delete('/api/v1/plugins/not-installed', {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: { deleteData: false, deleteFiles: true, confirm: 'ちがう', csrfToken: token },
  });

  expect(response.status()).toBe(422);
});
