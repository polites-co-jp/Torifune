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
 * SNS 投稿の承認待ちの画面（048-social-post-approval 設計 §7、受け入れ条件 #72〜#77）。
 *
 * 画面は `plugins/example-plugin`（`publish()` と `manual()` の両方を持つ）を題材に走らせる。
 * 承認待ちの投稿は、外部アプリの形（Scope `social.read` + `social.write` の API トークン）で
 * `publishTiming: 'after_approval'` を送って作る。`beforeAll` / `afterAll` は `social-publishing.spec.ts` を写す。
 *
 * **このファイルは `social-credentials.spec.ts`・`social-publishing.spec.ts`・`social.spec.ts` より先に走る**
 * （ファイル名の順に直列）。Plugin と承認待ちの投稿を残すと、後の spec の前提（Plugin の無い状態、
 * 承認待ち 0 件で区画が描かれない）を壊すので、**投稿は件ごとに、Plugin・アカウント・トークン・利用者は
 * `afterAll` で必ず片付ける**（実装プラン §7 の 12）。
 */

const origin = 'http://127.0.0.1:3000';
const PLUGIN_ID = 'example-plugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';
const NARROW = { width: 375, height: 720 };

/** この spec が作ったもの。`afterAll` で消す。 */
const createdAccountIds: string[] = [];
const createdTokenIds: string[] = [];
const createdUserIds: string[] = [];
/** 件ごとに作った投稿。`afterEach` で消す（承認待ちを次の件へ残さない）。 */
let createdPostIds: string[] = [];

/** `beforeAll` で作る共有の前提。 */
let accountId = '';
/** Bearer の API トークン（Scope `social.read` + `social.write`）で叩く要求。外部アプリの役。 */
let appRequest: APIRequestContext | undefined;

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

async function adminContext(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: origin, storageState: ADMIN_STORAGE });
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

function app(): APIRequestContext {
  if (appRequest === undefined) throw new Error('API トークンの要求がまだ無い');
  return appRequest;
}

interface Post {
  readonly id: string;
  readonly body: string;
}

/** 外部アプリとして承認待ちの投稿を登録する（`publishTiming: 'after_approval'`）。 */
async function requestApproval(overrides: Record<string, unknown> = {}): Promise<Post> {
  const body = String(overrides['body'] ?? `E2E承認待ち${unique()}`);
  const response = await app().post('/api/v1/social/posts', {
    data: {
      socialAccountId: accountId,
      publishTiming: 'after_approval',
      ...overrides,
      body,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const data = ((await response.json()) as { data: { id: string; status: string } }).data;
  expect(data.status).toBe('awaiting_approval');
  createdPostIds.push(data.id);
  return { id: data.id, body };
}

async function fetchStatus(request: APIRequestContext, id: string): Promise<string> {
  const response = await request.get(`/api/v1/social/posts/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: { status: string } }).data.status;
}

/** 「承認待ち」区画（`#approval-pending`）。投稿一覧にも同じ本文が出るので、区画で絞る。 */
function approvalSection(page: Page): Locator {
  return page.locator('#approval-pending');
}

/** 投稿一覧の行（操作列の「編集」を持つ行。区画にも同じ本文が出るので絞る）。 */
function postListRow(page: Page, body: string): Locator {
  return page.getByRole('row').filter({ hasText: body }).filter({ hasText: '編集' });
}

function approveDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: '投稿を承認する' });
}

/** 区画の「承認する…」を押してダイアログを開く。 */
async function openApproveDialog(page: Page): Promise<Locator> {
  await approvalSection(page)
    .getByRole('button', { name: /^承認する/ })
    .click();
  const dialog = approveDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px の丸め誤差は許す。
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

/** 閲覧者を作り、その閲覧者でログインした画面のコンテキストを返す。 */
async function viewerBrowserContext(
  request: APIRequestContext,
  browser: Browser,
): Promise<BrowserContext> {
  const loginId = `e2e_apr_viewer_${unique()}`;
  const password = 'e2e approval viewer correct horse battery staple';
  const created = await postJson(request, '/api/v1/users', {
    loginId,
    displayName: `E2E ${loginId}`,
    email: `${loginId}@example.com`,
    password,
    roles: ['viewer'],
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

/** 導入済みか。**同じ版を導入し直すと 422 になる**ので、叩く前に見る。 */
async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/v1/plugins');
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { installed: { id: string }[] } };
  return body.data.installed.some((plugin) => plugin.id === PLUGIN_ID);
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
    const enabledBody = (await enabled.json()) as { data?: { ok?: boolean; reason?: string } };
    expect(enabledBody.data?.reason ?? null).toBeNull();
    expect(enabledBody.data?.ok).toBe(true);

    // provider `example` のアカウント（資格情報は publisher の宣言どおり 2 項目）。
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'example',
      displayName: `E2E 承認 ${unique()}`,
      handle: `@${unique()}`,
      credentials: { handle: `sample_${unique()}`, appPassword: `pw_${unique()}` },
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    // 外部アプリに渡すトークン（Scope に social.approve を含めない。設計 §8.2）。
    const issued = await postJson(request, '/api/v1/api-tokens', {
      name: `e2e approval ${unique()}`,
      scopes: ['social.read', 'social.write'],
    });
    expect(issued.status(), await issued.text()).toBe(201);
    const token = (await issued.json()) as { data: { token: string; id: string } };
    createdTokenIds.push(token.data.id);
    appRequest = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Authorization: `Bearer ${token.data.token}` },
    });
  } finally {
    await request.dispose();
  }
});

test.afterEach(async ({ request }) => {
  for (const id of createdPostIds) {
    await deleteJson(request, `/api/v1/social/posts/${id}`);
  }
  createdPostIds = [];
});

