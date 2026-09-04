import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

/**
 * ダッシュボードの Core Widget（06_画面設計.md §9-10、014-dashboard、
 * 028-analytics-dashboard-redesign 設計 §7.2、受け入れ条件 #67〜#73）。
 *
 * `001` で器だけが残っていた画面。`018-analytics` でデータが揃って中身が入り、
 * `028` で「直近7日のアクセス」（前の 7 日との比較・直帰率・サイト別の行）と
 * 「実施中のキャンペーン」が足された。期間は直近 7 日固定（URL パラメータなし）。
 */

const origin = 'http://127.0.0.1:3000';

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

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

/**
 * サイトを作る。
 *
 * 名前を `0` で始めるのは、サイト別の行が**名前順**で並ぶため（設計 §7.2）。
 * 先に走る spec が残した多数のサイトより前に来るようにして、
 * 一覧の件数に上限があっても自分のサイトが必ず載るようにする。
 */
async function createSite(request: APIRequestContext): Promise<{ id: string; name: string }> {
  const token = await csrf(request);
  const name = `0 dashboard ${unique()}`;
  const response = await request.post('/api/v1/sites', {
    headers: headers(token),
    data: {
      name,
      url: `https://${unique()}.example.com`,
      description: '',
      status: 'active',
      csrfToken: token,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data: { id: string; name: string } };
  return body.data;
}

/** 画面の計測タグから公開キーを読む（一般 API では返していない）。 */
async function publicKeyOf(page: Page, siteId: string): Promise<string> {
  await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
  const snippet = await page
    .locator(`[data-tracking-snippet][data-site-id="${siteId}"]`)
    .textContent();
  const publicKey = /data-site="([^"]+)"/.exec(snippet ?? '')?.[1];
  expect(publicKey).toBeDefined();
  return publicKey ?? '';
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

/** 今日の分を集計する（cron から API Token で叩く想定の口）。 */
async function rollupToday(request: APIRequestContext): Promise<void> {
  const token = await csrf(request);
  const rollup = await request.post('/api/v1/analytics/rollup', {
    headers: headers(token),
    data: { from: today(), to: today(), csrfToken: token },
  });
  expect(rollup.status(), await rollup.text()).toBe(200);
}

/** サイトを作り、`paths` の分だけ記録して今日の分を集計する。 */
async function makeRolledUpSite(
  page: Page,
  request: APIRequestContext,
  paths: readonly string[],
): Promise<{ id: string; name: string }> {
  const site = await createSite(request);
  const publicKey = await publicKeyOf(page, site.id);
  await collectHits(request, publicKey, paths);
  await rollupToday(request);
  return site;
}

async function createCampaign(
  request: APIRequestContext,
  data: Record<string, unknown>,
): Promise<{ id: string; name: string }> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/campaigns', {
    headers: headers(token),
    data: { startsOn: today(), csrfToken: token, ...data },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: { id: string; name: string } }).data;
}

/**
 * 指定したロールの利用者を作り、その利用者でログインした request context を返す。
 * 使い終わったら `dispose()` する。
 *
 * `viewer` は `analytics.read` を持つので、権限が無い状態は `roles: []` でしか作れない。
 */
