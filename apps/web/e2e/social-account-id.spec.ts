import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

/**
 * SNS アカウントの ID を一覧に出してコピーする（051-social-account-id-display 設計 §7・§8、
 * 受け入れ条件 #20〜#30）。
 *
 * * アカウントは件ごとに API（管理者）で作る。provider `x`・資格情報なし・`status: 'disconnected'`、
 *   表示名に `unique()` を含める。provider `x` のサービスの表示名は `X`（E2E は X の配信 Plugin を導入しない）
 * * 行は「表示名を含み、ID の要素（`[data-account-id]`）を持つ行」で絞る。閲覧者の画面には
 *   「資格情報を設定」が無いので、`social-credentials.spec.ts` の `accountRow` の絞り方は使わない
 * * 「コピー」は `aria-label`（`「<表示名>（X）」のアカウントIDをコピー`）で `exact: true` で探す
 * * クリップボードを読む件は `clipboard-read` / `clipboard-write` を与えた context で
 *   `navigator.clipboard.readText()` を読む。既定の `baseURL`（`http://127.0.0.1:<port>`）は安全な
 *   コンテキスト。`TORIFUNE_E2E_BASE_URL` で安全でない URL を渡したときだけ、理由を付けて飛ばす（設計 §10.4）
 * * このファイルは `social-approval.spec.ts` などより**前に**走る（ファイル名の順に直列）。
 *   **作ったアカウント・利用者は `afterAll` で必ず消す**。Plugin は導入しない
 *
 * 補助の関数は `social-credentials.spec.ts`（`unique`・`csrf`・`postJson`・`deleteJson`）、
 * `social-approval.spec.ts`（`viewerBrowserContext`）、`responsive.spec.ts`（`NARROW`・
 * `hasHorizontalOverflow`）を写す（spec を import しない）。
 */

const BASE_URL =
  process.env['TORIFUNE_E2E_BASE_URL'] ?? `http://127.0.0.1:${process.env['PORT'] ?? 3000}`;
const origin = new URL(BASE_URL).origin;
const ADMIN_STORAGE = './e2e/.auth/admin.json';
const NARROW = { width: 375, height: 720 };

const CLIPBOARD_PERMISSIONS = ['clipboard-read', 'clipboard-write'];

/** 設計 §7.6 の文言。 */
const COPIED = 'アカウントIDをコピーしました。';
const COPY_FAILED = 'コピーできませんでした。アカウントIDを選択して写してください。';
const FORBIDDEN = 'この操作を行う権限がありません';

/** この spec が作ったもの。`afterAll` で消す（アカウントを消すと投稿も一緒に消える）。 */
const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

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

/** `afterAll` はテスト用の fixture を使えないので、自分で作る。 */
async function adminContext(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: origin, storageState: ADMIN_STORAGE });
}

interface Account {
  readonly id: string;
  readonly displayName: string;
}

/** API（管理者）でアカウントを作る。資格情報なし・未接続。 */
async function createAccount(request: APIRequestContext): Promise<Account> {
  const displayName = `E2E アカウントID ${unique()}`;
  const response = await postJson(request, '/api/v1/social/accounts', {
    provider: 'x',
    displayName,
    handle: `@${unique()}`,
    status: 'disconnected',
  });
  expect(response.status(), await response.text()).toBe(201);

  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdAccountIds.push(id);
  return { id, displayName };
}