test.afterAll(async ({ playwright }) => {
  await appRequest?.dispose();
  const request = await adminContext(playwright);
  try {
    // アカウントを消すと、その投稿も一緒に消える。
    for (const id of createdAccountIds) {
      await deleteJson(request, `/api/v1/social/accounts/${id}`);
    }
    for (const id of createdTokenIds) {
      await deleteJson(request, `/api/v1/api-tokens/${id}`);
    }
    for (const id of createdUserIds) {
      await deleteJson(request, `/api/v1/users/${id}`);
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

/** #72。承認待ちの区画 → 即投稿で承認 → 予約済み → 配信で配信済み。 */
test.describe('#72 承認して配信に回す', () => {
  test('#72 区画に出て、即投稿で承認すると区画から消え「予約済み」、配信の後に「配信済み」', async ({
    page,
    request,
  }) => {
    const post = await requestApproval();

    await page.goto('/social');
    const section = approvalSection(page);
    await expect(section.getByRole('heading', { name: /承認待ち（\s*1\s*件）/ })).toBeVisible();
    await expect(section).toContainText(post.body);

    const dialog = await openApproveDialog(page);
    await dialog.getByLabel(/即投稿/).check();
    await dialog.getByRole('button', { name: '承認する', exact: true }).click();

    await expect(approvalSection(page)).toHaveCount(0);
    await expect(postListRow(page, post.body)).toContainText('予約済み');
    expect(await fetchStatus(request, post.id)).toBe('scheduled');

    const published = await postJson(request, '/api/v1/social/publish');
    expect(published.status(), await published.text()).toBe(200);

    await page.reload();
    await expect(postListRow(page, post.body)).toContainText('配信済み');
  });
});

/** #73。差し戻すと下書きに戻る。 */
test.describe('#73 差し戻す', () => {
  test('#73 「差し戻す」→ 確認 → 区画から消え、投稿一覧の状態が「下書き」', async ({
    page,
    request,
  }) => {
    const post = await requestApproval();

    await page.goto('/social');
    await approvalSection(page).getByRole('button', { name: '差し戻す' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: '下書きに戻します。' });
    await expect(confirm).toContainText('承認の依頼は取り下げられます。');
    await confirm.getByRole('button', { name: '差し戻す' }).click();

    await expect(approvalSection(page)).toHaveCount(0);
    await expect(postListRow(page, post.body)).toContainText('下書き');
    expect(await fetchStatus(request, post.id)).toBe('draft');
  });
});

/** #74。閲覧者は区画を見られるが、承認・差し戻しはできない（表示制御。認可は UseCase）。 */
test.describe('#74 閲覧者', () => {
  test('#74 閲覧者には区画が見えるが「承認する」「差し戻す」が無い', async ({
    request,
    browser,
  }) => {
    const post = await requestApproval();
    const context = await viewerBrowserContext(request, browser);
    try {
      const page = await context.newPage();
      await page.goto('/social');

      const section = approvalSection(page);
      await expect(section).toContainText(post.body);
      await expect(section.getByRole('button', { name: /^承認する/ })).toHaveCount(0);
      await expect(section.getByRole('button', { name: '差し戻す' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

/** #75。画面を開いた後に書き換えられた投稿は、見た内容として承認できない（409）。 */
test.describe('#75 見た後に書き換えられた投稿の承認', () => {
  test('#75 ダイアログに「投稿の内容が変わっています」が出て、読み込み直すと新しい本文が出る', async ({
    page,
  }) => {
    const post = await requestApproval();
    const rewritten = `E2E書き換え後${unique()}`;

    await page.goto('/social');
    await expect(approvalSection(page)).toContainText(post.body);

    // 画面を開いた後に、外部アプリが本文を書き換える。
    const patched = await app().patch(`/api/v1/social/posts/${post.id}`, {
      data: { body: rewritten },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    const dialog = await openApproveDialog(page);
    await dialog.getByLabel(/即投稿/).check();
    await dialog.getByRole('button', { name: '承認する', exact: true }).click();

    await expect(dialog).toContainText('投稿の内容が変わっています');
    await dialog.getByRole('button', { name: '閉じて読み込み直す' }).click();

    await expect(approvalSection(page)).toContainText(rewritten);
    expect(await fetchStatus(app(), post.id)).toBe('awaiting_approval');
  });
});

/** #76。幅 375px でも崩れない。 */
test.describe('#76 狭い画面', () => {
  test.use({ viewport: NARROW });

  test('#76 承認待ちがある /social がページ全体で横スクロールせず、承認のダイアログが画面幅に収まる', async ({
    page,
  }) => {
    await requestApproval({
      // 本文は example-plugin の上限（100 文字）に収める。長い URL はリンクと画像で作る。
      body: `E2E狭い画面${unique()}${'x'.repeat(60)}`,
      link: `https://example.com/${'b'.repeat(200)}`,
      media: [{ url: `https://cdn.example.com/${'c'.repeat(200)}.jpg`, alt: '長い URL の画像' }],
    });

    await page.goto('/social');
    await expect(approvalSection(page)).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    const dialog = await openApproveDialog(page);
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(NARROW.width + 1);
    }
  });
});

/** #77。ダッシュボードの案内。 */
test.describe('#77 ダッシュボードの案内', () => {
  test('#77 「承認待ちの投稿が 1 件あります」とリンクが出て、押すと /social#approval-pending へ移る', async ({
    page,
  }) => {
    const post = await requestApproval();

    await page.goto('/dashboard');
    await expect(page.getByText(/承認待ちの投稿が\s*1\s*件あります/)).toBeVisible();

    await page.locator('a[href="/social#approval-pending"]').first().click();
    await page.waitForURL('**/social#approval-pending');
    await expect(approvalSection(page)).toContainText(post.body);
  });
});
