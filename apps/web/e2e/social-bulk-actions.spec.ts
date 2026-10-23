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
 * SNS 投稿の一括操作の画面（054-bulk-post-actions 設計 §9・§9.8・§9.11、受け入れ条件 #80〜#88）。
 *
 * * #80 登録元の列（トークンの名前／「管理画面」）と登録元の絞り込み、URL の `postSource=token:` と `tab=posts`（055 でアンカーなし）
 * * #81 承認待ちを絞って一括選択 →「一括送信（承認）」→「即投稿」→ Toast・予約済み・送信待ちタブで承認待ちでなくなる（055 で区画が送信待ちの表に替わった）
 * * #82 希望日時が過去と未来の承認待ち →「それぞれの希望日時に投稿」→ 結果のダイアログ、過去は承認待ちのまま。
 *   検証 1 回目で強めた分：選んだ直後の警告（中-1）、選んだ未来の予約を今すぐ送らない（低-1）、閉じた後に選択が消える（低-2）
 * * #83 未来の予約を「即投稿」→ 予約日時がいま → 配信の後に「配信済み」。強めた分：成功の Toast の後に選択が消える（低-2）
 * * #84 下書きと配信済みの「一括取り消し」→ 下書きだけが消える（ユーザー裁定 6）。
 *   強めた分：「削除する」の後は成功の Toast で、結果のダイアログは出ない（軽微-2）
 * * #85 閲覧者・編集者の出し分け
 * * #86 幅 375px で横スクロールしない、3 つのダイアログが画面幅に収まる、選択の列が表を動かさずに押せる
 * * #87 絞り込んで 2 ページ目へ移ると絞り込みが保たれ選択が消える、誤ったクエリは既定
 * * #88 設定 → API の発行フォームの説明
 *
 * 画面は `plugins/example-plugin`（`publish()` と `manual()` の両方を持つ）を題材に走らせる。
 * 投稿は外部アプリの形（Scope `social.read` + `social.write` の API トークン「ブログ連携-<乱数>」）で登録する。
 * `beforeAll` / `afterAll` は `social-approval.spec.ts`、横スクロールの検査は `responsive.spec.ts` を写す（import しない）。
 *
 * **このファイルは `social-account-id.spec.ts`・`social-approval.spec.ts` の後、`social-credentials.spec.ts`・
 * `social-publishing.spec.ts`・`social.spec.ts` の前に走る**（ファイル名の順に直列。実装プラン §7 の 10）。
 * Plugin と承認待ちの投稿を残すと、後の spec の前提（Plugin の無い状態、承認待ち 0 件で区画が描かれない）を
 * 壊すので、**投稿は件ごとに消し、Plugin・アカウント・利用者は `afterAll` で片付け、トークンは失効させる**。
 *
 * E2E のサーバは配信の定期実行が有効で、即投稿・今すぐ送るの予約は 1 分以内に配信されうる（実装プラン §8 の 23）。
 * 希望日時が過去の承認待ちは、登録の API に過去の `scheduledAt` を送って作る（DB を直接書き換えない。§8 の 24）。
 * 要素は設計 §9.10 と `ui/social/labels.ts` の文言・`aria-label` で引く。件数の文は数を含む部分だけを
 * 空白の有無を問わずに見る（実装プラン §8 の 53）。
 */

const origin = 'http://127.0.0.1:3000';
const PLUGIN_ID = 'example-plugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';
const NARROW = { width: 375, height: 720 };

