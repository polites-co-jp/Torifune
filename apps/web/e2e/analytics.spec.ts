import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * アクセス解析（05_API設計.md §20、06_画面設計.md §15、018-analytics）。
 *
 * 「サイトアクセスをすべて集める」を Torifune 自身が行う経路を通しで見る。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** サイトを作り、画面から公開キーを読む。 */
async function makeTrackedSite(request: APIRequestContext): Promise<string> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/sites', {
    headers: headers(token),
    data: {
      name: `analytics-${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://analytics.example.com',
      description: '',
      status: 'active',
      csrfToken: token,
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

test('計測スクリプトが配られる', async ({ request }) => {
  const response = await request.get('/t.js');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('javascript');
  // 測る側のサイトから読まれる。
  expect(response.headers()['access-control-allow-origin']).toBe('*');

  const body = await response.text();
  expect(body).toContain('sendBeacon');
  // Cookie を使わない（同意取得の話を持ち込まない）。
  expect(body).not.toContain('document.cookie');
});

test('計測タグの受け口は認証なしで叩けて、結果を返さない', async ({ request }) => {
  // 未認証でも 204。成功も失敗も同じ応答にして、キーの当たりを探らせない。
  const response = await request.post('/api/v1/collect', {
    headers: { Cookie: '' },
    data: { key: 'definitely-not-a-real-key', path: '/' },
  });

  expect(response.status()).toBe(204);
});

test('アクセスを集めて集計し、画面で見られる', async ({ page, request }) => {
  const siteId = await makeTrackedSite(request);

  // 画面から公開キーを読む（API では返していない）。
  await page.goto(`/analytics?siteId=${siteId}`);
  const snippet = await page.locator('[data-tracking-snippet]').textContent();
  const publicKey = /data-site="([^"]+)"/.exec(snippet ?? '')?.[1];
  expect(publicKey).toBeDefined();

  // 計測タグと同じことをする。
  for (const path of ['/', '/', '/pricing']) {
    const response = await request.post('/api/v1/collect', {
      headers: { Cookie: '' },
      data: { key: publicKey, path },
    });
    expect(response.status()).toBe(204);
  }

  // 集計する（cron から API Token で叩く想定の口）。
  const token = await csrf(request);
  const rollup = await request.post('/api/v1/analytics/rollup', {
    headers: headers(token),
    data: { from: today(), to: today(), csrfToken: token },
  });
  expect(rollup.status()).toBe(200);

  const analytics = await request.get(
    `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}`,
  );
  expect(analytics.status()).toBe(200);
  const points = ((await analytics.json()) as { data: { metric: string; value: number }[] }).data;
  expect(points.find((point) => point.metric === 'pageviews')?.value).toBe(3);

  // 画面にも出る。
  await page.goto(`/analytics?siteId=${siteId}&from=${today()}&to=${today()}`);
  await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
  await expect(page.getByText('/pricing')).toBeVisible();
});

/**
 * Pagination（05_API設計.md §20・§33）。
 *
 * **`GET /analytics/{id}` は無い。** analytics は
 * `(site_id, metric_date, source, metric)` の複合キーで保存する集計値の集合で、
 * 単一リソースを指す id が存在しない（仕様書 §20 / `改訂履歴.md` 2026-09-01）。
 */
test('一覧が他の一覧 API と同じ meta を返す', async ({ request }) => {
  const response = await request.get(`/api/v1/analytics?from=${today()}&to=${today()}`);
  expect(response.status()).toBe(200);

  const body = (await response.json()) as {
    data: unknown[];
    meta: { page: number; perPage: number; total: number };
  };

  expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
  expect(body.meta.page).toBe(1);
  expect(body.meta.perPage).toBe(20);
  expect(typeof body.meta.total).toBe('number');
});

test('page と perPage を指定できる', async ({ request }) => {
  const response = await request.get(
    `/api/v1/analytics?from=${today()}&to=${today()}&page=2&perPage=5`,
  );

  const body = (await response.json()) as { meta: { page: number; perPage: number } };
  expect(body.meta).toMatchObject({ page: 2, perPage: 5 });
});

test('perPage は上限で丸める', async ({ request }) => {
  const response = await request.get(
    `/api/v1/analytics?from=${today()}&to=${today()}&perPage=10000`,
  );

  const body = (await response.json()) as { meta: { perPage: number } };
  expect(body.meta.perPage).toBe(100);
});

test('旧名の limit も受け付ける', async ({ request }) => {
  // §41（後方互換）。既に limit を送っているクライアントを黙って壊さない。
  const response = await request.get(
    `/api/v1/analytics?from=${today()}&to=${today()}&kind=topPaths&limit=5`,
  );

  const body = (await response.json()) as { meta: { perPage: number } };
  expect(body.meta.perPage).toBe(5);
});

test('存在しない ID での取得は用意していない', async ({ request }) => {
  // 単一リソースの id が無いので、この経路は Next.js のルートとして存在しない。
  const response = await request.get('/api/v1/analytics/anything');
  expect(response.status()).toBe(404);
});

test('期間が逆転していれば 422', async ({ request }) => {
  const response = await request.get('/api/v1/analytics?from=2026-05-01&to=2026-04-01');
  expect(response.status()).toBe(422);
});

test('未認証では 401', async ({ request }) => {
  const response = await request.get(`/api/v1/analytics?from=${today()}&to=${today()}`, {
    headers: { Cookie: '' },
  });
  expect(response.status()).toBe(401);
});

test('ナビゲーションからアナリティクスへ行ける', async ({ page }) => {
  await page.goto('/dashboard');
  // ダッシュボードにも「アナリティクスで詳しく見る」があるので、ナビへ限定する。
  await page
    .getByRole('navigation', { name: 'メインナビゲーション' })
    .getByRole('link', { name: 'アナリティクス' })
    .click();

  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
});

test('データが無い期間では、何をすればよいかを出す', async ({ page }) => {
  await page.goto('/analytics?from=2020-01-01&to=2020-01-02');

  await expect(page.getByText('この期間のデータはありません。')).toBeVisible();
  await expect(page.getByText('計測タグをサイトへ貼り', { exact: false })).toBeVisible();
});
