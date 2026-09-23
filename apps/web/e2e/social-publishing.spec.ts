import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import pg from 'pg';

/**
 * SNS 配信の API と画面（035-social-publishing 設計 §6.5.9 / §7、
 * 受け入れ条件 #62、#65、#73〜#78、#80）。
 *
 * - `POST /api/v1/social/publish`（`system.manage`）：200 / 401 / 403 / 409 + `Retry-After`
 * - 資格情報が応答本文のどこにも出ない（配信を通した後も）
 * - 手動投稿待ちの区画・子ウィンドウ・「投稿した」「取りやめ」・アカウント追加の資格情報の欄
 *
 * 画面は `plugins/example-plugin` のループバック publisher を題材に走らせる
 * （実装プラン §8 の 12）。`beforeAll` / `afterAll` は `plugin-example.spec.ts` を写す。
 *
 * **`apps/web` の vitest は `environment: 'node'` で DOM が無い**（実装プラン §8 末尾）。
 * 入力・送信・開閉を伴う挙動はここでしか見られないので、薄くしない。
 */

const origin = 'http://127.0.0.1:3000';

/** `infrastructure/job-lock.ts` と同じ鍵（029 設計 §6.1.6）。 */
const JOB_LOCK_NAMESPACE = 7_602_931;

function jobLockKey(name: string): number {
  return createHash('sha256').update(name).digest().readInt32BE(0);
}

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

async function withDatabase<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const connectionString = process.env['DATABASE_URL'];
  expect(connectionString, 'E2E には DATABASE_URL が必要').toBeTruthy();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** 別の接続で `social.publish` のロックを保持したまま `fn` を実行する。 */
async function whileHoldingLock<T>(fn: () => Promise<T>): Promise<T> {
  return withDatabase(async (client) => {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [JOB_LOCK_NAMESPACE, jobLockKey('social.publish')],
    );
    expect(locked.rows[0]?.locked, '定期実行と重なった。やり直す').toBe(true);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        JOB_LOCK_NAMESPACE,
        jobLockKey('social.publish'),
      ]);
    }
  });
}

/** 数秒前（サーバーとクライアントの時計のずれを吸収する）。 */
function shortlyBefore(): Date {
  return new Date(Date.now() - 5_000);
}