/* 設計 §9.10 の文言（`ui/social/labels.ts`） */
const SOURCE_COLUMN = '登録元';
const SOURCE_SCREEN = '管理画面';
const FILTER_STATUS = '状態';
const FILTER_ACCOUNT = 'アカウント';
const FILTER_SOURCE = '登録元';
const FILTER_PER_PAGE = '表示件数';
const FILTER_ALL = 'すべて';
const FILTER_EMPTY = '条件に合う投稿がありません。';
const SELECT_PAGE = 'このページの投稿をすべて選択';
const SELECT_ROW_PREFIX = 'この投稿を選択：';
const BULK_SEND = '一括送信（承認）';
const BULK_SEND_NOW = /即投稿/;
const BULK_SEND_DESIRED = 'それぞれの希望日時に投稿';
const BULK_SEND_CONFIRM = '送る';
const BULK_DELETE = '一括取り消し';
const BULK_DELETE_TITLE = '投稿を一括で取り消しますか？';
const BULK_RESULT_TITLE = '一括操作の結果';
const REASON_DESIRED_PASSED = '希望日時を過ぎています';
/** 「それぞれの希望日時」を選んだときの警告（`BULK_SEND_WARN_DESIRED_PAST`。設計 §9.5 の図。数を含む部分だけを見る）。 */
const DESIRED_PAST_WARNING = /希望日時を過ぎている\s*1\s*件/;
/** 同じく、希望日時の無い承認待ちの警告（`BULK_SEND_WARN_NO_DESIRED`。設計 §9.5 の図。検証 2 回目 spec 低-1）。 */
const NO_DESIRED_WARNING = /希望日時が無い\s*1\s*件/;
/** 一括の 3 操作のパス（設計 §8.2〜§8.4）。 */
const BULK_PATH_PREFIX = '/api/v1/social/posts/bulk/';
const BULK_APPROVE_PATH = '/api/v1/social/posts/bulk/approve';
const BULK_PUBLISH_NOW_PATH = '/api/v1/social/posts/bulk/publish-now';
const API_TOKEN_NAME_NOTE = 'この名前は、SNS 画面の投稿一覧に『登録元』として表示されます';

/** この spec が作ったもの。`afterAll` で消す。 */
const createdAccountIds: string[] = [];
const createdTokenIds: string[] = [];
const createdUserIds: string[] = [];
/** 件ごとに作った投稿。`afterEach` で消す（承認待ちを次の件へ残さない）。 */
let createdPostIds: string[] = [];

/** `beforeAll` で作る共有の前提。 */
let accountId = '';
let tokenId = '';
let tokenName = '';
/** Bearer の API トークン（Scope `social.read` + `social.write`）で叩く要求。外部アプリ「ブログ連携」の役。 */
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

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

/**
 * 外部アプリ「ブログ連携」として投稿を登録する。`overrides` を省けば下書き。
 * 本文は example-plugin の上限（100 文字）に収める。
 */
async function createByToken(
  label: string,
  overrides: Record<string, unknown> = {},
): Promise<Post> {
  const body = `E2E一括${label}${unique()}`;
  const response = await app().post('/api/v1/social/posts', {
    data: { socialAccountId: accountId, ...overrides, body },
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdPostIds.push(id);
  return { id, body };
}

/** 画面（管理者のセッション）から登録する。登録元は「管理画面」になる（設計 §5.6）。 */
async function createBySession(request: APIRequestContext, label: string): Promise<Post> {
  const body = `E2E一括${label}${unique()}`;
  const response = await postJson(request, '/api/v1/social/posts', {
    socialAccountId: accountId,
    body,
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdPostIds.push(id);
  return { id, body };
}

interface PostState {
  readonly status: string;
  readonly scheduledAt: string | null;
}

async function fetchPost(request: APIRequestContext, id: string): Promise<PostState> {
  const response = await request.get(`/api/v1/social/posts/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: PostState }).data;
}

/**
 * 配信済みになるまで配信を回す。定期実行と重なって手動の実行が空振りしても、次の回で配信される。
 */
async function publishUntilPublished(request: APIRequestContext, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const { status } = await fetchPost(request, id);
        if (status === 'scheduled') {
          await postJson(request, '/api/v1/social/publish');
        }
        return status;
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toBe('published');
}

/** 投稿一覧の表（「登録元」の列を持つ表。承認待ちの区画の表と取り違えない）。 */
function postsTable(page: Page): Locator {
  return page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: SOURCE_COLUMN, exact: true }) });
}

/** 投稿一覧の本文の行。 */
function postsRows(page: Page): Locator {
  return postsTable(page).locator('tbody tr');
}

function postRow(page: Page, body: string): Locator {
  return postsRows(page).filter({ hasText: body });
}

/** 行のチェックボックス（`aria-label`「この投稿を選択：<本文の抜粋>」。設計 §9.1）。 */
function rowCheckbox(page: Page, body: string): Locator {
  return page.getByRole('checkbox', { name: `${SELECT_ROW_PREFIX}${body}` });
}

function selectPageCheckbox(page: Page): Locator {
  return page.getByRole('checkbox', { name: SELECT_PAGE, exact: true });
}

function filterSelect(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

/** 絞り込みを選び直す。選び直すとページ全体を読み込み直す（設計 §9.2）。 */
async function chooseFilter(
  page: Page,
  label: string,
  optionLabel: string,
  expectedUrl: RegExp,
): Promise<void> {
  await filterSelect(page, label).selectOption({ label: optionLabel });
  await expect(page).toHaveURL(expectedUrl);
}

/**
 * 送信待ちタブ（`/social`）の表の本文の行（055 設計 §9.3）。055 で承認待ちの区画
 * （`#approval-pending`）が無くなり、承認待ちは送信待ちタブの表に並ぶ。
 */
function pendingRow(page: Page, body: string): Locator {
  return page.getByRole('table').locator('tbody tr').filter({ hasText: body });
}

function sendDialog(page: Page): Locator {
  // 一括送信のダイアログの題は §9.10 で字面が決まっていないので「一括送信」を含む名前で引く（実装プラン §8 の 53）。
  return page.getByRole('dialog', { name: /一括送信/ });
}

function deleteDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: BULK_DELETE_TITLE });
}

function resultDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: BULK_RESULT_TITLE });
}

