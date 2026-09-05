import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import pg from 'pg';

/**
 * アクセス解析（05_API設計.md §20、06_画面設計.md §15、018-analytics、
 * 028-analytics-dashboard-redesign 設計 §7.3、受け入れ条件 #36〜#39・#75〜#89）。
 *
 * 「サイトアクセスをすべて集める」を Torifune 自身が行う経路を通しで見る。
 *
 * `/analytics` は `028` で「1 サイトずつ・期間プリセットと前期間比較つき・5 タブ」になった。
 * 状態はすべて URL パラメータ（`siteId` / `tab` / `period` / `from` / `to` / `bots` / `page`）で持つ。
 * 計測タグは「設定」タブに移った。
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

/** `YYYY-MM-DD` を日数ぶんずらす（文字列の日付演算。タイムゾーンに依らない）。 */
function shiftDate(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(time).toISOString().slice(0, 10);
}

/** `period=custom&from=今日&to=今日` の前期間は「昨日〜昨日」（設計 §7.3.1）。 */
function yesterday(): string {
  return shiftDate(today(), -1);
}

function unique(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** サイトを作る。名前は `analytics-` で始める。 */
async function makeTrackedSite(request: APIRequestContext): Promise<string> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/sites', {
    headers: headers(token),
    data: {
      name: `analytics-${unique()}`,
      url: 'https://analytics.example.com',
      description: '',
      status: 'active',
      csrfToken: token,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

/** 設定タブに描いた計測タグ。 */
function snippetOf(page: Page, siteId: string): Locator {
  return page.locator(`[data-tracking-snippet][data-site-id="${siteId}"]`);
}

/** 計測タグの文字列から `data-site` の値（公開キー）を取り出す。 */
function publicKeyIn(snippet: string | null): string {
  const publicKey = /data-site="([^"]+)"/.exec(snippet ?? '')?.[1];
  expect(publicKey).toBeDefined();
  return publicKey ?? '';
}

/**
 * 画面から公開キーを読む（API では返していない）。
 * 計測タグは `/analytics?siteId=…&tab=settings`（設計 §10 末尾）。
 */
async function publicKeyOf(page: Page, siteId: string): Promise<string> {
  await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
  return publicKeyIn(await snippetOf(page, siteId).textContent());
}

/** 計測タグと同じことをする。 */
async function collectHits(
  request: APIRequestContext,
  publicKey: string,
  paths: readonly string[],
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  for (const path of paths) {
    const response = await request.post('/api/v1/collect', {
      headers: { Cookie: '', ...extraHeaders },
      data: { key: publicKey, path },
    });
    expect(response.status()).toBe(204);
  }
}

/**
 * Bot の User-Agent で 1 件送る。
 * `collect` は `User-Agent` ヘッダで Bot を判定する（018 設計 §3.3）。
 */