async function manualRunCount(since: Date): Promise<number> {
  return withDatabase(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM job_runs
        WHERE job_name = 'social.publish' AND triggered_by = 'manual' AND started_at >= $1`,
      [since],
    );
    return Number(result.rows[0]?.count ?? '0');
  });
}

async function publish(request: APIRequestContext): Promise<APIResponse> {
  const token = await csrf(request);
  return request.post('/api/v1/social/publish', {
    headers: headers(token),
    data: { csrfToken: token },
  });
}

/** `viewer` は `social.read` を持ち `system.manage` を持たない。 */
async function viewerContext(
  request: APIRequestContext,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  const token = await csrf(request);
  const loginId = `e2e_pub_viewer_${Math.random().toString(36).slice(2, 10)}`;
  const password = 'e2e publish viewer correct horse battery staple';
  const created = await request.post('/api/v1/users', {
    headers: headers(token),
    data: {
      loginId,
      displayName: `E2E ${loginId}`,
      email: `${loginId}@example.com`,
      password,
      roles: ['viewer'],
      csrfToken: token,
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  const context = await playwright.request.newContext({ baseURL: origin });
  const loginToken = await csrf(context);
  const login = await context.post('/api/v1/auth/login', {
    headers: headers(loginToken),
    data: { loginId, password, csrfToken: loginToken },
  });
  expect(login.status(), await login.text()).toBe(200);
  return context;
}

/**
 * `summary` のキー（設計 §6.5.7、受け入れ条件 #57 / #62）。
 *
 * **2026-09-23 に 8 → 9 へ（裁定 #9）。** 「後ろへ送った」（`skipped`）と
 * 「3 回飛ばして諦めた」（`skipFailed`）を 1 つのキーにまとめない。
 */
const SUMMARY_KEYS = [
  'interrupted',
  'due',
  'skipped',
  'skipFailed',
  'attempted',
  'published',
  'retried',
  'failed',
  'unrecorded',
];

/** #62。`POST /api/v1/social/publish`（`TORIFUNE_SCHEDULER=off` の運用を SNS でも成り立たせる）。 */
test.describe('#62 POST /api/v1/social/publish', () => {
  test('#62 管理者では 200 で { data: <summary> } を返す', async ({ request }) => {
    const response = await publish(request);
    expect(response.status(), await response.text()).toBe(200);

    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data).sort()).toEqual([...SUMMARY_KEYS].sort());
    for (const key of SUMMARY_KEYS) {
      expect(typeof body.data[key], key).toBe('number');
    }
  });

  test("#62 job_runs に triggered_by = 'manual' の行が残る", async ({ request }) => {
    const since = shortlyBefore();

    expect((await publish(request)).status()).toBe(200);

    expect(await manualRunCount(since)).toBeGreaterThanOrEqual(1);
  });

  test('#62 未認証では 401', async ({ request }) => {
    // **API 基盤は CSRF 検証を認証より先に行う**（`api/route.ts`）。Cookie を丸ごと
    // 落とすと CSRF（二重送信）で 403 になり、認証の 401 まで届かない
    // （`jobs.spec.ts` の `POST /webhooks/deliver` が `[401, 403]` を許しているのと同じ事情）。
    // **CSRF の Cookie だけを持たせ、セッションを持たない**要求にして 401 を実際に踏む。
    const csrfToken = 'e2e-anonymous-csrf-token';
    const response = await request.post('/api/v1/social/publish', {
      headers: {
        Cookie: `torifune_csrf=${csrfToken}`,
        'X-CSRF-Token': csrfToken,
        Origin: origin,
      },
      data: { csrfToken },
    });

    expect(response.status(), await response.text()).toBe(401);
  });

  test('#62 system.manage を持たない viewer では 403', async ({ request, playwright }) => {
    const viewer = await viewerContext(request, playwright);
    try {
      const response = await publish(viewer);

      expect(response.status(), await response.text()).toBe(403);
    } finally {
      await viewer.dispose();
    }
  });

  test('#62 別の接続がロックを保持している間は 409 と Retry-After: 10', async ({ request }) => {
    // 手動（API）は解放を待つ。待っても取れなければ 409（029 設計 §6.3 と同じ形）。
    test.setTimeout(60_000);

    const response = await whileHoldingLock(async () => publish(request));

    expect(response.status(), await response.text()).toBe(409);
    expect(response.headers()['retry-after']).toBe('10');

    const body = (await response.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('CONFLICT');
    expect(Array.isArray(body.error.details?.['job'])).toBe(true);
  });
});

/**
 * #65。**資格情報は応答本文のどこにも出ない**（設計 §6.4 / §6.5.5）。
 *
 * 応答は `credentialConfigured` だけを返す（05 §18）。配信を通した後も変わらない。
 */
test.describe('#65 資格情報が応答本文に出ない', () => {
  const MARKER = 'CRED-MARKER';

  test('#65 配信を実行しても 4 つの応答に資格情報が現れない', async ({ request }) => {
    const token = await csrf(request);
    const createdAccount = await request.post('/api/v1/social/accounts', {
      headers: headers(token),
      data: {
        provider: 'x',
        displayName: 'E2E 配信の資格情報',
        handle: '@e2e_publish',
        credential: MARKER,
        status: 'connected',
        csrfToken: token,
      },
    });
    expect(createdAccount.status(), await createdAccount.text()).toBe(201);
    const accountId = ((await createdAccount.json()) as { data: { id: string } }).data.id;

    const postToken = await csrf(request);
    const createdPost = await request.post('/api/v1/social/posts', {
      headers: headers(postToken),
      data: {
        socialAccountId: accountId,
        body: 'E2E 配信の確認',
        status: 'scheduled',
        // **配信 Plugin が無くても断らない**（要件 §4 裁定 #8）。
        deliveryMode: 'auto',
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        csrfToken: postToken,
      },
    });
    expect(createdPost.status(), await createdPost.text()).toBe(201);
    const postId = ((await createdPost.json()) as { data: { id: string } }).data.id;

    try {
      expect((await publish(request)).status()).toBe(200);

      for (const path of [
        '/api/v1/social/posts',
        `/api/v1/social/posts/${postId}`,
        `/api/v1/social/accounts/${accountId}`,
        '/api/v1/jobs',
      ]) {
        const response = await request.get(path);
        expect(response.status(), path).toBe(200);
        expect(await response.text(), path).not.toContain(MARKER);
      }

      // 「設定済み」だけは見せる（何も設定されていないのと区別が付かないと運用できない）。
      const account = (await (
        await request.get(`/api/v1/social/accounts/${accountId}`)
      ).json()) as {
        data: { credentialConfigured: boolean };
      };
      expect(account.data.credentialConfigured).toBe(true);
    } finally {
      // 既存の `social.spec.ts` の前提（#79）を壊さないよう、作ったものは消す。
      const cleanupPost = await csrf(request);
      await request.delete(`/api/v1/social/posts/${postId}`, {
        headers: headers(cleanupPost),
        data: { csrfToken: cleanupPost },
      });
      const cleanupAccount = await csrf(request);
      await request.delete(`/api/v1/social/accounts/${accountId}`, {
        headers: headers(cleanupAccount),
        data: { csrfToken: cleanupAccount },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// ここから下は `plugins/example-plugin` のループバック publisher を題材に走る。
//
// #73〜#78、#80 と、#65 の寄せ直し（**実際に配信させてから**応答を見る）。
// ---------------------------------------------------------------------------

const PLUGIN_ID = 'example-plugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';

/** publisher が宣言する資格情報の項目（`plugins/example-plugin/social.ts`）。 */
const HANDLE_FIELD_LABEL = 'サンプルSNSのハンドル';
const APP_PASSWORD_FIELD_LABEL = 'アプリパスワード';

/** この spec が作ったアカウント。`afterAll` で消す（投稿も一緒に消える）。 */
const createdAccountIds: string[] = [];

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
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

interface Account {
  readonly id: string;
  readonly displayName: string;
}

/** provider `example` のアカウント。資格情報は publisher の宣言どおり 2 項目。 */
async function createExampleAccount(
  request: APIRequestContext,
  credentials: Record<string, string> = {
    handle: `sample_${unique()}`,
    appPassword: `pw_${unique()}`,
  },
): Promise<Account> {
  const displayName = `E2E サンプル ${unique()}`;
  const response = await postJson(request, '/api/v1/social/accounts', {
    provider: 'example',
    displayName,
    handle: `@${unique()}`,
    credentials,
    status: 'connected',
  });
  expect(response.status(), await response.text()).toBe(201);

  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdAccountIds.push(id);
  return { id, displayName };
}

interface Post {
  readonly id: string;
  readonly body: string;
}

async function createPost(
  request: APIRequestContext,
  accountId: string,
  overrides: Record<string, unknown>,
): Promise<Post> {
  const body = String(overrides['body'] ?? `E2E 投稿 ${unique()}`);
  const response = await postJson(request, '/api/v1/social/posts', {
    socialAccountId: accountId,
    ...overrides,
    body,
  });
  expect(response.status(), await response.text()).toBe(201);

  return { id: ((await response.json()) as { data: { id: string } }).data.id, body };
}

/** 予約時刻を過ぎた投稿を作るための時刻。 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function fetchPost(
  request: APIRequestContext,
  id: string,
): Promise<{ status: string; deliveryMode: string; externalUrl: string | null }> {
  const response = await request.get(`/api/v1/social/posts/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return (
    (await response.json()) as {
      data: { status: string; deliveryMode: string; externalUrl: string | null };
    }
  ).data;
}

/** 手動投稿待ちの区画（`#manual-pending`）。投稿一覧にも同じ本文が出るので、区画で絞る。 */
function manualPendingSection(page: Page): Locator {
  return page.locator('#manual-pending');
}

function manualPendingRow(page: Page, body: string): Locator {
  return manualPendingSection(page).getByRole('row').filter({ hasText: body });
}

/**
 * 投稿一覧（`SocialPosts`）の行。
 *
 * 手動投稿待ちの区画にも同じ本文が出るので、**「編集」を持つ行**で絞る
 * （操作列があるのは投稿一覧だけ）。
 */
function postListRow(page: Page, body: string): Locator {
  return page.getByRole('row').filter({ hasText: body }).filter({ hasText: '編集' });
}

/** 導入済みか。**同じ版を導入し直すと 422 になる**ので、叩く前に見る。 */
async function isInstalled(request: APIRequestContext): Promise<boolean> {
  const response = await request.get('/api/v1/plugins');
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { installed: { id: string }[] } };
  return body.data.installed.some((plugin) => plugin.id === PLUGIN_ID);
}