async function loginAsNewUser(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
  roles: readonly string[],
): Promise<APIRequestContext> {
  const token = await csrf(request);
  const loginId = `e2e_dashboard_${unique()}`;
  const password = 'e2e dashboard no permission user password';
  const created = await request.post('/api/v1/users', {
    headers: headers(token),
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles,
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

/** 「直近7日のアクセス」のチャート（`role="img"`）と、その代替表を含む `figure`。 */
const CHART_TITLE = '直近7日のページビューと訪問者の推移';

function accessChart(page: Page) {
  return page.getByRole('figure').filter({ has: page.getByRole('img', { name: CHART_TITLE }) });
}

test.describe('直近7日のアクセス', () => {
  /** #67 */
  test('見出し「直近7日のアクセス」と KPI のラベルが出る', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '直近7日のアクセス' })).toBeVisible();
    for (const label of ['ページビュー', '訪問者', '直帰率', 'SNS投稿（全体）']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });

  /** #67。SNS 投稿の全体件数に「配信済み n」を添える（`social.read`）。 */
  test('SNS投稿に「配信済み n」が添えられる', async ({ page }) => {
    await page.goto('/dashboard');

    // 数値は `toLocaleString('ja-JP')`（設計 §7.1）。0 件でも「配信済み 0」と出る。
    await expect(page.getByText(/配信済み\s*[\d,]+/).first()).toBeVisible();
  });

  /**
   * 設計 §7.2 / §7.4.2。前の 7 日との比較（`Stat` の `delta`）には
   * `data-tone`（`success` / `danger` / `muted`）が付く。前期が 0 なら `—` で `muted`。
   */
  test('前期間比に data-tone が付く', async ({ page, request }) => {
    await makeRolledUpSite(page, request, ['/']);

    await page.goto('/dashboard');

    const tones = page.locator('[data-tone]');
    expect(await tones.count()).toBeGreaterThan(0);
    for (const tone of await tones.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-tone')),
    )) {
      expect(['success', 'danger', 'muted']).toContain(tone);
    }
  });

  /**
   * #68。データの有無にかかわらず壊れない（06_画面設計.md §35）。
   *
   * **「データが無いときだけ空状態が出る」ことは E2E で確かめない。**
   * ダッシュボードは直近7日を全サイト分まとめて見るため、
   * 先に走るテストが記録を残すと空にできず、実行順に依存するテストになる。
   * 空のときに何も描かない・NaN が出るといった壊れ方は
   * `chart.test.ts`（`chartLayout([])`）で押さえている。
   */
  test('アクセス推移は、データの有無にかかわらず読める形で出る', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '直近7日のアクセス' })).toBeVisible();

    // 空状態か、チャートと値の表か、どちらかが必ず出る（空白のカードにしない）。
    const empty = page.getByText('アクセスの記録がありません', { exact: false });
    const chart = page.getByRole('img', { name: CHART_TITLE });
    expect((await empty.count()) + (await chart.count())).toBeGreaterThan(0);
  });

  /**
   * #68。SVG だけだと読み上げも拡大も効かない（014 設計 §3.1、028 設計 §7.4.1）。
   * データがあるときは、PV と訪問者の 2 系列が同じ値の表としても読める。
   */
  test('チャートに読み上げ用の名前があり、同じ値が表としても読める', async ({ page, request }) => {
    await makeRolledUpSite(page, request, ['/']);

    await page.goto('/dashboard');

    await expect(page.getByRole('img', { name: CHART_TITLE })).toBeVisible();
    const chart = accessChart(page);
    await expect(chart.getByRole('columnheader', { name: 'ページビュー' })).toBeVisible();
    await expect(chart.getByRole('columnheader', { name: '訪問者' })).toBeVisible();
  });

  /** #69。サイト別の行（`site.read`）に、そのサイトの直近 7 日の値が出る。 */
  test('サイト別の行にそのサイトの値が出る', async ({ page, request }) => {
    // 同じ訪問者（同じ UA・IP）の 3 PV → ページビュー 3、訪問者 1。
    const site = await makeRolledUpSite(page, request, ['/', '/pricing', '/about']);

    await page.goto('/dashboard');

    const row = page.getByRole('row', { name: new RegExp(site.name) });
    await expect(row).toBeVisible();
    await expect(row.getByRole('cell', { name: '3', exact: true })).toBeVisible();
    await expect(row.getByRole('cell', { name: '1', exact: true })).toBeVisible();
  });

  /** #69。行クリックで、そのサイトの直近 7 日をアナリティクスで開く。 */
  test('サイト別の行をクリックすると /analytics?siteId=<id>&period=7d へ移る', async ({
    page,
    request,
  }) => {
    const site = await createSite(request);

    await page.goto('/dashboard');
    await page.getByRole('row', { name: new RegExp(site.name) }).click();

    await page.waitForURL(/\/analytics\?/);
    const url = new URL(page.url());
    expect(url.pathname).toBe('/analytics');
    expect(url.searchParams.get('siteId')).toBe(site.id);
    expect(url.searchParams.get('period')).toBe('7d');
  });

  /** #72 */
  test('「アナリティクスで詳しく見る」で /analytics へ移る', async ({ page }) => {
    await page.goto('/dashboard');

    await page.getByRole('link', { name: 'アナリティクスで詳しく見る' }).click();
    await expect(page).toHaveURL(/\/analytics$/);
  });
});

