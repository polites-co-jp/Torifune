import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

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

/**
 * 内訳 API と `GET /analytics` の絞り込み（028 設計 §6.1〜§6.3、受け入れ条件 #36〜#39）。
 *
 * `GET /api/v1/analytics/breakdown?siteId&from&to&metric&source&page&perPage`
 * → `{ data: [{ key, value }], meta: { page, perPage, total } }`。
 * `GET /api/v1/analytics` の各要素に `key` が乗り、`metric` / `key` で絞れる。
 * `kind=topPaths` は互換のため残し、`analytics.path_pageviews` から引く。
 */

interface BreakdownItem {
  readonly key: string;
  readonly value: number;
}

interface BreakdownBody {
  readonly data: BreakdownItem[];
  readonly meta: { page: number; perPage: number; total: number };
}

interface PointBody {
  readonly data: { metric: string; key: string; value: number; source: string }[];
  readonly meta: { page: number; perPage: number; total: number };
}

/** 計測タグと同じことをする。 */
async function collectHits(
  request: APIRequestContext,
  publicKey: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const response = await request.post('/api/v1/collect', {
      headers: { Cookie: '' },
      data: { key: publicKey, path },
    });
    expect(response.status()).toBe(204);
  }
}

/** 今日の分を集計する。 */
async function rollupToday(request: APIRequestContext): Promise<void> {
  const token = await csrf(request);
  const rollup = await request.post('/api/v1/analytics/rollup', {
    headers: headers(token),
    data: { from: today(), to: today(), csrfToken: token },
  });
  expect(rollup.status()).toBe(200);
}

/** サイトを作り、`/` × 2、`/pricing` × 1、`/about` × 1 を記録して集計する。 */
async function makeRolledUpSite(page: Page, request: APIRequestContext): Promise<string> {
  const siteId = await makeTrackedSite(request);
  const publicKey = await publicKeyOf(page, siteId);
  await collectHits(request, publicKey, ['/', '/', '/pricing', '/about']);
  await rollupToday(request);
  return siteId;
}

function breakdownUrl(siteId: string, extra = ''): string {
  return `/api/v1/analytics/breakdown?siteId=${siteId}&from=${today()}&to=${today()}&metric=path_pageviews${extra}`;
}

/**
 * **ロールを 1 つも持たない利用者**でログインした request context を作る。
 *
 * `viewer` は `analytics.read` を持つので、権限が無い状態は `roles: []` でしか作れない。
 * `POST /users` の `roles` は省略可（既定 `[]`）で、API から作れる。
 */
