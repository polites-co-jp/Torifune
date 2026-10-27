import { expect, test } from '@playwright/test';

/**
 * API の応答の `Cache-Control: no-store` を `next start` の実機で確かめる
 * （058-api-no-store 設計 §10.6・§11 の U1、受け入れ条件 #35〜#38）。
 *
 * `proxy.ts` や Next.js が応答のヘッダを書き換えないことを、値が **`no-store` ちょうど**であることで見る。
 * ログインした状態は既定の `storageState`（`./e2e/.auth/admin.json`）を使う。
 */

const origin = 'http://127.0.0.1:3000';

/** #35 */
test('#35 ログインした状態の GET /api/v1/social/posts の 200 の cache-control が no-store ちょうど', async ({
  request,
}) => {
  const response = await request.get('/api/v1/social/posts');

  expect(response.status(), await response.text()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
});

/**
 * #36。未認証は `storageState` を引き継がない新しい要求の文脈で叩く
 * （`playwright.request.newContext` は config の `use.storageState` を読まない）。
 */
test('#36 未認証の GET /api/v1/social/posts の 401 の cache-control が no-store ちょうど', async ({
  playwright,
}) => {
  const context = await playwright.request.newContext({ baseURL: origin });
  try {
    // 未認証になっていることを先に確かめる。Cookie が残っていると検査が意味を失う。
    expect((await context.storageState()).cookies).toEqual([]);

    const response = await context.get('/api/v1/social/posts');

    expect(response.status()).toBe(401);
    expect(response.headers()['cache-control']).toBe('no-store');
  } finally {
    await context.dispose();
  }
});

/** #37 */
test('#37 GET /t.js の cache-control が public, max-age=3600 のまま', async ({ request }) => {
  const response = await request.get('/t.js');

  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('public, max-age=3600');
});

/**
 * #38（U1 の (b)）。画面の HTML はコードを変えず、今の値を確かめるだけ。
 * **赤なら直さずに報告して裁定を仰ぐ**（画面全体の話で 058 の範囲外。実装プラン §8 の 12）。
 */
test('#38 ログインした /social の HTML の cache-control に no-store が含まれる', async ({
  request,
}) => {
  const response = await request.get('/social', { maxRedirects: 0 });

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] ?? '').toContain('text/html');
  expect(response.headers()['cache-control'] ?? '').toContain('no-store');
});
