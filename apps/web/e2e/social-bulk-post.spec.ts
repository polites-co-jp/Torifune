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
 * 送信待ちの一括投稿とチェックの当たり判定（057-social-bulk-post 設計 §5・§7、受け入れ条件 #50〜#58）。
 *
 * * #50 送信待ちタブ：状態のセル・選択の列のセルの隅で切り替わる。チェックボックスは 1 回だけ。本文・アカウントのセルでは変わらない
 * * #51 投稿タブ：状態のセルで切り替わる。補足のリンク「（送信待ちで承認）」は遷移だけ
 *
 * 画面は `plugins/example-plugin`（`publish()` と `manual()` の両方を持つ。`manual()` の URL は同じオリジンの
 * `/plugins/example-plugin/manual-post?text=…`）を題材に走らせる。前提の作り方・後片付け・API トークンの Rate Limit の
 * 避け方は `social-pending-tab.spec.ts` を写す（spec 同士は import しない）。
 *
 * **隔離**：送信待ちタブはこの spec が作ったアカウントの `?pendingAccount=<id>`、投稿タブは `?tab=posts&postAccount=<id>` で
 * 絞って開き、前の spec の残りと混ぜない。対象は自分で作った行のチェックだけで選ぶ（「このページの投稿をすべて選択」を
 * 使わない。実装プラン §7 の 9）。**投稿は件ごとに消し、Plugin・アカウント・トークンは `afterAll` で片付ける。**
 */

const origin = 'http://127.0.0.1:3000';
const PLUGIN_ID = 'example-plugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';
/**
 * API トークンを発行する要求が名乗る送信元。発行の Rate Limit（1 分 10 回）のキーは `operationId:IP` で、
 * E2E の全ファイルが 1 つのバケツを共有する。他の spec と重ならない文書用のアドレス（RFC 5737）を使う
 * （`social-pending-tab.spec.ts` の `TOKEN_ISSUE_IP` と同じ考え方）。
 */
const TOKEN_ISSUE_IP = '198.51.100.57';

/* 設計 §5.1・§7・055 の文言（`ui/social/labels.ts`） */
const KIND_AWAITING = '承認待ち';
const KIND_SCHEDULED = '予約済み';
const SELECT_ROW_PREFIX = 'この投稿を選択：';
const APPROVAL_ROW_NOTE = '（送信待ちで承認）';

/** この spec が作ったもの。`afterAll` で消す。 */
const createdAccountIds: string[] = [];
const createdTokenIds: string[] = [];
/** 件ごとに作った投稿。`afterEach` で消す。 */
let createdPostIds: string[] = [];

let accountId = '';
/** Bearer の API トークン（Scope `social.read` + `social.write`）で叩く要求。外部アプリの役。 */
let appRequest: APIRequestContext | undefined;

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** CSRF トークン。取得の Rate Limit に当たらないよう、要求のコンテキストごとに 1 回だけ取る。 */
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
  return `E2E一括投稿${label}${unique()}`;
}

/** 画面（管理者のセッション）から登録する。 */
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