const BOT_USER_AGENT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function collectBotHit(
  request: APIRequestContext,
  publicKey: string,
  path = '/',
): Promise<void> {
  await collectHits(request, publicKey, [path], { 'User-Agent': BOT_USER_AGENT });
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

/** 今日の分を集計し、指標を読む。 */
async function metricToday(
  request: APIRequestContext,
  siteId: string,
  metric: string,
): Promise<number> {
  await rollupToday(request);

  const analytics = await request.get(
    `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&key=&perPage=100`,
  );
  expect(analytics.status()).toBe(200);
  const points = ((await analytics.json()) as { data: { metric: string; value: number }[] }).data;
  return points.find((point) => point.metric === metric)?.value ?? 0;
}

/** サイトを作り、`/` × 2、`/pricing` × 1、`/about` × 1 を記録して集計する。 */
async function makeRolledUpSite(page: Page, request: APIRequestContext): Promise<string> {
  const siteId = await makeTrackedSite(request);
  const publicKey = await publicKeyOf(page, siteId);
  await collectHits(request, publicKey, ['/', '/', '/pricing', '/about']);
  await rollupToday(request);
  return siteId;
}

/** 今日 1 日だけを見る URL。 */
function todayUrl(siteId: string, extra = ''): string {
  return `/analytics?siteId=${siteId}&period=custom&from=${today()}&to=${today()}${extra}`;
}

function breakdownUrl(siteId: string, extra = ''): string {
  return `/api/v1/analytics/breakdown?siteId=${siteId}&from=${today()}&to=${today()}&metric=path_pageviews${extra}`;
}

/**
 * データベースへ直接触る（`global-setup.ts` と同じ経路）。
 *
 * 使うのは 3 箇所だけ。
 * - サイトを 0 件にする（#89）。API には「全部消す」口が無い
 * - 前期間の集計値を入れる（#86）。`collect` は `occurred_at` を今にするので、
 *   昨日の分は API からは作れない。`source = 'e2e'` の行を `analytics` へ直接入れる
 *   （画面は出所をまたいで足す。設計 §7.3.3）
 * - **昨日の生ログ**を入れる（030 の #65）。「最終受信はあるが今日の生ログは 0 件」も
 *   同じ理由で API からは作れない
 */
async function withDatabase<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const connectionString = process.env['DATABASE_URL'];
  expect(connectionString, 'E2E には DATABASE_URL が必要').toBeTruthy();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 前期間の集計値を `source = 'e2e'`・`key = ''` で入れる。 */
async function seedAnalytics(
  siteId: string,
  metricDate: string,
  values: Readonly<Record<string, number>>,
): Promise<void> {
  await withDatabase(async (client) => {
    for (const [metric, value] of Object.entries(values)) {
      await client.query(
        `INSERT INTO analytics (site_id, metric_date, source, metric, key, value)
         VALUES ($1, $2, 'e2e', $3, '', $4)`,
        [siteId, metricDate, metric, value],
      );
    }
  });
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

/*
 * 画面の locator（設計 §7.3.2 / §7.4.2）。
 *
 * - 期間プリセット：`SegmentedControl`。`Tabs` と同じくリンクの並びで、選択中に `aria-current="page"`。
 *   「前月」を含む `nav` として探す
 * - タブ：`Tabs`（`nav` + リンク）。「参照元」を含む `nav` として探す
 * - サイト：`<select>`。アクセシブル名は「サイト」（`aria-label` か `<label>`）
 * - Bot：`Switch`。`role="switch"`、名前は「Bot を集計に含める」
 * - Stat：label と value（と `delta` の `<span data-tone>`）が同じ親要素の中にある。
 *   label のテキストの親をタイルとみなす。**タブ nav のリンク（「訪問者」など）が
 *   タブの中身より DOM 上で先にある**ので、`nav` の中とリンクは除いて探す
 */
function presetNav(page: Page): Locator {
  return page
    .getByRole('navigation')
    .filter({ has: page.getByRole('link', { name: '前月', exact: true }) });
}

function tabNav(page: Page): Locator {
  return page
    .getByRole('navigation')
    .filter({ has: page.getByRole('link', { name: '参照元', exact: true }) });
}

function siteSelect(page: Page): Locator {
  return page.getByRole('combobox', { name: 'サイト' });
}

function botSwitch(page: Page): Locator {
  return page.getByRole('switch', { name: 'Bot を集計に含める' });
}

function statTile(page: Page, label: string): Locator {
  return page
    .getByText(label, { exact: true })
    .and(page.locator(':not(nav *):not(a)'))
    .first()
    .locator('..');
}

/**
 * #89。サイトが 0 件のときの空状態。
 *
 * **このファイルの先頭に置く。** `global-setup` がサイトを全部消した直後の状態で開きたいが、
 * 実行順に依存させないため、ここでも `sites` を空にしてから開く（他のテストは
 * 自分でサイトを作るので、消しても壊れない）。E2E は `workers: 1` で直列。
 */
test('サイトが 0 件なら「Webサイトを登録すると」の空状態と /sites/new への導線が出る', async ({
  page,
}) => {
  await withDatabase((client) => client.query('DELETE FROM sites'));

  await page.goto('/analytics');

  await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
  await expect(page.getByText('Webサイトを登録すると', { exact: false })).toBeVisible();
  await expect(page.locator('a[href="/sites/new"]')).toBeVisible();
});

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

/**
 * #75。画面の骨格（設計 §7.3.2）。既定は 30 日・概要。
 */
test.describe('画面の骨格', () => {
  test('見出し「アナリティクス」と期間プリセットが出て、既定は「30日」が選択中', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    const nav = presetNav(page);
    for (const label of ['7日', '30日', '90日', '今月', '前月', 'カスタム']) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: '30日', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: '7日', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('period=7d なら「7日」が選択中になる', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    const nav = presetNav(page);
    await expect(nav.getByRole('link', { name: '7日', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: '30日', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('サイトの <select> が出て、URL の siteId が選ばれている', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(siteSelect(page)).toBeVisible();
    await expect(siteSelect(page)).toHaveValue(siteId);
  });

  test('サイトを選ぶと URL の siteId が変わる', async ({ page, request }) => {
    const first = await makeTrackedSite(request);
    const second = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${first}`);
    await siteSelect(page).selectOption(second);

    await page.waitForURL((url) => url.searchParams.get('siteId') === second);
    await expect(siteSelect(page)).toHaveValue(second);
  });

  test('「Bot を集計に含める」スイッチが出て、既定はオフ', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(botSwitch(page)).toBeVisible();
    await expect(botSwitch(page)).toHaveAttribute('aria-checked', 'false');
  });

  test('スイッチを押すと bots=1 になり、オンとして描かれる', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);
    await botSwitch(page).click();

    await page.waitForURL((url) => url.searchParams.get('bots') === '1');
    await expect(botSwitch(page)).toHaveAttribute('aria-checked', 'true');
  });

  test('5 つのタブが出て、既定は「概要」が選択中', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    const nav = tabNav(page);
    for (const label of ['概要', 'ページ', '参照元', '訪問者', '設定']) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole('link', { name: '概要', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('タブを押すと URL の tab が変わる', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);
    await tabNav(page).getByRole('link', { name: 'ページ', exact: true }).click();

    await page.waitForURL((url) => url.searchParams.get('tab') === 'pages');
    await expect(tabNav(page).getByRole('link', { name: 'ページ', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

/**
 * #76。未設置サイト（計測したことが無い）の導線（設計 §7.3.7）。
 */
test.describe('未設置サイトの導線', () => {
  test('選択肢に「（未設置）」が付く', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(siteSelect(page)).toHaveValue(siteId);
    await expect(siteSelect(page).locator('option:checked')).toHaveText(/（未設置）$/);
  });

  test('本文に「まだアクセスの記録がありません」と「計測タグを取得」が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(page.getByText('計測タグ未設置')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'まだアクセスの記録がありません' }),
    ).toBeVisible();
    // 029 設計 §7.1.3 で説明文が「数字が出るには、計測タグをサイトへ貼る必要があります。
    // 集計は Torifune が N 分ごとに自動で行います。」に変わった。
    await expect(
      page.getByText('計測タグをサイトへ貼る必要があります', { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '計測タグを取得' })).toBeVisible();
  });

  test('「計測タグを取得」を押すと tab=settings になり計測タグが出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);
    await page.getByRole('button', { name: '計測タグを取得' }).click();

    await page.waitForURL((url) => url.searchParams.get('tab') === 'settings');
    expect(new URL(page.url()).searchParams.get('siteId')).toBe(siteId);
    await expect(snippetOf(page, siteId)).toBeVisible();
  });

  test('計測して集計すると「（未設置）」が外れ、導線が消える', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);
    await rollupToday(request);

    await page.goto(todayUrl(siteId));

    await expect(siteSelect(page).locator('option:checked')).not.toHaveText(/（未設置）/);
    await expect(page.getByRole('heading', { name: 'まだアクセスの記録がありません' })).toHaveCount(
      0,
    );
  });
});

/**
 * #77。計測 → 集計 → 画面（概要タブ）。
 */
test.describe('概要タブ', () => {
  test('集計後の概要にページビューの値が出る', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/', '/pricing']);

    // 集計する（cron から API Token で叩く想定の口）。
    expect(await metricToday(request, siteId, 'pageviews')).toBe(3);

    await page.goto(todayUrl(siteId));

    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    await expect(statTile(page, 'ページビュー')).toContainText('3');
  });

  test('集計後の概要に /pricing を含む上位ページが出る', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/', '/pricing']);
    await rollupToday(request);

    await page.goto(todayUrl(siteId));

    await expect(page.getByText('/pricing', { exact: true }).first()).toBeVisible();
  });

  /** §7.3.6。上位ページの「すべて →」はページタブへ。 */
  test('上位ページの「すべて」で tab=pages へ移る', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    await page.goto(todayUrl(siteId));
    await page
      .getByRole('link', { name: /^すべて/ })
      .first()
      .click();

    await page.waitForURL((url) => url.searchParams.get('tab') === 'pages');
  });
});

/**
 * #78。ページタブ（設計 §7.3.6）。
 */
test.describe('ページタブ', () => {
  test('列見出し「ページビュー / 訪問者 / ランディング / 直帰率 / 平均滞在」が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeRolledUpSite(page, request);

    await page.goto(todayUrl(siteId, '&tab=pages'));

    for (const column of ['ページビュー', '訪問者', 'ランディング', '直帰率', '平均滞在']) {
      await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
    }
  });

  test('注記「実際より短めに出ます」が出る', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    await page.goto(todayUrl(siteId, '&tab=pages'));

    await expect(page.getByText('実際より短めに出ます', { exact: false })).toBeVisible();
  });

  test('記録したパスが行として並ぶ', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    await page.goto(todayUrl(siteId, '&tab=pages'));

    await expect(page.getByRole('row', { name: /\/pricing/ })).toBeVisible();
  });

  /**
   * 制御文字を含むパス（028 の検証で追記）。
   *
   * JSON なので U+0001 を含むパスを受け口へ送れる。受け口が記録しない（`normalizePath`）、
   * ロールアップが key に出さない、画面が `keys` に渡す前に濾す、の三重で守り、
   * 「ページ」タブが 500 で落ちないこと。
   */
  test.describe('制御文字を含むパス', () => {
    const CONTROL_PATH = `/ctl${String.fromCharCode(0x01)}x`;

    async function makeSiteWithControlPath(page: Page, request: APIRequestContext) {
      const siteId = await makeTrackedSite(request);
      const publicKey = await publicKeyOf(page, siteId);
      await collectHits(request, publicKey, ['/ok', CONTROL_PATH]);
      await rollupToday(request);
      return siteId;
    }

    test('送っても受け口は 204 を返す', async ({ page, request }) => {
      // 結果を出し分けない（キーの当たりを探らせない）。`collectHits` が 204 を確かめる。
      const siteId = await makeTrackedSite(request);
      const publicKey = await publicKeyOf(page, siteId);

      await collectHits(request, publicKey, [CONTROL_PATH]);
    });

    test('rollup 後に tab=pages が HTTP 200 で列見出しが出る', async ({ page, request }) => {
      const siteId = await makeSiteWithControlPath(page, request);

      const response = await page.goto(todayUrl(siteId, '&tab=pages'));

      expect(response?.status()).toBe(200);
      for (const column of ['ページビュー', '訪問者', 'ランディング', '直帰率', '平均滞在']) {
        await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
      }
    });

    test('そのパスの行は出ず、正常な別パスの行は出る', async ({ page, request }) => {
      const siteId = await makeSiteWithControlPath(page, request);

      await page.goto(todayUrl(siteId, '&tab=pages'));

      await expect(page.getByRole('row', { name: /\/ok/ })).toBeVisible();
      await expect(page.getByRole('row', { name: /ctl/ })).toHaveCount(0);
    });
  });
});

/**
 * #79。参照元タブ。referrer 無しの記録は `(direct)`。
 */
test.describe('参照元タブ', () => {
  test('(direct) の行が出る', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    await page.goto(todayUrl(siteId, '&tab=referrers'));

    await expect(page.getByRole('row', { name: /\(direct\)/ })).toBeVisible();
  });
});

/**
 * #80 / #81。Bot の扱い（設計 §7.3.4）。
 *
 * 人の PV 2 件と Bot の PV 1 件を送っておく。
 */
async function makeSiteWithBot(page: Page, request: APIRequestContext): Promise<string> {
  const siteId = await makeTrackedSite(request);
  const publicKey = await publicKeyOf(page, siteId);
  await collectHits(request, publicKey, ['/', '/pricing']);
  await collectBotHit(request, publicKey, '/');
  await rollupToday(request);
  return siteId;
}

test.describe('Bot の扱い', () => {
  /** #80 */
  test('訪問者タブに「Bot のアクセス」が出る', async ({ page, request }) => {
    const siteId = await makeSiteWithBot(page, request);

    await page.goto(todayUrl(siteId, '&tab=visitors'));

    await expect(page.getByText('Bot のアクセス', { exact: true })).toBeVisible();
    await expect(page.getByText('Bot のページビュー', { exact: true })).toBeVisible();
    await expect(
      page.getByText('「Bot を集計に含める」スイッチに左右されません', { exact: false }),
    ).toBeVisible();
  });

  /** #80。「Bot のアクセス」はスイッチに左右されない。 */
  test('bots=1 にしても「Bot のページビュー」の値が変わらない', async ({ page, request }) => {
    const siteId = await makeSiteWithBot(page, request);

    await page.goto(todayUrl(siteId, '&tab=visitors'));
    const off = await statTile(page, 'Bot のページビュー').textContent();

    await page.goto(todayUrl(siteId, '&tab=visitors&bots=1'));
    const on = await statTile(page, 'Bot のページビュー').textContent();

    expect(off).toContain('1');
    expect(on).toBe(off);
  });

  /** #81。ページビューは Bot 分だけ増える（2 → 3）。 */
  test('bots=1 で概要のページビューが Bot 分だけ増える', async ({ page, request }) => {
    const siteId = await makeSiteWithBot(page, request);
    expect(await metricToday(request, siteId, 'bot_pageviews')).toBe(1);

    await page.goto(todayUrl(siteId));
    await expect(statTile(page, 'ページビュー')).toContainText('2');

    await page.goto(todayUrl(siteId, '&bots=1'));
    await expect(statTile(page, 'ページビュー')).toContainText('3');
  });

  /** #81。デバイスに「Bot」行が出る（オフのときは出ない）。 */
  test('bots=1 でデバイスに「Bot」行が出る', async ({ page, request }) => {
    const siteId = await makeSiteWithBot(page, request);

    await page.goto(todayUrl(siteId));
    await expect(page.getByText('Bot', { exact: true })).toHaveCount(0);

    await page.goto(todayUrl(siteId, '&bots=1'));
    await expect(page.getByText('Bot', { exact: true })).toBeVisible();
  });
});

/**
 * #82 / #83。設定タブ（設計 §7.3.6）。計測タグと公開キーの再発行。
 */
test.describe('設定タブ', () => {
  /** #82 */
  test('計測タグに data-site-id と data-site がある', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);

    const snippet = snippetOf(page, siteId);
    await expect(snippet).toBeVisible();
    await expect(snippet).toContainText('data-site="');
  });

  /** #82 */
  test('計測タグの src が絶対 URL で /t.js で終わる', async ({ page, request }) => {
    // 相対パスのまま他所のサイトへ貼ると、貼った先の /t.js を探しに行って届かない。
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);

    const snippet = await snippetOf(page, siteId).textContent();
    const src = /src="([^"]+)"/.exec(snippet ?? '')?.[1] ?? '';
    expect(src.startsWith('http://') || src.startsWith('https://')).toBe(true);
    expect(src.endsWith('/t.js')).toBe(true);
  });

  /** 設計 §10 末尾。サイト選択が 1 サイトずつになった。 */
  test('選択したサイトの設定タブにそのサイトのタグだけが出る', async ({ page, request }) => {
    const first = await makeTrackedSite(request);
    const second = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${second}&tab=settings`);

    await expect(snippetOf(page, second)).toBeVisible();
    await expect(snippetOf(page, first)).toHaveCount(0);
  });

  /** #83 */
  test('「公開キーを再発行」で確認ダイアログが出る', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
    await page.getByRole('button', { name: '公開キーを再発行' }).click();

    const dialog = page.getByRole('dialog', { name: '公開キーを再発行しますか？' });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('貼り直すまでアクセスは記録されません', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: '再発行する' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'キャンセル' })).toBeVisible();
  });

  /** #83。確認すると data-site が変わる。 */
  test('「再発行する」で確認すると計測タグの data-site が変わる', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const before = await publicKeyOf(page, siteId);

    await page.getByRole('button', { name: '公開キーを再発行' }).click();
    await page
      .getByRole('dialog', { name: '公開キーを再発行しますか？' })
      .getByRole('button', { name: '再発行する' })
      .click();

    // `router.refresh()` で Server Component から新しいタグを読み直す。
    await expect(snippetOf(page, siteId)).not.toContainText(`data-site="${before}"`);
    const after = publicKeyIn(await snippetOf(page, siteId).textContent());
    expect(after).not.toBe(before);
    // #43。新しいキーは 64 桁の 16 進。
    expect(after).toMatch(/^[0-9a-f]{64}$/);
  });

  /** #83 / §7.3.6。成功の Toast。 */
  test('再発行すると「公開キーを再発行しました」と知らせる', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
    await page.getByRole('button', { name: '公開キーを再発行' }).click();
    await page
      .getByRole('dialog', { name: '公開キーを再発行しますか？' })
      .getByRole('button', { name: '再発行する' })
      .click();

    await expect(page.getByText('公開キーを再発行しました')).toBeVisible();
  });

  /** #83。キャンセルすると変わらない。 */
  test('「キャンセル」すると計測タグの data-site は変わらない', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const before = await publicKeyOf(page, siteId);

    await page.getByRole('button', { name: '公開キーを再発行' }).click();
    const dialog = page.getByRole('dialog', { name: '公開キーを再発行しますか？' });
    await dialog.getByRole('button', { name: 'キャンセル' }).click();

    await expect(dialog).toBeHidden();
    await expect(snippetOf(page, siteId)).toContainText(`data-site="${before}"`);
    // 読み直しても同じ。
    await page.reload();
    expect(publicKeyIn(await snippetOf(page, siteId).textContent())).toBe(before);
  });

  /** §7.3.6 受信状況。最終受信は rollup が書き戻す（#76 の補足）。 */
  test('受信状況が計測前は「未受信」、集計後は「受信中」になる', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);

    await expect(page.getByText('未受信', { exact: true })).toBeVisible();

    await collectHits(request, publicKey, ['/']);
    await rollupToday(request);
    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);

    await expect(page.getByText('受信中', { exact: true })).toBeVisible();
    await expect(page.getByText('未受信', { exact: true })).toHaveCount(0);
  });
});

