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