async function contextWithoutPermissions(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  const token = await csrf(request);
  const loginId = `e2e_noperm_${Math.random().toString(36).slice(2, 10)}`;
  const password = 'e2e analytics no permission user password';
  const created = await request.post('/api/v1/users', {
    headers: headers(token),
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles: [],
      csrfToken: token,
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const context = await playwright.request.newContext({ baseURL: origin });
  const loginToken = await csrf(context);
  const login = await context.post('/api/v1/auth/login', {
    headers: headers(loginToken),
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(login.status(), await login.text()).toBe(200);
  return context;
}

test.describe('内訳 API', () => {
  /** #36 */
  test('GET /analytics/breakdown が { data: [{ key, value }], meta } を返す', async ({
    page,
    request,
  }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(breakdownUrl(siteId));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as BreakdownBody;
    expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
    expect(Object.keys(body.meta).sort()).toEqual(['page', 'perPage', 'total']);
    // value 降順・key 昇順。
    expect(body.data).toEqual([
      { key: '/', value: 2 },
      { key: '/about', value: 1 },
      { key: '/pricing', value: 1 },
    ]);
    expect(body.meta.total).toBe(3);
    expect(body.meta.page).toBe(1);
  });

  /** #36。page / perPage が効き、total は key の種類数。 */
  test('page と perPage を指定できる', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(breakdownUrl(siteId, '&page=2&perPage=2'));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as BreakdownBody;
    expect(body.meta).toEqual({ page: 2, perPage: 2, total: 3 });
    expect(body.data).toEqual([{ key: '/pricing', value: 1 }]);
  });

  /** #36 */
  test('perPage は 100 で丸める', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(breakdownUrl(siteId, '&perPage=10000'));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as BreakdownBody;
    expect(body.meta.perPage).toBe(100);
  });

  /** #36 の派生。source を指定するとその出所だけ。 */
  test('source=core で Core の集計だけになる', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(breakdownUrl(siteId, '&source=core'));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as BreakdownBody;
    expect(body.data.find((item) => item.key === '/')?.value).toBe(2);
  });

  /** #31 の API 側。**ID を差し替えるだけで他サイトの値が取れない。** */
  test('siteId を指定すると他のサイトの値が混ざらない', async ({ page, request }) => {
    const first = await makeRolledUpSite(page, request);
    const second = await makeRolledUpSite(page, request);

    const body = (await (await request.get(breakdownUrl(first))).json()) as BreakdownBody;
    const other = (await (await request.get(breakdownUrl(second))).json()) as BreakdownBody;

    // 2 サイトとも `/` を 2 回記録しているが、それぞれ 1 サイト分しか数えない。
    expect(body.data.find((item) => item.key === '/')?.value).toBe(2);
    expect(other.data.find((item) => item.key === '/')?.value).toBe(2);
    expect(body.meta.total).toBe(3);
  });

  /** #37 */
  test('未認証では 401', async ({ request }) => {
    const response = await request.get(
      `/api/v1/analytics/breakdown?from=${today()}&to=${today()}&metric=path_pageviews`,
      { headers: { Cookie: '' } },
    );
    expect(response.status()).toBe(401);
  });

  /** #37。`analytics.read` を持たない利用者は 403。 */
  test('analytics.read を持たないロールでは 403', async ({ request, playwright }) => {
    const outsider = await contextWithoutPermissions(request, playwright);
    try {
      const response = await outsider.get(
        `/api/v1/analytics/breakdown?from=${today()}&to=${today()}&metric=path_pageviews`,
      );
      expect(response.status()).toBe(403);
    } finally {
      await outsider.dispose();
    }
  });

  /** #37 */
  test('期間が逆転していれば 422', async ({ request }) => {
    const response = await request.get(
      '/api/v1/analytics/breakdown?from=2026-05-01&to=2026-04-01&metric=path_pageviews',
    );
    expect(response.status()).toBe(422);
  });

  /** #37 */
  test('metric が無ければ 422', async ({ request }) => {
    const response = await request.get(`/api/v1/analytics/breakdown?from=${today()}&to=${today()}`);
    expect(response.status()).toBe(422);
  });

  /** #34 の API 側。指標名の形式でない metric は 422。 */
  test('metric が指標名の形式でなければ 422', async ({ request }) => {
    const response = await request.get(
      `/api/v1/analytics/breakdown?from=${today()}&to=${today()}&metric=${encodeURIComponent('Path Views')}`,
    );
    expect(response.status()).toBe(422);
  });

  /** §6.2。`keys` は画面の内部都合で API に出さない。 */
  test('OpenAPI の breakdown のクエリに keys が無い', async ({ request }) => {
    const document = (await (await request.get('/api/v1/openapi.json')).json()) as {
      paths: Record<string, Record<string, { parameters?: { name: string }[] }>>;
    };

    const parameters = document.paths['/analytics/breakdown']?.['get']?.parameters ?? [];
    const names = parameters.map((parameter) => parameter.name).sort();
    expect(names).toEqual(['from', 'metric', 'page', 'perPage', 'siteId', 'source', 'to']);
  });
});

test.describe('GET /analytics の絞り込み', () => {
  /** #38 */
  test('各要素に key がある', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&perPage=100`,
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as PointBody;
    expect(body.data.length).toBeGreaterThan(0);
    for (const point of body.data) {
      expect(typeof point.key).toBe('string');
    }
    expect(body.data.some((point) => point.key === '/pricing')).toBe(true);
  });

  /** #38 */
  test('metric で絞れる', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&metric=path_pageviews&perPage=100`,
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as PointBody;
    expect(body.data.length).toBe(3);
    expect(body.data.every((point) => point.metric === 'path_pageviews')).toBe(true);
    expect(body.meta.total).toBe(3);
  });

  /** #38 */
  test('key で絞れる', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&key=${encodeURIComponent('/pricing')}&perPage=100`,
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as PointBody;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((point) => point.key === '/pricing')).toBe(true);
  });

  /** #38。`key=`（空）でキー無しの行だけ。 */
  test('key= でキー無しの行だけになる', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&key=&perPage=100`,
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as PointBody;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data.every((point) => point.key === '')).toBe(true);
    expect(body.data.find((point) => point.metric === 'pageviews')?.value).toBe(4);
  });

  /** #38。metric と key を同時に渡せる。 */
  test('metric と key を同時に指定できる', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    const response = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&metric=path_pageviews&key=${encodeURIComponent('/')}`,
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as PointBody;
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ metric: 'path_pageviews', key: '/', value: 2 });
  });

  /** #38。metric が指標名の形式でなければ 422。 */
  test('metric が指標名の形式でなければ 422', async ({ request }) => {
    const response = await request.get(
      `/api/v1/analytics?from=${today()}&to=${today()}&metric=${encodeURIComponent('Page Views')}`,
    );
    expect(response.status()).toBe(422);
  });
});

test.describe('kind=topPaths の互換', () => {
  /** #39 */
  test('従来の形 { path, pageviews } を返し、値が path_pageviews の合算と一致する', async ({
    page,
    request,
  }) => {
    const siteId = await makeRolledUpSite(page, request);

    const legacy = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&kind=topPaths`,
    );
    expect(legacy.status()).toBe(200);
    const legacyBody = (await legacy.json()) as {
      data: { path: string; pageviews: number }[];
      meta: { total: number };
    };

    const breakdown = (await (
      await request.get(breakdownUrl(siteId, '&source=core'))
    ).json()) as BreakdownBody;

    expect(legacyBody.data.map((row) => Object.keys(row).sort())).toEqual(
      legacyBody.data.map(() => ['pageviews', 'path']),
    );
    expect(legacyBody.data).toEqual(
      breakdown.data.map((item) => ({ path: item.key, pageviews: item.value })),
    );
    expect(legacyBody.meta.total).toBe(breakdown.meta.total);
  });

  /** #39。上位ページは集計値から引くので、集計前は空。 */
  test('集計を流す前は空', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/fresh']);

    const response = await request.get(
      `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&kind=topPaths`,
    );
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { data: unknown[]; meta: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
  });

  /** #39。エンドポイント単位の非推奨にはしない（`kind=points` まで巻き込むため）。 */
  test('応答に Deprecation ヘッダが付かない', async ({ request }) => {
    const response = await request.get(
      `/api/v1/analytics?from=${today()}&to=${today()}&kind=topPaths`,
    );
    expect(response.status()).toBe(200);
    expect(response.headers()['deprecation']).toBeUndefined();
    expect(response.headers()['sunset']).toBeUndefined();
  });

  /** #39。OpenAPI では `deprecated` にならず、`kind` の説明に置き換え先が書かれている。 */
  test('OpenAPI の kind の説明に /analytics/breakdown への置き換えが書かれている', async ({
    request,
  }) => {
    const document = (await (await request.get('/api/v1/openapi.json')).json()) as {
      paths: Record<
        string,
        Record<
          string,
          { deprecated?: boolean; parameters?: { name: string; description?: string }[] }
        >
      >;
    };

    const operation = document.paths['/analytics']?.['get'];
    expect(operation).toBeDefined();
    expect(operation?.deprecated).toBeUndefined();

    const kind = operation?.parameters?.find((parameter) => parameter.name === 'kind');
    expect(kind).toBeDefined();
    expect(kind?.description).toContain('/analytics/breakdown');
    expect(kind?.description).toContain('topPaths');
  });
});