/**
 * 受信状況の 4 状態と定期実行（029-scheduled-jobs 設計 §7.1、受け入れ条件 #56〜#60、#63）。
 *
 * E2E は定期実行が有効（`TORIFUNE_ROLLUP_INTERVAL_MINUTES=1`。`playwright.config.ts`）な状態で走る。
 * `collect` 直後の画面は、定期ロールアップが先に走っているかどうかで「集計待ち」か数字かが変わる
 * （設計 §11 #10）。厳密な判定は Domain（#6〜#10）と部品（#53〜#54）で担保する。
 */
test.describe('受信状況の 4 状態と定期実行', () => {
  /** `StatusRow`：ラベルの span の親（行）。 */
  function statusRow(page: Page, label: string): Locator {
    return page.getByText(label, { exact: true }).locator('..');
  }

  const DATE_TIME = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

  /** #56 */
  test('計測したことが無いサイトは「計測タグ未設置」の導線に「N 分ごとに自動」が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(page.getByText('計測タグ未設置')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'まだアクセスの記録がありません' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '計測タグを取得' })).toBeVisible();
    await expect(page.getByText(/\d+ 分ごとに自動/)).toBeVisible();
  });

  /** #57。集計を待たずに「届いている」ことが分かる。 */
  test('collect を 1 件送った直後は「計測タグ未設置」が出ず、最終受信が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);

    await page.goto(todayUrl(siteId));

    await expect(page.getByText('計測タグ未設置')).toHaveCount(0);
    await expect(page.getByText(/最終受信 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/).first()).toBeVisible();
    // 定期実行が先に走っていれば概要の数字、まだなら「集計待ち」の導線。どちらでもよい。
    await expect(
      page
        .getByRole('heading', { name: /アクセスは届いています/ })
        .or(page.getByText('ページビュー', { exact: true }).first()),
    ).toBeVisible();
  });

  /** #58 */
  test('collect → rollup の後の設定タブは「受信中」で、最終集計（全体）・このサイトの集計値の最終更新・定期実行が埋まる', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);
    await rollupToday(request);

    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);

    await expect(page.getByText('受信中', { exact: true })).toBeVisible();
    await expect(statusRow(page, '最終集計（全体）')).toContainText(DATE_TIME);
    await expect(statusRow(page, 'このサイトの集計値の最終更新')).toContainText(DATE_TIME);
    await expect(statusRow(page, '定期実行')).toContainText(
      /有効 · \d+ 分ごと · 次回 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/,
    );
    await expect(statusRow(page, '未集計の受信')).toContainText('—');
  });

  /** #59。Bot だけの期間は概要タブで警告する。 */
  test('Bot だけを集計した期間の概要に「すべて Bot と判定され」の警告が出て、bots=1 では出ない', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectBotHit(request, publicKey, '/');
    await rollupToday(request);

    await page.goto(todayUrl(siteId));
    await expect(
      page.getByRole('alert').filter({ hasText: 'すべて Bot と判定され' }),
    ).toBeVisible();

    await page.goto(todayUrl(siteId, '&bots=1'));
    await expect(page.getByText('すべて Bot と判定され', { exact: false })).toHaveCount(0);
    await expect(statTile(page, 'ページビュー')).toContainText('1');
  });

  /** #60。**人手を介さない経路。** API を叩かずに数字が出る。 */
  test('collect のあと API を叩かずに待つと、定期実行で概要にページビューが出る', async ({
    page,
    request,
  }) => {
    // 初回遅延 15 秒 + 間隔 1 分。
    test.setTimeout(150_000);
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/pricing']);

    await page.goto(todayUrl(siteId));
    await expect
      .poll(
        async () => {
          await page.reload();
          const tile = statTile(page, 'ページビュー');
          if ((await tile.count()) === 0) return null;
          return (await tile.textContent()) ?? null;
        },
        { timeout: 120_000, intervals: [5_000] },
      )
      .toMatch(/[1-9]/);

    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);
    await expect(statusRow(page, '最終集計（全体）')).toContainText(DATE_TIME);
  });

  /**
   * #63。既存の「受信状況が計測前は「未受信」、集計後は「受信中」になる」（設定タブの describe）は
   * 文言そのまま通る。ここでは 4 状態のうち exact な「未受信」と「受信中」を改めて固定する。
   */
  test('計測前は「未受信」、collect + 集計後は「受信中」（exact）', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);

    await expect(page.getByText('未受信', { exact: true })).toBeVisible();
    await expect(page.getByText('受信中', { exact: true })).toHaveCount(0);

    await collectHits(request, publicKey, ['/']);
    await rollupToday(request);
    await page.goto(`/analytics?siteId=${siteId}&tab=settings`);

    await expect(page.getByText('受信中', { exact: true })).toBeVisible();
    await expect(page.getByText('未受信', { exact: true })).toHaveCount(0);
    await expect(page.getByText('受信中（集計待ち）', { exact: true })).toHaveCount(0);
  });
});

