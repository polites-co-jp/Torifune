import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 画面の `?page=` の解釈（044-screen-page-param 設計 §6・§10.3、受け入れ条件 #11〜#16）。
 *
 * 画面は URL の `?page=`（`/social` は `?postPage=`）を `normalizePage` で丸めてから UseCase へ渡す。
 * `Infinity`・小数・`1e18` のような値で開いても **500 にならず、200 でその画面が出る**ことを見る。
 *
 * - 1 ページ目に倒れる値（`Infinity`・`1.01` など）では 1 ページ目が出る
 * - `1e18` は `Number.MAX_SAFE_INTEGER` ページ目（空のページ）になる
 *
 * 既定の利用者（管理者。`global-setup.ts`）で開く。Permission の検査の後ろの経路（`page` が
 * UseCase に届く経路）を通すため。
 */

const origin = 'http://127.0.0.1:3000';

/** 設計 §10.3 の「3 つの値」。 */
const THREE_VALUES = ['Infinity', '1.01', '1e18'] as const;

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function createSite(request: APIRequestContext, name: string): Promise<string> {
  const token = await csrf(request);
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
  return ((await response.json()) as { data: { id: string } }).data.id;
}

async function deleteSite(request: APIRequestContext, siteId: string): Promise<void> {
  const token = await csrf(request);
  const response = await request.delete(`/api/v1/sites/${siteId}`, {
    headers: headers(token),
    data: { csrfToken: token },
  });
  expect(response.status(), await response.text()).toBe(204);
}

/** 開いて、200 と見出し（`h1`）を確かめる。 */
async function expectScreen(page: Page, url: string, heading: string): Promise<void> {
  const response = await page.goto(url);

  expect(response?.status(), url).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

/**
 * #11。`/sites` はテストで作ったサイトが 1 ページ目に出る（`created_at` の降順で先頭）。
 * 他の spec が作った行が残っていても、作ったばかりのサイトは 1 ページ目にある。
 */
test.describe('#11 /sites', () => {
  const siteName = `E2E page-param ${unique()}`;
  let siteId: string | null = null;

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({
      baseURL: origin,
      storageState: './e2e/.auth/admin.json',
    });
    try {
      siteId = await createSite(request, siteName);
    } finally {
      await request.dispose();
    }
  });

  test.afterAll(async ({ playwright }) => {
    if (siteId === null) return;
    const request = await playwright.request.newContext({
      baseURL: origin,
      storageState: './e2e/.auth/admin.json',
    });
    try {
      await deleteSite(request, siteId);
    } finally {
      await request.dispose();
    }
  });

  for (const query of [
    'page=Infinity',
    'page=-Infinity',
    'page=1.01',
    'page=abc',
    'page=1e400',
    'page=-5',
    'page=0',
    'page=2&page=3',
  ]) {
    test(`#11 /sites?${query} は 200 で 1 ページ目（作ったサイトが見える）`, async ({ page }) => {
      await expectScreen(page, `/sites?${query}`, 'Webサイト');

      await expect(page.getByText(siteName, { exact: true })).toBeVisible();
    });
  }

  test('#11 /sites?page=1e18 は 200 で空のページ（作ったサイトが見えない）', async ({ page }) => {
    await expectScreen(page, '/sites?page=1e18', 'Webサイト');

    await expect(page.getByText(siteName, { exact: true })).toHaveCount(0);
  });

  test('#11 /sites?page=1 では作ったサイトが見える（前提）', async ({ page }) => {
    await expectScreen(page, '/sites?page=1', 'Webサイト');

    await expect(page.getByText(siteName, { exact: true })).toBeVisible();
  });
});

test.describe('#12 /campaigns', () => {
  for (const value of THREE_VALUES) {
    test(`#12 /campaigns?page=${value} は 200 で見出しが出る`, async ({ page }) => {
      await expectScreen(page, `/campaigns?page=${value}`, 'キャンペーン');
    });
  }
});

test.describe('#13 /settings?tab=users', () => {
  for (const value of THREE_VALUES) {
    test(`#13 /settings?tab=users&page=${value} は 200 で見出しが出る`, async ({ page }) => {
      await expectScreen(page, `/settings?tab=users&page=${value}`, '設定');
    });
  }
});