/** 利用者を作り、その利用者でログインした画面のコンテキストを返す（`roles` を引数にする）。 */
async function userBrowserContext(
  request: APIRequestContext,
  browser: Browser,
  roles: readonly string[],
): Promise<BrowserContext> {
  const loginId = `e2e_accid_${roles.length === 0 ? 'norole' : roles.join('_')}_${unique()}`;
  const password = 'e2e account id user correct horse battery staple';
  const created = await postJson(request, '/api/v1/users', {
    loginId,
    displayName: `E2E ${loginId}`,
    email: `${loginId}@example.com`,
    password,
    roles: [...roles],
  });
  expect(created.status(), await created.text()).toBe(201);
  createdUserIds.push(((await created.json()) as { data: { id: string } }).data.id);

  const context = await browser.newContext({ baseURL: origin });
  const loginToken = await csrf(context.request);
  const login = await context.request.post('/api/v1/auth/login', {
    headers: headers(loginToken),
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(login.status(), await login.text()).toBe(200);
  return context;
}

/** アカウント一覧の行（表示名を含み、ID の要素を持つ行）。 */
function accountRow(page: Page, displayName: string): Locator {
  return page
    .getByRole('row')
    .filter({ hasText: displayName })
    .filter({ has: page.locator('[data-account-id]') });
}

function idElement(row: Locator): Locator {
  return row.locator('code[data-account-id]');
}

function copyButton(row: Locator, displayName: string): Locator {
  return row.getByRole('button', {
    name: `「${displayName}（X）」のアカウントIDをコピー`,
    exact: true,
  });
}

/** 文言で絞った通知（ページに他の `status` があっても取り違えない）。 */
function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

/** クリップボードを読む件の前提。安全なコンテキストでなければ理由を付けて飛ばす（設計 §10.4）。 */
async function requireSecureContext(page: Page): Promise<void> {
  const secure = await page.evaluate(() => window.isSecureContext);
  test.skip(
    !secure,
    `${origin} は安全なコンテキストではない（window.isSecureContext が false）ため、クリップボードを読めない`,
  );
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** ページ全体が横に伸びているか（`responsive.spec.ts` と同じ判定）。 */
async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px の丸め誤差は許す。
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.afterAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    for (const id of createdAccountIds) {
      await deleteJson(request, `/api/v1/social/accounts/${id}`);
    }
    for (const id of createdUserIds) {
      await deleteJson(request, `/api/v1/users/${id}`);
    }
  } finally {
    await request.dispose();
  }
});

/* -------------------------------------------------------------------------- */
/* 管理者（#20〜#24・#28）                                                      */
/* -------------------------------------------------------------------------- */

