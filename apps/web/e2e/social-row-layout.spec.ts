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
 * SNS 投稿一覧の 2 段表示（056-social-row-layout 設計 §5、受け入れ条件 #22〜#28）。
 *
 * * #22 送信待ちタブ：200 字の本文の行グループ（`<tbody>`）に行が 2 つ、1 段目に「予約済み」「編集」「削除」、
 *   2 段目の本文の要素の `textContent` が本文と一致
 * * #23 投稿タブ：同じ
 * * #24 幅 1280：2 段目の本文の要素の `innerText` が本文と一致（改行の位置が保たれ、空白に畳まれない）
 * * #25 幅 1280：「編集」と「削除」の上端が同じ（横に並ぶ）
 * * #26 幅 375：200 字の本文と空白の無い 200 字の URL の本文があっても、両タブでページが横へスクロールしない
 * * #27 投稿タブ：行グループの「削除」→「削除する」で、その行グループが消える
 * * #28 送信待ちタブ：承認待ちの行グループの「承認する…」でダイアログが開き、本文の全文が出る
 *
 * **アカウントは Plugin の無い provider（`mastodon`）で作る**（056 実装プラン §8 の 10）。`example-plugin` は
 * 本文の上限を 100 字と宣言しており（登録時に検査される）、200 字の本文を登録できない。publisher の無い
 * provider には上限が掛からない（`social.spec.ts` の「Core が知らない provider でも登録できる」と同じ）。
 * 予約は自動の配信方法・予約日時を 7 日後にして、配信ジョブに触れさせない（実装プラン §8 の 4）。
 * 承認待ちは外部アプリの形（Scope `social.read` + `social.write` の API トークン）で `publishTiming: 'after_approval'`
 * を送って作る（`social-approval.spec.ts`・`social-pending-tab.spec.ts` を写す。import しない）。
 *
 * **隔離**：表は、この spec が作ったアカウントで絞って開く（送信待ちは `?pendingAccount=<id>`、投稿タブは
 * `?tab=posts&postAccount=<id>`）。**投稿は件ごとに消し、アカウント・トークンは `afterAll` で片付ける**
 * （このファイルは `social-publishing.spec.ts` の後、`social.spec.ts` の前に走る。投稿タブの 1 ページ目を汚さない）。
 *
 * 2 段目の本文の要素は、行グループの 2 つ目の `<tr>` の中で `white-space` が `pre-wrap` の要素
 * （`getComputedStyle` で選ぶ。テスト用の属性は足さない。実装プラン §8 の 7）。
 */

const origin = 'http://127.0.0.1:3000';
const ADMIN_STORAGE = './e2e/.auth/admin.json';
const WIDE = { width: 1280, height: 800 };
const NARROW = { width: 375, height: 812 };
/**
 * API トークンを発行する要求が名乗る送信元。発行の Rate Limit（1 分 10 回）のキーは `operationId:IP` で、
 * E2E の全ファイルが 1 つのバケツを共有する。直前の spec と同じ 1 分に入って 429 にならないよう、
 * 文書用のアドレス（RFC 5737）で別のバケツを使う（`social-pending-tab.spec.ts` の `198.51.100.55` とも分ける）。
 */
const TOKEN_ISSUE_IP = '198.51.100.56';

/* 文言（`ui/social/labels.ts`・055 設計 §9.3.4） */
const KIND_SCHEDULED = '予約済み';
const STATUS_SCHEDULED = '予約済み';
const APPROVE_DIALOG_TITLE = '投稿を承認する';
const DELETE_CONFIRM = '削除する';

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

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
}

interface Post {
  readonly id: string;
  readonly body: string;
  /** 行グループを引く印（本文の先頭。空白を含まない）。 */
  readonly key: string;
}

/**
 * 改行・空行・全角の空白・連続した空白を含む、ちょうど 200 字の本文（実装プラン §8 の 5）。
 * 先頭の印（`key`）は空白を含まず、他の本文の部分文字列にならない。「予約済み」「編集」「削除」「承認待ち」を含まない。
 */
function multilineBody(key: string): string {
  const head = `${key}一行目の本文です。\n二行目  連続した空白\n\n四行目\u3000全角の空白の後`;
  const tail = '末尾まで確かめる本文。';
  return `${head}${'う'.repeat(200 - head.length - tail.length)}${tail}`;
}

/** 空白の無い 200 字の URL を本文に持つ本文（実装プラン §8 の 6）。 */
function longUrlBody(key: string): string {
  return `${key} https://example.com/${'u'.repeat(200)}`;
}

function keyOf(label: string): string {
  return `E2E二段${label}${unique()}`;
}

