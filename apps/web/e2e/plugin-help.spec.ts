import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

/**
 * Plugin の手順書（ヘルプ）を画面で読む（041-plugin-help-docs 設計 §7・§8、受け入れ条件 #54〜#62）。
 *
 * 題材は `plugins/example-plugin` の見本の手順書 2 本（設計 §12.6）：
 *
 * | `id` | `title` |
 * | --- | --- |
 * | `usage` | サンプルSNS の資格情報の用意のしかた |
 * | `markdown` | 手順書で使える書き方（描かれないものの見本：画像・`<script>` を含む生の HTML・`javascript:` のリンク） |
 *
 * `example-plugin` の provider `example` は資格情報の項目を宣言しているので、`/social` のヘルプボタン（#61 / #62）が
 * SNS の配信 Plugin を有効にせずに走る（`037` #85 を保つ）。
 *
 * * `beforeAll` で `example-plugin` を導入・有効化する。#62 は `example` のアカウントを API で 1 件作る
 * * **`afterAll` で必ずアカウントを消し、Plugin を無効化・削除する**（後に走る `plugin-manager.spec.ts` ほかの前提を壊さない）
 * * `noopener` の新しいタブは `popup` が発火しないことがあるので、`context.waitForEvent('page')` で拾う（実装プラン §8 の 10）
 * * 幅の見方は `responsive.spec.ts` と同じ（`scrollWidth <= clientWidth + 1`）
 */

const origin = 'http://127.0.0.1:3000';

const PLUGIN_ID = 'example-plugin';
const PLUGIN_NAME = 'サンプルPlugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';

const USAGE = { id: 'usage', title: 'サンプルSNS の資格情報の用意のしかた' } as const;
const MARKDOWN = { id: 'markdown', title: '手順書で使える書き方' } as const;

const HELP_INDEX = `/plugins/${PLUGIN_ID}/help`;
const USAGE_PATH = `${HELP_INDEX}/${USAGE.id}`;
const MARKDOWN_PATH = `${HELP_INDEX}/${MARKDOWN.id}`;
const SETTINGS_PATH = `/plugins/${PLUGIN_ID}/settings`;

/* 設計 §7.7 の文言 */
const BUNDLED_NOTE =
  'この手順書は Plugin に同梱された文書です。外部サービスの画面の名前や手順は変わることがあります。';
const HELP_PREFIX = '手順書：';
const SET_CREDENTIAL = '資格情報を設定';
const ADD_TITLE = 'SNSアカウントを追加';

const NARROW = { width: 375, height: 720 };

/** この spec が作ったアカウント。`afterAll` で消す。 */
const createdAccountIds: string[] = [];

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

async function postJson(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown> = {},
): Promise<APIResponse> {
  const token = await csrf(request);
  return request.post(path, { headers: headers(token), data: { ...data, csrfToken: token } });
}

async function deleteJson(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown> = {},
): Promise<APIResponse> {
  const token = await csrf(request);
  return request.delete(path, { headers: headers(token), data: { ...data, csrfToken: token } });
}

async function adminContext(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: origin, storageState: ADMIN_STORAGE });
}

/** 導入済みか。**同じ版を導入し直すと 422 になる**ので、叩く前に見る。 */
async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/v1/plugins');
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { installed: { id: string }[] } };
  return body.data.installed.some((plugin) => plugin.id === PLUGIN_ID);
}

/** `example` のアカウントを API で作る（資格情報なし・未接続）。 */
async function createExampleAccount(request: APIRequestContext): Promise<string> {
  const displayName = `E2E 手順書 ${unique()}`;
  const response = await postJson(request, '/api/v1/social/accounts', {
    provider: 'example',
    displayName,
    handle: `@${unique()}`,
    status: 'disconnected',
  });
  expect(response.status(), await response.text()).toBe(201);
  createdAccountIds.push(((await response.json()) as { data: { id: string } }).data.id);
  return displayName;
}