/** 一括の帯の「一括送信（承認）…」を押してダイアログを開く。 */
async function openSendDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: BULK_SEND }).click();
  const dialog = sendDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openDeleteDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: BULK_DELETE }).click();
  const dialog = deleteDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

function successToast(page: Page, text: RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
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

function sourceFilteredPath(): string {
  // 登録元の絞り込みのクエリ（設計 §9.2 の `postSource=token:<UUID>`）。
  return `/social?tab=posts&postSource=token:${tokenId}`;
}

/** 指定のロールの利用者を作り、その利用者でログインした画面のコンテキストを返す。 */
async function roleBrowserContext(
  request: APIRequestContext,
  browser: Browser,
  role: 'viewer' | 'editor',
): Promise<BrowserContext> {
  const loginId = `e2e_bulk_${role}_${unique()}`;
  const password = `e2e bulk ${role} correct horse battery staple`;
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
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'example',
      displayName: `E2E 一括 ${unique()}`,
      handle: `@${unique()}`,
      credentials: { handle: `sample_${unique()}`, appPassword: `pw_${unique()}` },
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    // 外部アプリ「ブログ連携」に渡すトークン。名前は登録元として一覧に出る（設計 §5.6）。
    tokenName = `ブログ連携-${unique()}`;
    const issued = await postJson(request, '/api/v1/api-tokens', {
      name: tokenName,
      scopes: ['social.read', 'social.write'],
    });
    expect(issued.status(), await issued.text()).toBe(201);
    const token = (await issued.json()) as { data: { token: string; id: string } };
    tokenId = token.data.id;
    createdTokenIds.push(tokenId);
    appRequest = await playwright.request.newContext({
      baseURL: origin,
      extraHTTPHeaders: { Authorization: `Bearer ${token.data.token}` },
    });
  } finally {
    await request.dispose();
  }
});

