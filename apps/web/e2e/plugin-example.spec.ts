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

/**
 * `011-plugin-runtime` の受け入れ条件 #32（Permission を持たないユーザー）。
 *
 * 011 の検証で「表示の E2E は Plugin が要る」として 013 へ持ち越されたまま、
 * どこにも書かれていなかった。ここで解消する。
 *
 * **画面は 403 を返さず「権限がありません」を描画する**（HTTP は 200）。
 * `/sites` `/social` と同じ扱い。API 側は実際に 403 を返す。
 * 経緯は `docs/設計/011-plugin-runtime/検証レポート.md` §4.1。
 */
test('Permission を持たないユーザーが Plugin ページへ直接来ると「権限がありません」になる', async ({
  playwright,
}) => {
  const { hash } = await import('@node-rs/argon2');
  const { default: pg } = await import('pg');
  const { uuidv7 } = await import('uuidv7');

  const connectionString = process.env['DATABASE_URL'];
  expect(connectionString, 'E2E には DATABASE_URL が必要').toBeTruthy();

  // サンプル Plugin のページは `site.read` を要求する。
  // **ロールを1つも持たないユーザー**を作れば、その権限だけが無い状態になる。
  const loginId = 'e2e_no_permission';
  const password = 'e2e no permission user password';
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('DELETE FROM users WHERE login_id = $1', [loginId]);
    await client.query(
      'INSERT INTO users (id, login_id, email, display_name, password_hash) VALUES ($1, $2, $3, $4, $5)',
      [uuidv7(), loginId, `${loginId}@example.com`, '権限なし', await hash(password)],
    );

    const context = await playwright.request.newContext({ baseURL: origin });
    let storage;
    try {
      const token = await csrf(context);
      const login = await context.post('/api/v1/auth/login', {
        headers: { Origin: origin, 'X-CSRF-Token': token },
        data: { loginId, password, csrfToken: token },
      });
      expect(login.status(), await login.text()).toBe(200);
      storage = await context.storageState();
    } finally {
      await context.dispose();
    }

    const browser = await playwright.chromium.launch();
    try {
      const page = await browser.newPage({ baseURL: origin, storageState: storage });

      // **このサンプルのメニューは permission を宣言していないので、誰にでも出る。**
      // 見えることと使えることは別だ、というのがこの拡張点の要点
      // （`plugins/example-plugin/index.tsx` のコメントを参照）。
      await page.goto('/dashboard');
      const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
      await expect(nav.getByRole('link', { name: 'サンプルPlugin' })).toBeVisible();

      // **URL を直接叩いても止まる。** 表示を隠すだけでは認可にならない。
      const response = await page.goto(`/plugins/${PLUGIN_ID}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByText('この操作を行う権限がありません')).toBeVisible();
      // Plugin のページの中身が出ていないこと。
      await expect(page.getByTestId('example-site-total')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  } finally {
    await client.query('DELETE FROM users WHERE login_id = $1', [loginId]);
    await client.end();
  }
});
