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
 * SNS 画面の「送信待ち」タブ（055-social-pending-tab 設計 §5・§9、受け入れ条件 #61〜#74・#80・#81）。
 *
 * * #61 h1「SNS」とタブ 4 つ・`aria-current`・`?tab=xxx`・閲覧者
 * * #62 送信待ちの表の並び（手が要るもの順）・下書きは投稿タブ・投稿タブに区画が無い
 * * #63 予約時刻前の手動の予約を開いて「投稿した」→ 配信履歴に配信済み
 * * #64 幅 375px で送信待ちタブ・順に投稿・承認のダイアログが横スクロールしない
 * * #65 承認待ちの手動投稿に「投稿画面を開く」が無く、承認すると手動投稿待ちになる
 * * #66・#67 選んだ手動投稿を順に投稿（開くのは人のクリックだけ・記録・409 で飛ばす）
 * * #68 送信待ちタブで 054 の一括送信・一括取り消し
 * * #69 投稿タブの絞り込みの URL（`tab=posts`・`#` なし）と一括取り消し
 * * #70・#71 `/social/history` の転送と配信履歴タブの絞り込み
 * * #72 ダッシュボードの 2 つの導線
 * * #73 投稿フォームの戻り先（3 つ）
 * * #74 アカウント 0 件の「SNS画面へ」とアカウントタブの追加（**この spec の最後**）
 * * #80 並び順「予定の時刻順」の URL・並び・持ち回り・誤った値・条件をクリア
 * * #81 行の「削除」・編集者に無い・375px の操作のセルと確認ダイアログ
 *
 * 画面は `plugins/example-plugin`（`publish()` と `manual()` の両方を持つ）を題材に走らせる。
 * 承認待ちは外部アプリの形（Scope `social.read` + `social.write` の API トークン）で
 * `publishTiming: 'after_approval'` を送って作る。`beforeAll` / `afterAll` は `social-approval.spec.ts`、
 * 横スクロールの検査は `responsive.spec.ts` を写す（import しない）。
 *
 * **隔離**（実装プラン §8 の 29・46）：表の行は、この spec が作ったアカウントの
 * `?pendingAccount=<id>` で絞って開き、前の spec の残りと混ぜない（#62・#80 は並びをちょうど見る）。
 * URL が決まっている件（#61・#70・#72）は、作った投稿の行が見えることと URL・選ばれた値で見る。
 *
 * **このファイルは `social-credentials.spec.ts` の後、`social-publishing.spec.ts` の前に走る**
 * （ファイル名の順に直列。実装プラン §7 の 8・§8 の 35）。承認待ち・手動投稿待ち・Plugin を残すと
 * 後の spec（送信待ちタブの 1 ページ目、ダッシュボードの件数）に効くので、**投稿は件ごとに消し、
 * Plugin・アカウント・トークン・利用者は `afterAll` で片付ける**。
 *
 * 子ウィンドウは `page.context().waitForEvent('page')` で拾い、「次の窓は開かない」は context の
 * `page` イベントの数が増えないことで見る（`noopener` では `popup` が出ないことがある。§8 の 15）。
 * E2E のサーバは配信の定期実行が有効で、即投稿で承認した自動の予約は 1 分以内に配信されうる（§8 の 30）。
 */

const origin = 'http://127.0.0.1:3000';
const PLUGIN_ID = 'example-plugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';
const NARROW = { width: 375, height: 720 };
/** API トークンを発行する要求が名乗る送信元（`beforeAll` の注記）。 */
const TOKEN_ISSUE_IP = '198.51.100.55';

/* 設計 §9.3.4・§9.5・§9.9 の文言（`ui/social/labels.ts`） */
const TABS_LABEL = 'SNSのタブ';
const TAB_NAMES = ['送信待ち', '投稿', 'アカウント', '配信履歴'] as const;
const PENDING_HEADING = '送信待ち';
const KIND_MANUAL_PENDING = '手動投稿待ち';
const KIND_AWAITING = '承認待ち';
const KIND_SCHEDULED = '予約済み';
const FILTER_STATUS = '状態';
const FILTER_SORT = '並び順';
const SORT_ACTION = '手が要るもの順';
const SORT_TIME = '予定の時刻順';
const OPEN_LABEL = '投稿画面を開く';
const DONE_LABEL = '投稿した';
const NOT_POSTED_LABEL = '投稿しなかった';
const QUIT_LABEL = 'やめる';
const SKIP_LABEL = '飛ばして次へ';
const CONFIRM_FAIL_LABEL = '失敗にする';
const DONE_DIALOG_TITLE = '投稿を記録しますか？';
const DONE_CONFIRM_LABEL = '記録する';
const AWAITING_MANUAL_NOTE = '承認すると投稿画面を開けます';
const APPROVE_DIALOG_TITLE = '投稿を承認する';
const SEQUENCE_BUTTON = /^選んだ手動投稿を順に投稿/;
const SEQUENCE_DIALOG = /^手動投稿（/;
const STALE_IN_SEQUENCE = '内容が変わっています';
const SELECT_ROW_PREFIX = 'この投稿を選択：';
const BULK_SEND = '一括送信（承認）';
const BULK_SEND_NOW = /即投稿/;
const BULK_DELETE = '一括取り消し';
const BULK_DELETE_TITLE = '投稿を一括で取り消しますか？';
const DELETE_TITLE = '投稿を削除しますか？';
const MANUAL_NOT_POSTED_REASON = '手動投稿で『投稿しなかった』が選ばれました。';
/** 前の版の区画の見出し（`approval-pending.tsx`・`manual-pending.tsx`）。055 で無くなる。 */
const OLD_SECTION_HEADING = /(承認待ち|手動投稿待ち)（\s*\d+\s*件）/;

/** この spec が作ったもの。`afterAll` で消す。 */
const createdAccountIds: string[] = [];
const createdTokenIds: string[] = [];
const createdUserIds: string[] = [];
/** 件ごとに作った投稿。`afterEach` で消す（承認待ち・手動投稿待ちを次の件・次の spec へ残さない）。 */
let createdPostIds: string[] = [];