test.afterEach(async ({ request }) => {
  // CSRF の取得の Rate Limit に当たらないよう、1 回取ったトークンで消す（二重送信の Cookie は使い回せる）。
  const token = await csrf(request);
  for (const id of createdPostIds) {
    await request.delete(`/api/v1/social/posts/${id}`, {
      headers: headers(token),
      data: { csrfToken: token },
    });
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
    // トークンは消せないので失効させる。
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

/** #80。登録元の列と登録元の絞り込み（設計 §5.6・§9.1・§9.2）。 */
test.describe('#80 登録元の列と絞り込み', () => {
  test('#80 トークンで 2 件・画面で 1 件 → 登録元に「ブログ連携」×2 と「管理画面」×1 が出る', async ({
    page,
    request,
  }) => {
    const blog1 = await createByToken('ブログ1');
    const blog2 = await createByToken('ブログ2');
    const screen = await createBySession(request, '画面');

    await page.goto('/social?tab=posts');
    await expect(postsTable(page).getByRole('columnheader', { name: SOURCE_COLUMN })).toBeVisible();

    for (const post of [blog1, blog2]) {
      const row = postRow(page, post.body);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(tokenName);
      await expect(row).not.toContainText(SOURCE_SCREEN);
    }
    const screenRow = postRow(page, screen.body);
    await expect(screenRow).toHaveCount(1);
    await expect(screenRow).toContainText(SOURCE_SCREEN);
    await expect(screenRow).not.toContainText(tokenName);
  });

  test('#80 登録元で「ブログ連携」を選ぶと 2 件だけになり、URL に postSource=token: と tab=posts が付き、# が付かない', async ({
    page,
    request,
  }) => {
    const blog1 = await createByToken('ブログ1');
    const blog2 = await createByToken('ブログ2');
    const screen = await createBySession(request, '画面');

    await page.goto('/social?tab=posts');
    await chooseFilter(page, FILTER_SOURCE, tokenName, /[?&]postSource=token:[0-9a-fA-F-]+/);
    await expect(page).toHaveURL(/[?&]tab=posts(&|$)/);
    await expect(page).not.toHaveURL(/#/);

    await expect(postsRows(page)).toHaveCount(2);
    await expect(postRow(page, blog1.body)).toHaveCount(1);
    await expect(postRow(page, blog2.body)).toHaveCount(1);
    await expect(postRow(page, screen.body)).toHaveCount(0);
    // 選ばれた条件が帯に残る。
    await expect(filterSelect(page, FILTER_SOURCE).locator('option:checked')).toHaveText(tokenName);
  });
});

/** #81。承認待ちを絞って一括選択 → 即投稿（設計 §9.3〜§9.5・§9.7）。 */
test.describe('#81 一括送信（即投稿）', () => {
  test('#81 状態「承認待ち」＋登録元で絞り、一括選択 →「即投稿」→「送る」→ Toast、2 件が承認待ちでなくなり区画が消える', async ({
    page,
    request,
  }) => {
    const first = await createByToken('承認1', { publishTiming: 'after_approval' });
    const second = await createByToken('承認2', { publishTiming: 'after_approval' });

    // 送る前：送信待ちタブに 2 件が「承認待ち」で並ぶ（055 で区画が送信待ちの表に替わった）。
    await page.goto('/social');
    for (const post of [first, second]) {
      await expect(pendingRow(page, post.body)).toContainText('承認待ち');
    }

    await page.goto('/social?tab=posts');

    await chooseFilter(page, FILTER_STATUS, '承認待ち', /[?&]postStatus=awaiting_approval/);
    await chooseFilter(page, FILTER_SOURCE, tokenName, /[?&]postSource=token:/);
    await expect(page).toHaveURL(/[?&]postStatus=awaiting_approval/);
    await expect(postsRows(page)).toHaveCount(2);

    await selectPageCheckbox(page).check();
    await expect(rowCheckbox(page, first.body)).toBeChecked();
    await expect(rowCheckbox(page, second.body)).toBeChecked();
    await expect(page.getByText(/2\s*件を選択中/)).toBeVisible();

    const dialog = await openSendDialog(page);
    await expect(dialog).toContainText(/承認待ち\s*2\s*件/);
    await dialog.getByLabel(BULK_SEND_NOW).check();
    await dialog.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();

    await expect(successToast(page, /2\s*件を処理しました/)).toBeVisible();
    // 読み込み直すと、承認待ちの絞り込みには何も残らない。
    await expect(page.getByText(FILTER_EMPTY)).toBeVisible();

    // 送った後：送信待ちタブで 2 件が「承認待ち」でない（予約済み、または配信済みで表から消えている）。
    await page.goto('/social');
    await expect(page.getByRole('heading', { level: 2, name: '送信待ち' })).toBeVisible();
    for (const post of [first, second]) {
      await expect(pendingRow(page, post.body)).not.toContainText('承認待ち');
    }

    // 定期実行が先に配信していれば「配信済み」（実装プラン §8 の 23）。
    for (const post of [first, second]) {
      expect(['scheduled', 'published']).toContain((await fetchPost(request, post.id)).status);
    }
    await page.goto(sourceFilteredPath());
    for (const post of [first, second]) {
      await expect(postRow(page, post.body)).toContainText(/予約済み|配信済み/);
      await expect(postRow(page, post.body)).not.toContainText('承認待ち');
    }
  });
});

/** #82。それぞれの希望日時に投稿 → 過ぎたものは結果のダイアログに出る（設計 §8.2・§9.7。ユーザー裁定 2）。 */
test.describe('#82 一括送信（それぞれの希望日時）', () => {
  test('#82 希望日時が過去と未来の 2 件 → 結果のダイアログに過去の 1 件が「希望日時を過ぎています」で出て、閉じると未来は予約済み・過去は承認待ち', async ({
    page,
    request,
  }) => {
    const past = await createByToken('過去', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(-60),
    });
    const future = await createByToken('未来', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(24 * 60),
    });

    await page.goto('/social?tab=posts');
    await rowCheckbox(page, past.body).check();
    await rowCheckbox(page, future.body).check();

    const dialog = await openSendDialog(page);
    await dialog.getByLabel(BULK_SEND_DESIRED).check();
    await dialog.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();

    const result = resultDialog(page);
    await expect(result).toBeVisible();
    await expect(result).toContainText(/1\s*件を処理しました/);
    await expect(result).toContainText(/1\s*件は処理されませんでした/);
    await expect(result).toContainText(REASON_DESIRED_PASSED);
    await expect(result).toContainText(past.body);
    await expect(result).not.toContainText(future.body);

    await result.getByRole('button', { name: '閉じる' }).click();
    await expect(result).toHaveCount(0);

    await expect(postRow(page, future.body)).toContainText('予約済み');
    await expect(postRow(page, past.body)).toContainText('承認待ち');
    expect((await fetchPost(request, future.id)).status).toBe('scheduled');
    expect((await fetchPost(request, past.id)).status).toBe('awaiting_approval');
  });

  test('#82 「それぞれの希望日時に投稿」を選んだ直後、送る前のダイアログに「希望日時を過ぎている 1 件」と「希望日時が無い 1 件」の警告が出る（検証 1 回目 spec 中-1・検証 2 回目 spec 低-1）', async ({
    page,
  }) => {
    const past = await createByToken('過去', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(-60),
    });
    const future = await createByToken('未来', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(24 * 60),
    });
    // 希望日時の無い承認待ち（`scheduledAt` を送らない）。
    const noDesired = await createByToken('希望なし', { publishTiming: 'after_approval' });

    await page.goto('/social?tab=posts');
    await rowCheckbox(page, past.body).check();
    await rowCheckbox(page, future.body).check();
    await rowCheckbox(page, noDesired.body).check();

    const dialog = await openSendDialog(page);
    // 時機を選ぶ前は即投稿の内訳なので、希望日時の 2 つの警告は出ない（設計 §9.5・#69）。
    await expect(dialog).not.toContainText(DESIRED_PAST_WARNING);
    await expect(dialog).not.toContainText(NO_DESIRED_WARNING);

    await dialog.getByLabel(BULK_SEND_DESIRED).check();
    await expect(dialog).toContainText(DESIRED_PAST_WARNING);
    await expect(dialog).toContainText(NO_DESIRED_WARNING);

    // 送らずに閉じる（行は承認待ちのまま。後片付けは afterEach）。
    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('#82 選択に承認を経ていない未来の予約を含めても、「それぞれの希望日時」では今すぐ送らない（bulk/publish-now の要求が出ず、予約日時が同じ。検証 1 回目 spec 低-1）', async ({
    page,
    request,
  }) => {
    const past = await createByToken('過去', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(-60),
    });
    const future = await createByToken('未来', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(24 * 60),
    });
    const scheduled = await createByToken('予約', {
      publishTiming: 'scheduled',
      scheduledAt: minutesFromNow(24 * 60),
    });
    const scheduledBefore = await fetchPost(request, scheduled.id);

    const bulkRequests: string[] = [];
    page.on('request', (sent) => {
      const path = new URL(sent.url()).pathname;
      if (sent.method() === 'POST' && path.startsWith(BULK_PATH_PREFIX)) {
        bulkRequests.push(path);
      }
    });

    await page.goto('/social?tab=posts');
    for (const post of [past, future, scheduled]) {
      await rowCheckbox(page, post.body).check();
    }

    const dialog = await openSendDialog(page);
    await dialog.getByLabel(BULK_SEND_DESIRED).check();
    await dialog.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();

    // 過去の 1 件が承認されないので結果のダイアログが出る（送り終えた合図）。
    const result = resultDialog(page);
    await expect(result).toBeVisible();

    // 判別力：一括承認の要求は捉えている。今すぐ送るの要求は出ていない。
    expect(bulkRequests).toContain(BULK_APPROVE_PATH);
    expect(bulkRequests).not.toContain(BULK_PUBLISH_NOW_PATH);

    const scheduledAfter = await fetchPost(request, scheduled.id);
    expect(scheduledAfter.status).toBe('scheduled');
    expect(scheduledAfter.scheduledAt).toBe(scheduledBefore.scheduledAt);
  });

  test('#82 結果のダイアログを閉じた後、残った行のチェックボックスはすべて外れ、一括の帯の 2 つのボタンは disabled（検証 1 回目 spec 低-2）', async ({
    page,
  }) => {
    const past = await createByToken('過去', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(-60),
    });
    const future = await createByToken('未来', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(24 * 60),
    });
    const scheduled = await createByToken('予約', {
      publishTiming: 'scheduled',
      scheduledAt: minutesFromNow(24 * 60),
    });

    await page.goto('/social?tab=posts');
    for (const post of [past, future, scheduled]) {
      await rowCheckbox(page, post.body).check();
    }

    const dialog = await openSendDialog(page);
    await dialog.getByLabel(BULK_SEND_DESIRED).check();
    await dialog.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();

    const result = resultDialog(page);
    await expect(result).toBeVisible();
    await result.getByRole('button', { name: '閉じる' }).click();
    await expect(result).toHaveCount(0);

    // 3 行とも一覧に残る（承認待ち・予約済み・予約済み）。どれも選ばれていない。
    for (const post of [past, future, scheduled]) {
      await expect(postRow(page, post.body)).toHaveCount(1);
      await expect(rowCheckbox(page, post.body)).not.toBeChecked();
    }
    await expect(selectPageCheckbox(page)).not.toBeChecked();
    await expect(page.getByRole('button', { name: BULK_SEND })).toBeDisabled();
    await expect(page.getByRole('button', { name: BULK_DELETE })).toBeDisabled();
  });
});