test.describe('実施中のキャンペーン', () => {
  /** #70 */
  test('見出し「実施中のキャンペーン」が出る', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '実施中のキャンペーン' })).toBeVisible();
  });

  /** #70。`running` のキャンペーンが行として並ぶ（`starts_on` 降順、5 件まで）。 */
  test('running のキャンペーンが行として並ぶ', async ({ page, request }) => {
    const running = await createCampaign(request, {
      name: `実施中 ${unique()}`,
      status: 'running',
    });

    await page.goto('/dashboard');

    await expect(page.getByRole('row', { name: new RegExp(running.name) })).toBeVisible();
  });

  /** #70。`draft` は「実施中」ではない。 */
  test('draft のキャンペーンは並ばない', async ({ page, request }) => {
    const draft = await createCampaign(request, {
      name: `下書き ${unique()}`,
      status: 'draft',
    });

    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '実施中のキャンペーン' })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(draft.name) })).toHaveCount(0);
  });

  /** #70。行クリックでそのキャンペーンの分析へ。 */
  test('行をクリックすると /campaigns/<id>/analytics へ移る', async ({ page, request }) => {
    const running = await createCampaign(request, {
      name: `実施中 ${unique()}`,
      status: 'running',
    });

    await page.goto('/dashboard');
    await page.getByRole('row', { name: new RegExp(running.name) }).click();

    await expect(page).toHaveURL(new RegExp(`/campaigns/${running.id}/analytics$`));
  });

  /** #70。「すべて →」は一覧へ。 */
  test('「すべて」で /campaigns へ移る', async ({ page, request }) => {
    // 枠が空でも導線は出す。行が 1 つは並ぶ状態で確かめる。
    await createCampaign(request, { name: `実施中 ${unique()}`, status: 'running' });

    await page.goto('/dashboard');
    await page.getByRole('link', { name: /^すべて/ }).click();

    await expect(page).toHaveURL(/\/campaigns$/);
  });
});

test.describe('最近の投稿と最近の活動', () => {
  /** #71 */
  test('最近の投稿と最近の活動が出る', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page.getByRole('heading', { name: '最近の投稿' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '最近の活動' })).toBeVisible();
  });

  /**
   * #71。監査ログから作る（014 設計 §3.4）。専用のテーブルを作っていない。
   */
  test('操作すると最近の活動に出る', async ({ page, request }) => {
    await createSite(request);

    await page.goto('/dashboard');

    await expect(page.getByRole('row', { name: /Webサイトを作成/ }).first()).toBeVisible();
  });
});

test.describe('権限による出し分け', () => {
  /**
   * #73。`analytics.read` が無ければアクセス系の枠を出さず、「ようこそ」カードを出す
   * （014 設計 §3.3「空の枠を出さない」、028 設計 §7.2）。
   *
   * `viewer` は `analytics.read` を持つので、ロールを 1 つも持たない利用者で確かめる。
   */
  test('analytics.read を持たない利用者にはアクセス系の枠が出ず、「ようこそ」カードが出る', async ({
    browser,
    request,
    playwright,
  }) => {
    const api = await loginAsNewUser(request, playwright, []);
    let storage;
    try {
      storage = await api.storageState();
    } finally {
      await api.dispose();
    }

    const context = await browser.newContext({ baseURL: origin, storageState: storage });
    try {
      const page = await context.newPage();
      const response = await page.goto('/dashboard');
      expect(response?.status()).toBe(200);

      await expect(page.getByRole('heading', { name: 'ダッシュボード' })).toBeVisible();

      // 「ようこそ」カード。現行どおりの文言（`014` §3.3）でよい。
      await expect(page.getByText(/ようこそ|とりふねへログインしています/)).toBeVisible();

      // アクセス系の枠（KPI・チャート・サイト別の行）が無い。
      await expect(page.getByRole('heading', { name: '直近7日のアクセス' })).toHaveCount(0);
      await expect(page.getByRole('img', { name: CHART_TITLE })).toHaveCount(0);
      await expect(page.getByText('SNS投稿（全体）', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'アナリティクスで詳しく見る' })).toHaveCount(0);
      // `campaign.read` も無いので「実施中のキャンペーン」も出ない。
      await expect(page.getByRole('heading', { name: '実施中のキャンペーン' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