/** `beforeAll` で作る共有の前提。 */
let accountId = '';
let accountName = '';
/** Bearer の API トークン（Scope `social.read` + `social.write`）で叩く要求。外部アプリの役。 */
let appRequest: APIRequestContext | undefined;

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * CSRF トークン。**取得の Rate Limit に当たらないよう、要求のコンテキストごとに 1 回だけ取る**
 * （二重送信の Cookie は使い回せる。実装プラン §7 の 10）。
 */
const csrfTokens = new Map<APIRequestContext, string>();

async function csrf(request: APIRequestContext): Promise<string> {
  const cached = csrfTokens.get(request);
  if (cached !== undefined) return cached;
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  csrfTokens.set(request, body.data.csrfToken);
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

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

interface Post {
  readonly id: string;
  readonly body: string;
}

/** 本文。example-plugin の上限（100 文字）に収め、他の本文の部分文字列にならない形にする。 */
function bodyOf(label: string): string {
  return `E2E送信待ち${label}${unique()}`;
}

/** 画面（管理者のセッション）から登録する。`overrides` を省けば下書き。 */
async function createBySession(
  request: APIRequestContext,
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<Post> {
  const body = String(overrides['body'] ?? bodyOf(label));
  const response = await postJson(request, '/api/v1/social/posts', {
    socialAccountId: accountId,
    ...overrides,
    body,
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdPostIds.push(id);
  return { id, body };
}

/** 予約時刻を過ぎた手動の予約（手動投稿待ち）。 */
async function createManualPending(request: APIRequestContext, label: string): Promise<Post> {
  return createBySession(request, label, {
    status: 'scheduled',
    deliveryMode: 'manual',
    scheduledAt: minutesFromNow(-30),
  });
}

/** 予約時刻前の手動の予約（予約済み）。 */
async function createManualScheduled(
  request: APIRequestContext,
  label: string,
  minutes = 60,
): Promise<Post> {
  return createBySession(request, label, {
    status: 'scheduled',
    deliveryMode: 'manual',
    scheduledAt: minutesFromNow(minutes),
  });
}

/** 自動の予約（未来。定期実行が配信しない）。 */
async function createAutoScheduled(
  request: APIRequestContext,
  label: string,
  minutes = 120,
): Promise<Post> {
  return createBySession(request, label, {
    status: 'scheduled',
    deliveryMode: 'auto',
    scheduledAt: minutesFromNow(minutes),
  });
}

/** 外部アプリとして承認待ちの投稿を登録する（`publishTiming: 'after_approval'`）。 */
async function requestApproval(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<Post> {
  const body = String(overrides['body'] ?? bodyOf(label));
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

interface PostState {
  readonly status: string;
  readonly failureReason: string | null;
}

async function fetchPost(request: APIRequestContext, id: string): Promise<PostState> {
  const response = await request.get(`/api/v1/social/posts/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: PostState }).data;
}

/** この spec のアカウントで絞った送信待ちタブ（実装プラン §8 の 29）。 */
function pendingPath(extra = ''): string {
  return `/social?pendingAccount=${accountId}${extra}`;
}

function tabsNav(page: Page): Locator {
  return page.getByRole('navigation', { name: TABS_LABEL });
}

function tabLink(page: Page, name: string): Locator {
  return tabsNav(page).getByRole('link', { name, exact: true });
}

/** 選ばれたタブが `name` だけであること。 */
async function expectCurrentTab(page: Page, name: string): Promise<void> {
  await expect(tabsNav(page).getByRole('link')).toHaveCount(TAB_NAMES.length);
  for (const tab of TAB_NAMES) {
    if (tab === name) {
      await expect(tabLink(page, tab)).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(tabLink(page, tab)).not.toHaveAttribute('aria-current', 'page');
    }
  }
}

/**
 * 表の投稿の行グループ（送信待ちタブ・投稿タブはそれぞれ表が 1 つ）。056 で 1 投稿が `<tbody>` 1 つ
 * （1 段目に状態・操作、2 段目に本文）になったので、件数は行グループ＝投稿の数（056 設計 §12.2）。
 */
function tableRows(page: Page): Locator {
  return page.getByRole('table').locator('tbody');
}

/** 本文を含む行グループ。本文は 2 段目に全文で出る（056 設計 §5.3）。先頭 40 字で引く形はそのまま。 */
function rowOf(page: Page, body: string): Locator {
  return tableRows(page).filter({ hasText: body.slice(0, 40) });
}

/** 表の行の並びを、渡した本文の並びに写す（どれにも当たらない行は `?`）。 */
async function rowOrder(page: Page, posts: readonly Post[]): Promise<string[]> {
  const texts = await tableRows(page).allInnerTexts();
  return texts.map((text) => posts.find((post) => text.includes(post.body))?.body ?? '?');
}

function rowCheckbox(page: Page, body: string): Locator {
  return page.getByRole('checkbox', { name: `${SELECT_ROW_PREFIX}${body}` });
}

function filterSelect(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

function sequenceDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: SEQUENCE_DIALOG });
}

function statusToast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

/** 行の「編集」（`Link` で包んだボタン）。 */
function editControl(row: Locator): Locator {
  return row.getByRole('link', { name: '編集' }).or(row.getByRole('button', { name: '編集' }));
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px の丸め誤差は許す。
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

async function expectWithinViewport(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(NARROW.width + 1);
  }
}

/** 指定のロールの利用者を作り、その利用者でログインした画面のコンテキストを返す。 */
async function roleBrowserContext(
  request: APIRequestContext,
  browser: Browser,
  role: 'viewer' | 'editor',
): Promise<BrowserContext> {
  const loginId = `e2e_pend_${role}_${unique()}`;
  const password = `e2e pending ${role} correct horse battery staple`;
  const created = await postJson(request, '/api/v1/users', {
    loginId,
    displayName: `E2E ${loginId}`,
    email: `${loginId}@example.com`,
    password,
    roles: [role],
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
    accountName = `E2E 送信待ち ${unique()}`;
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'example',
      displayName: accountName,
      handle: `@${unique()}`,
      credentials: { handle: `sample_${unique()}`, appPassword: `pw_${unique()}` },
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    // **トークンの発行だけ、この spec の送信元の IP を名乗る。** 発行の Rate Limit（1 分 10 回）の
    // キーは `operationId:IP`（`clientIpOf` は `X-Forwarded-For` の先頭を取る）で、E2E の全ファイルが
    // 1 つのバケツを共有する。全件では直前の spec（`site-scoped-social`・`social-approval`・
    // `social-bulk-actions`）の発行と同じ 1 分に入り 429 になった（実装プラン §8 の 77）。
    // Rate Limit の実装は変えず、文書用のアドレス（RFC 5737）で別のバケツを使う。
    const tokenCsrf = await csrf(request);
    const issued = await request.post('/api/v1/api-tokens', {
      headers: { ...headers(tokenCsrf), 'X-Forwarded-For': TOKEN_ISSUE_IP },
      data: {
        name: `e2e pending ${unique()}`,
        scopes: ['social.read', 'social.write'],
        csrfToken: tokenCsrf,
      },
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
    // アカウントを消すと、その投稿も一緒に消える（#74 が先に消していれば 404 で何もしない）。
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

/** #61。h1 とタブ（設計 §5.1・§9.1）。 */
test.describe('#61 タブ', () => {
  test('#61 ナビの「SNS」で /social が開き、h1「SNS」とタブ 4 つがあり「送信待ち」が aria-current="page"', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await page.getByRole('link', { name: 'SNS', exact: true }).first().click();
    await page.waitForURL((url) => url.pathname === '/social' && url.search === '');

    await expect(page.getByRole('heading', { level: 1, name: 'SNS', exact: true })).toHaveCount(1);
    await expect(tabsNav(page).getByRole('link')).toHaveText([...TAB_NAMES]);
    await expectCurrentTab(page, '送信待ち');
    await expect(
      page.getByRole('heading', { level: 2, name: PENDING_HEADING, exact: true }),
    ).toBeVisible();
  });

  for (const [name, key] of [
    ['投稿', 'posts'],
    ['アカウント', 'accounts'],
    ['配信履歴', 'history'],
  ] as const) {
    test(`#61 タブ「${name}」を押すと ?tab=${key} になり、そのタブが aria-current`, async ({
      page,
    }) => {
      await page.goto('/social');
      await tabLink(page, name).click();
      await page.waitForURL((url) => url.pathname === '/social' && url.search === `?tab=${key}`);

      await expect(page.getByRole('heading', { level: 1, name: 'SNS', exact: true })).toHaveCount(
        1,
      );
      await expectCurrentTab(page, name);
    });
  }

  test('#61 「送信待ち」のタブのリンクは /social（tab を書かない）', async ({ page }) => {
    await page.goto('/social?tab=posts');
    await expect(tabLink(page, '送信待ち')).toHaveAttribute('href', '/social');
    await tabLink(page, '送信待ち').click();
    await page.waitForURL((url) => url.pathname === '/social' && url.search === '');
    await expectCurrentTab(page, '送信待ち');
  });

  test('#61 /social?tab=xxx は 200 で送信待ち', async ({ page }) => {
    const response = await page.goto('/social?tab=xxx');
    expect(response?.status()).toBe(200);
    await expectCurrentTab(page, '送信待ち');
    await expect(
      page.getByRole('heading', { level: 2, name: PENDING_HEADING, exact: true }),
    ).toBeVisible();
  });

  test('#61 閲覧者にも 4 つのタブが見える', async ({ request, browser }) => {
    const context = await roleBrowserContext(request, browser, 'viewer');
    try {
      const page = await context.newPage();
      await page.goto('/social');
      await expect(page.getByRole('heading', { level: 1, name: 'SNS', exact: true })).toHaveCount(
        1,
      );
      await expect(tabsNav(page).getByRole('link')).toHaveText([...TAB_NAMES]);
      await expectCurrentTab(page, '送信待ち');
    } finally {
      await context.close();
    }
  });
});

/** #62。送信待ちの表の並び（設計 §5.2・§5.3・§9.3）。 */
test.describe('#62 送信待ちの表', () => {
  test('#62 承認待ち・予約時刻前の手動・予約時刻を過ぎた手動・自動の予約・下書きを作ると、下書き以外の 4 件が手動投稿待ち → 承認待ち → 予約済みの順に並ぶ', async ({
    page,
    request,
  }) => {
    const awaiting = await requestApproval('承認');
    const manualFuture = await createManualScheduled(request, '手動予約', 60);
    const manualPast = await createManualPending(request, '手動待ち');
    const auto = await createAutoScheduled(request, '自動予約', 120);
    const draft = await createBySession(request, '下書き');
    const all = [awaiting, manualFuture, manualPast, auto, draft];

    await page.goto(pendingPath());
    await expect(filterSelect(page, FILTER_SORT).locator('option:checked')).toHaveText(SORT_ACTION);
    await expect(tableRows(page)).toHaveCount(4);
    expect(await rowOrder(page, all)).toEqual([
      manualPast.body,
      awaiting.body,
      manualFuture.body,
      auto.body,
    ]);
    await expect(rowOf(page, manualPast.body)).toContainText(KIND_MANUAL_PENDING);
    await expect(rowOf(page, awaiting.body)).toContainText(KIND_AWAITING);
    await expect(rowOf(page, manualFuture.body)).toContainText(KIND_SCHEDULED);
    await expect(rowOf(page, auto.body)).toContainText(KIND_SCHEDULED);
    await expect(rowOf(page, draft.body)).toHaveCount(0);
  });

  test('#62 下書きは「投稿」タブにあり、「投稿」タブに承認待ち・手動投稿待ちの区画が無い', async ({
    page,
    request,
  }) => {
    await requestApproval('承認');
    await createManualPending(request, '手動待ち');
    const draft = await createBySession(request, '下書き');

    await page.goto('/social?tab=posts');
    await expect(rowOf(page, draft.body)).toContainText('下書き');
    await expect(page.getByRole('heading', { name: OLD_SECTION_HEADING })).toHaveCount(0);
    await expect(page.locator('#approval-pending')).toHaveCount(0);
    await expect(page.locator('#manual-pending')).toHaveCount(0);
  });
});

/** #63。予約時刻の前でも手動の予約を開いて記録できる（ユーザー裁定 4・6）。 */
test.describe('#63 予約時刻前の手動投稿', () => {
  test('#63 「投稿画面を開く」で子ウィンドウが開き、「投稿した」→「記録する」→ Toast、行が消え、配信履歴タブに「配信済み」で出る', async ({
    page,
    request,
  }) => {
    const post = await createManualScheduled(request, '前倒し', 120);

    await page.goto(pendingPath());
    const row = rowOf(page, post.body);
    await expect(row).toContainText(KIND_SCHEDULED);

    const opened = page.context().waitForEvent('page');
    await row.getByRole('button', { name: OPEN_LABEL }).click();
    const child = await opened;
    await child.waitForLoadState('domcontentloaded');
    const childUrl = new URL(child.url());
    expect(childUrl.pathname).toBe('/plugins/example-plugin/manual-post');
    expect(childUrl.searchParams.get('text')).toBe(post.body);
    await child.close();

    await row.getByRole('button', { name: DONE_LABEL, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: DONE_DIALOG_TITLE });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: DONE_CONFIRM_LABEL }).click();

    await expect(statusToast(page, /記録しました/)).toBeVisible();
    await expect(rowOf(page, post.body)).toHaveCount(0);
    expect((await fetchPost(request, post.id)).status).toBe('published');

    await page.goto('/social?tab=history');
    await expect(page.getByRole('row').filter({ hasText: post.body })).toContainText('配信済み');
  });
});