/** `viewer` ロール（`social.read` を持ち `plugin.manage` を持たない）の利用者でログインした API の文脈。 */
async function viewerRequest(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  const loginId = `e2e_help_viewer_${unique()}`;
  const password = 'e2e help viewer correct horse battery staple';
  const created = await postJson(request, '/api/v1/users', {
    loginId,
    displayName: `E2E ${loginId}`,
    email: `${loginId}@example.com`,
    password,
    roles: ['viewer'],
  });
  expect(created.status(), await created.text()).toBe(201);

  const context = await playwright.request.newContext({ baseURL: origin });
  const login = await postJson(context, '/api/v1/auth/login', { loginId, password });
  expect(login.status(), await login.text()).toBe(200);
  return context;
}

/** ページ全体が横に伸びているか（`responsive.spec.ts` と同じ見方）。 */
async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

function main(page: Page): Locator {
  return page.locator('main');
}

/** `main` の中の `<a>` の `href` と文言（宣言の順を見るため）。 */
async function linksIn(scope: Locator): Promise<{ href: string; text: string }[]> {
  return scope.locator('a').evaluateAll((elements) =>
    elements.map((element) => ({
      href: element.getAttribute('href') ?? '',
      text: (element.textContent ?? '').trim(),
    })),
  );
}

/** 設定画面の「手順書」の Card（見出し「手順書」を持ついちばん内側の section）。 */
function helpCardOf(page: Page): Locator {
  return page
    .getByRole('heading', { name: '手順書', exact: true })
    .locator('xpath=ancestor::section[1]');
}

/** アカウント一覧の行（「資格情報を設定」を持つ行で絞る。`social-credentials.spec.ts` と同じ）。 */
function accountRow(page: Page, displayName: string): Locator {
  return page
    .getByRole('row')
    .filter({ hasText: displayName })
    .filter({ has: page.getByRole('button', { name: SET_CREDENTIAL }) });
}

test.beforeAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    if (!(await isInstalled(request))) {
      const installed = await postJson(request, '/api/v1/plugins', {
        pluginId: PLUGIN_ID,
        acknowledgedPermissions: true,
      });
      expect(installed.status(), await installed.text()).toBe(201);
    }

    const enabled = await postJson(request, `/api/v1/plugins/${PLUGIN_ID}/enable`);
    const body = (await enabled.json()) as { data?: { ok?: boolean; reason?: string } };
    expect(body.data?.reason ?? null).toBeNull();
    expect(body.data?.ok).toBe(true);
  } finally {
    await request.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    for (const accountId of createdAccountIds) {
      await deleteJson(request, `/api/v1/social/accounts/${accountId}`);
    }

    await postJson(request, `/api/v1/plugins/${PLUGIN_ID}/disable`);
    await deleteJson(request, `/api/v1/plugins/${PLUGIN_ID}`, {
      // ファイルは残す。リポジトリに置いてあるサンプルを消してはいけない。
      deleteData: true,
      deleteFiles: false,
      confirm: PLUGIN_ID,
    });
  } finally {
    await request.dispose();
  }
});

/* -------------------------------------------------------------------------- */
/* #54 /plugins の「設定」→ 設定画面 → 手順書                                     */
/* -------------------------------------------------------------------------- */

