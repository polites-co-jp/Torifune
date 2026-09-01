import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * ダッシュボードの Core Widget（06_画面設計.md §9-10、014-dashboard）。
 *
 * `001` で器だけが残っていた画面。`018-analytics` でデータが揃ったので中身が入る。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

test('KPI とアクセス推移が出る', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: '直近7日' })).toBeVisible();
  await expect(page.getByText('ページビュー（7日）')).toBeVisible();
  await expect(page.getByText('訪問者（7日）')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'アクセス推移' })).toBeVisible();
});

/**
 * データの有無にかかわらず壊れない（06_画面設計.md §35）。
 *
 * **「データが無いときだけ空状態が出る」ことは E2E で確かめない。**
 * ダッシュボードは直近7日を全サイト分まとめて見るため、
 * 先に走るテストが記録を残すと空にできず、実行順に依存するテストになる。
 * 空のときに何も描かない・NaN が出るといった壊れ方は
 * `chart.test.ts`（`chartPolyline([])`）で押さえている。
 */
test('アクセス推移は、データの有無にかかわらず読める形で出る', async ({ page }) => {
  await page.goto('/dashboard');

  const card = page.getByRole('heading', { name: 'アクセス推移' }).locator('..');
  await expect(card).toBeVisible();

  // 空状態か、値の表か、どちらかが必ず出る（空白のカードにしない）。
  const empty = card.getByText('アクセスの記録がありません', { exact: false });
  const table = card.getByRole('columnheader', { name: 'ページビュー' });
  expect((await empty.count()) + (await table.count())).toBeGreaterThan(0);
});

test('最近の投稿と最近の活動が出る', async ({ page }) => {
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: '最近の投稿' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近の活動' })).toBeVisible();
});

/**
 * 監査ログから作る（設計 §3.4）。専用のテーブルを作っていない。
 */
test('操作すると最近の活動に出る', async ({ page, request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/sites', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      name: 'dashboard-activity',
      url: 'https://dashboard-activity.example.com',
      description: '',
      status: 'active',
      csrfToken: token,
    },
  });
  expect(response.status()).toBe(201);

  await page.goto('/dashboard');

  await expect(page.getByRole('row', { name: /Webサイトを作成/ }).first()).toBeVisible();
});

/**
 * SVG だけだと読み上げも拡大も効かない（設計 §3.1）。
 * データがあるときは、同じ値が表としても読める。
 */
test('アクセス推移に読み上げ用のラベルと代替がある', async ({ page, request }) => {
  // 計測 → 集計まで済ませる。
  const token = await csrf(request);
  const site = await request.post('/api/v1/sites', {
    headers: { 'X-CSRF-Token': token, Origin: origin },
    data: {
      name: 'dashboard-chart',
      url: 'https://dashboard-chart.example.com',
      description: '',
      status: 'active',
      csrfToken: token,
    },
  });
  const siteId = ((await site.json()) as { data: { id: string } }).data.id;

  await page.goto(`/analytics?siteId=${siteId}`);
  const snippet = await page.locator('[data-tracking-snippet]').textContent();
  const publicKey = /data-site="([^"]+)"/.exec(snippet ?? '')?.[1];

  await request.post('/api/v1/collect', {
    headers: { Cookie: '' },
    data: { key: publicKey, path: '/' },
  });

  const rollupToken = await csrf(request);
  await request.post('/api/v1/analytics/rollup', {
    headers: { 'X-CSRF-Token': rollupToken, Origin: origin },
    data: { csrfToken: rollupToken },
  });

  await page.goto('/dashboard');

  await expect(page.getByRole('img', { name: '直近7日のページビューの推移' })).toBeVisible();
  // 同じ値が表としても読める。
  await expect(page.getByRole('columnheader', { name: 'ページビュー' }).first()).toBeVisible();
});

test('アナリティクスへの導線がある', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByRole('link', { name: 'アナリティクスで詳しく見る' }).click();
  await expect(page).toHaveURL(/\/analytics$/);
});
