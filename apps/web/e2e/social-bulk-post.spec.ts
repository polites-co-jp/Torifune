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
 * * #52 一括投稿の通し（窓 3 つ・戻ると記録のボタン・選ぶと次が開く・結果・API の状態）
 * * #53 戻る前は「投稿した」が無い・子の `window.opener` が `null`
 * * #54 途中でやめる、#55 409 と「飛ばして次へ」（窓は増えない）、#56 承認待ちの自動だけ（窓なし・Toast）
 * * #57 幅 375px、#58 送信待ちタブと投稿タブの帯のボタン（ユーザー裁定 3）
 *
 * **子の窓**は `page.context().waitForEvent('page')` で拾い、窓の数は context の `page` イベントの数で見る（`noopener` では
 * `popup` が出ないことがある。055 実装プラン §8 の 15）。窓を押す前に `waitForEvent` を作る（実装プラン §8 の 8）。
 * **「戻った」**は、Playwright がページを切り替えても `focus`・`blur` を起こさないので、子の窓を閉じてから
 * とりふねのページで `blur`・`focus` のイベントを起こして作る（設計 §15 R7・実装プラン §8 の 9）。
 * E2E のサーバは配信の定期実行が有効で、即投稿で承認した自動の予約は 1 分以内に配信されうる（055 実装プラン §8 の 30）。
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
const NARROW = { width: 375, height: 720 };
const BULK_POST_BUTTON = '一括投稿…';
const BULK_POST_TITLE = '一括投稿';
const CONFIRM_LABEL = '投稿する';
const SEQUENCE_DIALOG = /^手動投稿（/;
const RESULT_TITLE = '一括投稿の結果';
const POSTED_LABEL = '投稿した';
const NOT_POSTED_LABEL = '投稿しなかった';
const CONFIRM_FAIL_LABEL = '失敗にする';
const RECORD_NOW_LABEL = '記録へ進む';
const QUIT_LABEL = 'やめる';
const SKIP_LABEL = '飛ばして次へ';
const CLOSE_LABEL = '閉じる';
const STALE_IN_SEQUENCE = '内容が変わっています。この投稿は飛ばして次へ進めます。';
const MANUAL_NOT_POSTED_REASON = '手動投稿で『投稿しなかった』が選ばれました。';
const OLD_BULK_SEND = /^一括送信（承認）/;
const OLD_SEQUENCE = /^選んだ手動投稿を順に投稿/;

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

/** 予約時刻前の手動の予約（予約済み）。 */
async function createManualScheduled(
  request: APIRequestContext,
  label: string,
  minutes: number,
): Promise<Post> {
  return createBySession(request, label, {
    status: 'scheduled',
    deliveryMode: 'manual',
    scheduledAt: minutesFromNow(minutes),
  });
}

interface PostState {
  readonly status: string;
  readonly failureReason: string | null;
  readonly scheduledAt: string | null;
}