test.describe('#54 /plugins の「設定」から設定画面へ', () => {
  test('#54 example-plugin のカードの「設定」を押すと /plugins/example-plugin/settings へ移り、手順書の Card に 2 本のリンクと既存の設定のフォームがある', async ({
    page,
  }) => {
    await page.goto('/plugins');

    const installed = page.locator('section[aria-labelledby="installed-heading"]');
    const card = installed.locator('section').filter({ hasText: PLUGIN_NAME });
    await card.getByRole('link', { name: '設定', exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${SETTINGS_PATH}$`));
    await expect(page.getByRole('heading', { level: 1, name: PLUGIN_NAME })).toBeVisible();

    const helpCard = helpCardOf(page);
    await expect(helpCard.getByRole('link', { name: new RegExp(USAGE.title) })).toHaveAttribute(
      'href',
      USAGE_PATH,
    );
    await expect(helpCard.getByRole('link', { name: new RegExp(MARKDOWN.title) })).toHaveAttribute(
      'href',
      MARKDOWN_PATH,
    );
    expect(await helpCard.getByRole('link').count()).toBe(2);

    // 既存の設定のフォーム（`plugin-example.spec.ts` と同じ欄）。
    await expect(page.getByLabel('あいさつ')).toBeVisible();
  });

  test('#54 設定画面の応答は 200', async ({ page }) => {
    const response = await page.request.get(SETTINGS_PATH);

    expect(response.status()).toBe(200);
  });

  test('#54 カードの「設定」は /plugins/example-plugin を指さない', async ({ page }) => {
    await page.goto('/plugins');

    const installed = page.locator('section[aria-labelledby="installed-heading"]');
    const card = installed.locator('section').filter({ hasText: PLUGIN_NAME });
    await expect(card.getByRole('link', { name: '設定', exact: true })).toHaveAttribute(
      'href',
      SETTINGS_PATH,
    );
    expect(await card.locator(`a[href="/plugins/${PLUGIN_ID}"]`).count()).toBe(0);
  });

  test('#54 設定画面の手順書のリンクは新しいタブで開く（target="_blank" rel="noopener noreferrer"）', async ({
    page,
  }) => {
    await page.goto(SETTINGS_PATH);

    const helpCard = helpCardOf(page);
    for (const link of await helpCard.getByRole('link').all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #55 一覧 → 本文                                                              */
/* -------------------------------------------------------------------------- */

test.describe('#55 手順書の一覧から本文へ', () => {
  test('#55 一覧の h1 が「サンプルPlugin の手順書」で、宣言の順に 2 本の題名のリンクがある', async ({
    page,
  }) => {
    const response = await page.goto(HELP_INDEX);
    expect(response?.status()).toBe(200);

    await expect(
      page.getByRole('heading', { level: 1, name: `${PLUGIN_NAME} の手順書` }),
    ).toBeVisible();

    const docs = (await linksIn(main(page))).filter((link) =>
      link.href.startsWith(`${HELP_INDEX}/`),
    );
    expect(docs.map((link) => link.href)).toEqual([USAGE_PATH, MARKDOWN_PATH]);
    expect(docs[0]?.text).toContain(USAGE.title);
    expect(docs[1]?.text).toContain(MARKDOWN.title);
  });

  test('#55 1 本目を押すと /plugins/example-plugin/help/usage へ移り、h1 がその題名、同梱の注記が出る', async ({
    page,
  }) => {
    await page.goto(HELP_INDEX);

    await main(page).getByRole('link', { name: USAGE.title }).click();

    await expect(page).toHaveURL(new RegExp(`${USAGE_PATH}$`));
    await expect(page.getByRole('heading', { level: 1, name: USAGE.title })).toBeVisible();
    await expect(page.getByText(BUNDLED_NOTE)).toBeVisible();
  });

  test('#55 管理者（plugin.manage）にはパンくずの「プラグイン」が /plugins へのリンク', async ({
    page,
  }) => {
    await page.goto(USAGE_PATH);

    await expect(main(page).getByRole('link', { name: 'プラグイン', exact: true })).toHaveAttribute(
      'href',
      '/plugins',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #56 / #57 権限                                                               */
/* -------------------------------------------------------------------------- */

test.describe('#56 plugin.manage を持たない利用者も、読み込まれた Plugin の手順書を読める', () => {
  test('#56 social.read だけの利用者（viewer）が本文を開くと 200 で本文が出て、パンくずの「プラグイン」はリンクでない', async ({
    browser,
    request,
    playwright,
  }) => {
    const viewer = await viewerRequest(request, playwright);
    const context = await browser.newContext({
      baseURL: origin,
      storageState: await viewer.storageState(),
    });
    await viewer.dispose();

    try {
      const page = await context.newPage();
      const response = await page.goto(USAGE_PATH);

      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${USAGE_PATH}$`));
      await expect(page.getByRole('heading', { level: 1, name: USAGE.title })).toBeVisible();
      await expect(page.getByText(BUNDLED_NOTE)).toBeVisible();

      await expect(main(page).getByText('プラグイン', { exact: true })).toBeVisible();
      expect(await main(page).getByRole('link', { name: 'プラグイン', exact: true }).count()).toBe(
        0,
      );
    } finally {
      await context.close();
    }
  });
});

test.describe('#57 未認証', () => {
  test('#57 未認証で /plugins/example-plugin/help/usage を開くとログイン画面へ移る', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto(USAGE_PATH);

    await expect(page).toHaveURL(/\/login/);
  });

  test('#57 未認証で一覧を開いてもログイン画面へ移る', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(HELP_INDEX);

    await expect(page).toHaveURL(/\/login/);
  });
});