/** 自動の予約（未来。定期実行が配信しない）。 */
async function createAutoScheduled(
  request: APIRequestContext,
  label: string,
  minutes = 7 * 24 * 60,
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

/** この spec のアカウントで絞った送信待ちタブ。 */
function pendingPath(): string {
  return `/social?pendingAccount=${accountId}`;
}

/** この spec のアカウントで絞った投稿タブ。 */
function postsPath(): string {
  return `/social?tab=posts&postAccount=${accountId}`;
}

/** 表の投稿の行グループ（056 で 1 投稿 = `<tbody>` 1 つ）。 */
function rowOf(page: Page, body: string): Locator {
  return page
    .getByRole('table')
    .locator('tbody')
    .filter({ hasText: body.slice(0, 40) });
}

/** 行の 1 段目の `index` 番目のセル（0 が選択の列、1 が状態）。 */
function firstTierCell(row: Locator, index: number): Locator {
  return row.locator('tr').first().locator('td').nth(index);
}

/** 行の 2 段目（本文）のセル。 */
function secondTierCell(row: Locator): Locator {
  return row.locator('tr').nth(1).locator('td').first();
}

function rowCheckbox(page: Page, body: string): Locator {
  return page.getByRole('checkbox', { name: `${SELECT_ROW_PREFIX}${body}` });
}

/** 導入済みか。同じ版を導入し直すと 422 になるので、叩く前に見る。 */
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
      displayName: `E2E 一括投稿 ${unique()}`,
      handle: `@${unique()}`,
      credentials: { handle: `sample_${unique()}`, appPassword: `pw_${unique()}` },
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    // トークンの発行だけ、この spec の送信元の IP を名乗る（冒頭の TOKEN_ISSUE_IP の注記）。
    const tokenCsrf = await csrf(request);
    const issued = await request.post('/api/v1/api-tokens', {
      headers: { ...headers(tokenCsrf), 'X-Forwarded-For': TOKEN_ISSUE_IP },
      data: {
        name: `e2e bulk post ${unique()}`,
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
    // アカウントを消すと、その投稿も一緒に消える。
    for (const id of createdAccountIds) {
      await deleteJson(request, `/api/v1/social/accounts/${id}`);
    }
    for (const id of createdTokenIds) {
      await deleteJson(request, `/api/v1/api-tokens/${id}`);
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

/** #50。送信待ちタブの当たり判定（設計 §5.1・ユーザー裁定 2）。 */
test.describe('#50 送信待ちタブのチェックの当たり判定', () => {
  test('#50 状態のセル（状態の文字）を押すとその行のチェックが付き、もう一度で外れる', async ({
    page,
    request,
  }) => {
    const post = await createAutoScheduled(request, '状態');

    await page.goto(pendingPath());
    const row = rowOf(page, post.body);
    const checkbox = rowCheckbox(page, post.body);
    await expect(checkbox).not.toBeChecked();

    await firstTierCell(row, 1).getByText(KIND_SCHEDULED, { exact: true }).click();
    await expect(checkbox).toBeChecked();
    await expect(page.getByText(/1\s*件を選択中/)).toBeVisible();

    await firstTierCell(row, 1).getByText(KIND_SCHEDULED, { exact: true }).click();
    await expect(checkbox).not.toBeChecked();
  });

  test('#50 選択の列のセルの隅（チェックボックスの外）を押すと付く', async ({ page, request }) => {
    const post = await createAutoScheduled(request, '隅');

    await page.goto(pendingPath());
    await firstTierCell(rowOf(page, post.body), 0).click({ position: { x: 2, y: 2 } });

    await expect(rowCheckbox(page, post.body)).toBeChecked();
  });

  test('#50 チェックボックスを押すと 1 回だけ切り替わる（付いたまま外れない）', async ({
    page,
    request,
  }) => {
    const post = await createAutoScheduled(request, '箱');

    await page.goto(pendingPath());
    await rowCheckbox(page, post.body).click();
    await expect(rowCheckbox(page, post.body)).toBeChecked();
    // セルへ泡立ったクリックで外れていない（少し待って見直す）。
    await page.waitForTimeout(300);
    await expect(rowCheckbox(page, post.body)).toBeChecked();
  });

  test('#50 2 段目（本文）とアカウントのセルを押しても変わらない', async ({ page, request }) => {
    const post = await createAutoScheduled(request, '本文');

    await page.goto(pendingPath());
    const row = rowOf(page, post.body);
    await secondTierCell(row).click();
    await firstTierCell(row, 2).click();
    await page.waitForTimeout(300);

    await expect(rowCheckbox(page, post.body)).not.toBeChecked();
  });
});

/** #51。投稿タブの当たり判定（設計 §5.1・§5.5）。 */
test.describe('#51 投稿タブのチェックの当たり判定', () => {
  test('#51 状態のセルを押すとチェックが付く', async ({ page, request }) => {
    const post = await createAutoScheduled(request, '投稿タブ');

    await page.goto(postsPath());
    await firstTierCell(rowOf(page, post.body), 1).click();

    await expect(rowCheckbox(page, post.body)).toBeChecked();
  });

  test('#51 承認待ちの行の状態のセルのリンク「（送信待ちで承認）」を押すと /social?pendingStatus=awaiting_approval へ移る', async ({
    page,
  }) => {
    const post = await requestApproval('投稿タブ承認');

    await page.goto(postsPath());
    const cell = firstTierCell(rowOf(page, post.body), 1);
    await expect(cell).toContainText(KIND_AWAITING);
    await cell.getByRole('link', { name: APPROVAL_ROW_NOTE }).click();

    await page.waitForURL(
      (url) =>
        url.pathname === '/social' && url.searchParams.get('pendingStatus') === 'awaiting_approval',
    );
  });
});