test.describe('管理者', () => {
  test('#20 行の ID の要素のテキストが、作成の応答の id と GET /social/accounts/{id} の id に一致する', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);

    const fetched = await request.get(`/api/v1/social/accounts/${account.id}`);
    expect(fetched.status(), await fetched.text()).toBe(200);
    const fetchedId = ((await fetched.json()) as { data: { id: string } }).data.id;

    await page.goto('/social');
    const element = idElement(accountRow(page, account.displayName));
    await expect(element).toHaveCount(1);

    const text = await element.textContent();
    expect(text).toBe(account.id);
    expect(text).toBe(fetchedId);
    expect(await element.getAttribute('data-account-id')).toBe(account.id);
  });

  test('#21 「コピー」を押すとクリップボードの文字列がその id と完全に一致し、成功の通知が出る', async ({
    page,
    context,
    request,
  }) => {
    const account = await createAccount(request);
    await context.grantPermissions(CLIPBOARD_PERMISSIONS, { origin });

    await page.goto('/social');
    await requireSecureContext(page);

    await copyButton(accountRow(page, account.displayName), account.displayName).click();
    await expect(toast(page, COPIED)).toBeVisible();

    const copied = await readClipboard(page);
    expect(copied).toBe(account.id);
    expect(copied).toHaveLength(36);
    expect(copied).toBe(copied.trim());
  });

  test('#22 画面で写した値を socialAccountId にした POST /social/posts（draft）が 201 で、応答の socialAccountId が一致する', async ({
    page,
    context,
    request,
  }) => {
    const account = await createAccount(request);
    await context.grantPermissions(CLIPBOARD_PERMISSIONS, { origin });

    await page.goto('/social');
    await requireSecureContext(page);

    await copyButton(accountRow(page, account.displayName), account.displayName).click();
    await expect(toast(page, COPIED)).toBeVisible();
    const copied = await readClipboard(page);

    const created = await postJson(request, '/api/v1/social/posts', {
      socialAccountId: copied,
      body: `E2E アカウントID の投稿 ${unique()}`,
      status: 'draft',
    });
    expect(created.status(), await created.text()).toBe(201);
    const post = ((await created.json()) as { data: { socialAccountId: string } }).data;
    expect(post.socialAccountId).toBe(copied);
  });

  test('#23 アカウント A・B があるとき、B の行の「コピー」を押すとクリップボードは B の id', async ({
    page,
    context,
    request,
  }) => {
    const a = await createAccount(request);
    const b = await createAccount(request);
    await context.grantPermissions(CLIPBOARD_PERMISSIONS, { origin });

    await page.goto('/social');
    await requireSecureContext(page);

    await copyButton(accountRow(page, b.displayName), b.displayName).click();
    await expect(toast(page, COPIED)).toBeVisible();

    const copied = await readClipboard(page);
    expect(copied).toBe(b.id);
    expect(copied).not.toBe(a.id);
  });

  test('#24 画面で追加した行に、再読み込みせずに ID の要素が出て、GET の同じ表示名の行の id と一致する', async ({
    page,
  }) => {
    const displayName = `E2E アカウントID 画面から ${unique()}`;

    await page.goto('/social');
    // 読み込み直すと消える印。追加の後に残っていれば、ページは読み込み直されていない。
    await page.evaluate(() => {
      (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload = true;
    });

    await page.getByRole('button', { name: '+ アカウントを追加' }).click();
    const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await dialog.getByLabel('サービス').selectOption('x');
    await dialog.getByLabel('表示名').fill(displayName);
    await dialog.getByLabel('ハンドル').fill(`@${unique()}`);
    await dialog.getByLabel('資格情報（アクセストークン等）').fill(`e2e-credential-${unique()}`);
    await dialog.getByRole('button', { name: '追加' }).click();

    const element = idElement(accountRow(page, displayName));
    await expect(element).toHaveCount(1);
    const shown = await element.textContent();

    // 後始末のために ID を控える（比べる前に控え、失敗しても消せるようにする）。
    const list = await page.request.get('/api/v1/social/accounts?perPage=100');
    expect(list.status(), await list.text()).toBe(200);
    const accounts = ((await list.json()) as { data: { id: string; displayName: string }[] }).data;
    const created = accounts.find((account) => account.displayName === displayName);
    expect(created, '画面から作ったアカウントが一覧に無い').toBeDefined();
    createdAccountIds.push(created?.id ?? '');

    expect(shown).toBe(created?.id);
    expect(
      await page.evaluate(
        () => (window as unknown as { __e2eNoReload?: boolean }).__e2eNoReload === true,
      ),
    ).toBe(true);
  });

  test('#28 「コピー」を押しても /api/ への要求が出ない', async ({ page, context, request }) => {
    const account = await createAccount(request);
    await context.grantPermissions(CLIPBOARD_PERMISSIONS, { origin });

    await page.goto('/social');
    const button = copyButton(accountRow(page, account.displayName), account.displayName);
    await expect(button).toBeVisible();

    let apiRequests = 0;
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname.startsWith('/api/')) apiRequests += 1;
    });
    const before = apiRequests;

    await button.click();
    // 結果の通知が出るのを待ってから数える（固定の待ち時間を置かない。実装プラン §8 の 7）。
    await expect(toast(page, new RegExp(`${COPIED}|${COPY_FAILED}`))).toBeVisible();

    expect(apiRequests).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* 閲覧者（#25）                                                                */
/* -------------------------------------------------------------------------- */