/**
 * #84。不正な期間でも画面を落とさない（設計 §7.3.1）。API は 422 だが画面は警告を出して 30 日に戻す。
 */
test.describe('不正な期間', () => {
  function warning(page: Page): Locator {
    return page
      .locator('[role="alert"], [role="status"]')
      .filter({ hasText: '期間を確認してください' });
  }

  test('期間が逆転していても画面が落ちず、「期間を確認してください」の警告が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);

    const response = await page.goto(
      `/analytics?siteId=${siteId}&period=custom&from=2026-05-01&to=2026-04-01`,
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    await expect(warning(page)).toBeVisible();
  });

  test('400 日を超える期間でも画面が落ちず、警告が出る', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    const response = await page.goto(
      `/analytics?siteId=${siteId}&period=custom&from=2020-01-01&to=2026-01-01`,
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    await expect(warning(page)).toBeVisible();
  });

  test('日付として読めない from でも画面が落ちず、警告が出る', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    const response = await page.goto(
      `/analytics?siteId=${siteId}&period=custom&from=not-a-date&to=2026-04-01`,
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    await expect(warning(page)).toBeVisible();
  });

  test('正しい期間では警告が出ない', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(todayUrl(siteId));

    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    await expect(warning(page)).toHaveCount(0);
  });
});

/**
 * #85。前期間の文とタイムゾーン（設計 §7.1 / §7.3.2）。
 */
test.describe('前期間と日付の区切り', () => {
  test('「前期間（… 〜 …）と比較」が出る', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(
      page.getByText(/前期間（\d{4}-\d{2}-\d{2} 〜 \d{4}-\d{2}-\d{2}）と比較/),
    ).toBeVisible();
  });

  test('今日 1 日の前期間は昨日 1 日', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);

    await page.goto(todayUrl(siteId));

    await expect(
      page.getByText(`前期間（${yesterday()} 〜 ${yesterday()}）と比較`, { exact: false }),
    ).toBeVisible();
  });

  test('「日付の区切りは Asia/Tokyo」が出る', async ({ page, request }) => {
    // `playwright.config.ts` の `TORIFUNE_TIMEZONE`。決め打ちではなく実際の値を出す。
    const siteId = await makeTrackedSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(
      page.getByText(`日付の区切りは ${SERVER_TIME_ZONE}`, { exact: false }),
    ).toBeVisible();
  });
});

/**
 * #86。前期間比のトーン（設計 §7.3.5）。`Stat` の `delta` は `<span data-tone>`。
 *
 * `period=custom&from=今日&to=今日` の前期間は昨日。昨日の値は `analytics` へ
 * `source = 'e2e'` で直接入れる（画面は出所をまたいで足す）。
 */