/**
 * Plugin の導入と有効化。
 *
 * `plugin-example.spec.ts` も同じ Plugin を導入する（あちらが先に走り、`afterAll` で
 * 削除する）。**削除が残っていても続けられるよう、既に導入済みなら有効化だけ行う**
 * （実装プラン §7 の 10）。導入済みの版と同じ版は 422 で断られるため、導入の可否は
 * 一覧で確かめる。
 */
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

/**
 * **必ず無効化して削除する**（実装プラン §7 の 10）。
 *
 * このファイルは `social.spec.ts` より先に走る。Plugin を残すと provider の表示名も
 * 「サービス」の選択肢も変わり、#79（既存の `social.spec.ts` がそのまま通る）が壊れる。
 */
test.afterAll(async ({ playwright }) => {
  const request = await adminContext(playwright);
  try {
    // アカウントを消すと、その投稿も一緒に消える。
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

/**
 * #76。アカウント追加の `credentialFields`（設計 §7.5）。
 *
 * **`Modal` を閉じると入力値を捨てることは、ここでしか見られない**（実装プラン §8 末尾）。
 * vitest は `environment: 'node'` で DOM が無く、開閉を観測できない。
 */
test.describe('#76 アカウント追加の資格情報の欄', () => {
  test('#76 「サンプルSNS」を選ぶと publisher が宣言した 2 つの欄が出る', async ({ page }) => {
    await page.goto('/social');
    await page.getByRole('button', { name: '+ アカウントを追加' }).click();

    const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await dialog.getByLabel('サービス').selectOption({ label: 'サンプルSNS' });

    await expect(dialog.getByLabel(HANDLE_FIELD_LABEL)).toBeVisible();
    await expect(dialog.getByLabel(APP_PASSWORD_FIELD_LABEL)).toBeVisible();

    // publisher が無い provider では、従来どおり 1 つの欄に戻る。
    await dialog.getByLabel('サービス').selectOption('x');
    await expect(dialog.getByLabel(HANDLE_FIELD_LABEL)).toHaveCount(0);
    await expect(dialog.getByLabel('資格情報（アクセストークン等）')).toBeVisible();
  });

  test('#76 開いて入力し、閉じて開き直すと入力値が残っていない', async ({ page }) => {
    // 捨てないと、次に別のアカウントを作るときに前の資格情報が混ざる（設計 §7.5）。
    await page.goto('/social');
    await page.getByRole('button', { name: '+ アカウントを追加' }).click();

    const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await dialog.getByLabel('サービス').selectOption({ label: 'サンプルSNS' });
    await dialog.getByLabel('表示名').fill('捨てられるはずの名前');
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill('discarded_handle');
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill('discarded-app-password');

    await dialog.getByRole('button', { name: 'キャンセル' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: '+ アカウントを追加' }).click();
    const reopened = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await reopened.getByLabel('サービス').selectOption({ label: 'サンプルSNS' });

    await expect(reopened.getByLabel(HANDLE_FIELD_LABEL)).toHaveValue('');
    await expect(reopened.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveValue('');
    expect(await page.content()).not.toContain('discarded-app-password');
  });

  test('#76 保存すると一覧に平文が出ず「••••••••」になる', async ({ page }) => {
    const secret = `e2e-app-password-${unique()}`;
    const displayName = `E2E 画面から ${unique()}`;

    await page.goto('/social');
    await page.getByRole('button', { name: '+ アカウントを追加' }).click();

    const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await dialog.getByLabel('サービス').selectOption({ label: 'サンプルSNS' });
    await dialog.getByLabel('表示名').fill(displayName);
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill('sample_handle');
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill(secret);
    await dialog.getByRole('button', { name: '追加' }).click();

    const row = page.getByRole('row').filter({ hasText: displayName });
    await expect(row).toBeVisible();
    await expect(row).toContainText('••••••••');
    await expect(row).toContainText('サンプルSNS');
    expect(await page.content()).not.toContain(secret);

    // 後始末のために ID を控える。
    const list = await page.request.get('/api/v1/social/accounts?perPage=100');
    const accounts = ((await list.json()) as { data: { id: string; displayName: string }[] }).data;
    const created = accounts.find((account) => account.displayName === displayName);
    expect(created, '画面から作ったアカウントが一覧に無い').toBeDefined();
    createdAccountIds.push(created?.id ?? '');
  });
});

/**
 * publisher の無い provider の手動投稿は 422（設計 §6.1.2 の g）。
 *
 * **「配信 Plugin が無い」だけでは断らない**（要件 §4 裁定 #8。#65 の既存テストが
 * `auto` / `scheduled` の 201 を見ている）。断るのは手動投稿だけで、
 * 投稿画面の URL は publisher の `manual()` からしか得られず、待っても整わないため。
 */
test.describe('#76 publisher の無い provider', () => {
  test('#76 provider x に手動投稿を作ると 422 で、理由が deliveryMode に出る', async ({
    request,
  }) => {
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'x',
      displayName: `E2E 手動不可 ${unique()}`,
      handle: `@${unique()}`,
      credential: 'e2e-credential',
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    const accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    const response = await postJson(request, '/api/v1/social/posts', {
      socialAccountId: accountId,
      body: 'E2E 手動投稿できない SNS',
      status: 'scheduled',
      deliveryMode: 'manual',
      scheduledAt: minutesAgo(1),
    });

    expect(response.status(), await response.text()).toBe(422);
    const body = (await response.json()) as { error: { details?: Record<string, string[]> } };
    expect(body.error.details?.['deliveryMode']?.join('')).toContain('手動投稿に対応していません');
  });
});

/** #80。publisher の `validate()` の文言が、フォームの「本文」の下に出る。 */
test.describe('#80 publisher の validate()', () => {
  test('#80 [invalid] を含む本文は 422 になり、Plugin の文言が本文の下に出る', async ({
    page,
    request,
  }) => {
    const account = await createExampleAccount(request);

    await page.goto('/social/posts/new');
    await page
      .getByLabel('アカウント')
      .selectOption({ label: `${account.displayName}（サンプルSNS）` });
    await page.getByLabel('本文').fill('[invalid] を含む本文');

    const posted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/social/posts') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存' }).click();
    expect((await posted).status(), 'Plugin の validate() が 422 にしていない').toBe(422);

    // Plugin の文言が出る（Alert には出ない。`api-client` は `message` を画面側の
    // 文言へ置き換えるので、この文が出るのはフィールドの欄だけ）。
    await expect(page.getByText('本文に [invalid] は使えません（サンプルSNS）。')).toBeVisible();

    // **「本文」の欄に紐づいていること**（`aria-describedby` の指す先に出る）。
    const describedBy = await page.getByLabel('本文').getAttribute('aria-describedby');
    expect(describedBy, '本文の欄がエラーへ紐づいていない').toBeTruthy();
    await expect(page.locator(`[id="${describedBy ?? ''}"]`)).toContainText(
      '本文に [invalid] は使えません（サンプルSNS）。',
    );

    // 422 なので画面は移らない。
    expect(new URL(page.url()).pathname).toBe('/social/posts/new');
  });
});

/**
 * #70 相当。**「配信方法」で選んだ値が実際に送信される**こと。
 *
 * 単体テストは `environment: 'node'` で送信 body を見られず、
 * 「欄が出る／出ない」までで固定してある（実装プラン §8 末尾）。
 */
test.describe('#70 投稿フォームの配信方法', () => {
  test('#70 「手動」を選んで保存すると deliveryMode: manual で保存される', async ({
    page,
    request,
  }) => {
    const account = await createExampleAccount(request);
    const body = `E2E 配信方法 ${unique()}`;

    await page.goto('/social/posts/new');
    await page
      .getByLabel('アカウント')
      .selectOption({ label: `${account.displayName}（サンプルSNS）` });
    await page.getByLabel('本文').fill(body);
    // publisher が `manual()` を持つ provider でだけ出る欄（設計 §7.4）。
    await page.getByLabel('配信方法').selectOption({ label: '手動' });
    await page.getByRole('button', { name: '保存' }).click();

    await page.waitForURL('**/social');

    const list = await request.get(`/api/v1/social/posts?accountId=${account.id}`);
    const posts = ((await list.json()) as { data: { id: string; body: string }[] }).data;
    const created = posts.find((post) => post.body === body);
    expect(created, '作った投稿が見つからない').toBeDefined();
    expect((await fetchPost(request, created?.id ?? '')).deliveryMode).toBe('manual');
  });
});

/**
 * #73。手動投稿待ちの区画 → 子ウィンドウ → 「投稿した」。
 *
 * **子ウィンドウは `context.waitForEvent('page')` で拾う**（実装プラン §7 の 11）。
 * `noopener` を付けると `window.open` は `null` を返し、`popup` イベントは
 * `opener` が無いと発火しないことがある。
 */
test.describe('#73 手動投稿待ちと子ウィンドウ', () => {
  test('#73 「投稿画面を開く」で本文入りの画面が開き、「投稿した」で published になる', async ({
    page,
    request,
  }) => {
    const account = await createExampleAccount(request);
    const body = `E2E手動投稿${unique()}`;
    const post = await createPost(request, account.id, {
      body,
      status: 'scheduled',
      deliveryMode: 'manual',
      scheduledAt: minutesAgo(3),
    });

    await page.goto('/social');

    const section = manualPendingSection(page);
    await expect(section.getByRole('heading', { name: /手動投稿待ち/ })).toBeVisible();
    await expect(section).toContainText(body);
    // Plugin が添えた注意書き（`manual()` の `note`）。
    await expect(section).toContainText('サンプルです。実際にはどこにも投稿されません。');

    const row = manualPendingRow(page, body);
    // 「経過」列（設計 §7.1 の補足）。Server Component が文字列にして渡している。
    await expect(row).toContainText(/\d+ (分|時間|日)/);

    const opened = page.context().waitForEvent('page');
    await row.getByRole('button', { name: '投稿画面を開く' }).click();
    const child = await opened;
    await child.waitForLoadState('domcontentloaded');

    // URL に本文が URL エンコードで入っている（Web Intent と同じ形）。
    expect(child.url()).toContain(encodeURIComponent(body));
    const childUrl = new URL(child.url());
    expect(childUrl.pathname).toBe('/plugins/example-plugin/manual-post');
    expect(childUrl.searchParams.get('text')).toBe(body);
    await expect(child.getByTestId('example-manual-post-text')).toHaveText(body);
    await child.close();

    await row.getByRole('button', { name: '投稿した' }).click();
    const dialog = page.getByRole('dialog', { name: '投稿を記録しますか？' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '記録する' }).click();

    // 行が消える（二重に押せない）。
    await expect(manualPendingRow(page, body)).toHaveCount(0);
    expect((await fetchPost(request, post.id)).status).toBe('published');
  });
});

/** #74。「取りやめ」→ 確認 → `draft` に戻る。 */
test.describe('#74 手動投稿の取りやめ', () => {
  test('#74 「取りやめ」を確認すると行が消え、API では draft になる', async ({ page, request }) => {
    const account = await createExampleAccount(request);
    const body = `E2E取りやめ${unique()}`;
    const post = await createPost(request, account.id, {
      body,
      status: 'scheduled',
      deliveryMode: 'manual',
      scheduledAt: minutesAgo(2),
    });

    await page.goto('/social');
    await manualPendingRow(page, body).getByRole('button', { name: '取りやめ' }).click();

    const dialog = page.getByRole('dialog', { name: '予約を取りやめますか？' });
    await expect(dialog).toContainText('下書きに戻します。予約は解除されます。');
    await dialog.getByRole('button', { name: '取りやめる' }).click();

    await expect(manualPendingRow(page, body)).toHaveCount(0);
    expect((await fetchPost(request, post.id)).status).toBe('draft');
  });
});

/** #77。ダッシュボードには件数と導線だけを出す（設計 §7.6）。 */
test.describe('#77 ダッシュボードの導線', () => {
  test('#77 手動投稿待ちがあると件数と導線が出て、無くなると消える', async ({ page, request }) => {
    const account = await createExampleAccount(request);
    const body = `E2Eダッシュボード${unique()}`;
    const post = await createPost(request, account.id, {
      body,
      status: 'scheduled',
      deliveryMode: 'manual',
      scheduledAt: minutesAgo(1),
    });

    await page.goto('/dashboard');
    await expect(page.getByText(/手動投稿待ちが \d+ 件あります/)).toBeVisible();

    await page.getByRole('link', { name: 'SNS 画面へ →' }).click();
    await page.waitForURL('**/social**');
    await expect(manualPendingSection(page)).toContainText(body);

    // 0 件なら何も描かない。
    const cancelled = await patchJson(request, `/api/v1/social/posts/${post.id}`, {
      status: 'draft',
    });
    expect(cancelled.status(), await cancelled.text()).toBe(200);

    await page.goto('/dashboard');
    await expect(page.getByText(/手動投稿待ちが/)).toHaveCount(0);
  });
});

/** #75。配信ジョブが publisher を通して実際に配信する。 */
test.describe('#75 自動配信', () => {
  test('#75 POST /api/v1/social/publish で published になり、履歴に「投稿を見る」が出る', async ({
    page,
    request,
  }) => {
    const account = await createExampleAccount(request);
    const body = `E2E自動配信${unique()}`;
    const post = await createPost(request, account.id, {
      body,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: minutesAgo(1),
    });

    expect((await publish(request)).status()).toBe(200);

    const published = await fetchPost(request, post.id);
    expect(published.status).toBe('published');
    // publisher が返した `externalUrl` が記録されている。
    expect(published.externalUrl).toContain('/plugins/example-plugin/posts/');

    await page.goto('/social/history');
    const row = page.getByRole('row').filter({ hasText: body });
    await expect(row).toContainText('配信済み');
    await expect(row.getByRole('link', { name: /投稿を見る/ })).toHaveAttribute(
      'href',
      published.externalUrl ?? '',
    );
  });

  test('#75 定期実行だけでも 90 秒以内に published になる', async ({ request }) => {
    // 初回遅延 15 秒 + 間隔 1 分（実装プラン §7 の 12）。**API を叩かずに待つ。**
    test.setTimeout(120_000);

    const account = await createExampleAccount(request);
    const post = await createPost(request, account.id, {
      body: `E2E定期実行${unique()}`,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: minutesAgo(1),
    });

    await expect
      .poll(async () => (await fetchPost(request, post.id)).status, {
        timeout: 90_000,
        intervals: [5_000],
      })
      .toBe('published');
  });
});

/**
 * #78。設定 → 一般「定期実行」に `social.publish` の行が出る（設計 §7.7）。
 *
 * > **配置をここで追認する（検証レポート §4 の 7）。** 実装プランは
 * > `settings-tabs.spec.ts` へ置くと宣言していたが、実物はここにある。
 * > この行が `ok` になるには**配信ジョブが実際に走っている**ことが要り、
 * > その前提（`plugins/example-plugin` の有効化と投稿）はこのファイルが作る。
 * > 設定画面のタブ構成を見る spec へ移すと、前提を二重に用意することになる。
 */
test.describe('#78 定期実行の行', () => {
  test('#78 「SNS 投稿の配信」の行があり、90 秒以内に結果が ok になる', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto('/settings?tab=general');
    await expect(page.getByRole('row', { name: /SNS 投稿の配信/ })).toBeVisible();

    await expect
      .poll(
        async () => {
          await page.reload();
          return page
            .getByRole('row', { name: /SNS 投稿の配信/ })
            .locator('[data-job-status="ok"]')
            .count();
        },
        { timeout: 90_000, intervals: [5_000] },
      )
      .toBeGreaterThanOrEqual(1);
  });
});

/**
 * #29 の Cookie 経路（検証レポート §4 の 4。実装プラン §8 の 3 が宣言した 2 本目）。
 *
 * **セッション認証からは `externalRef` を指定できない**（設計 §6.1.2 の c）。
 * Token が無いと一意の名前空間が無く、PostgreSQL の一意索引は NULL を
 * 区別しないので「冪等のつもりで二重登録」が黙って起きる。
 *
 * 結合テスト（`social-publishing.integration.test.ts`）は UseCase を直接呼んでおり、
 * **HTTP の Cookie 経路で実際に 422 になることはここでしか見ていない。**
 */
test.describe('#29 セッション認証では externalRef を指定できない', () => {
  test('#29 Cookie の要求に externalRef を付けると 422 externalRef', async ({ request }) => {
    const account = await createExampleAccount(request);

    const response = await postJson(request, '/api/v1/social/posts', {
      socialAccountId: account.id,
      body: `E2E externalRef ${unique()}`,
      status: 'draft',
      externalRef: `e2e-${unique()}`,
    });

    expect(response.status(), await response.text()).toBe(422);
    const body = (await response.json()) as { error: { details?: Record<string, string[]> } };
    expect(Object.keys(body.error.details ?? {})).toContain('externalRef');
    expect(body.error.details?.['externalRef']?.join('')).toContain('トークン');
  });

  test('#29 externalRef を省略すれば Cookie でも 201', async ({ request }) => {
    const account = await createExampleAccount(request);

    const response = await postJson(request, '/api/v1/social/posts', {
      socialAccountId: account.id,
      body: `E2E externalRef なし ${unique()}`,
      status: 'draft',
    });

    expect(response.status(), await response.text()).toBe(201);
  });
});

/**
 * #106。**`app/social/page.tsx` が `publisherProviders` を渡していることを見る唯一のテスト**
 * （設計 §7.3、検証レポート §4 の 1）。
 *
 * 部品テスト（#69）は props を直接与えて描くので、**Server Component が
 * 組み立てて渡す経路は通らない。** 渡し忘れても部品テストは緑のままになる。
 * この警告こそ裁定 #8 で 422 を外した代償なので、配線まで固定する。
 */
test.describe('#106 配信の支度ができていない予約の警告', () => {
  test('#106 publisher の無い provider の予約に Badge と件数入りの Alert が出る', async ({
    page,
    request,
  }) => {
    // provider `x` には publisher が無い（`example` にしかない）。
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'x',
      displayName: `E2E 配信不可 ${unique()}`,
      handle: `@${unique()}`,
      credential: 'e2e-credential',
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    const accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    const body = `E2E支度なし${unique()}`;
    // **裁定 #8 で 201。** 断らない代わりに、予約した時点で画面に出す。
    await createPost(request, accountId, {
      body,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: minutesAgo(1),
    });

    await page.goto('/social');

    await expect(postListRow(page, body)).toContainText('配信 Plugin なし');
    await expect(page.getByText(/配信の支度ができていない予約投稿が \d+ 件あります/)).toBeVisible();
  });

  test('#106 Alert が約24時間で取りやめになることまで伝える', async ({ page, request }) => {
    // 裁定 #9 で「支度が整わない予約は約24時間で failed」という**新しい結末**が生まれた。
    // 画面がそれを言わないと、運用者は取りやめられて初めて知る（設計 §7.3）。
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'x',
      displayName: `E2E 猶予 ${unique()}`,
      handle: `@${unique()}`,
      credential: 'e2e-credential',
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    const accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    await createPost(request, accountId, {
      body: `E2E猶予${unique()}`,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: minutesAgo(1),
    });

    await page.goto('/social');

    await expect(page.getByText(/約24時間/)).toBeVisible();
  });
});

/**
 * #120（2026-09-23 に足した。裁定 #15-a）。**残り回数の配線**（設計 §6.1.4 / §7.3）。
 *
 * 裁定 #14-a の代償で、2 回飛ばされた投稿は**日時を直しても次の 1 回で `failed`** になる。
 * `failed` は終端なので予約へ戻せない。**運用者が予約し直す前に残りを知れること**が
 * 裁定 #15-a の目的で、応答（`skipCount` / `skipReason`）と画面の補足の両方が要る。
 *
 * 部品テスト（#119）は props を直接与えて描くので、**Server Component が
 * `skipCount` を渡す経路は通らない**（#106 と同じ理由）。ここで配線まで固定する。
 */
test.describe('#120 飛ばされた予約の残り回数', () => {
  test('#120 1 回飛ばすと応答に skipCount / skipReason が出て、一覧に「あと 2 回」が出る', async ({
    page,
    request,
  }) => {
    // provider `x` には publisher が無い（`example` にしかない）＝ `no_publisher` で飛ばされる。
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'x',
      displayName: `E2E 残り回数 ${unique()}`,
      handle: `@${unique()}`,
      credential: 'e2e-credential',
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    const accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    const body = `E2E残り回数${unique()}`;
    const post = await createPost(request, accountId, {
      body,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: minutesAgo(1),
    });

    // 1 回走らせる（定期実行が先に拾っていても、待ち時刻が 1 時間先へ行くので結果は同じ）。
    expect((await publish(request)).status()).toBe(200);

    const got = await request.get(`/api/v1/social/posts/${post.id}`);
    expect(got.status(), await got.text()).toBe(200);
    const data = (
      (await got.json()) as {
        data: { status: string; skipCount: number; skipReason: string | null };
      }
    ).data;

    // #118 の HTTP 版。**`status` は `scheduled` のまま**で、飛ばした履歴だけが増える。
    expect(data.status).toBe('scheduled');
    expect(data.skipCount).toBe(1);
    expect(data.skipReason).toBe('no_publisher');

    await page.goto('/social');

    // 上限は 3 回なので、1 回飛ばされた時点で残りは 2 回（設計 §7.3）。
    await expect(postListRow(page, body)).toContainText('あと 2 回で取りやめ');
  });
});

/**
 * #107。投稿一覧の状態列に出る「手動投稿待ち」の補足（設計 §7.3）。
 *
 * **設計書に条件が無かったために未観測だった箇所**（検証レポート §4 の 2、
 * 設計書側の問題 5）。`PostRow.manualPending` は Server Component が
 * 「いま」を判定して渡す（設計 §7.1 の補足）ので、部品テストでは配線を見られない。
 */
test.describe('#107 投稿一覧の「手動投稿待ち」の補足', () => {
  test('#107 manual で期限の来た投稿の状態列に補足が出る', async ({ page, request }) => {
    const account = await createExampleAccount(request);
    const body = `E2E補足行${unique()}`;
    await createPost(request, account.id, {
      body,
      status: 'scheduled',
      deliveryMode: 'manual',
      scheduledAt: minutesAgo(3),
    });

    await page.goto('/social');

    await expect(postListRow(page, body)).toContainText('手動投稿待ち');
  });

  test('#107 期限がまだ来ていない manual の行には補足が出ない', async ({ page, request }) => {
    // 「手動投稿待ち」は期限が来てから（設計 §5.8）。
    const account = await createExampleAccount(request);
    const body = `E2E未来の手動${unique()}`;
    await createPost(request, account.id, {
      body,
      status: 'scheduled',
      deliveryMode: 'manual',
      scheduledAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    await page.goto('/social');

    const row = postListRow(page, body);
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('手動投稿待ち');
  });
});

/**
 * #108。編集画面の `manualSupported` の配線（設計 §7.4）。
 *
 * `app/social/posts/[id]/edit/page.tsx` も `new` と同じ props を組み立てるが、
 * **E2E は `new` しか通っていなかった**（検証レポート §4 の 5）。
 */
test.describe('#108 編集画面の配信方法', () => {
  test('#108 manual 対応の provider のアカウントの投稿では「配信方法」が出る', async ({
    page,
    request,
  }) => {
    const account = await createExampleAccount(request);
    const post = await createPost(request, account.id, {
      body: `E2E編集manual${unique()}`,
      status: 'draft',
    });

    await page.goto(`/social/posts/${post.id}/edit`);

    await expect(page.getByLabel('配信方法')).toBeVisible();
  });

  test('#108 非対応の provider のアカウントの投稿では「配信方法」が出ない', async ({
    page,
    request,
  }) => {
    // 押しても 422 になる選択肢を出さない（設計 §7.4）。
    const account = await postJson(request, '/api/v1/social/accounts', {
      provider: 'x',
      displayName: `E2E 編集非対応 ${unique()}`,
      handle: `@${unique()}`,
      credential: 'e2e-credential',
      status: 'connected',
    });
    expect(account.status(), await account.text()).toBe(201);
    const accountId = ((await account.json()) as { data: { id: string } }).data.id;
    createdAccountIds.push(accountId);

    const post = await createPost(request, accountId, {
      body: `E2E編集auto${unique()}`,
      status: 'draft',
    });

    await page.goto(`/social/posts/${post.id}/edit`);

    await expect(page.getByLabel('本文')).toBeVisible();
    await expect(page.getByLabel('配信方法')).toHaveCount(0);
  });
});

/**
 * #104。Plugin マネージャが Manifest の `extensions` を出す（設計 §7.9、裁定 #11）。
 *
 * **資格情報を Plugin へ渡す変更を正当化した根拠のうち「宣言で見える」の半分が
 * 実装されていなかった**（検証レポート §6 の 1）。
 *
 * > **設計 §10 #104 は `/settings?tab=plugins` と書いているが、Plugin マネージャの
 * > 置き場は `/plugins` である**（`app/plugins/page.tsx`。設定画面にタブは無い）。
 * > 条件が指しているのは「導入前に見える一覧」という場所であり、ここではその実物を開く。
 */
test.describe('#104 Plugin マネージャの拡張点', () => {
  /**
   * **サンプル Plugin の行に絞る。**
   *
   * もとは `page.getByText(/SNS配信/)` とページ全体を見ていたが、
   * **`036` が 2 つ目の `social` Plugin を足した時点で strict mode に触れて落ちた**。
   * テスト名は「サンプル Plugin の**行に**」と言っているのに、ロケータがそれを守っていなかった
   * （Plugin が 1 つしか無いあいだだけ通っていた）。**絞るのは弱めることではなく、名前どおりにすること。**
   */
  function examplePluginCard(page: Page) {
    return page.locator('section').filter({ hasText: 'サンプルPlugin' }).last();
  }

  test('#104 サンプル Plugin の行に「SNS配信」が出る', async ({ page }) => {
    await page.goto('/plugins');

    await expect(page.getByText('サンプルPlugin  1.0.0')).toBeVisible();
    await expect(examplePluginCard(page).getByText(/SNS配信/)).toBeVisible();
  });

  test('#104 何を握るかが読める文言になっている', async ({ page }) => {
    await page.goto('/plugins');

    await expect(examplePluginCard(page).getByText(/資格情報を受け取ります/)).toBeVisible();
  });

  test('#104 有効化した後は登録済みの provider として example が出る', async ({ page }) => {
    // どちらの Plugin が provider を握ったかを確かめる場所（検証レポート §6 の 3）。
    await page.goto('/plugins');

    await expect(page.getByText(/登録済み[\s\S]{0,60}example/).first()).toBeVisible();
  });
});

/**
 * #65 の寄せ直し（実装プラン §8「G3 からの申し送り」）。
 *
 * G4 の #65 は publisher の無い provider（投稿は `skipped`）でしか見ていない。
 * **ループバック publisher で実際に配信させてから**、応答に資格情報が出ないことを見る。
 */
test.describe('#65 配信が成功した後も資格情報が応答に出ない', () => {
  test('#65 publisher を通して配信した後の 3 つの応答に資格情報が現れない', async ({ request }) => {
    const handleValue = `CRED-MARKER-HANDLE-${unique()}`;
    const appPasswordValue = `CRED-MARKER-SECRET-${unique()}`;
    const account = await createExampleAccount(request, {
      handle: handleValue,
      appPassword: appPasswordValue,
    });
    const post = await createPost(request, account.id, {
      body: `E2E資格情報${unique()}`,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: minutesAgo(1),
    });

    expect((await publish(request)).status()).toBe(200);
    // **実際に配信が成功したことを確かめてから**応答を見る。
    expect((await fetchPost(request, post.id)).status).toBe('published');

    for (const path of [
      '/api/v1/social/posts',
      `/api/v1/social/posts/${post.id}`,
      `/api/v1/social/accounts/${account.id}`,
    ]) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      const text = await response.text();
      expect(text, path).not.toContain(handleValue);
      expect(text, path).not.toContain(appPasswordValue);
    }

    // 「設定済み」だけは見せる（何も設定されていないのと区別が付かないと運用できない）。
    const shown = (await (await request.get(`/api/v1/social/accounts/${account.id}`)).json()) as {
      data: { credentialConfigured: boolean };
    };
    expect(shown.data.credentialConfigured).toBe(true);
  });
});
