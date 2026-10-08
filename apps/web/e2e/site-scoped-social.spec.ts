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
 * SNS アカウントと API トークンを Web サイトに紐づける画面（053-site-scoped-social 設計 §9、
 * 受け入れ条件 #73〜#79・#93）。管理者でログインして動かす（`playwright.config.ts` の storageState）。
 *
 * * #73 `/social` の追加で「サイト：A」→ 一覧の「サイト」列に A
 * * #74 `/settings?tab=api` で「サイト：A」のトークンを発行 → 列に A、`site.read` が選べない
 * * #75 そのトークンで一覧と登録ができ、共通のトークンでは同じアカウントへ 422
 * * #76 「サイト」から「共通」へ変えて列が変わる、「サイトで絞り込む」で A だけ
 * * #77 紐づいたままのサイトの削除は Toast で断られ、外すと消せる
 * * #78 閲覧者は列だけ見え、「サイト」ボタンと「+ アカウントを追加」が無い
 * * #79 幅 375px で 2 画面とも横スクロールせず、2 つの Modal が画面幅に収まる
 * * #93 トークンの「サイトを変える」で B へ移すと、列が B になり見える範囲も B に変わる
 *
 * provider は配信 Plugin を要しない `x`（`social.spec.ts` と同じ）。`csrf`・`issueToken` は
 * `api-token.spec.ts`、閲覧者のログインは `social-approval.spec.ts`、横スクロールの検査は
 * `responsive.spec.ts` を写す（import しない）。
 *
 * **このファイルは `sites.spec.ts`・`social*.spec.ts` より先に走る**（ファイル名の順に直列）。
 * 件ごとに要る前提は件の中で API で作り、作ったアカウント・サイト・利用者は `afterAll` で消し、
 * トークンは失効させる（実装プラン §7 の 11）。CSRF の取得の Rate Limit（1 分 300 回）に当たらないよう、
 * サイト A・B は `beforeAll` で 1 回だけ作って使い回す（§7 の 12）。
 */

const origin = 'http://127.0.0.1:3000';
const ADMIN_STORAGE = './e2e/.auth/admin.json';
const NARROW = { width: 375, height: 720 };

/* 設計 §9.1・§9.2 の文言 */
const SITE_LABEL = 'サイト';
const COMMON_LABEL = '共通';
const SOCIAL_COMMON_OPTION = '共通（どのサイトのトークンからも使える）';
const ACCOUNT_SITE_CHANGE_TITLE = 'サイトの紐づけを変える';
const ACCOUNT_SITE_CHANGED = 'サイトの紐づけを変えました。';
const FILTER_LABEL = 'サイトで絞り込む';
const TOKEN_SITE_CHANGE_BUTTON = 'サイトを変える';
const TOKEN_SITE_CHANGE_TITLE = 'トークンのサイトを変える';
const TOKEN_SITE_CHANGED = 'トークンのサイトを変えました。';
/** サイトの削除の 409（設計 §8.6）。サーバの応答の文がそのまま Toast に出る（設計 §9.3）。 */
const SITE_IN_USE_ONE = 'このサイトに紐づいた SNS アカウントが 1 件あります';

/** この spec が作ったもの。`afterAll` で片付ける。 */
const createdAccountIds: string[] = [];
const createdTokenIds: string[] = [];
const createdSiteIds: string[] = [];
const createdUserIds: string[] = [];

/** `beforeAll` で作る共有のサイト。 */
let siteA = { id: '', name: '' };
let siteB = { id: '', name: '' };

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

/** `beforeAll` / `afterAll` はテスト用の fixture を使えないので、自分で作る。 */
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

async function patchJson(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
): Promise<APIResponse> {
  const token = await csrf(request);
  return request.patch(path, { headers: headers(token), data: { ...data, csrfToken: token } });
}

async function deleteJson(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown> = {},
): Promise<APIResponse> {
  const token = await csrf(request);
  return request.delete(path, { headers: headers(token), data: { ...data, csrfToken: token } });
}

