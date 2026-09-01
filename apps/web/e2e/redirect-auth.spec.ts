import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * リダイレクト型認証の受け口（`025-redirect-authentication` 設計 §7 §10）。
 *
 * **往復そのもの**（認可開始 → コールバック → セッション発行）は
 * `application/auth/redirect-login.integration.test.ts` が
 * Plugin API 経由のループバック Provider で確かめている。
 *
 * ここで見るのは、E2E でしか確かめられない次の2つ。
 *
 * 1. Plugin が `login.methods` へ差し込んだボタンから、**実際に認可開始へ辿れる**
 * 2. Core の2つの口が、**外から叩かれたときに安全に落ちる**
 *
 * 標準認証のままの環境（＝既定）では往復型の Provider が居ないため、
 * 認可開始は成立しない。**それが正しい挙動**であることを確かめる。
 * 往復を成立させるには `EXAMPLE_PLUGIN_AUTH_USER_ID` を与えて
 * サンプル Plugin の Provider へ差し替える必要があり、
 * それはプロセス起動時の環境変数なので E2E の途中では切り替えられない。
 */

const START = '/api/v1/auth/authorize';
const CALLBACK = '/api/v1/auth/callback';

const PLUGIN_ID = 'example-plugin';
const origin = 'http://127.0.0.1:3000';

/**
 * **このファイルで導入と有効化まで行う。**
 * `plugin-example.spec.ts` も同じ Plugin を使うが、あちらは最後に必ず
 * 無効化して削除する（他のテストの前提を壊さないため）。
 * その状態に依存すると、ファイルの実行順が変わった瞬間に落ちる。
 */
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

async function adminRequest(playwright: {
  request: { newContext: (options: object) => Promise<APIRequestContext> };
}): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: origin,
    storageState: './e2e/.auth/admin.json',
  });
}

test.beforeAll(async ({ playwright }) => {
  const request = await adminRequest(playwright);

  await post(request, '/api/v1/plugins', {
    pluginId: PLUGIN_ID,
    acknowledgedPermissions: true,
  });
  await post(request, `/api/v1/plugins/${PLUGIN_ID}/enable`);

  await request.dispose();
});

test.afterAll(async ({ playwright }) => {
  const request = await adminRequest(playwright);

  // 有効なまま残すと、この Plugin が本体の画面を変えたままになる。
  await post(request, `/api/v1/plugins/${PLUGIN_ID}/disable`);
  const token = await csrf(request);
  await request.delete(`/api/v1/plugins/${PLUGIN_ID}`, {
    headers: { Origin: origin, 'X-CSRF-Token': token },
    data: { csrfToken: token, deleteFiles: false, deleteData: true },
  });

  await request.dispose();
});

test('ログイン画面の Plugin のログイン手段が、認可開始へのリンクになっている', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/login');

  const method = page.getByTestId('example-login-method');
  await expect(method).toBeVisible();

  // **パスを直書きさせない。** Plugin は `AUTHORIZATION_START_PATH` を使う。
  await expect(method).toHaveAttribute('href', START);
});

test('往復型の Provider が居なければ、認可を開始しない', async ({ request }) => {
  const response = await request.get(START, { maxRedirects: 0 });

  // 標準認証にリダイレクト往復は無い。
  // **500 にしない。** 設定されていないことは異常ではない。
  expect(response.status()).toBe(400);
});

test('**認可開始が外部へリダイレクトしない**（Open Redirect 対策）', async ({ request }) => {
  const response = await request.get(`${START}?returnTo=${encodeURIComponent('//evil.example')}`, {
    maxRedirects: 0,
  });

  const location = response.headers()['location'];
  // 開始できない環境では Location そのものが出ない。
  // 出る場合でも、外部のホストであってはならない。
  if (location !== undefined) {
    expect(location.startsWith('//')).toBe(false);
    expect(location.startsWith('http://evil.example')).toBe(false);
    expect(location.startsWith('https://evil.example')).toBe(false);
  }
});

test('偽の State でコールバックを叩いてもログインできない', async ({ request }) => {
  const response = await request.get(`${CALLBACK}?code=forged&state=forged`, { maxRedirects: 0 });

  expect(response.status()).toBe(302);

  // ログイン画面へ戻すだけ。**理由を細かく出さない。**
  expect(response.headers()['location']).toContain('/login');

  // **セッション Cookie を張らない。**
  const setCookie = response.headers()['set-cookie'] ?? '';
  expect(setCookie).not.toContain('torifune_session=');
});

test('State の無いコールバックも同じように落ちる', async ({ request }) => {
  const withState = await request.get(`${CALLBACK}?code=x&state=y`, { maxRedirects: 0 });
  const withoutState = await request.get(`${CALLBACK}?code=x`, { maxRedirects: 0 });

  // 区別できると、State の生死を外から探れる。
  expect(withoutState.status()).toBe(withState.status());
  expect(withoutState.headers()['location']).toBe(withState.headers()['location']);
});