test.describe('閲覧者', () => {
  test('#25 social.read だけの閲覧者：行に ID の要素と「コピー」があり写せる。「資格情報を設定」「削除」「+ アカウントを追加」は無い', async ({
    request,
    browser,
  }) => {
    const account = await createAccount(request);
    const context = await userBrowserContext(request, browser, ['viewer']);
    try {
      await context.grantPermissions(CLIPBOARD_PERMISSIONS, { origin });
      const page = await context.newPage();
      await page.goto('/social');

      const row = accountRow(page, account.displayName);
      await expect(idElement(row)).toHaveCount(1);
      expect(await idElement(row).textContent()).toBe(account.id);
      await expect(copyButton(row, account.displayName)).toBeVisible();

      await expect(row.getByRole('button', { name: '資格情報を設定' })).toHaveCount(0);
      await expect(row.getByRole('button', { name: '削除', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '+ アカウントを追加' })).toHaveCount(0);

      await requireSecureContext(page);
      await copyButton(row, account.displayName).click();
      await expect(toast(page, COPIED)).toBeVisible();
      expect(await readClipboard(page)).toBe(account.id);
    } finally {
      await context.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 狭い画面（#26）                                                              */
/* -------------------------------------------------------------------------- */

test.describe('狭い画面', () => {
  test.use({ viewport: NARROW });

  test('#26 幅 375px：/social がページ全体で横スクロールせず、行の「コピー」を押すとクリップボードがその id', async ({
    page,
    context,
    request,
  }) => {
    const account = await createAccount(request);
    await context.grantPermissions(CLIPBOARD_PERMISSIONS, { origin });

    await page.goto('/social');
    const row = accountRow(page, account.displayName);
    await expect(idElement(row)).toHaveCount(1);

    expect(await hasHorizontalOverflow(page)).toBe(false);

    await requireSecureContext(page);
    // 表の中のスクロールを経て押す（click はボタンを見える位置まで送る）。
    await copyButton(row, account.displayName).click();
    await expect(toast(page, COPIED)).toBeVisible();
    expect(await readClipboard(page)).toBe(account.id);

    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* クリップボードが使えないとき（#27）                                           */
/* -------------------------------------------------------------------------- */

test.describe('クリップボードが使えないとき', () => {
  test('#27 「コピー」を押すと失敗の通知が出て、ID の要素を 1 回クリックすると選択がその id になる', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    // http で開いた画面と同じく、navigator.clipboard を undefined にする。権限は与えない。
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        get: () => undefined,
        configurable: true,
      });
    });

    await page.goto('/social');
    expect(await page.evaluate(() => navigator.clipboard === undefined)).toBe(true);

    const row = accountRow(page, account.displayName);
    await copyButton(row, account.displayName).click();
    await expect(toast(page, COPY_FAILED)).toBeVisible();

    const element = idElement(row);
    await expect(element).toBeVisible();
    await element.click();

    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(account.id);
  });
});

/* -------------------------------------------------------------------------- */
/* 見えない利用者（#29・#30）                                                   */
/* -------------------------------------------------------------------------- */

test.describe('見えない利用者', () => {
  test('#29 ロールを持たない利用者（social.read なし）の /social は権限なしの表示で、id が HTML に現れない', async ({
    request,
    browser,
  }) => {
    const account = await createAccount(request);
    const context = await userBrowserContext(request, browser, []);
    try {
      const page = await context.newPage();
      await page.goto('/social');

      await expect(page.getByText(FORBIDDEN)).toBeVisible();
      await expect(page.locator('[data-account-id]')).toHaveCount(0);
      expect(await page.content()).not.toContain(account.id);
    } finally {
      await context.close();
    }
  });

  test('#30 未認証で /social を開くと /login へ移り、id が HTML に現れない', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);

    await page.context().clearCookies();
    // 未認証になっていることを先に確かめる。ここが空でないとリダイレクトの検査が意味を失う。
    expect(await page.context().cookies()).toEqual([]);

    await page.goto('/social');

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByLabel('ログインID')).toBeVisible();
    expect(await page.content()).not.toContain(account.id);
  });
});