async function createSite(request: APIRequestContext, label: string) {
  const name = `E2E ${label} ${unique()}`;
  const response = await postJson(request, '/api/v1/sites', {
    name,
    url: `https://${unique()}.example.com`,
    description: '',
    status: 'active',
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdSiteIds.push(id);
  return { id, name };
}

/** 管理者のセッションでアカウントを作る（区画 `all`。`siteId` を決められる）。 */
async function createAccount(request: APIRequestContext, siteId: string | null) {
  const displayName = `E2E 区画 ${unique()}`;
  const response = await postJson(request, '/api/v1/social/accounts', {
    provider: 'x',
    displayName,
    handle: `@${unique()}`,
    siteId,
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdAccountIds.push(id);
  return { id, displayName };
}

/** セッションでトークンを発行し、平文と ID を返す（`api-token.spec.ts` の `issueToken` に `siteId` を足す）。 */
async function issueToken(
  request: APIRequestContext,
  scopes: readonly string[],
  siteId: string | null,
) {
  const name = `E2E 区画 ${unique()}`;
  const response = await postJson(request, '/api/v1/api-tokens', { name, scopes, siteId });
  expect(response.status(), await response.text()).toBe(201);
  const data = ((await response.json()) as { data: { token: string; id: string } }).data;
  createdTokenIds.push(data.id);
  return { name, token: data.token, id: data.id };
}

/** 管理者のセッションで、表示名からアカウントの ID を引く（画面で作ったものを片付けるため）。 */
async function accountIdByName(request: APIRequestContext, displayName: string): Promise<string> {
  const response = await request.get('/api/v1/social/accounts?perPage=100');
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { id: string; displayName: string }[] };
  const found = body.data.find((account) => account.displayName === displayName);
  expect(found, `アカウント「${displayName}」`).toBeDefined();
  return found?.id ?? '';
}

/** 自分のトークンの一覧から、名前で ID を引く（画面で発行したものを失効させるため）。 */
async function tokenIdByName(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.get('/api/v1/api-tokens');
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { id: string; name: string }[] };
  const found = body.data.find((token) => token.name === name);
  expect(found, `トークン「${name}」`).toBeDefined();
  return found?.id ?? '';
}

/** トークン（Bearer）で見えるアカウントの ID。 */
async function accountIdsVisibleTo(request: APIRequestContext, plaintext: string) {
  const response = await request.get('/api/v1/social/accounts?perPage=100', {
    headers: { Authorization: `Bearer ${plaintext}` },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { id: string }[] };
  return body.data.map((account) => account.id);
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px の丸め誤差は許す。
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

/** Modal が画面の横幅に収まっている（左端が 0 以上、右端が画面幅以下。1px の丸め誤差は許す）。 */
async function expectWithinViewport(dialog: Locator, width: number): Promise<void> {
  const box = await dialog.boundingBox();
  expect(box, 'Modal の位置と大きさ').not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(width + 1);
}

function accountRow(page: Page, displayName: string): Locator {
  return page.getByRole('row').filter({ hasText: displayName });
}

function tokenRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ hasText: name });
}

/**
 * 設定 → API の発行フォームで、サイトを選んでトークンを発行し、画面に出た平文を返す。
 * 発行したトークンは `afterAll` で失効させる。
 */
async function issueTokenOnScreen(
  page: Page,
  request: APIRequestContext,
  siteName: string,
  scopes: readonly string[],
): Promise<{ name: string; token: string }> {
  const name = `E2E 画面 ${unique()}`;
  await page.goto('/settings?tab=api');
  await page.getByLabel('名前', { exact: true }).fill(name);
  await page.getByLabel(SITE_LABEL, { exact: true }).selectOption({ label: siteName });
  for (const scope of scopes) {
    await page.getByRole('checkbox', { name: scope, exact: true }).check();
  }
  await page.getByRole('button', { name: '発行する' }).click();

  const issued = page.locator('[data-issued-token]');
  await expect(issued).toBeVisible();
  const token = ((await issued.textContent()) ?? '').trim();
  expect(token).toMatch(/^tfp_/);

  createdTokenIds.push(await tokenIdByName(request, name));
  return { name, token };
}

/** 閲覧者を作り、その閲覧者でログインした画面のコンテキストを返す（`social-approval.spec.ts` を写す）。 */
async function viewerBrowserContext(
  request: APIRequestContext,
  browser: Browser,
): Promise<BrowserContext> {
  const loginId = `e2e_site_scope_viewer_${unique()}`;
  const password = 'e2e site scope viewer correct horse battery staple';
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

test.beforeAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    siteA = await createSite(request, 'サイトA');
    siteB = await createSite(request, 'サイトB');
  } finally {
    await request.dispose();
  }
});