/** #83。未来の予約を今すぐ送る（設計 §5.4・§8.3）。 */
test.describe('#83 予約を今すぐ送る', () => {
  test('#83 未来の予約を「即投稿」で送ると予約日時がいまになり、配信の後に「配信済み」', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const post = await createByToken('予約', {
      publishTiming: 'scheduled',
      scheduledAt: minutesFromNow(24 * 60),
    });

    await page.goto('/social?tab=posts');
    await expect(postRow(page, post.body)).toContainText('予約済み');
    await rowCheckbox(page, post.body).check();

    const dialog = await openSendDialog(page);
    await expect(dialog).toContainText(/予約済み\s*1\s*件を今すぐ送ります/);
    await dialog.getByLabel(BULK_SEND_NOW).check();
    // サーバとの時計のずれを吸収する。
    const before = Date.now() - 5_000;
    await dialog.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();
    await expect(successToast(page, /1\s*件を処理しました/)).toBeVisible();
    const after = Date.now() + 5_000;

    const sent = await fetchPost(request, post.id);
    expect(sent.scheduledAt).not.toBeNull();
    const scheduledAt = new Date(sent.scheduledAt ?? '').getTime();
    expect(scheduledAt).toBeGreaterThanOrEqual(before);
    expect(scheduledAt).toBeLessThanOrEqual(after);

    await publishUntilPublished(request, post.id);
    await page.reload();
    await expect(postRow(page, post.body)).toContainText('配信済み');
  });

  test('#83 成功の Toast の後、その行のチェックボックスは外れ、一括の帯の 2 つのボタンは disabled（検証 1 回目 spec 低-2）', async ({
    page,
  }) => {
    const post = await createByToken('予約', {
      publishTiming: 'scheduled',
      scheduledAt: minutesFromNow(24 * 60),
    });

    await page.goto('/social?tab=posts');
    await rowCheckbox(page, post.body).check();
    // 判別力：送る前は選ばれていて、帯のボタンが押せる。
    await expect(page.getByRole('button', { name: BULK_SEND })).toBeEnabled();

    const dialog = await openSendDialog(page);
    await dialog.getByLabel(BULK_SEND_NOW).check();
    await dialog.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();
    await expect(successToast(page, /1\s*件を処理しました/)).toBeVisible();

    // 読み込み直した後も行は一覧に残る（予約済みか、定期実行が先に配信していれば配信済み。実装プラン §8 の 23）。
    await expect(postRow(page, post.body)).toHaveCount(1);
    await expect(rowCheckbox(page, post.body)).not.toBeChecked();
    await expect(page.getByRole('button', { name: BULK_SEND })).toBeDisabled();
    await expect(page.getByRole('button', { name: BULK_DELETE })).toBeDisabled();
  });
});