test.describe('#14 /social/history', () => {
  for (const value of THREE_VALUES) {
    test(`#14 /social/history?page=${value} は 200 で見出しが出る`, async ({ page }) => {
      await expectScreen(page, `/social/history?page=${value}`, '配信履歴');
    });
  }
});

test.describe('#15 /social の postPage', () => {
  for (const value of THREE_VALUES) {
    test(`#15 /social?postPage=${value} は 200 で見出しが出る`, async ({ page }) => {
      await expectScreen(page, `/social?postPage=${value}`, 'SNS');
    });
  }
});

/**
 * #16。`/analytics` の表（ページ・参照元のタブ）。
 *
 * - `period=custom&from=今日&to=今日` は集計値を読む経路（`listAnalyticsBreakdown` が `OFFSET` を DB へ渡す）
 * - `period=today` はメモリ上で切る経路
 *
 * 既定の期間（`30d`）は末尾が昨日で、今日のヒットだけのサイトは表を読まないので使わない。
 * 準備は `analytics.spec.ts` の「rollup 後に tab=pages が HTTP 200」と同じ（関数は写す）。
 */
test.describe('#16 /analytics の表', () => {
  /**
   * サーバーが集計に使う境目での「今日」（`playwright.config.ts` の `TORIFUNE_TIMEZONE`）。
   * 実行マシンのローカル日付で作らない。
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

  /** 画面から公開キーを読む（API では返していない）。 */
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

  /** 今日の分を集計する。 */
  async function rollupToday(request: APIRequestContext): Promise<void> {
    const token = await csrf(request);
    const rollup = await request.post('/api/v1/analytics/rollup', {
      headers: headers(token),
      data: { from: today(), to: today(), csrfToken: token },
    });
    expect(rollup.status(), await rollup.text()).toBe(200);
  }

  let siteId: string | null = null;

  /** 今日のヒットを送って今日の分を集計したサイト。1 度だけ作る。 */
  async function rolledUpSite(page: Page, request: APIRequestContext): Promise<string> {
    if (siteId === null) {
      const id = await createSite(request, `analytics-page-param-${unique()}`);
      siteId = id;
      const publicKey = await publicKeyOf(page, id);
      await collectHits(request, publicKey, ['/', '/', '/pricing', '/about']);
      await rollupToday(request);
    }
    return siteId;
  }

  test.afterAll(async ({ playwright }) => {
    if (siteId === null) return;
    const request = await playwright.request.newContext({
      baseURL: origin,
      storageState: './e2e/.auth/admin.json',
    });
    try {
      await deleteSite(request, siteId);
    } finally {
      await request.dispose();
    }
  });

  test('#16 準備：今日の 1 ページ目の表に行が出る（前提）', async ({ page, request }) => {
    const id = await rolledUpSite(page, request);
    const url = `/analytics?siteId=${id}&period=custom&from=${today()}&to=${today()}&tab=pages`;

    await expectScreen(page, url, 'アナリティクス');
    await expect(page.getByRole('row', { name: /\/pricing/ })).toBeVisible();
  });

  for (const tab of ['pages', 'referrers'] as const) {
    for (const value of THREE_VALUES) {
      test(`#16 集計値の経路：period=custom（今日〜今日）&tab=${tab}&page=${value} は 200 で見出しが出る`, async ({
        page,
        request,
      }) => {
        const id = await rolledUpSite(page, request);
        const url = `/analytics?siteId=${id}&period=custom&from=${today()}&to=${today()}&tab=${tab}&page=${value}`;

        await expectScreen(page, url, 'アナリティクス');
      });
    }
  }

  for (const value of THREE_VALUES) {
    test(`#16 メモリ上の経路：period=today&tab=pages&page=${value} は 200 で見出しが出る`, async ({
      page,
      request,
    }) => {
      const id = await rolledUpSite(page, request);
      const url = `/analytics?siteId=${id}&period=today&tab=pages&page=${value}`;

      await expectScreen(page, url, 'アナリティクス');
    });
  }
});
