import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

/**
 * サーバーが集計に使う境目での「今日」。
 *
 * **実行マシンのローカル日付で作らない。** サーバーは
 * `TORIFUNE_TIMEZONE`（playwright.config.ts で固定）で1日を区切るため、
 * ローカルで作ると境目をまたぐ時間帯だけ落ちる。
 */
const SERVER_TIME_ZONE = 'Asia/Tokyo';

function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SERVER_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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

/** 画面から公開キーを読む（API では返していない）。 */
async function publicKeyOf(page: Page, siteId: string): Promise<string> {
  await page.goto(`/analytics?siteId=${siteId}`);
  const snippet = await page
    .locator(`[data-tracking-snippet][data-site-id="${siteId}"]`)
    .textContent();
  const publicKey = /data-site="([^"]+)"/.exec(snippet ?? '')?.[1];
  expect(publicKey).toBeDefined();
  return publicKey ?? '';
}

/** 今日の分を集計し、指標を読む。 */
async function metricToday(
  request: APIRequestContext,
  siteId: string,
  metric: string,
): Promise<number> {
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
  return points.find((point) => point.metric === metric)?.value ?? 0;
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

test('登録したサイトの計測タグが、絞り込まなくても出る', async ({ page, request }) => {
  // 絞り込みを待たせると、登録したサイトが見当たらないように見える。
  const siteId = await makeTrackedSite(request);

  await page.goto('/analytics');

  const snippet = page.locator(`[data-tracking-snippet][data-site-id="${siteId}"]`);
  await expect(snippet).toBeVisible();
  await expect(snippet).toContainText('data-site=');
});

test('計測タグの src が絶対 URL になっている', async ({ page, request }) => {
  // 相対パスのまま他所のサイトへ貼ると、貼った先の /t.js を探しに行って届かない。
  const siteId = await makeTrackedSite(request);

  await page.goto('/analytics');

  const snippet = await page
    .locator(`[data-tracking-snippet][data-site-id="${siteId}"]`)
    .textContent();

  const src = /src="([^"]+)"/.exec(snippet ?? '')?.[1] ?? '';
  expect(src.startsWith('http://') || src.startsWith('https://')).toBe(true);
  expect(src.endsWith('/t.js')).toBe(true);
});

test('サイトを絞り込むと、そのサイトのタグだけになる', async ({ page, request }) => {
  const first = await makeTrackedSite(request);
  const second = await makeTrackedSite(request);

  await page.goto(`/analytics?siteId=${second}`);

  await expect(page.locator(`[data-tracking-snippet][data-site-id="${second}"]`)).toBeVisible();
  await expect(page.locator(`[data-tracking-snippet][data-site-id="${first}"]`)).toHaveCount(0);
});

test('アクセスを集めて集計し、画面で見られる', async ({ page, request }) => {
  const siteId = await makeTrackedSite(request);
  const publicKey = await publicKeyOf(page, siteId);

  // 計測タグと同じことをする。
  for (const path of ['/', '/', '/pricing']) {
    const response = await request.post('/api/v1/collect', {
      headers: { Cookie: '' },
      data: { key: publicKey, path },
    });
    expect(response.status()).toBe(204);
  }

  // 集計する（cron から API Token で叩く想定の口）。
  expect(await metricToday(request, siteId, 'pageviews')).toBe(3);

  // 画面にも出る。
  await page.goto(`/analytics?siteId=${siteId}&from=${today()}&to=${today()}`);
  await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
  await expect(page.getByText('/pricing')).toBeVisible();
});

/**
 * 計測タグを貼った SPA（018-analytics 設計 §3.4）。
 *
 * **Torifune とは別オリジンに貼る。** 貼った先から受け口への送信が CORS の対象になり、
 * プリフライトが起きない形かどうかを実際のブラウザで確かめられる。
 * ページの中身は Playwright が返し、このホストへは何も届かない。
 *
 * `https` にしているのは Chromium の Local Network Access のため。外部サイトから
 * ループバック（このテストの受け口）へ送るには、安全なコンテキストで許可を得る必要がある。
 * ループバック宛ては混在コンテンツにならないので、`https` ページから `http` の受け口へ送れる。
 */
const SPA_ORIGIN = 'https://spa.example.test';

test.describe('SPA のクライアント遷移', () => {
  // Headless の User-Agent は Bot 扱いになり、集計から外れる（設計 §3.3）。
  test.use({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  });

  test('pathname が変わるたびに記録され、同じ pathname では増えない', async ({
    page,
    context,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);

    // Chromium の Local Network Access。外部サイトからループバックへ送るときだけ
    // 許可が要る。本番では受け口も公開ホストなので関係ない。
    await context.grantPermissions(['local-network-access'], { origin: SPA_ORIGIN });

    await page.route(`${SPA_ORIGIN}/**`, (route) =>
      route.request().resourceType() === 'document'
        ? route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><script src="${origin}/t.js" data-site="${publicKey}"></script></head><body>spa</body></html>`,
          })
        : route.fulfill({ status: 404 }),
    );

    // 受け口への送信を見張る。プリフライト（OPTIONS）が飛ばず、POST だけであること。
    const collectMethods: string[] = [];
    page.on('request', (sent) => {
      if (sent.url().endsWith('/api/v1/collect')) {
        collectMethods.push(sent.method());
      }
    });

    // ハードロード：1件。
    await page.goto(`${SPA_ORIGIN}/`);

    // クライアント遷移。Next.js のようにクエリ更新の replaceState や
    // 同じ path への pushState が混ざっても、path が変わった分だけ数える。
    await page.evaluate(() => {
      history.pushState({}, '', '/topics');
      history.replaceState({}, '', '/topics?page=2');
      history.pushState({}, '', '/topics');
      history.pushState({}, '', '/topics/18665');
    });
    await expect(page).toHaveURL(`${SPA_ORIGIN}/topics/18665`);

    // 戻る：popstate で /topics へ。
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(`${SPA_ORIGIN}/topics`);

    // 期待する記録: / → /topics → /topics/18665 → /topics の4件。
    // sendBeacon は送りっぱなしなので、届くまで集計を繰り返す。
    await expect.poll(() => metricToday(request, siteId, 'pageviews'), { timeout: 15_000 }).toBe(4);

    expect(collectMethods).toEqual(['POST', 'POST', 'POST', 'POST']);
  });
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