test.afterAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    // アカウントを先に消す（紐づいたアカウントがあるとサイトを消せない。投稿も一緒に消える）。
    for (const id of createdAccountIds) {
      await deleteJson(request, `/api/v1/social/accounts/${id}`);
    }
    // トークンは消せないので失効させる（失効したトークンは後の spec に出ない）。
    for (const id of createdTokenIds) {
      await deleteJson(request, `/api/v1/api-tokens/${id}`);
    }
    for (const id of createdSiteIds) {
      await deleteJson(request, `/api/v1/sites/${id}`);
    }
    for (const id of createdUserIds) {
      await deleteJson(request, `/api/v1/users/${id}`);
    }
  } finally {
    await request.dispose();
  }
});

/* -------------------------------------------------------------------------- */
/* #73 アカウントの追加でサイトを選ぶ                                              */
/* -------------------------------------------------------------------------- */

test('#73 「サイト：A」を選んで登録すると、一覧の「サイト」列に A が出る', async ({
  page,
  request,
}) => {
  const displayName = `E2E 画面から ${unique()}`;

  await page.goto('/social');
  await page.getByRole('button', { name: '+ アカウントを追加' }).click();

  const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
  await dialog.getByLabel('サービス').selectOption('x');
  await dialog.getByLabel(SITE_LABEL, { exact: true }).selectOption({ label: siteA.name });
  await dialog.getByLabel('表示名').fill(displayName);
  await dialog.getByRole('button', { name: '追加' }).click();

  const row = accountRow(page, displayName);
  await expect(row).toBeVisible();
  await expect(row).toContainText(siteA.name);

  const id = await accountIdByName(request, displayName);
  createdAccountIds.push(id);

  // 画面の値だけでなく、保存された紐づけも A。
  const got = await request.get(`/api/v1/social/accounts/${id}`);
  expect(((await got.json()) as { data: { siteId: string | null } }).data.siteId).toBe(siteA.id);

  // 読み込み直しても列は A のまま（Server Component が siteId と sites を渡している）。
  await page.reload();
  await expect(accountRow(page, displayName)).toContainText(siteA.name);
});

/* -------------------------------------------------------------------------- */
/* #74 トークンの発行でサイトを選ぶ                                                */
/* -------------------------------------------------------------------------- */

test('#74 サイトを選ぶと site.read が選べなくなる', async ({ page }) => {
  await page.goto('/settings?tab=api');
  const siteRead = page.getByRole('checkbox', { name: 'site.read', exact: true });

  // 共通（既定）のうちは選べる。
  await expect(siteRead).toBeEnabled();

  await page.getByLabel(SITE_LABEL, { exact: true }).selectOption({ label: siteA.name });
  await expect(siteRead).toBeDisabled();
  await expect(siteRead).not.toBeChecked();
  // SNS の権限は選べる。
  await expect(page.getByRole('checkbox', { name: 'social.read', exact: true })).toBeEnabled();
});

test('#74 「サイト：A」・social.read + social.write で発行すると、一覧の「サイト」列に A が出る', async ({
  page,
  request,
}) => {
  const issued = await issueTokenOnScreen(page, request, siteA.name, [
    'social.read',
    'social.write',
  ]);

  const row = tokenRow(page, issued.name);
  await expect(row).toBeVisible();
  await expect(row).toContainText(siteA.name);

  // 保存された紐づけも A。
  const list = await request.get('/api/v1/api-tokens');
  const body = (await list.json()) as {
    data: { name: string; siteId: string | null; siteScoped: boolean }[];
  };
  const saved = body.data.find((token) => token.name === issued.name);
  expect(saved?.siteId).toBe(siteA.id);
  expect(saved?.siteScoped).toBe(true);
});

/* -------------------------------------------------------------------------- */
/* #75 発行したトークンで API を叩く                                               */
/* -------------------------------------------------------------------------- */