/** #84。一括取り消しは下書き・承認待ち・予約済みだけを消す（設計 §5.5・§9.6。ユーザー裁定 6）。 */
test.describe('#84 一括取り消し', () => {
  test('#84 下書き 1 件と配信済み 1 件 →「1 件を削除」「対象外 1 件（配信済み 1）」→「削除する」→ 下書きだけが消える', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    const draft = await createByToken('草稿');
    const published = await createByToken('既配信', { publishTiming: 'now' });
    await publishUntilPublished(request, published.id);

    await page.goto('/social?tab=posts');
    await expect(postRow(page, draft.body)).toContainText('下書き');
    await expect(postRow(page, published.body)).toContainText('配信済み');
    await rowCheckbox(page, draft.body).check();
    await rowCheckbox(page, published.body).check();

    const dialog = await openDeleteDialog(page);
    await expect(dialog).toContainText(/1\s*件を削除/);
    await expect(dialog).toContainText(/対象外\s*1\s*件（配信済み\s*1）/);
    await expect(dialog).toContainText('この操作は取り消せません。');
    await dialog.getByRole('button', { name: '削除する' }).click();

    // 送らなかった配信済みの行は結果の「対象外」に数えないので、成功の Toast だけが出る
    // （設計 §9.7。検証 1 回目 spec 軽微-2・実装プラン §8 の 62）。
    await expect(successToast(page, /1\s*件を削除しました。/)).toBeVisible();
    await expect(resultDialog(page)).toHaveCount(0);

    await expect(postRow(page, draft.body)).toHaveCount(0);
    await expect(postRow(page, published.body)).toContainText('配信済み');

    const gone = await request.get(`/api/v1/social/posts/${draft.id}`);
    expect(gone.status()).toBe(404);
    expect((await fetchPost(request, published.id)).status).toBe('published');
  });
});