/** 画面（管理者のセッション）から自動の予約を登録する（7 日後。配信ジョブに触れさせない）。 */
async function createScheduled(
  request: APIRequestContext,
  key: string,
  body: string,
): Promise<Post> {
  const response = await postJson(request, '/api/v1/social/posts', {
    socialAccountId: accountId,
    body,
    status: 'scheduled',
    deliveryMode: 'auto',
    scheduledAt: daysFromNow(7),
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdPostIds.push(id);
  return { id, body, key };
}

/** 外部アプリとして承認待ちの投稿を登録する（`publishTiming: 'after_approval'`）。 */
async function requestApproval(key: string, body: string): Promise<Post> {
  const response = await app().post('/api/v1/social/posts', {
    data: { socialAccountId: accountId, publishTiming: 'after_approval', body },
  });
  expect(response.status(), await response.text()).toBe(201);
  const data = ((await response.json()) as { data: { id: string; status: string } }).data;
  expect(data.status).toBe('awaiting_approval');
  createdPostIds.push(data.id);
  return { id: data.id, body, key };
}

function pendingPath(): string {
  return `/social?pendingAccount=${accountId}`;
}

function postsPath(): string {
  return `/social?tab=posts&postAccount=${accountId}`;
}

/** 表の、印を含む投稿の行グループ（`<tbody>`。056 設計 §5.1）。 */
function rowGroup(page: Page, key: string): Locator {
  return page.getByRole('table').locator('tbody').filter({ hasText: key });
}

/**
 * 行の「編集」。`<Link><Button>編集</Button></Link>` の入れ子で link と button の両方に当たるので、
 * 外側の link だけを引く（両方を `or` で引くと strict mode で 2 要素になる）。
 */
function editControl(scope: Locator): Locator {
  return scope.getByRole('link', { name: '編集' });
}

function deleteControl(scope: Locator): Locator {
  return scope.getByRole('button', { name: '削除', exact: true });
}

interface BodyText {
  readonly textContent: string | null;
  readonly innerText: string;
}

/** 2 段目（行グループの 2 つ目の `<tr>`）の中の、`white-space: pre-wrap` の要素の文字（無ければ null）。 */
async function secondTierBody(group: Locator): Promise<BodyText | null> {
  return group
    .locator('tr')
    .nth(1)
    .evaluate((tr) => {
      const found = [...tr.querySelectorAll<HTMLElement>('*')].filter(
        (element) => getComputedStyle(element).whiteSpace === 'pre-wrap',
      );
      const element = found[0];
      if (found.length !== 1 || element === undefined) return null;
      return { textContent: element.textContent, innerText: element.innerText };
    });
}

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px の丸め誤差は許す。
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.beforeAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    // Plugin の無い provider（本文の上限が掛からない。冒頭の注記）。
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'mastodon',
      displayName: `E2E 二段 ${unique()}`,
      handle: `@${unique()}`,
      credential: `e2e-row-layout-${unique()}`,
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    const tokenCsrf = await csrf(request);
    const issued = await request.post('/api/v1/api-tokens', {
      headers: { ...headers(tokenCsrf), 'X-Forwarded-For': TOKEN_ISSUE_IP },
      data: {
        name: `e2e row layout ${unique()}`,
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
  } finally {
    await request.dispose();
  }
});

/** 2 つのタブ（#22・#23 と #24・#25 は同じ形で両方を見る）。 */
const TABS = [
  { name: '送信待ち', path: pendingPath, statusLabel: KIND_SCHEDULED, criterion: '#22' },
  { name: '投稿', path: postsPath, statusLabel: STATUS_SCHEDULED, criterion: '#23' },
] as const;

for (const tab of TABS) {
  test.describe(`${tab.criterion} ${tab.name}タブの 2 段`, () => {
    test.use({ viewport: WIDE });

    test(`${tab.criterion} ${tab.name}タブ：改行を含む 200 字の本文の行グループに行が 2 つあり、1 段目に「${tab.statusLabel}」と「編集」「削除」がある`, async ({
      page,
      request,
    }) => {
      const key = keyOf('段');
      const post = await createScheduled(request, key, multilineBody(key));
      expect(post.body).toHaveLength(200);

      await page.goto(tab.path());
      const group = rowGroup(page, post.key);
      await expect(group).toHaveCount(1);
      await expect(group.locator('tr')).toHaveCount(2);

      const first = group.locator('tr').nth(0);
      await expect(first).toContainText(tab.statusLabel);
      await expect(editControl(first)).toBeVisible();
      await expect(deleteControl(first)).toBeVisible();
    });

    test(`${tab.criterion} ${tab.name}タブ：2 段目の本文の要素の textContent が 200 字の本文と一致する（切れない）`, async ({
      page,
      request,
    }) => {
      const key = keyOf('全');
      const post = await createScheduled(request, key, multilineBody(key));

      await page.goto(tab.path());
      const group = rowGroup(page, post.key);
      await expect(group).toHaveCount(1);

      const body = await secondTierBody(group);
      expect(body, '2 段目の white-space: pre-wrap の要素').not.toBeNull();
      expect(body?.textContent).toBe(post.body);
    });
  });

  test.describe(`#24・#25 幅 1280 の${tab.name}タブ`, () => {
    test.use({ viewport: WIDE });

    test(`#24 ${tab.name}タブ：2 段目の本文の要素の innerText が本文と一致する（改行の位置が保たれ、空白に畳まれない）`, async ({
      page,
      request,
    }) => {
      const key = keyOf('改');
      const post = await createScheduled(request, key, multilineBody(key));

      await page.goto(tab.path());
      const group = rowGroup(page, post.key);
      await expect(group).toHaveCount(1);

      const body = await secondTierBody(group);
      expect(body, '2 段目の white-space: pre-wrap の要素').not.toBeNull();
      expect(body?.innerText).toBe(post.body);
      expect(body?.innerText.split('\n')).toHaveLength(post.body.split('\n').length);
    });

    test(`#25 ${tab.name}タブ：1 段目の「編集」と「削除」の上端が同じ（横に並ぶ）`, async ({
      page,
      request,
    }) => {
      const key = keyOf('横');
      const post = await createScheduled(request, key, multilineBody(key));

      await page.goto(tab.path());
      const first = rowGroup(page, post.key).locator('tr').nth(0);
      await expect(editControl(first)).toBeVisible();
      await expect(deleteControl(first)).toBeVisible();

      const edit = await editControl(first).boundingBox();
      const remove = await deleteControl(first).boundingBox();
      expect(edit).not.toBeNull();
      expect(remove).not.toBeNull();
      expect(
        Math.abs((edit?.y ?? 0) - (remove?.y ?? Number.POSITIVE_INFINITY)),
      ).toBeLessThanOrEqual(1);
    });
  });
}

test.describe('#26 幅 375 で横に伸びない', () => {
  test.use({ viewport: NARROW });

  for (const tab of TABS) {
    test(`#26 ${tab.name}タブ：200 字の本文と空白の無い 200 字の URL の本文の投稿があっても、ページ全体が横へスクロールしない`, async ({
      page,
      request,
    }) => {
      const longKey = keyOf('狭');
      const urlKey = keyOf('網');
      const long = await createScheduled(request, longKey, multilineBody(longKey));
      const url = await createScheduled(request, urlKey, longUrlBody(urlKey));

      await page.goto(tab.path());
      await expect(rowGroup(page, long.key)).toHaveCount(1);
      await expect(rowGroup(page, url.key)).toHaveCount(1);
      await expect(rowGroup(page, url.key)).toContainText(`https://example.com/${'u'.repeat(200)}`);

      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  }
});

test.describe('#27 投稿タブの行グループの削除', () => {
  test.use({ viewport: WIDE });

  test('#27 行グループの「削除」→ 確認 →「削除する」で、その投稿の行グループが消える', async ({
    page,
    request,
  }) => {
    const key = keyOf('消');
    const post = await createScheduled(request, key, multilineBody(key));
    const otherKey = keyOf('残');
    const other = await createScheduled(request, otherKey, multilineBody(otherKey));

    await page.goto(postsPath());
    const group = rowGroup(page, post.key);
    await expect(group).toHaveCount(1);

    await deleteControl(group).click();
    await page.getByRole('button', { name: DELETE_CONFIRM }).click();

    await expect(rowGroup(page, post.key)).toHaveCount(0);
    await expect(rowGroup(page, other.key)).toHaveCount(1);
    expect((await request.get(`/api/v1/social/posts/${post.id}`)).status()).toBe(404);
  });
});

test.describe('#28 送信待ちタブの承認のダイアログ', () => {
  test.use({ viewport: WIDE });

  test('#28 承認待ちの投稿の行グループの「承認する…」でダイアログが開き、本文の全文が出る', async ({
    page,
  }) => {
    const key = keyOf('承');
    const post = await requestApproval(key, multilineBody(key));

    await page.goto(pendingPath());
    const group = rowGroup(page, post.key);
    await expect(group).toHaveCount(1);
    await group.getByRole('button', { name: /^承認する/ }).click();

    const dialog = page.getByRole('dialog', { name: APPROVE_DIALOG_TITLE });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(post.body);
    await expect(dialog).toContainText('末尾まで確かめる本文。');
  });
});