test('#75 画面で発行したサイト A のトークンで一覧と登録ができ、共通のトークンでは 422', async ({
  page,
  request,
}) => {
  const account = await createAccount(request, siteA.id);
  const issued = await issueTokenOnScreen(page, request, siteA.name, [
    'social.read',
    'social.write',
  ]);

  // 一覧に A のアカウントが出る。
  expect(await accountIdsVisibleTo(request, issued.token)).toContain(account.id);

  // そのアカウントへ登録できる。
  const created = await request.post('/api/v1/social/posts', {
    headers: { Authorization: `Bearer ${issued.token}` },
    data: { socialAccountId: account.id, body: `E2E 区画の投稿 ${unique()}`, status: 'draft' },
  });
  expect(created.status(), await created.text()).toBe(201);

  // 共通のトークンからは A のアカウントは使えない（存在しない場合と同じ 422）。
  const common = await issueToken(request, ['social.read', 'social.write'], null);
  const rejected = await request.post('/api/v1/social/posts', {
    headers: { Authorization: `Bearer ${common.token}` },
    data: { socialAccountId: account.id, body: `E2E 区画の外 ${unique()}`, status: 'draft' },
  });
  expect(rejected.status(), await rejected.text()).toBe(422);
  const error = (await rejected.json()) as { error: { details?: Record<string, unknown> } };
  expect(Object.keys(error.error.details ?? {})).toContain('socialAccountId');
});

/* -------------------------------------------------------------------------- */
/* #76 アカウントのサイトを変える・絞り込む                                         */
/* -------------------------------------------------------------------------- */

/** 行の「サイト」から Modal を開き、選んで保存する。 */
async function changeAccountSite(page: Page, displayName: string, optionLabel: string) {
  await accountRow(page, displayName)
    .getByRole('button', { name: SITE_LABEL, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: ACCOUNT_SITE_CHANGE_TITLE });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').selectOption({ label: optionLabel });
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(ACCOUNT_SITE_CHANGED)).toBeVisible();
  await expect(dialog).toHaveCount(0);
}

test('#76 「サイト」から「共通」に変えて保存すると、列が「共通」になる', async ({
  page,
  request,
}) => {
  const account = await createAccount(request, siteA.id);

  await page.goto('/social');
  await expect(accountRow(page, account.displayName)).toContainText(siteA.name);

  await changeAccountSite(page, account.displayName, SOCIAL_COMMON_OPTION);

  const row = accountRow(page, account.displayName);
  await expect(row).not.toContainText(siteA.name);
  await expect(row).toContainText(COMMON_LABEL);

  // 保存された紐づけも共通。
  const got = await request.get(`/api/v1/social/accounts/${account.id}`);
  expect(((await got.json()) as { data: { siteId: string | null } }).data.siteId).toBeNull();
});

test('#76 紐づけ直して「サイトで絞り込む」で A を選ぶと A のアカウントだけになる', async ({
  page,
  request,
}) => {
  const target = await createAccount(request, null);
  const common = await createAccount(request, null);

  await page.goto('/social');
  await changeAccountSite(page, target.displayName, siteA.name);
  await expect(accountRow(page, target.displayName)).toContainText(siteA.name);

  // 絞り込みの選択肢は描いた時点のアカウントから作られるので、読み込み直してから選ぶ。
  await page.reload();
  await page.getByLabel(FILTER_LABEL).selectOption({ label: siteA.name });

  await expect(accountRow(page, target.displayName)).toBeVisible();
  await expect(accountRow(page, common.displayName)).toHaveCount(0);
});

/* -------------------------------------------------------------------------- */
/* #77 紐づいたままのサイトの削除                                                  */
/* -------------------------------------------------------------------------- */

async function deleteSiteOnScreen(page: Page, siteName: string): Promise<void> {
  await page
    .getByRole('row', { name: new RegExp(escapeRegExp(siteName)) })
    .getByRole('button', { name: '削除' })
    .click();
  await page.getByRole('button', { name: '削除する' }).click();
}

test('#77 紐づいたままサイトを削除すると Toast で断られ、紐づけを外すと削除できる', async ({
  page,
  request,
}) => {
  const site = await createSite(request, '削除するサイト');
  const account = await createAccount(request, site.id);

  await page.goto('/sites');
  await deleteSiteOnScreen(page, site.name);

  await expect(page.getByText(SITE_IN_USE_ONE)).toBeVisible();
  // サイトは残る。
  await expect(page.getByRole('cell', { name: site.name })).toBeVisible();
  expect((await request.get(`/api/v1/sites/${site.id}`)).status()).toBe(200);

  // 紐づけを外す。
  const unlinked = await patchJson(request, `/api/v1/social/accounts/${account.id}`, {
    siteId: null,
  });
  expect(unlinked.status(), await unlinked.text()).toBe(200);

  await page.reload();
  await deleteSiteOnScreen(page, site.name);

  await expect(page.getByRole('cell', { name: site.name })).toBeHidden();
  expect((await request.get(`/api/v1/sites/${site.id}`)).status()).toBe(404);
});