/** #85。表示の出し分け（設計 §10.1。表示制御であって、認可は UseCase）。 */
test.describe('#85 閲覧者・編集者', () => {
  test('#85 閲覧者には選択の列と一括の帯が無く、登録元の列と絞り込みはある', async ({
    request,
    browser,
  }) => {
    const post = await createByToken('閲覧');
    const context = await roleBrowserContext(request, browser, 'viewer');
    try {
      const page = await context.newPage();
      await page.goto('/social?tab=posts');

      await expect(postRow(page, post.body)).toContainText(tokenName);
      await expect(
        postsTable(page).getByRole('columnheader', { name: SOURCE_COLUMN }),
      ).toBeVisible();
      for (const label of [FILTER_STATUS, FILTER_ACCOUNT, FILTER_SOURCE, FILTER_PER_PAGE]) {
        await expect(filterSelect(page, label)).toBeVisible();
      }

      await expect(selectPageCheckbox(page)).toHaveCount(0);
      await expect(rowCheckbox(page, post.body)).toHaveCount(0);
      await expect(page.getByRole('button', { name: BULK_SEND })).toHaveCount(0);
      await expect(page.getByRole('button', { name: BULK_DELETE })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('#85 編集者には「一括送信（承認）」があり「一括取り消し」が無い', async ({
    request,
    browser,
  }) => {
    const post = await createByToken('編集者');
    const context = await roleBrowserContext(request, browser, 'editor');
    try {
      const page = await context.newPage();
      await page.goto('/social?tab=posts');

      await expect(postRow(page, post.body)).toBeVisible();
      await expect(selectPageCheckbox(page)).toHaveCount(1);
      await expect(rowCheckbox(page, post.body)).toHaveCount(1);
      await expect(page.getByRole('button', { name: BULK_SEND })).toHaveCount(1);
      await expect(page.getByRole('button', { name: BULK_DELETE })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

/** #86。幅 375px（設計 §9.11）。 */
test.describe('#86 狭い画面', () => {
  test.use({ viewport: NARROW });

  test('#86 絞り込み・選択・一括の帯がある /social が横スクロールせず、選択の列は表を横に動かさずに押せる', async ({
    page,
  }) => {
    const post = await createByToken('狭い画面', { publishTiming: 'after_approval' });

    await page.goto(sourceFilteredPath());
    await expect(postRow(page, post.body)).toBeVisible();
    await expect(filterSelect(page, FILTER_SOURCE)).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // 表は今までどおり表の中で横に動く。選択の列は先頭なので、動かさずにチェックできる。
    const scroller = page.locator('.tf-table-scroll').filter({ has: postsTable(page) });
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(0);
    await rowCheckbox(page, post.body).check();
    await expect(rowCheckbox(page, post.body)).toBeChecked();
    expect(await scroller.evaluate((element) => element.scrollLeft)).toBe(0);

    await expect(page.getByText(/1\s*件を選択中/)).toBeVisible();
    await expect(page.getByRole('button', { name: BULK_SEND })).toBeVisible();
    await expect(page.getByRole('button', { name: BULK_DELETE })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('#86 一括送信・一括取り消し・結果のダイアログが画面幅に収まる', async ({ page }) => {
    // 希望日時を過ぎた承認待ちを「それぞれの希望日時」で送り、結果のダイアログを出す。
    const post = await createByToken('狭いダイアログ', {
      publishTiming: 'after_approval',
      scheduledAt: minutesFromNow(-60),
    });

    await page.goto(sourceFilteredPath());
    await rowCheckbox(page, post.body).check();

    const send = await openSendDialog(page);
    await expectWithinViewport(send);
    await send.getByRole('button', { name: 'キャンセル' }).click();
    await expect(send).toHaveCount(0);

    const remove = await openDeleteDialog(page);
    await expectWithinViewport(remove);
    await remove.getByRole('button', { name: 'キャンセル' }).click();
    await expect(remove).toHaveCount(0);

    const again = await openSendDialog(page);
    await again.getByLabel(BULK_SEND_DESIRED).check();
    await again.getByRole('button', { name: BULK_SEND_CONFIRM, exact: true }).click();
    const result = resultDialog(page);
    await expect(result).toContainText(REASON_DESIRED_PASSED);
    await expectWithinViewport(result);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});

/** #87。ページ送りで絞り込みを保ち、選択は消える。画面のクエリの誤りは無視する（設計 §5.3・§9.2）。 */
test.describe('#87 絞り込みとページ送り', () => {
  test('#87 21 件を登録元で絞って 2 ページ目へ移ると絞り込みが保たれ、選択が消える', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const posts: Post[] = [];
    for (let index = 0; index < 21; index += 1) {
      posts.push(await createByToken(`頁${String(index).padStart(2, '0')}`));
    }

    await page.goto('/social?tab=posts');
    await chooseFilter(page, FILTER_SOURCE, tokenName, /[?&]postSource=token:/);
    await expect(postsRows(page)).toHaveCount(20);

    await selectPageCheckbox(page).check();
    await expect(page.getByText(/このページの\s*20\s*件を選択中（全\s*21\s*件）/)).toBeVisible();

    await page
      .getByRole('navigation', { name: 'ページ送り' })
      .last()
      .getByRole('button', { name: '次へ' })
      .click();
    await expect(page).toHaveURL(/[?&]postPage=2(&|#|$)/);
    await expect(page).toHaveURL(/[?&]postSource=token:/);
    await expect(page).toHaveURL(/[?&]tab=posts(&|$)/);
    await expect(page).not.toHaveURL(/#/);

    await expect(postsRows(page)).toHaveCount(1);
    // 最も古い 1 件が 2 ページ目に回る（新しい順）。
    const oldest = posts[0];
    if (oldest === undefined) throw new Error('投稿が無い');
    await expect(postRow(page, oldest.body)).toHaveCount(1);
    await expect(filterSelect(page, FILTER_SOURCE).locator('option:checked')).toHaveText(tokenName);
    await expect(rowCheckbox(page, oldest.body)).not.toBeChecked();
    await expect(selectPageCheckbox(page)).not.toBeChecked();
    await expect(page.getByText(/^\s*0\s*件を選択中\s*$/)).toBeVisible();
  });

  test('#87 /social?tab=posts&postStatus=xxx&postPerPage=abc&postSource=token:zzz は 200 で、絞り込みは「すべて」・20 件', async ({
    page,
  }) => {
    const response = await page.goto(
      '/social?tab=posts&postStatus=xxx&postPerPage=abc&postSource=token:zzz',
    );
    expect(response?.status()).toBe(200);

    await expect(filterSelect(page, FILTER_STATUS).locator('option:checked')).toHaveText(
      FILTER_ALL,
    );
    await expect(filterSelect(page, FILTER_SOURCE).locator('option:checked')).toHaveText(
      FILTER_ALL,
    );
    await expect(filterSelect(page, FILTER_PER_PAGE).locator('option:checked')).toHaveText('20');
  });
});

/** #88。設定 → API の発行フォームの説明（設計 §9.9）。 */
test.describe('#88 設定 → API の説明', () => {
  test('#88 発行フォームに「この名前は、SNS 画面の投稿一覧に『登録元』として表示されます」が出る', async ({
    page,
  }) => {
    await page.goto('/settings?tab=api');
    await expect(page.getByText(API_TOKEN_NAME_NOTE)).toBeVisible();
  });
});