/* -------------------------------------------------------------------------- */
/* #58 404                                                                     */
/* -------------------------------------------------------------------------- */

test.describe('#58 宣言に無い手順書・無い Plugin は 404', () => {
  for (const path of [
    `${HELP_INDEX}/nope`,
    '/plugins/nonexistent/help',
    '/plugins/nonexistent/help/usage',
  ]) {
    test(`#58 ${path} → 404`, async ({ page }) => {
      const response = await page.goto(path);

      expect(response?.status()).toBe(404);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* #59 見本の手順書（描かれないもの・リンク）                                        */
/* -------------------------------------------------------------------------- */

test.describe('#59 見本の手順書（markdown）の描き方', () => {
  test('#59 main の中に img 要素が 0 個で、「［画像：」が有る', async ({ page }) => {
    await page.goto(MARKDOWN_PATH);
    await expect(page.getByRole('heading', { level: 1, name: MARKDOWN.title })).toBeVisible();

    expect(await main(page).locator('img').count()).toBe(0);
    await expect(main(page)).toContainText('［画像：');
  });

  test('#59 生の <script> を含む本文を開いても dialog が一度も発火しない', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });

    await page.goto(MARKDOWN_PATH);
    await expect(page.getByRole('heading', { level: 1, name: MARKDOWN.title })).toBeVisible();
    await page.waitForLoadState('load');

    expect(dialogs).toBe(0);
    // 生の HTML はエスケープされた文字として見える（消さない。設計 §7.3.2）。
    await expect(main(page)).toContainText('<script');
    expect(await main(page).locator('script').count()).toBe(0);
  });

  test('#59 外部リンクは target="_blank" と rel="noopener noreferrer" を持つ', async ({ page }) => {
    await page.goto(MARKDOWN_PATH);

    const external = main(page).locator('a[href^="http:"], a[href^="https:"]');
    expect(await external.count()).toBeGreaterThan(0);
    for (const link of await external.all()) {
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  test('#59 javascript: のリンクは a 要素にならない（文言だけが残る）', async ({ page }) => {
    await page.goto(MARKDOWN_PATH);

    // どの <a> の href にも javascript: が無い
    const hrefs = (await linksIn(page.locator('body'))).map((link) => link.href.toLowerCase());
    expect(hrefs.filter((href) => href.replace(/\s/g, '').includes('javascript:'))).toEqual([]);

    // 見本のリンク「押す」（設計 §10.4 #25・実装プラン T19）は文字だけで、a の中に無い
    const words = main(page).getByText('押す', { exact: true });
    expect(await words.count()).toBeGreaterThan(0);
    for (const word of await words.all()) {
      expect(await word.evaluate((element) => element.closest('a') === null)).toBe(true);
    }
  });

  test('#59 相対リンク（./usage.md）は target を持たず、押すと同じタブで /plugins/example-plugin/help/usage へ移る', async ({
    page,
  }) => {
    await page.goto(MARKDOWN_PATH);

    // 「この Plugin の手順書」の一覧のリンクと、本文の相対リンクの 2 つ以上がある。本文は一覧より後ろ。
    const toUsage = main(page).locator(`a[href="${USAGE_PATH}"]`);
    expect(await toUsage.count()).toBeGreaterThanOrEqual(2);
    for (const link of await toUsage.all()) {
      expect(await link.getAttribute('target')).toBeNull();
    }

    const pagesBefore = page.context().pages().length;
    await toUsage.last().click();

    await expect(page).toHaveURL(new RegExp(`${USAGE_PATH}$`));
    await expect(page.getByRole('heading', { level: 1, name: USAGE.title })).toBeVisible();
    expect(page.context().pages().length).toBe(pagesBefore);
  });

  test('#59 目次（#…）のリンクを押すと URL の断片が #help-… になり、その見出しが見える', async ({
    page,
  }) => {
    await page.goto(MARKDOWN_PATH);

    const toc = main(page).locator('a[href^="#"]').first();
    await expect(toc).toBeVisible();
    const href = (await toc.getAttribute('href')) ?? '';
    expect(decodeURIComponent(href).startsWith('#help-')).toBe(true);

    await toc.click();

    await expect
      .poll(() => decodeURIComponent(new URL(page.url()).hash))
      .toBe(decodeURIComponent(href));
    const id = decodeURIComponent(href).slice(1);
    const target = page.locator(`[id="${id}"]`);
    await expect(target).toBeInViewport();
    expect(await target.evaluate((element) => /^H[2-6]$/.test(element.tagName))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #60 レスポンシブ                                                             */
/* -------------------------------------------------------------------------- */

test.describe('#60 幅 375px', () => {
  test.use({ viewport: NARROW });

  test('#60 /plugins/example-plugin/help/markdown のページ全体が横に動かない', async ({ page }) => {
    await page.goto(MARKDOWN_PATH);
    await expect(page.getByRole('heading', { level: 1, name: MARKDOWN.title })).toBeVisible();

    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#60 表とコードは枠の中で横に動く（中身が枠より広く、ページは広がらない）', async ({
    page,
  }) => {
    await page.goto(MARKDOWN_PATH);
    await expect(page.getByRole('heading', { level: 1, name: MARKDOWN.title })).toBeVisible();

    // 見本は狭い画面ではみ出す幅の表と長い 1 行のコードを持つ（実装プラン T19）。
    const scrollsInside = async (selector: string): Promise<boolean> =>
      main(page)
        .locator(selector)
        .evaluateAll((elements) =>
          elements.some((element) => element.scrollWidth > element.clientWidth + 1),
        );

    expect(await scrollsInside('pre')).toBe(true);
    expect(
      await main(page)
        .locator('table')
        .evaluateAll((tables) =>
          tables.some((table) => {
            const box = table.parentElement;
            return box !== null && box.scrollWidth > box.clientWidth + 1;
          }),
        ),
    ).toBe(true);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #61 / #62 /social のヘルプボタン                                               */
/* -------------------------------------------------------------------------- */

test.describe('#61 アカウント追加の Modal のヘルプボタン', () => {
  test('#61 サービスに example を選ぶとヘルプボタンが見え、押すと新しいページで手順書が開き、元の Modal と入力が残る', async ({
    page,
  }) => {
    await page.goto('/social');
    await page.getByRole('button', { name: '+ アカウントを追加' }).click();

    const dialog = page.getByRole('dialog', { name: ADD_TITLE });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('サービス').selectOption({ label: 'サンプルSNS' });

    const help = dialog.getByRole('link', { name: new RegExp(HELP_PREFIX) });
    await expect(help).toBeVisible();
    await expect(help).toHaveAttribute('href', USAGE_PATH);
    await expect(help).toHaveAttribute('target', '_blank');
    await expect(help).toHaveAttribute('rel', 'noopener noreferrer');

    const displayName = `E2E 入力中 ${unique()}`;
    await dialog.getByLabel('表示名').fill(displayName);

    const opened = page.context().waitForEvent('page');
    await help.click();
    const child = await opened;
    await child.waitForLoadState('domcontentloaded');

    expect(new URL(child.url()).pathname).toBe(USAGE_PATH);
    await expect(child.getByRole('heading', { level: 1, name: USAGE.title })).toBeVisible();
    await child.close();

    // 元のページ：Modal は開いたまま、表示名の入力が残っている
    await expect(page).toHaveURL(/\/social/);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('表示名')).toHaveValue(displayName);
  });
});

test.describe('#62 「資格情報を設定」の Modal のヘルプボタン', () => {
  test('#62 既存のアカウントの「資格情報を設定」の Modal にもヘルプボタンがあり、同じ URL を新しいタブで開く', async ({
    page,
    request,
  }) => {
    const displayName = await createExampleAccount(request);

    await page.goto('/social');
    await accountRow(page, displayName).getByRole('button', { name: SET_CREDENTIAL }).click();

    const dialog = page.getByRole('dialog', { name: SET_CREDENTIAL });
    await expect(dialog).toBeVisible();

    const help = dialog.getByRole('link', { name: new RegExp(HELP_PREFIX) });
    await expect(help).toBeVisible();
    await expect(help).toHaveAttribute('href', USAGE_PATH);
    await expect(help).toHaveAttribute('target', '_blank');
    await expect(help).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