/** #64。幅 375px（設計 §9.10）。 */
test.describe('#64 狭い画面', () => {
  test.use({ viewport: NARROW });

  test('#64 選択・一括の帯・行の操作のある送信待ちタブがページ全体で横スクロールしない', async ({
    page,
    request,
  }) => {
    const manual = await createManualPending(request, '狭い');
    await requestApproval('狭い承認');

    await page.goto(pendingPath());
    await expect(rowOf(page, manual.body)).toBeVisible();
    await rowCheckbox(page, manual.body).check();
    await expect(page.getByRole('button', { name: BULK_SEND })).toBeVisible();
    await expect(page.getByRole('button', { name: SEQUENCE_BUTTON })).toBeVisible();
    await expect(rowOf(page, manual.body).getByRole('button', { name: OPEN_LABEL })).toHaveCount(1);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#64 順に投稿のダイアログがページ全体で横スクロールせず、画面幅に収まる', async ({
    page,
    request,
  }) => {
    const manual = await createManualPending(request, '狭い順に');

    await page.goto(pendingPath());
    await rowCheckbox(page, manual.body).check();
    await page.getByRole('button', { name: SEQUENCE_BUTTON }).click();
    const dialog = sequenceDialog(page);
    await expect(dialog).toBeVisible();
    await expectWithinViewport(dialog);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#64 承認のダイアログがページ全体で横スクロールせず、画面幅に収まる', async ({ page }) => {
    const post = await requestApproval('狭い承認', {
      body: `E2E送信待ち狭い承認${unique()}${'x'.repeat(60)}`,
      link: `https://example.com/${'b'.repeat(200)}`,
      media: [{ url: `https://cdn.example.com/${'c'.repeat(200)}.jpg`, alt: '長い URL の画像' }],
    });

    await page.goto(pendingPath());
    await rowOf(page, post.body)
      .getByRole('button', { name: /^承認する/ })
      .click();
    const dialog = page.getByRole('dialog', { name: APPROVE_DIALOG_TITLE });
    await expect(dialog).toBeVisible();
    await expectWithinViewport(dialog);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});

/** #65。承認待ちの手動投稿は承認の後に開ける（ユーザー裁定 4。048 §7.2）。 */
test.describe('#65 承認待ちの手動投稿', () => {
  test('#65 行に「投稿画面を開く」が無く、「承認する…」→ 全文 →「即投稿」→ 承認すると「手動投稿待ち」になり「投稿画面を開く」が出る', async ({
    page,
    request,
  }) => {
    // 本文の列の抜粋（60 字）より長くし、ダイアログが全文を出すことを見る。
    const body = `E2E送信待ち承認手動${unique()}${'あ'.repeat(70)}`;
    const post = await requestApproval('承認手動', { body, deliveryMode: 'manual' });

    await page.goto(pendingPath());
    const row = rowOf(page, post.body);
    await expect(row).toContainText(KIND_AWAITING);
    await expect(row.getByRole('button', { name: OPEN_LABEL })).toHaveCount(0);
    await expect(row).toContainText(AWAITING_MANUAL_NOTE);

    await row.getByRole('button', { name: /^承認する/ }).click();
    const dialog = page.getByRole('dialog', { name: APPROVE_DIALOG_TITLE });
    await expect(dialog).toContainText(body);
    await dialog.getByLabel(/即投稿/).check();
    await dialog.getByRole('button', { name: '承認する', exact: true }).click();

    await expect(rowOf(page, post.body)).toContainText(KIND_MANUAL_PENDING);
    await expect(rowOf(page, post.body).getByRole('button', { name: OPEN_LABEL })).toBeVisible();
    expect((await fetchPost(request, post.id)).status).toBe('scheduled');
  });
});

/** #66・#67。選んだ手動投稿を順に投稿（設計 §9.5。ユーザー裁定 6）。 */
test.describe('#66 選んだ手動投稿を順に投稿', () => {
  test('#66 3 件と承認待ち 1 件を選んで順に投稿：開くのはクリックだけ、記録の後に次の窓は開かず、やめると Toast と残り', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const first = await createManualScheduled(request, '順1', 30);
    const second = await createManualScheduled(request, '順2', 40);
    const third = await createManualScheduled(request, '順3', 50);
    const awaiting = await requestApproval('順承認', { deliveryMode: 'manual' });

    let pageEvents = 0;
    page.context().on('page', () => {
      pageEvents += 1;
    });

    await page.goto(pendingPath());
    for (const post of [first, second, third, awaiting]) {
      await rowCheckbox(page, post.body).check();
    }
    await page.getByRole('button', { name: SEQUENCE_BUTTON }).click();

    const dialog = sequenceDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/手動投稿（\s*1\s*\/\s*3\s*件目）/);
    await expect(dialog).toContainText(first.body);
    await expect(dialog).toContainText(/対象外\s*1\s*件（承認待ち\s*1）/);
    // ダイアログを開いただけでは子ウィンドウが開かない。
    await page.waitForTimeout(1_000);
    expect(pageEvents).toBe(0);

    const opened = page.context().waitForEvent('page');
    await dialog.getByRole('button', { name: OPEN_LABEL }).click();
    const child = await opened;
    await child.waitForLoadState('domcontentloaded');
    expect(new URL(child.url()).searchParams.get('text')).toBe(first.body);
    await child.close();
    expect(pageEvents).toBe(1);

    await dialog.getByRole('button', { name: DONE_LABEL, exact: true }).click();
    await expect(dialog).toHaveAccessibleName(/手動投稿（\s*2\s*\/\s*3\s*件目）/);
    await expect(dialog).toContainText(second.body);
    // 記録の後に次の窓は開かない（次の「投稿画面を開く」を押すまで）。
    await page.waitForTimeout(1_000);
    expect(pageEvents).toBe(1);

    await dialog.getByRole('button', { name: NOT_POSTED_LABEL }).click();
    await expect(dialog).toContainText('配信履歴に「失敗」として残ります');
    await dialog.getByRole('button', { name: CONFIRM_FAIL_LABEL }).click();
    await expect(dialog).toHaveAccessibleName(/手動投稿（\s*3\s*\/\s*3\s*件目）/);
    await expect(dialog).toContainText(third.body);

    await dialog.getByRole('button', { name: QUIT_LABEL }).click();
    await expect(sequenceDialog(page)).toHaveCount(0);
    await expect(
      statusToast(page, /2\s*件を記録しました（投稿した\s*1・投稿しなかった\s*1）。/),
    ).toBeVisible();
    expect(pageEvents).toBe(1);

    // 送信待ちに 3 件目と承認待ちが残り、選択はすべて外れる。
    await expect(rowOf(page, first.body)).toHaveCount(0);
    await expect(rowOf(page, second.body)).toHaveCount(0);
    await expect(rowOf(page, third.body)).toHaveCount(1);
    await expect(rowOf(page, awaiting.body)).toHaveCount(1);
    await expect(rowCheckbox(page, third.body)).not.toBeChecked();
    await expect(rowCheckbox(page, awaiting.body)).not.toBeChecked();

    expect((await fetchPost(request, first.id)).status).toBe('published');
    const failed = await fetchPost(request, second.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe(MANUAL_NOT_POSTED_REASON);
    expect((await fetchPost(request, third.id)).status).toBe('scheduled');

    await page.goto('/social?tab=history');
    await expect(page.getByRole('row').filter({ hasText: first.body })).toContainText('配信済み');
    const failedRow = page.getByRole('row').filter({ hasText: second.body });
    await expect(failedRow).toContainText('失敗');
    await expect(failedRow).toContainText(MANUAL_NOT_POSTED_REASON);
  });

  test('#67 途中で 2 件目の本文を API で PATCH すると、2 件目の「投稿した」で「内容が変わっています」が出て「飛ばして次へ」で 3 件目へ進み、2 件目は送信待ちのまま', async ({
    page,
    request,
  }) => {
    const first = await createManualScheduled(request, '競合1', 30);
    const second = await createManualScheduled(request, '競合2', 40);
    const third = await createManualScheduled(request, '競合3', 50);
    const rewritten = bodyOf('競合2書き換え');

    await page.goto(pendingPath());
    for (const post of [first, second, third]) {
      await rowCheckbox(page, post.body).check();
    }
    await page.getByRole('button', { name: SEQUENCE_BUTTON }).click();
    const dialog = sequenceDialog(page);
    await expect(dialog).toHaveAccessibleName(/手動投稿（\s*1\s*\/\s*3\s*件目）/);

    await dialog.getByRole('button', { name: DONE_LABEL, exact: true }).click();
    await expect(dialog).toHaveAccessibleName(/手動投稿（\s*2\s*\/\s*3\s*件目）/);

    // 2 件目を表示した後に、別の要求（外部アプリ）が本文を書き換える。
    const patched = await app().patch(`/api/v1/social/posts/${second.id}`, {
      data: { body: rewritten },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    await dialog.getByRole('button', { name: DONE_LABEL, exact: true }).click();
    await expect(dialog).toContainText(STALE_IN_SEQUENCE);
    await dialog.getByRole('button', { name: SKIP_LABEL }).click();
    await expect(dialog).toHaveAccessibleName(/手動投稿（\s*3\s*\/\s*3\s*件目）/);
    await expect(dialog).toContainText(third.body);

    await dialog.getByRole('button', { name: QUIT_LABEL }).click();
    await expect(sequenceDialog(page)).toHaveCount(0);

    expect((await fetchPost(request, first.id)).status).toBe('published');
    expect((await fetchPost(request, second.id)).status).toBe('scheduled');
    expect((await fetchPost(request, third.id)).status).toBe('scheduled');
    await expect(rowOf(page, rewritten)).toHaveCount(1);
  });
});

/** #68。送信待ちタブで 054 の一括操作（設計 §5.4。ユーザー裁定 2・5）。 */
test.describe('#68 送信待ちタブの一括操作', () => {
  test('#68 承認待ち 2 件を「一括送信（承認）」→「即投稿」→「送る」→ Toast、自動は予約済み（または配信済み）・手動は手動投稿待ち', async ({
    page,
    request,
  }) => {
    const auto = await requestApproval('一括自動');
    const manual = await requestApproval('一括手動', { deliveryMode: 'manual' });

    await page.goto(pendingPath());
    await rowCheckbox(page, auto.body).check();
    await rowCheckbox(page, manual.body).check();
    await page.getByRole('button', { name: BULK_SEND }).click();
    const dialog = page.getByRole('dialog', { name: /一括送信/ });
    await expect(dialog).toContainText(/承認待ち\s*2\s*件/);
    await dialog.getByLabel(BULK_SEND_NOW).check();
    await dialog.getByRole('button', { name: '送る', exact: true }).click();

    await expect(statusToast(page, /2\s*件を処理しました/)).toBeVisible();
    await expect(rowOf(page, manual.body)).toContainText(KIND_MANUAL_PENDING);
    // 自動は「予約済み」。定期実行が先に配信していれば表から消え、API で配信済み（実装プラン §8 の 30）。
    await expect(rowOf(page, auto.body)).not.toContainText(KIND_AWAITING);
    expect(['scheduled', 'published']).toContain((await fetchPost(request, auto.id)).status);
    if ((await rowOf(page, auto.body).count()) > 0) {
      await expect(rowOf(page, auto.body)).toContainText(KIND_SCHEDULED);
    }
    expect((await fetchPost(request, manual.id)).status).toBe('scheduled');
  });

  test('#68 予約済み 1 件を「一括取り消し」→「削除する」→ 行が消える', async ({
    page,
    request,
  }) => {
    const scheduled = await createAutoScheduled(request, '一括取消');

    await page.goto(pendingPath());
    await expectCurrentTab(page, '送信待ち');
    await rowCheckbox(page, scheduled.body).check();
    await page.getByRole('button', { name: BULK_DELETE }).click();
    const dialog = page.getByRole('dialog', { name: BULK_DELETE_TITLE });
    await expect(dialog).toContainText(/1\s*件を削除/);
    await dialog.getByRole('button', { name: '削除する' }).click();

    await expect(statusToast(page, /1\s*件を削除しました。/)).toBeVisible();
    await expect(rowOf(page, scheduled.body)).toHaveCount(0);
    expect((await request.get(`/api/v1/social/posts/${scheduled.id}`)).status()).toBe(404);
  });
});

/** #69。投稿タブの絞り込みの URL（設計 §9.8）。 */
test.describe('#69 投稿タブの絞り込み', () => {
  test('#69 状態「下書き」を選ぶと URL が tab=posts と postStatus=draft を含み # を含まず、下書きを一括取り消しできる', async ({
    page,
    request,
  }) => {
    const draft = await createBySession(request, '投稿タブ下書き');

    await page.goto('/social?tab=posts');
    await filterSelect(page, FILTER_STATUS).selectOption({ label: '下書き' });
    await expect(page).toHaveURL(/[?&]postStatus=draft(&|$)/);
    await expect(page).toHaveURL(/[?&]tab=posts(&|$)/);
    await expect(page).not.toHaveURL(/#/);
    await expectCurrentTab(page, '投稿');

    await rowCheckbox(page, draft.body).check();
    await page.getByRole('button', { name: BULK_DELETE }).click();
    const dialog = page.getByRole('dialog', { name: BULK_DELETE_TITLE });
    await dialog.getByRole('button', { name: '削除する' }).click();

    await expect(statusToast(page, /1\s*件を削除しました。/)).toBeVisible();
    await expect(rowOf(page, draft.body)).toHaveCount(0);
    expect((await request.get(`/api/v1/social/posts/${draft.id}`)).status()).toBe(404);
  });
});

/** #70。`/social/history` の転送（設計 §9.7）。 */
test.describe('#70 /social/history の転送', () => {
  test('#70 /social/history?status=failed&page=2 は /social?tab=history&historyStatus=failed&historyPage=2 へ移り、h1「SNS」と配信履歴タブ', async ({
    page,
  }) => {
    const response = await page.goto('/social/history?status=failed&page=2');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/social\?tab=history&historyStatus=failed&historyPage=2$/);
    await expect(page.getByRole('heading', { level: 1, name: 'SNS', exact: true })).toHaveCount(1);
    await expectCurrentTab(page, '配信履歴');
  });

  test('#70 /social/history?page=abc は /social?tab=history へ移り 200', async ({ page }) => {
    const response = await page.goto('/social/history?page=abc');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/social\?tab=history$/);
    await expectCurrentTab(page, '配信履歴');
  });
});

/** #71。配信履歴タブの絞り込み（設計 §9.6）。 */
test.describe('#71 配信履歴タブの絞り込み', () => {
  test('#71 結果「失敗」を選んで「絞り込む」→ URL が tab=history と historyStatus=failed を含み、配信履歴タブのまま', async ({
    page,
  }) => {
    await page.goto('/social?tab=history');
    await page.getByLabel('結果').selectOption({ label: '失敗' });
    await page.getByRole('button', { name: '絞り込む' }).click();

    await expect(page).toHaveURL(/[?&]historyStatus=failed(&|$)/);
    await expect(page).toHaveURL(/[?&]tab=history(&|$)/);
    await expectCurrentTab(page, '配信履歴');
    await expect(
      page.getByRole('heading', { level: 2, name: '配信履歴', exact: true }),
    ).toBeVisible();
  });
});

/** #72。ダッシュボードの導線（設計 §9.8）。 */
test.describe('#72 ダッシュボードの導線', () => {
  test('#72 「手動投稿待ちが n 件あります」の導線 → /social?pendingStatus=manual_pending で、状態の絞り込みが「手動投稿待ち」', async ({
    page,
    request,
  }) => {
    const post = await createManualPending(request, 'ダッシュ手動');

    await page.goto('/dashboard');
    await expect(page.getByText(/手動投稿待ちが \d+ 件あります/)).toBeVisible();
    await page.locator('a[href="/social?pendingStatus=manual_pending"]').first().click();
    await page.waitForURL(
      (url) => url.pathname === '/social' && url.search === '?pendingStatus=manual_pending',
    );

    await expect(filterSelect(page, FILTER_STATUS).locator('option:checked')).toHaveText(
      new RegExp(`^${KIND_MANUAL_PENDING}（\\s*\\d+\\s*）$`),
    );
    await expect(rowOf(page, post.body)).toContainText(KIND_MANUAL_PENDING);
  });

  test('#72 「承認待ちの投稿が n 件あります」の導線 → /social?pendingStatus=awaiting_approval で、状態の絞り込みが「承認待ち」', async ({
    page,
  }) => {
    const post = await requestApproval('ダッシュ承認');

    await page.goto('/dashboard');
    await expect(page.getByText(/承認待ちの投稿が\s*\d+\s*件あります/)).toBeVisible();
    await page.locator('a[href="/social?pendingStatus=awaiting_approval"]').first().click();
    await page.waitForURL(
      (url) => url.pathname === '/social' && url.search === '?pendingStatus=awaiting_approval',
    );

    await expect(filterSelect(page, FILTER_STATUS).locator('option:checked')).toHaveText(
      new RegExp(`^${KIND_AWAITING}（\\s*\\d+\\s*）$`),
    );
    await expect(rowOf(page, post.body)).toContainText(KIND_AWAITING);
  });
});

/** #73。投稿フォームの戻り先（設計 §5.7）。 */
test.describe('#73 投稿フォームの戻り先', () => {
  test('#73 送信待ちタブの行の「編集」→ 保存 → 送信待ちタブ（/social）へ戻る', async ({
    page,
    request,
  }) => {
    const post = await createManualScheduled(request, '戻り先送信待ち');
    const edited = bodyOf('戻り先送信待ち編集後');

    await page.goto(pendingPath());
    await editControl(rowOf(page, post.body)).first().click();
    await page.waitForURL((url) => url.pathname === `/social/posts/${post.id}/edit`);
    expect(new URL(page.url()).searchParams.get('from')).toBe('pending');
    await page.getByLabel('本文').fill(edited);
    await page.getByRole('button', { name: '保存' }).click();

    await page.waitForURL((url) => url.pathname === '/social' && url.search === '');
    await expectCurrentTab(page, '送信待ち');
    await expect(rowOf(page, edited)).toHaveCount(1);
  });

  test('#73 投稿タブの行の「編集」→ 保存 → /social?tab=posts へ戻る', async ({ page, request }) => {
    const post = await createBySession(request, '戻り先投稿');
    const edited = bodyOf('戻り先投稿編集後');

    await page.goto('/social?tab=posts');
    await editControl(rowOf(page, post.body)).first().click();
    await page.waitForURL((url) => url.pathname === `/social/posts/${post.id}/edit`);
    expect(new URL(page.url()).searchParams.get('from')).toBeNull();
    await page.getByLabel('本文').fill(edited);
    await page.getByRole('button', { name: '保存' }).click();

    await page.waitForURL((url) => url.pathname === '/social' && url.search === '?tab=posts');
    await expectCurrentTab(page, '投稿');
    await expect(rowOf(page, edited)).toHaveCount(1);
  });

  test('#73 /social/posts/new?from=https://example.com から保存すると /social?tab=posts へ戻る', async ({
    page,
    request,
  }) => {
    const body = bodyOf('戻り先外部');

    await page.goto(`/social/posts/new?from=${encodeURIComponent('https://example.com')}`);
    await page.getByLabel('アカウント').selectOption({ label: `${accountName}（サンプルSNS）` });
    await page.getByLabel('本文').fill(body);
    await page.getByRole('button', { name: '保存' }).click();

    await page.waitForURL((url) => url.pathname === '/social' && url.search === '?tab=posts');
    expect(new URL(page.url()).host).toBe(new URL(origin).host);

    // 後片付けのため、作った投稿の ID を拾う。
    const list = await request.get(`/api/v1/social/posts?accountId=${accountId}&perPage=100`);
    const posts = ((await list.json()) as { data: { id: string; body: string }[] }).data;
    const created = posts.find((candidate) => candidate.body === body);
    expect(created, '作った投稿が見つからない').toBeDefined();
    if (created !== undefined) createdPostIds.push(created.id);
  });
});

/** #80。並び順「予定の時刻順」（ユーザー裁定 7。設計 §5.3・§9.2）。 */
test.describe('#80 並び順', () => {
  test('#80 「予定の時刻順」を選ぶと URL に pendingSort=time が付き、行が予定の時刻順になる。状態を選び直しても保たれる', async ({
    page,
    request,
  }) => {
    const manualPast = await createManualPending(request, '時刻手動待ち'); // −30 分
    const manualFuture = await createManualScheduled(request, '時刻手動予約', 60);
    const awaiting = await requestApproval('時刻承認', { scheduledAt: minutesFromNow(90) });
    const auto = await createAutoScheduled(request, '時刻自動', 120);
    const all = [manualPast, manualFuture, awaiting, auto];

    await page.goto(pendingPath());
    expect(await rowOrder(page, all)).toEqual([
      manualPast.body,
      awaiting.body,
      manualFuture.body,
      auto.body,
    ]);

    await filterSelect(page, FILTER_SORT).selectOption({ label: SORT_TIME });
    await expect(page).toHaveURL(/[?&]pendingSort=time(&|$)/);
    await expect(page).toHaveURL(new RegExp(`[?&]pendingAccount=${accountId}(&|$)`));
    await expect(page).not.toHaveURL(/[?&]tab=/);
    await expect(filterSelect(page, FILTER_SORT).locator('option:checked')).toHaveText(SORT_TIME);
    await expect(tableRows(page)).toHaveCount(4);
    expect(await rowOrder(page, all)).toEqual([
      manualPast.body,
      manualFuture.body,
      awaiting.body,
      auto.body,
    ]);

    await filterSelect(page, FILTER_STATUS).selectOption('scheduled');
    await expect(page).toHaveURL(/[?&]pendingStatus=scheduled(&|$)/);
    await expect(page).toHaveURL(/[?&]pendingSort=time(&|$)/);
    await expect(tableRows(page)).toHaveCount(2);
    expect(await rowOrder(page, all)).toEqual([manualFuture.body, auto.body]);
  });

  test('#80 予定の時刻順のまま 2 ページ目へ移っても pendingSort=time が保たれる', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    for (let index = 0; index < 21; index += 1) {
      const body = bodyOf(`頁${String(index).padStart(2, '0')}`);
      const response = await app().post('/api/v1/social/posts', {
        data: {
          socialAccountId: accountId,
          publishTiming: 'scheduled',
          scheduledAt: minutesFromNow(24 * 60 + index),
          body,
        },
      });
      expect(response.status(), await response.text()).toBe(201);
      createdPostIds.push(((await response.json()) as { data: { id: string } }).data.id);
    }

    await page.goto(pendingPath('&pendingSort=time'));
    await expect(tableRows(page)).toHaveCount(20);
    await page
      .getByRole('navigation', { name: 'ページ送り' })
      .last()
      .getByRole('button', { name: '次へ' })
      .click();
    await expect(page).toHaveURL(/[?&]pendingPage=2(&|$)/);
    await expect(page).toHaveURL(/[?&]pendingSort=time(&|$)/);
    await expect(page).toHaveURL(new RegExp(`[?&]pendingAccount=${accountId}(&|$)`));
    await expect(tableRows(page)).toHaveCount(1);
    await expect(filterSelect(page, FILTER_SORT).locator('option:checked')).toHaveText(SORT_TIME);
  });

  test('#80 /social?pendingSort=xxx は 200 で「手が要るもの順」', async ({ page }) => {
    const response = await page.goto('/social?pendingSort=xxx');
    expect(response?.status()).toBe(200);
    await expect(filterSelect(page, FILTER_SORT).locator('option:checked')).toHaveText(SORT_ACTION);
  });

  test('#80 「条件をクリア」で pendingSort が消え /social へ戻る', async ({ page, request }) => {
    await createManualScheduled(request, '時刻クリア');

    await page.goto(pendingPath('&pendingSort=time'));
    await page.getByRole('link', { name: '条件をクリア' }).click();
    await page.waitForURL((url) => url.pathname === '/social' && url.search === '');
    await expect(filterSelect(page, FILTER_SORT).locator('option:checked')).toHaveText(SORT_ACTION);
  });
});