test.describe('前期間比のトーン', () => {
  const STAT_LABELS = ['ページビュー', '訪問者', 'セッション', '直帰率', '平均滞在時間'] as const;

  /**
   * 今日：同じ訪問者の PV 2 件（30 分以内）→ pageviews 2、visitors 1、sessions 1、bounces 0。
   * 昨日：pageviews 10、visitors 4、sessions 20、bounces 16（直帰率 80%）。
   */
  async function makeSiteWithPreviousPeriod(page: Page, request: APIRequestContext) {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/pricing']);
    await rollupToday(request);
    await seedAnalytics(siteId, yesterday(), {
      pageviews: 10,
      visitors: 4,
      sessions: 20,
      bounces: 16,
    });
    return siteId;
  }

  test('前期間比の data-tone は success / danger / muted のいずれか', async ({ page, request }) => {
    const siteId = await makeSiteWithPreviousPeriod(page, request);

    await page.goto(todayUrl(siteId));

    const tones = page.locator('[data-tone]');
    expect(await tones.count()).toBeGreaterThanOrEqual(STAT_LABELS.length);
    for (const tone of await tones.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-tone')),
    )) {
      expect(['success', 'danger', 'muted']).toContain(tone);
    }
  });

  test('PV が下がったとき danger', async ({ page, request }) => {
    const siteId = await makeSiteWithPreviousPeriod(page, request);

    await page.goto(todayUrl(siteId));

    // delta(2, 10) = −80.0%（設計 §7.3.5。符号は U+2212）。
    const delta = statTile(page, 'ページビュー').locator('[data-tone]');
    await expect(delta).toHaveAttribute('data-tone', 'danger');
    await expect(delta).toHaveText(/[−-]80\.0%/);
  });

  test('直帰率が下がったとき success', async ({ page, request }) => {
    const siteId = await makeSiteWithPreviousPeriod(page, request);

    await page.goto(todayUrl(siteId));

    // deltaPt(0 / 1, 16 / 20) = −80.0pt。直帰率だけ lowerIsBetter。
    const delta = statTile(page, '直帰率').locator('[data-tone]');
    await expect(delta).toHaveAttribute('data-tone', 'success');
    await expect(delta).toHaveText(/[−-]80\.0pt/);
  });

  test('前期が 0 のとき「—」で muted', async ({ page, request }) => {
    // 昨日の値を入れない → 前期はすべて 0。
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/pricing']);
    await rollupToday(request);

    await page.goto(todayUrl(siteId));

    for (const label of STAT_LABELS) {
      const delta = statTile(page, label).locator('[data-tone]');
      await expect(delta, label).toHaveAttribute('data-tone', 'muted');
      await expect(delta, label).toHaveText('—');
    }
  });
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
 * `(site_id, metric_date, source, metric, key)` の複合キーで保存する集計値の集合で、
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

/**
 * #82（029-scheduled-jobs 検証の反映。security-reviewer M-1）。
 *
 * `isValidRange` が形式（`^\d{4}-\d{2}-\d{2}$`）しか見ていないと、実在しない日付が通る。
 * その先の `rangeDays` は `Date.parse` に依るので `NaN` になり、
 * **`NaN > MAX_RANGE_DAYS` が `false`** で幅の検査まで素通りする。
 * 入口（`isValidRange`）を直すと、`POST /analytics/rollup` だけでなく
 * `GET /analytics` 系（`assertRange`）と画面も同時に塞がる。ここはその回帰。
 */
test('実在しない日付なら 422（GET /analytics）', async ({ request }) => {
  const response = await request.get('/api/v1/analytics?from=0000-00-00&to=9999-99-99');

  expect(response.status(), await response.text()).toBe(422);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe('VALIDATION_ERROR');
});

test('実在しない日付なら 422（GET /analytics/breakdown）', async ({ request }) => {
  const response = await request.get(
    '/api/v1/analytics/breakdown?from=2026-02-30&to=2026-03-01&metric=path_pageviews',
  );

  expect(response.status(), await response.text()).toBe(422);
});

test('未認証では 401', async ({ request }) => {
  const response = await request.get(`/api/v1/analytics?from=${today()}&to=${today()}`, {
    headers: { Cookie: '' },
  });
  expect(response.status()).toBe(401);
});

/** #87 */
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

/**
 * #88。`analytics.read` を持たない利用者には権限なしの画面（`AsyncState forbidden`）。
 *
 * **画面は 403 を返さず「権限がありません」を描画する**（HTTP は 200）。
 * `/sites` `/social` と同じ扱い。API 側は実際に 403 を返す（`内訳 API` の #37）。
 */
test('analytics.read を持たない利用者には権限なしの画面が出る', async ({
  browser,
  request,
  playwright,
}) => {
  const api = await contextWithoutPermissions(request, playwright);
  let storage;
  try {
    storage = await api.storageState();
  } finally {
    await api.dispose();
  }

  const context = await browser.newContext({ baseURL: origin, storageState: storage });
  try {
    const page = await context.newPage();
    const response = await page.goto('/analytics');
    expect(response?.status()).toBe(200);

    await expect(page.getByText('この操作を行う権限がありません')).toBeVisible();
    // 集計の中身（サイト選択・タブ）は出さない。
    await expect(siteSelect(page)).toHaveCount(0);
    await expect(tabNav(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
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

  /** UUID でない siteId は 500 にせず空結果（028 の検証で追記）。 */
  test('UUID でない siteId なら 200 で data が空', async ({ request }) => {
    const response = await request.get(
      `/api/v1/analytics/breakdown?siteId=abc&from=${today()}&to=${today()}&metric=pageviews`,
    );
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as BreakdownBody;
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
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

  /** UUID でない siteId は 500 にせず空結果（028 の検証で追記）。 */
  test('UUID でない siteId なら 200 で data が空', async ({ request }) => {
    const response = await request.get(
      `/api/v1/analytics?siteId=abc&from=${today()}&to=${today()}`,
    );
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as PointBody;
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(0);
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

/**
 * 「当日」（030-analytics-today 設計 §7、受け入れ条件 #48〜#69、#74、#76、#79〜#83、#86）。
 *
 * 既存のタブ（概要 / ページ / 参照元 / 訪問者）から本日を外し、
 * そこに出ているのが**前日までの確定値**であることを画面で分かるようにする。
 * 本日の値は「当日」（`?period=today`）で、`access_logs` を直接集計して出す。
 *
 * **既存のデータ系テストは `todayUrl`（`period=custom&from=今日&to=今日`）を使っており、
 * プリセットの `to` が昨日になっても影響を受けない。**
 */

/** 「当日」だけの `SegmentedControl`（`aria-label="当日"` の `nav`）。 */
function todayNav(page: Page): Locator {
  return page.getByRole('navigation', { name: '当日', exact: true });
}

/** `?period=today` で開く URL。 */
function todayPeriodUrl(siteId: string, extra = ''): string {
  return `/analytics?siteId=${siteId}&period=today${extra}`;
}

/** §7.5.1 の案内（`receiving` なのに当期が空で、今日は届いている状態）。 */
function staleRangeNotice(page: Page): Locator {
  return page
    .locator('[role="status"], [role="alert"]')
    .filter({ hasText: 'アクセスは今日届いています' });
}

/** §7.4.3 の注記（今日を含むカスタム期間）。 */
function todayInCustomNotice(page: Page): Locator {
  return page.locator('[role="status"], [role="alert"]').filter({ hasText: '今日を含む期間です' });
}

/**
 * **昨日**の生ログを 1 行だけ直接 INSERT する（#65 の下ごしらえ）。
 *
 * `collect` は `occurred_at` を今にするので、「最終受信はあるが今日の生ログは 0 件」を
 * API からは作れない。
 */
async function seedYesterdayAccessLog(siteId: string): Promise<void> {
  await withDatabase((client) =>
    client.query(
      `INSERT INTO access_logs (id, site_id, occurred_at, path, referrer_host, visitor_hash, device)
       VALUES ($1, $2, now() - interval '1 day', '/', NULL, $3, 'desktop')`,
      [crypto.randomUUID(), siteId, `e2e-${unique()}`],
    ),
  );
}

/**
 * **この describe だけで使い回す下ごしらえ。**
 *
 * `GET /api/v1/auth/csrf` の Rate Limit は 1 分あたり 300 回（`DEFAULT_RATE_LIMIT`）で、
 * キーは `operationId:IP`。**E2E の全ファイルがこの 1 つのバケツを共有する。**
 * 全件が 1.5〜2 分で走り切るので、テストごとにサイトを作ると当日の 36 件だけで
 * 40 回以上を消費し、後続のファイル（jobs / api-token / social など）が 429 で落ちる。
 * 実際、この describe を `--grep-invert` で外すと全件が通り、入れると 8〜24 件が
 * 実行のたびに別の場所で落ちた。
 *
 * そこで**サイトの状態を変えない（読むだけの）テストは下ごしらえを共有する。**
 * 集計値や生ログを足すテスト・未集計であることに依存するテストは、
 * これまでどおり自分のサイトを作る（共有すると実行順に依存してしまう）。
 *
 * `workers: 1` かつ `fullyParallel: false` なので、遅延生成に競合は起きない。
 * `global-setup` が実行ごとに `sites` を消すので、実行をまたいで残ることもない。
 */
let pristineSiteId: string | null = null;
let todayHitsSiteId: string | null = null;
let rolledUpTodaySiteId: string | null = null;

/** 一度も受信していないサイト。期間セグメントの描画と「計測タグ未設置」の見た目に使う。 */
async function pristineSite(request: APIRequestContext): Promise<string> {
  pristineSiteId ??= await makeTrackedSite(request);
  return pristineSiteId;
}

/**
 * 今日の生ログがあるサイト。人は `/` ×2 と `/pricing` の 3 PV、Bot が 1 件。
 * **集計は流さない**（当日は生ログを直接読むので要らない）。
 */
async function todayHitsSite(page: Page, request: APIRequestContext): Promise<string> {
  if (todayHitsSiteId === null) {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/', '/pricing']);
    await collectBotHit(request, publicKey, '/');
    todayHitsSiteId = siteId;
  }
  return todayHitsSiteId;
}

/**
 * 今日の生ログを集計済みのサイト（未集計 0 件 ＝ `diagnoseReception` は `receiving`）。
 * §7.5.1 の案内の出し分けに使う。
 */
async function rolledUpTodaySite(page: Page, request: APIRequestContext): Promise<string> {
  if (rolledUpTodaySiteId === null) {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);
    await rollupToday(request);
    rolledUpTodaySiteId = siteId;
  }
  return rolledUpTodaySiteId;
}

test.describe('当日', () => {
  /** #48。期間セグメントの左に、**別のグループ（別の `nav`）**として出る（裁定 3.2）。 */
  test('「当日」が期間セグメントとは別の nav として、その左に出る', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    await page.goto(`/analytics?siteId=${siteId}`);

    await expect(todayNav(page)).toBeVisible();
    await expect(todayNav(page).getByRole('link', { name: '当日', exact: true })).toBeVisible();
    // 期間セグメント（「前月」を含む nav）とは別物。
    await expect(presetNav(page).getByRole('link', { name: '当日', exact: true })).toHaveCount(0);

    // DOM 順で「当日」が期間セグメントより先（＝左）。
    const labels = await page
      .getByRole('navigation')
      .evaluateAll((navs) => navs.map((nav) => nav.getAttribute('aria-label') ?? ''));
    const todayIndex = labels.indexOf('当日');
    const presetIndex = labels.indexOf('期間');
    expect(todayIndex, `nav の aria-label: ${labels.join(' / ')}`).toBeGreaterThanOrEqual(0);
    expect(presetIndex).toBeGreaterThanOrEqual(0);
    expect(todayIndex).toBeLessThan(presetIndex);
  });

  /** #49。`period === 'today'` のとき期間セグメントは**どれも選択状態にならない**。 */
  test('?period=today で「当日」が選択状態になり、期間の 6 項目はどれも選択されない', async ({
    page,
    request,
  }) => {
    const siteId = await pristineSite(request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(todayNav(page).getByRole('link', { name: '当日', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const label of ['7日', '30日', '90日', '今月', '前月', 'カスタム']) {
      await expect(
        presetNav(page).getByRole('link', { name: label, exact: true }),
        label,
      ).not.toHaveAttribute('aria-current', 'page');
    }
  });

  /** #50。期間セグメントを押せば「当日」から抜ける。 */
  test('期間セグメントを押すと「当日」が非選択になる', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    await page.goto(todayPeriodUrl(siteId));
    await presetNav(page).getByRole('link', { name: '7日', exact: true }).click();

    await page.waitForURL((url) => url.searchParams.get('period') === '7d');
    await expect(
      todayNav(page).getByRole('link', { name: '当日', exact: true }),
    ).not.toHaveAttribute('aria-current', 'page');
    await expect(presetNav(page).getByRole('link', { name: '7日', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  /** #51。既存の選択の見え方を壊さない（「当日」が増えても 7日 は選べる）。 */
  test('?period=7d では「7日」が選択で「当日」は非選択', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(presetNav(page).getByRole('link', { name: '7日', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      todayNav(page).getByRole('link', { name: '当日', exact: true }),
    ).not.toHaveAttribute('aria-current', 'page');
  });

  /**
   * #52。**確定値ではないことと、いつ時点かを出す**（§7.4.1）。
   *
   * `{HH:mm}` はサーバーが集計した瞬間であって、ブラウザの時計ではない。
   */
  test('?period=today に「{日時} 時点の速報値」と「確定値ではありません」が出る', async ({
    page,
    request,
  }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(page.getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} 時点の速報値/)).toBeVisible();
    await expect(page.getByText('確定値ではありません', { exact: false })).toBeVisible();
    // 当日は前期間比を出さないので、ヘッダ行に「前期間（…）と比較」は出ない。
    await expect(page.getByText(/前期間（\d{4}-\d{2}-\d{2} 〜/)).toHaveCount(0);
  });

  /** #52。約 N 分ごとに確定することを添える（§7.4.2）。 */
  test('?period=today に「約 N 分ごとに確定します」が出る', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(page.getByText(/約 \d+ 分ごとに確定します/)).toBeVisible();
  });

  /**
   * #53。前期間比の代わりに**前日の確定値を並記**する（§13-1）。
   *
   * 「今日はいまのところ n、昨日は 1 日で m だった」が読めれば、進み具合の把握には足りる。
   */
  test('?period=today に前日の確定値（ページビュー・訪問者）が並記される', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);
    await seedAnalytics(siteId, yesterday(), { pageviews: 10, visitors: 4 });

    await page.goto(todayPeriodUrl(siteId));

    const banner = page.getByText(`前日（${yesterday()}）の確定値`, { exact: false });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('10');
    await expect(banner).toContainText('4');
  });

  /** #54。当日は「比べていない」ので、矢印も `—` も出さない。 */
  test('?period=today の概要タブに前期間比が出ない', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(statTile(page, 'ページビュー')).toContainText('3');
    await expect(page.locator('[data-tone]')).toHaveCount(0);
  });

  /** #55。1 日の折れ線に意味が無い。カードごと出さない。 */
  test('?period=today の概要タブに「日次の推移」カードが出ない', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(page.getByText('日次の推移', { exact: true })).toHaveCount(0);
    // 当日は時間帯別がその役割を担う。
    await expect(page.getByText('時間帯別のページビュー', { exact: true })).toBeVisible();
  });

  /** #56。1 日しかないので「訪問者」と同じ数になる。同じ数を 2 枚並べない。 */
  test('?period=today の訪問者タブに「1日あたり訪問者」が出ない', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId, '&tab=visitors'));

    await expect(page.getByText('1日あたり訪問者', { exact: true })).toHaveCount(0);
    await expect(statTile(page, '訪問者')).toBeVisible();
    // 「Bot のアクセス」は当日でも出す（未決事項 #3）。
    await expect(page.getByText('Bot のアクセス', { exact: true })).toBeVisible();
  });

  /** #57。補正も除外もしない代わりに、偏りを注記で担保する（§13-2）。 */
  test('?period=today の直帰率と平均滞在時間に偏りの注記が出る', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(statTile(page, '直帰率')).toContainText('確定後より高めに出ます');
    await expect(statTile(page, '平均滞在時間')).toContainText('実際より短めに出ます');
  });

  /** #58。表は本日の値で出る。並び順と 1 ページの件数は確定期間と同じ。 */
  test('?period=today のページタブに本日のパスが行として並ぶ', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId, '&tab=pages'));

    for (const column of ['ページビュー', '訪問者', 'ランディング', '直帰率', '平均滞在']) {
      await expect(page.getByRole('columnheader', { name: column })).toBeVisible();
    }
    // ページビュー降順（`sumByKey` と同じ並び）。
    await expect(page.getByRole('row', { name: /\/pricing/ })).toBeVisible();
    await expect(page.getByRole('row').nth(1)).toContainText('2');
  });

  /** #58。参照元タブ。referrer 無しは `(direct)`。 */
  test('?period=today の参照元タブに (direct) の行が出る', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId, '&tab=referrers'));

    await expect(page.getByRole('row', { name: /\(direct\)/ })).toBeVisible();
  });

  /** #58。ページ送りも動く（メモリ上でスライスする。§11.3）。 */
  test('?period=today&tab=pages&page=2 が 500 にならず、空のまま描ける', async ({
    page,
    request,
  }) => {
    const siteId = await todayHitsSite(page, request);

    const response = await page.goto(todayPeriodUrl(siteId, '&tab=pages&page=2'));

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();
    await expect(page.getByRole('row', { name: /\/pricing/ })).toHaveCount(0);
  });

  /**
   * #59。**既存の期間のグラフに本日の点が現れない**（要件 §4）。
   *
   * 今日だけ計測して集計しても、`7d`（末尾が昨日）には 1 件も入らない。
   * 混ぜると「午前 10 時の本日」が急落に見える。
   */
  test('今日だけ計測して集計しても ?period=7d には本日の値が出ない', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/', '/', '/pricing']);
    // 本日分は `analytics` へ入る（`todayUrl` で見れば 3 と出る）。
    expect(await metricToday(request, siteId, 'pageviews')).toBe(3);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(statTile(page, 'ページビュー')).toContainText('0');
    await expect(page.getByText('この期間のアクセスの記録はありません。')).toBeVisible();
  });

  /** #60。既存の期間で「集計は前日まで」と分かる（裁定 3.3）。 */
  test('?period=7d のヘッダ行に「集計は前日まで」が出る', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(page.getByText('集計は前日まで', { exact: false })).toBeVisible();
  });

  /** #60。当日では出さない（当日は前日までではない）。 */
  test('?period=today のヘッダ行に「集計は前日まで」は出ない', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(page.getByText('集計は前日まで', { exact: false })).toHaveCount(0);
  });

  /**
   * #61。**今日が月の 1 日でも 500 にならない**（§7.2）。
   *
   * `to` を昨日にすると `month` は `from > to` になり、そのまま渡すと `ValidationError` で
   * 画面ごと落ちる。`presetRange` が `null` を返し、画面は集計をせず空状態を出す。
   *
   * 実行日が 1 日でないと空状態そのものは再現できない（`presetRange('month', 月初) === null` は
   * ユニット #5、解決は `analytics-query.test.ts` で決定的に見ている）。
   * ここでは 500 にならないことを見て、1 日なら空状態も確かめる。
   */
  test('?period=month が 500 にならない（今日が月の 1 日でも）', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    const response = await page.goto(`/analytics?siteId=${siteId}&period=month`);

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();

    if (today().endsWith('-01')) {
      await expect(page.getByText('今月の確定値はまだありません', { exact: false })).toBeVisible();
      await expect(page.getByRole('link', { name: '当日を見る' })).toBeVisible();
      // #84。「当日を見る」導線が 2 つ並ばない（§7.5.1 の案内は出さない）。
      await expect(staleRangeNotice(page)).toHaveCount(0);
    }
  });

  /**
   * #62 / #86。今日を含むカスタム期間には、値が古く見える理由を出す（§7.4.3）。
   *
   * 逃げ道（カスタムで今日を明示）は塞がない。値は集計値（最大 15 分遅れ）のまま。
   */
  test('?period=custom で今日を含むと注記と「当日を見る」が出る', async ({ page, request }) => {
    const siteId = await makeRolledUpSite(page, request);

    await page.goto(todayUrl(siteId));

    await expect(todayInCustomNotice(page)).toBeVisible();
    await expect(page.getByText('いまの値は「当日」で見られます', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: '当日を見る' })).toBeVisible();
    // #86。`tone="info"` は `role="status"`（`danger` の `role="alert"` ではない）。
    await expect(todayInCustomNotice(page)).toHaveAttribute('role', 'status');
    // 今日を含む custom では「集計は前日まで」を出さない。
    await expect(page.getByText('集計は前日まで', { exact: false })).toHaveCount(0);
  });

  /** #62。今日を含まないカスタム期間には注記を出さない。 */
  test('?period=custom で今日を含まなければ注記が出ない', async ({ page, request }) => {
    const siteId = await pristineSite(request);

    await page.goto(
      `/analytics?siteId=${siteId}&period=custom&from=${shiftDate(today(), -10)}&to=${yesterday()}`,
    );

    await expect(todayInCustomNotice(page)).toHaveCount(0);
    await expect(page.getByText('集計は前日まで', { exact: false })).toBeVisible();
  });

  /**
   * #63。前日までが空で今日だけ届いている状態を、「集計待ち」と誤って説明しない（§7.5）。
   *
   * 定期ロールアップ（1 分間隔）が `collect` と画面表示の間に走ると `pending` が 0 になり、
   * 導線ではなく §7.5.1 の案内（`receiving`）になる。**どちらでもよい**が、
   * どちらの場合も「次回の集計のあとに数字が出ます」は出してはならない。
   * 決定的な担保は `not-tracked.test.ts` のユニットで取る。
   */
  test('今日だけ届いている状態の ?period=7d で「当日」への導線が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(
      page
        .getByText('届いているのは今日の分です', { exact: false })
        .or(page.getByText('アクセスは今日届いています', { exact: false })),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: '当日を見る' }).first()).toBeVisible();
    await expect(page.getByText('そのあとにこの画面へ数字が出ます', { exact: false })).toHaveCount(
      0,
    );
  });

  /** #64。一度も受信していないサイトは、当日でも現行どおりの導線（既存 E2E の locator を保つ）。 */
  test('一度も受信していないサイトは ?period=today でも「計測タグ未設置」の導線が出る', async ({
    page,
    request,
  }) => {
    const siteId = await pristineSite(request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(page.getByText('計測タグ未設置')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'まだアクセスの記録がありません' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '計測タグを取得' })).toBeVisible();
  });

  /**
   * #65。今日 0 件・過去に受信ありのとき、**導線ではなく通常のタブ**を出す（§7.6）。
   *
   * 「当日」は未集計の値を見るための期間なので、届いているのに中身を隠すのは矛盾する。
   */
  test('今日の生ログが 0 件で過去に受信があるサイトは、?period=today で通常のタブと 0 が出る', async ({
    page,
    request,
  }) => {
    const siteId = await makeTrackedSite(request);
    await seedYesterdayAccessLog(siteId);

    await page.goto(todayPeriodUrl(siteId));

    // 導線は出さない。
    await expect(page.getByText('計測タグ未設置')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /アクセスは届いています/ })).toHaveCount(0);
    // 値はすべて 0。
    await expect(statTile(page, 'ページビュー')).toContainText('0');
    await expect(statTile(page, '訪問者')).toContainText('0');
    await expect(page.getByText('今日のアクセスはまだありません', { exact: false })).toBeVisible();
  });

  /** #66。「Bot を集計に含める」は当日でも同じ規則で効く（§7.3.4）。 */
  test('?period=today&bots=1 で Bot を含めた値になる', async ({ page, request }) => {
    const siteId = await todayHitsSite(page, request);

    await page.goto(todayPeriodUrl(siteId));
    await expect(statTile(page, 'ページビュー')).toContainText('3');

    await page.goto(todayPeriodUrl(siteId, '&bots=1'));
    await expect(statTile(page, 'ページビュー')).toContainText('4');
  });

  /** #67。`analytics.read` を持たない利用者は、当日でも現行どおり権限なしの画面。 */
  test('analytics.read を持たない利用者は ?period=today でも権限なしの画面', async ({
    browser,
    request,
    playwright,
  }) => {
    const api = await contextWithoutPermissions(request, playwright);
    let storage;
    try {
      storage = await api.storageState();
    } finally {
      await api.dispose();
    }

    const context = await browser.newContext({ baseURL: origin, storageState: storage });
    try {
      const page = await context.newPage();
      const response = await page.goto('/analytics?period=today');

      expect(response?.status()).toBe(200);
      await expect(page.getByText('この操作を行う権限がありません')).toBeVisible();
      await expect(todayNav(page)).toHaveCount(0);
      await expect(siteSelect(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  /**
   * #68。未認証は現行どおり `/login` へリダイレクト。
   *
   * **`browser.newContext()` では未認証にならない。** `playwright.config.ts` の
   * `use.storageState`（管理者でログイン済み）は新しく作ったコンテキストにも効くため、
   * 何も渡さずに作ると**管理者のまま**開いてしまい、この検査が素通りする。
   *
   * 既存の未認証テスト（`ui-shell.spec.ts`「未ログインでダッシュボードを開くと
   * ログイン画面へ送られる」）と同じく、`page` の Cookie を消してから開く。
   * `storageState: undefined` を渡す形にしないのは、それが config の既定を
   * 打ち消すかどうかが Playwright のバージョンに依るため。
   */
  test('未認証で ?period=today を開くと /login へリダイレクトされる', async ({ page }) => {
    await page.context().clearCookies();
    // 未認証になっていることを先に確かめる。ここが空でないとリダイレクトの検査が意味を失う。
    expect(await page.context().cookies()).toEqual([]);

    await page.goto('/analytics?period=today');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('ログインID')).toBeVisible();
  });

  /** #69。存在しない siteId は現行どおり 404（当日でも変わらない）。 */
  test('存在しない siteId の ?period=today は 404', async ({ page }) => {
    const response = await page.goto(`/analytics?siteId=${crypto.randomUUID()}&period=today`);

    expect(response?.status()).toBe(404);
  });

  /** #69。UUID でない siteId も 404（キャストエラーで 500 にしない）。 */
  test('UUID でない siteId の ?period=today は 404', async ({ page }) => {
    const response = await page.goto('/analytics?siteId=not-a-uuid&period=today');

    expect(response?.status()).toBe(404);
  });

  /**
   * #74。**参照 API は変更しない**（§6）。`period` を受け付けない。
   *
   * 生ログを直接集計する例外は、有界であることを保証できる経路にだけ開く。
   * API に開くと、外から任意の頻度で重い集計を起こせる口になる。
   */
  test('GET /api/v1/analytics は period を受け付けず、応答が変わらない', async ({
    page,
    request,
  }) => {
    const siteId = await makeRolledUpSite(page, request);
    const base = `/api/v1/analytics?siteId=${siteId}&from=${today()}&to=${today()}&key=&perPage=100`;

    const plain = await request.get(base);
    const withPeriod = await request.get(`${base}&period=today`);

    expect(plain.status()).toBe(200);
    expect(withPeriod.status()).toBe(200);
    expect(await withPeriod.json()).toEqual(await plain.json());
  });

  /**
   * #76。定期ロールアップが走った直後（未集計 0 件）で当期の集計値が 0 件、
   * 最終受信が今日のとき、案内と「当日を見る」を出す（§7.5.1）。
   *
   * `rollupToday` は `runJob` を通るので、以後 `pending` は 0 にしかならない（決定的）。
   * `diagnoseReception` は `receiving` を返しており、導線は出ていない。
   */
  test('集計済み・当期 0 件・今日受信ありの ?period=7d に案内と「当日を見る」が出る', async ({
    page,
    request,
  }) => {
    const siteId = await rolledUpTodaySite(page, request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(staleRangeNotice(page)).toBeVisible();
    await expect(staleRangeNotice(page)).toContainText('確定値はまだありません');
    await expect(staleRangeNotice(page)).toContainText('集計は前日まで');
    await expect(page.getByRole('link', { name: '当日を見る' }).first()).toBeVisible();
    // 導線（`not-tracked`）は出ていない。
    await expect(page.getByRole('heading', { name: /アクセスは届いています/ })).toHaveCount(0);
    await expect(page.getByText('計測タグ未設置')).toHaveCount(0);
  });

  /** #77 / #86。案内は `tone="info"`（`role="status"`）。`danger` の `role="alert"` にしない。 */
  test('案内の role が status', async ({ page, request }) => {
    const siteId = await rolledUpTodaySite(page, request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(staleRangeNotice(page)).toHaveAttribute('role', 'status');
  });

  /** #79。一度も受信していなければ、案内ではなく `not-received` の導線が出る。 */
  test('未受信のサイトでは案内が出ず、「計測タグ未設置」の導線が出る', async ({
    page,
    request,
  }) => {
    const siteId = await pristineSite(request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(staleRangeNotice(page)).toHaveCount(0);
    await expect(page.getByText('計測タグ未設置')).toBeVisible();
  });

  /** #80。当期に集計値が 1 件でもあれば案内は出ない（数字が出ているときに案内しない）。 */
  test('当期に集計値があれば案内が出ない', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);
    await rollupToday(request);
    // 当期（末尾が昨日）に確定値を入れる。
    await seedAnalytics(siteId, yesterday(), { pageviews: 10, visitors: 4 });

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);

    await expect(statTile(page, 'ページビュー')).toContainText('10');
    await expect(staleRangeNotice(page)).toHaveCount(0);
  });

  /** #81。当日を見ているのに当日への導線は出さない。 */
  test('?period=today では案内が出ない', async ({ page, request }) => {
    const siteId = await rolledUpTodaySite(page, request);

    await page.goto(todayPeriodUrl(siteId));

    await expect(staleRangeNotice(page)).toHaveCount(0);
  });

  /**
   * #82。導線と案内が**二重に出ない**。
   *
   * `collect` 直後は定期ロールアップ（1 分間隔）との競合で
   * `pending-rollup`（導線）にも `receiving`（案内）にもなりうる。
   * **どちらか一方だけ**であることは、どちらに転んでも成り立つ。
   */
  test('導線と案内が同時に出ない', async ({ page, request }) => {
    const siteId = await makeTrackedSite(request);
    const publicKey = await publicKeyOf(page, siteId);
    await collectHits(request, publicKey, ['/']);

    await page.goto(`/analytics?siteId=${siteId}&period=7d`);
    await expect(page.getByRole('heading', { name: 'アナリティクス' })).toBeVisible();

    const guidance = await page.getByRole('heading', { name: /アクセスは届いています/ }).count();
    const notice = await staleRangeNotice(page).count();

    expect(guidance + notice, `導線 ${guidance} 件 / 案内 ${notice} 件`).toBe(1);
  });

  /** #83。設定タブは期間に依存しない。 */
  test('?tab=settings では案内が出ない', async ({ page, request }) => {
    const siteId = await rolledUpTodaySite(page, request);

    await page.goto(`/analytics?siteId=${siteId}&period=7d&tab=settings`);

    await expect(snippetOf(page, siteId)).toBeVisible();
    await expect(staleRangeNotice(page)).toHaveCount(0);
  });
});