async function fetchPost(request: APIRequestContext, id: string): Promise<PostState> {
  const response = await request.get(`/api/v1/social/posts/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: PostState }).data;
}

function bulkPostButton(page: Page): Locator {
  return page.getByRole('button', { name: BULK_POST_BUTTON, exact: true });
}

function confirmDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: BULK_POST_TITLE, exact: true });
}

function sequenceDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: SEQUENCE_DIALOG });
}

function resultDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: RESULT_TITLE, exact: true });
}

function statusToast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text });
}

/**
 * とりふねの画面に戻ってきたことを起こす（設計 §5.4・§15 R7）。Playwright はページを切り替えても `focus`・`blur` を
 * 起こさないので、とりふねのページで `blur`（離れた）→ `focus`（戻った）のイベントを起こす（実装プラン §8 の 9）。
 */
async function comeBack(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    window.dispatchEvent(new Event('focus'));
  });
}

/** 子の窓の URL の `text`（example-plugin の投稿画面は本文を `text` に入れる）。 */
function textOfChild(child: Page): string | null {
  return new URL(child.url()).searchParams.get('text');
}

/** 帯の「一括投稿…」で確認を開く（選ぶのは自分で作った行のチェックだけ。実装プラン §7 の 9）。 */
async function openBulkPost(page: Page, posts: readonly Post[]): Promise<Locator> {
  await page.goto(pendingPath());
  for (const post of posts) {
    await rowCheckbox(page, post.body).check();
  }
  await bulkPostButton(page).click();
  const dialog = confirmDialog(page);
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

async function expectWithinViewport(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (box !== null) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(NARROW.width + 1);
  }
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

/** #52。一括投稿の通し（設計 §5.2〜§5.4・§7.3〜§7.5。ユーザー裁定 3・4、U1・U2 は (a)）。 */
test.describe('#52 一括投稿の通し', () => {
  test('#52 未来の自動の予約 1・承認待ちの自動 1・予約済みの手動 2・承認待ちの手動 1 を一括投稿：窓は 3 つ、戻ると記録のボタン、選ぶと次が開く', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const futureAuto = await createAutoScheduled(request, '未来自動');
    const awaitingAuto = await requestApproval('承認自動');
    const manualA = await createManualScheduled(request, '手動A', 30);
    const manualB = await createManualScheduled(request, '手動B', 40);
    const awaitingManualC = await requestApproval('承認手動C', { deliveryMode: 'manual' });

    let pageEvents = 0;
    page.context().on('page', () => {
      pageEvents += 1;
    });

    const confirm = await openBulkPost(page, [
      futureAuto,
      awaitingAuto,
      manualA,
      manualB,
      awaitingManualC,
    ]);
    await expect(confirm).toContainText('自動配信の予約 1 件');
    await expect(confirm).toContainText('承認待ち 2 件を承認して投稿します（自動 1・手動 1）');
    await expect(confirm).toContainText('手動投稿 3 件');

    // 「投稿する」で 1 つ目の窓（先頭の予約済みの手動投稿 A）が開く（U2 の (a)）。
    const firstOpened = page.context().waitForEvent('page');
    await confirm.getByRole('button', { name: CONFIRM_LABEL, exact: true }).click();
    const first = await firstOpened;
    await first.waitForLoadState('domcontentloaded');
    expect(textOfChild(first)).toBe(manualA.body);

    const sequence = sequenceDialog(page);
    await expect(sequence).toHaveAccessibleName(/手動投稿（\s*1\s*\/\s*3\s*件目）/);
    await first.close();
    await comeBack(page);

    // 戻ると「投稿した」が出て、押すと次の窓（B）が開く。
    const secondOpened = page.context().waitForEvent('page');
    await sequence.getByRole('button', { name: POSTED_LABEL, exact: true }).click();
    const second = await secondOpened;
    await second.waitForLoadState('domcontentloaded');
    expect(textOfChild(second)).toBe(manualB.body);
    await expect(sequence).toHaveAccessibleName(/手動投稿（\s*2\s*\/\s*3\s*件目）/);
    await second.close();
    await comeBack(page);

    // 「投稿しなかった」→「失敗にする」で次の窓（承認した C）が開く。
    await sequence.getByRole('button', { name: NOT_POSTED_LABEL, exact: true }).click();
    const thirdOpened = page.context().waitForEvent('page');
    await sequence.getByRole('button', { name: CONFIRM_FAIL_LABEL, exact: true }).click();
    const third = await thirdOpened;
    await third.waitForLoadState('domcontentloaded');
    expect(textOfChild(third)).toBe(awaitingManualC.body);
    await expect(sequence).toHaveAccessibleName(/手動投稿（\s*3\s*\/\s*3\s*件目）/);

    // 戻らずに「記録へ進む」→「投稿した」→ 終わりの表示。
    await sequence.getByRole('button', { name: RECORD_NOW_LABEL, exact: true }).click();
    await sequence.getByRole('button', { name: POSTED_LABEL, exact: true }).click();
    const result = resultDialog(page);
    await expect(result).toBeVisible();
    await result.getByRole('button', { name: CLOSE_LABEL, exact: true }).click();
    await expect(resultDialog(page)).toHaveCount(0);
    await third.close();

    expect(pageEvents).toBe(3);

    expect((await fetchPost(request, manualA.id)).status).toBe('published');
    const failed = await fetchPost(request, manualB.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe(MANUAL_NOT_POSTED_REASON);
    expect((await fetchPost(request, awaitingManualC.id)).status).toBe('published');
    expect(['scheduled', 'published']).toContain(
      (await fetchPost(request, awaitingAuto.id)).status,
    );
    const future = await fetchPost(request, futureAuto.id);
    if (future.status !== 'published') {
      expect(future.status).toBe('scheduled');
      expect(Date.parse(String(future.scheduledAt))).toBeLessThanOrEqual(Date.now());
    }

    // 送信待ちに承認待ち・予約済みの手動投稿として残らず、選択が外れる（実装プラン §8 の 19）。
    for (const post of [manualA, manualB, awaitingManualC]) {
      await expect(rowOf(page, post.body)).toHaveCount(0);
    }
    for (const post of [awaitingAuto, futureAuto]) {
      if ((await rowOf(page, post.body).count()) > 0) {
        await expect(rowOf(page, post.body)).not.toContainText(KIND_AWAITING);
        await expect(rowCheckbox(page, post.body)).not.toBeChecked();
      }
    }
  });
});

/** #53。戻る前は記録のボタンが出ない（設計 §5.4・U1 の (a)）。 */
test.describe('#53 戻る前の順に投稿', () => {
  test('#53 「投稿する」で子の窓が開いた後、ダイアログに「記録へ進む」があり「投稿した」が無い。子の窓の window.opener が null', async ({
    page,
    request,
  }) => {
    const manual = await createManualScheduled(request, '戻る前', 30);

    const confirm = await openBulkPost(page, [manual]);
    const opened = page.context().waitForEvent('page');
    await confirm.getByRole('button', { name: CONFIRM_LABEL, exact: true }).click();
    const child = await opened;

    const sequence = sequenceDialog(page);
    await expect(
      sequence.getByRole('button', { name: RECORD_NOW_LABEL, exact: true }),
    ).toBeVisible();
    await expect(sequence.getByRole('button', { name: POSTED_LABEL, exact: true })).toHaveCount(0);

    await child.waitForLoadState('domcontentloaded');
    expect(await child.evaluate(() => window.opener === null)).toBe(true);
    await child.close();
  });
});

/** #54。途中でやめる（設計 §7.5。055 裁定 6）。 */
test.describe('#54 途中でやめる', () => {
  test('#54 予約済みの手動 3 件で一括投稿 → 1 件目を記録 → 2 件目で「やめる」→ 記録していない 2 件は送信待ちに残り、選択が外れる', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const first = await createManualScheduled(request, 'やめる1', 30);
    const second = await createManualScheduled(request, 'やめる2', 40);
    const third = await createManualScheduled(request, 'やめる3', 50);

    const confirm = await openBulkPost(page, [first, second, third]);
    const firstOpened = page.context().waitForEvent('page');
    await confirm.getByRole('button', { name: CONFIRM_LABEL, exact: true }).click();
    await (await firstOpened).close();
    await comeBack(page);

    const sequence = sequenceDialog(page);
    const secondOpened = page.context().waitForEvent('page');
    await sequence.getByRole('button', { name: POSTED_LABEL, exact: true }).click();
    await (await secondOpened).close();
    await expect(sequence).toHaveAccessibleName(/手動投稿（\s*2\s*\/\s*3\s*件目）/);

    await sequence.getByRole('button', { name: QUIT_LABEL, exact: true }).click();
    const result = resultDialog(page);
    await expect(result).toContainText('記録していない手動投稿 2 件は送信待ちに残ります。');
    await result.getByRole('button', { name: CLOSE_LABEL, exact: true }).click();
    await expect(resultDialog(page)).toHaveCount(0);

    expect((await fetchPost(request, first.id)).status).toBe('published');
    expect((await fetchPost(request, second.id)).status).toBe('scheduled');
    expect((await fetchPost(request, third.id)).status).toBe('scheduled');
    await expect(rowOf(page, first.body)).toHaveCount(0);
    await expect(rowOf(page, second.body)).toHaveCount(1);
    await expect(rowOf(page, third.body)).toHaveCount(1);
    await expect(rowCheckbox(page, second.body)).not.toBeChecked();
    await expect(rowCheckbox(page, third.body)).not.toBeChecked();
  });
});

/** #55。見た後の変更は 409（設計 §5.3・§7.5・§15 R3）。 */
test.describe('#55 記録の 409', () => {
  test('#55 2 件目を表示した後に本文を PATCH すると「内容が変わっています…」、「飛ばして次へ」で 3 件目（窓は増えない）、2 件目は scheduled のまま', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const first = await createManualScheduled(request, '競合1', 30);
    const second = await createManualScheduled(request, '競合2', 40);
    const third = await createManualScheduled(request, '競合3', 50);

    let pageEvents = 0;
    page.context().on('page', () => {
      pageEvents += 1;
    });

    const confirm = await openBulkPost(page, [first, second, third]);
    const firstOpened = page.context().waitForEvent('page');
    await confirm.getByRole('button', { name: CONFIRM_LABEL, exact: true }).click();
    await (await firstOpened).close();
    await comeBack(page);

    const sequence = sequenceDialog(page);
    const secondOpened = page.context().waitForEvent('page');
    await sequence.getByRole('button', { name: POSTED_LABEL, exact: true }).click();
    await (await secondOpened).close();
    await expect(sequence).toHaveAccessibleName(/手動投稿（\s*2\s*\/\s*3\s*件目）/);

    // 2 件目を表示した後に、別の要求（外部アプリ）が本文を書き換える。
    const patched = await app().patch(`/api/v1/social/posts/${second.id}`, {
      data: { body: bodyOf('競合2書き換え') },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    await sequence.getByRole('button', { name: RECORD_NOW_LABEL, exact: true }).click();
    // 2 件目の「投稿した」で 3 件目の窓が先に開く（記録の要求より先。設計 §5.4）。
    const thirdOpened = page.context().waitForEvent('page');
    await sequence.getByRole('button', { name: POSTED_LABEL, exact: true }).click();
    await (await thirdOpened).close();
    await expect(sequence).toContainText(STALE_IN_SEQUENCE);
    const windowsBeforeSkip = pageEvents;

    await sequence.getByRole('button', { name: SKIP_LABEL, exact: true }).click();
    await expect(sequence).toHaveAccessibleName(/手動投稿（\s*3\s*\/\s*3\s*件目）/);
    await expect(sequence).toContainText(third.body);
    await page.waitForTimeout(1_000);
    expect(pageEvents).toBe(windowsBeforeSkip);
    expect(pageEvents).toBe(3);

    await sequence.getByRole('button', { name: QUIT_LABEL, exact: true }).click();
    await resultDialog(page).getByRole('button', { name: CLOSE_LABEL, exact: true }).click();

    expect((await fetchPost(request, first.id)).status).toBe('published');
    expect((await fetchPost(request, second.id)).status).toBe('scheduled');
    expect((await fetchPost(request, third.id)).status).toBe('scheduled');
  });
});

/** #56。承認待ちの自動だけ（設計 §7.4 の 7。055 #68 の置き換え）。 */
test.describe('#56 承認待ちの自動だけの一括投稿', () => {
  test('#56 承認待ちの自動 2 件で「投稿する」→ 子の窓は開かず、Toast「2 件を処理しました」、2 件が承認待ちでなくなる', async ({
    page,
    request,
  }) => {
    const first = await requestApproval('自動だけ1');
    const second = await requestApproval('自動だけ2');

    let pageEvents = 0;
    page.context().on('page', () => {
      pageEvents += 1;
    });

    const confirm = await openBulkPost(page, [first, second]);
    await expect(confirm).toContainText('承認待ち 2 件を承認して投稿します（自動 2）');
    await confirm.getByRole('button', { name: CONFIRM_LABEL, exact: true }).click();

    await expect(statusToast(page, /2\s*件を処理しました/)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(pageEvents).toBe(0);
    for (const post of [first, second]) {
      expect(['scheduled', 'published']).toContain((await fetchPost(request, post.id)).status);
      if ((await rowOf(page, post.body).count()) > 0) {
        await expect(rowOf(page, post.body)).not.toContainText(KIND_AWAITING);
      }
    }
  });
});

/** #57。幅 375px（設計 §7.7）。 */
test.describe('#57 狭い画面', () => {
  test.use({ viewport: NARROW });

  test('#57 帯の「一括投稿…」が見え、一括投稿の確認と順に投稿（returned）のダイアログが画面幅に収まり、ページ全体が横へスクロールしない', async ({
    page,
    request,
  }) => {
    const manual = await createManualScheduled(request, '狭い', 30);
    const awaiting = await requestApproval('狭い承認', {
      body: `E2E一括投稿狭い${unique()}${'x'.repeat(60)}`,
    });

    await page.goto(pendingPath());
    await rowCheckbox(page, manual.body).check();
    await rowCheckbox(page, awaiting.body).check();
    await expect(bulkPostButton(page)).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await bulkPostButton(page).click();
    const confirm = confirmDialog(page);
    await expect(confirm).toBeVisible();
    await expectWithinViewport(confirm);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    const opened = page.context().waitForEvent('page');
    await confirm.getByRole('button', { name: CONFIRM_LABEL, exact: true }).click();
    await (await opened).close();
    const sequence = sequenceDialog(page);
    await sequence.getByRole('button', { name: RECORD_NOW_LABEL, exact: true }).click();
    await expect(sequence.getByRole('button', { name: POSTED_LABEL, exact: true })).toBeVisible();
    await expectWithinViewport(sequence);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await sequence.getByRole('button', { name: QUIT_LABEL, exact: true }).click();
    await resultDialog(page).getByRole('button', { name: CLOSE_LABEL, exact: true }).click();
  });
});

/** #58。帯のボタン（ユーザー裁定 3）。 */
test.describe('#58 送信待ちタブと投稿タブの帯', () => {
  test('#58 送信待ちタブの帯に「一括送信（承認）」「選んだ手動投稿を順に投稿」が無く、投稿タブの帯には「一括送信（承認）…」がある', async ({
    page,
    request,
  }) => {
    const post = await createAutoScheduled(request, '帯');

    await page.goto(pendingPath());
    await rowCheckbox(page, post.body).check();
    await expect(bulkPostButton(page)).toBeVisible();
    await expect(page.getByRole('button', { name: OLD_BULK_SEND })).toHaveCount(0);
    await expect(page.getByRole('button', { name: OLD_SEQUENCE })).toHaveCount(0);

    await page.goto(postsPath());
    await rowCheckbox(page, post.body).check();
    await expect(page.getByRole('button', { name: /^一括送信（承認）…$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: BULK_POST_BUTTON, exact: true })).toHaveCount(0);
  });
});