/** #81。行の「削除」（ユーザー裁定 8。設計 §9.3.4）。 */
test.describe('#81 行の削除', () => {
  test('#81 管理者で予約済みの行の「削除」→「削除する」→ 行が消え、投稿タブにも無い', async ({
    page,
    request,
  }) => {
    const post = await createAutoScheduled(request, '行削除');

    await page.goto(pendingPath());
    await expectCurrentTab(page, '送信待ち');
    await rowOf(page, post.body).getByRole('button', { name: '削除', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: DELETE_TITLE });
    await expect(dialog).toContainText('この操作は取り消せません。');
    await dialog.getByRole('button', { name: '削除する' }).click();

    await expect(statusToast(page, '削除しました。')).toBeVisible();
    await expect(rowOf(page, post.body)).toHaveCount(0);
    expect((await request.get(`/api/v1/social/posts/${post.id}`)).status()).toBe(404);

    await page.goto('/social?tab=posts');
    await expect(rowOf(page, post.body)).toHaveCount(0);
  });

  test('#81 編集者（social.delete なし）には送信待ちの行に「削除」が無い', async ({
    request,
    browser,
  }) => {
    const post = await createAutoScheduled(request, '編集者');
    const context = await roleBrowserContext(request, browser, 'editor');
    try {
      const page = await context.newPage();
      await page.goto(pendingPath());
      await expectCurrentTab(page, '送信待ち');
      const row = rowOf(page, post.body);
      // 判別力：行と「編集」は見えている。
      await expect(editControl(row).first()).toBeVisible();
      await expect(row.getByRole('button', { name: '削除', exact: true })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test.describe('#81 狭い画面', () => {
    test.use({ viewport: NARROW });

    test('#81 幅 375px で手動投稿待ちの行の操作のセルがボタンを折り返し、ページ全体が横スクロールせず、削除の確認ダイアログが画面幅に収まる', async ({
      page,
      request,
    }) => {
      const post = await createManualPending(request, '狭い操作');

      await page.goto(pendingPath());
      const row = rowOf(page, post.body);
      // 056 で 1 投稿が 2 段になり、行グループの最後の <td> は 2 段目の本文になった。操作は 1 段目の最後のセル。
      const cell = row.locator('tr').first().locator('td').last();
      const buttons = cell.getByRole('button');
      // 「投稿画面を開く」「投稿した」「取りやめ」「編集」「削除」。
      await expect(buttons.filter({ hasText: OPEN_LABEL })).toHaveCount(1);
      await expect(buttons.filter({ hasText: '削除' })).toHaveCount(1);
      await cell.scrollIntoViewIfNeeded();
      const tops = new Set<number>();
      for (const button of await buttons.all()) {
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        if (box !== null) tops.add(Math.round(box.y));
      }
      expect(tops.size).toBeGreaterThanOrEqual(2);
      expect(await hasHorizontalOverflow(page)).toBe(false);

      await cell.getByRole('button', { name: '削除', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: DELETE_TITLE });
      await expect(dialog).toBeVisible();
      await expectWithinViewport(dialog);
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  });
});

/**
 * #74。アカウント 0 件の「SNS画面へ」とアカウントタブの追加（設計 §5.7・§13.10 の 74）。
 *
 * **この spec の最後に置く。** E2E の DB は spec の間で共有され前の spec のアカウントが残るので、
 * 件の初めに API で SNS アカウントをすべて消す（後に走る spec はアカウントを自分で作る。実装プラン §8 の 31）。
 */
test.describe('#74 アカウント 0 件', () => {
  test('#74 /social/posts/new の「SNS画面へ」が /social?tab=accounts で、アカウントタブで「+ アカウントを追加」ができる', async ({
    page,
    request,
  }) => {
    for (let round = 0; round < 20; round += 1) {
      const list = await request.get('/api/v1/social/accounts?perPage=100');
      expect(list.status(), await list.text()).toBe(200);
      const accounts = ((await list.json()) as { data: { id: string }[] }).data;
      if (accounts.length === 0) break;
      for (const account of accounts) {
        const removed = await deleteJson(request, `/api/v1/social/accounts/${account.id}`);
        expect([200, 204, 404]).toContain(removed.status());
      }
    }
    createdPostIds = [];

    await page.goto('/social/posts/new');
    const link = page.getByRole('link', { name: 'SNS画面へ' });
    await expect(link).toHaveAttribute('href', '/social?tab=accounts');
    await link.click();
    await page.waitForURL((url) => url.pathname === '/social' && url.search === '?tab=accounts');
    await expectCurrentTab(page, 'アカウント');

    const displayName = `E2E 0件から ${unique()}`;
    await page.getByRole('button', { name: '+ アカウントを追加' }).click();
    const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await dialog.getByLabel('サービス').selectOption('x');
    await dialog.getByLabel('表示名').fill(displayName);
    await dialog.getByRole('button', { name: '追加' }).click();
    await expect(page.getByRole('row').filter({ hasText: displayName })).toBeVisible();

    // 後片付け（afterAll で消す）。
    const after = await request.get('/api/v1/social/accounts?perPage=100');
    const created = ((await after.json()) as { data: { id: string; displayName: string }[] }).data;
    for (const account of created) {
      if (account.displayName === displayName) createdAccountIds.push(account.id);
    }
  });
});