/* -------------------------------------------------------------------------- */
/* #78 閲覧者                                                                    */
/* -------------------------------------------------------------------------- */

test('#78 閲覧者には「サイト」列が見え、「サイト」ボタンと「+ アカウントを追加」が無い', async ({
  browser,
  request,
}) => {
  const account = await createAccount(request, siteA.id);
  const context = await viewerBrowserContext(request, browser);
  try {
    const page = await context.newPage();
    await page.goto('/social');

    await expect(page.getByRole('columnheader', { name: SITE_LABEL, exact: true })).toBeVisible();
    // 閲覧者は site.read を持つので、名前が引ける。
    await expect(accountRow(page, account.displayName)).toContainText(siteA.name);

    await expect(page.getByRole('button', { name: SITE_LABEL, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ アカウントを追加' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/* -------------------------------------------------------------------------- */
/* #79 幅 375px                                                                  */
/* -------------------------------------------------------------------------- */

test.describe('#79 幅 375px', () => {
  test.use({ viewport: NARROW });

  test('#79 /social（サイトに紐づいたアカウントがある）がページ全体で横スクロールしない', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, siteA.id);

    await page.goto('/social');
    await expect(accountRow(page, account.displayName)).toContainText(siteA.name);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#79 「サイトの紐づけを変える」の Modal が画面幅に収まる', async ({ page, request }) => {
    const account = await createAccount(request, siteA.id);

    await page.goto('/social');
    await accountRow(page, account.displayName)
      .getByRole('button', { name: SITE_LABEL, exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: ACCOUNT_SITE_CHANGE_TITLE });
    await expect(dialog).toBeVisible();

    await expectWithinViewport(dialog, NARROW.width);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#79 /settings?tab=api がページ全体で横スクロールしない', async ({ page, request }) => {
    const issued = await issueToken(request, ['social.read'], siteA.id);

    await page.goto('/settings?tab=api');
    // 「サイト」の Select と列が描かれた状態で見る。
    await expect(page.getByLabel(SITE_LABEL, { exact: true })).toBeVisible();
    await expect(tokenRow(page, issued.name)).toContainText(siteA.name);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#79 「トークンのサイトを変える」の Modal が画面幅に収まる', async ({ page, request }) => {
    const issued = await issueToken(request, ['social.read'], siteA.id);

    await page.goto('/settings?tab=api');
    await tokenRow(page, issued.name)
      .getByRole('button', { name: TOKEN_SITE_CHANGE_BUTTON, exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: TOKEN_SITE_CHANGE_TITLE });
    await expect(dialog).toBeVisible();

    await expectWithinViewport(dialog, NARROW.width);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #93 トークンのサイトを画面で変える                                               */
/* -------------------------------------------------------------------------- */

test('#93 「サイトを変える」で B へ移すと、列が B になり、そのトークンから B のアカウントだけが見える', async ({
  page,
  request,
}) => {
  const accountA = await createAccount(request, siteA.id);
  const accountB = await createAccount(request, siteB.id);
  const issued = await issueToken(request, ['social.read'], siteA.id);

  // 前提：変える前は A のアカウントが見え、B のアカウントは見えない。
  const before = await accountIdsVisibleTo(request, issued.token);
  expect(before).toContain(accountA.id);
  expect(before).not.toContain(accountB.id);

  await page.goto('/settings?tab=api');
  await expect(tokenRow(page, issued.name)).toContainText(siteA.name);

  await tokenRow(page, issued.name)
    .getByRole('button', { name: TOKEN_SITE_CHANGE_BUTTON, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: TOKEN_SITE_CHANGE_TITLE });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox').selectOption({ label: siteB.name });
  await dialog.getByRole('button', { name: '変える', exact: true }).click();

  await expect(page.getByText(TOKEN_SITE_CHANGED)).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const row = tokenRow(page, issued.name);
  await expect(row).toContainText(siteB.name);
  await expect(row).not.toContainText(siteA.name);

  // 同じ平文のまま、見える範囲が B に変わる。
  const after = await accountIdsVisibleTo(request, issued.token);
  expect(after).toContain(accountB.id);
  expect(after).not.toContain(accountA.id);
});
