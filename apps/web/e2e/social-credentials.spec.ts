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
 * SNS アカウントの資格情報を画面で入れ直す・消す（039-social-credential-fields 設計 §7.3〜§7.4、
 * 受け入れ条件 #35〜#40、#54）。
 *
 * 画面は `plugins/example-plugin` の publisher（provider `example`、`handle` / `appPassword` の 2 項目）を
 * 題材に走らせる。`beforeAll` / `afterAll` は `social-publishing.spec.ts` を写す。
 *
 * * **`none`（`credentialFields: []` の publisher）は E2E で見ない。** X の配信 Plugin を E2E で導入しない
 *   （`037` #85）。`none` は単体（#18 / #21）と結合（#32）が固定する（設計 §10.7 の注）
 * * このファイルは `social-publishing.spec.ts` と `social.spec.ts` より**前に**走る。
 *   **`afterAll` で必ず Plugin を無効化・削除し、作ったアカウントを消す**（後の spec の前提を壊さない）
 * * `GET /api/v1/auth/csrf` の Rate Limit に触れないよう、API での準備は最小にする
 * * 「消す」は「資格情報を消す」に部分一致で当たるので、確認ダイアログで絞ったうえで `exact: true` にする。
 *   「資格情報を設定」は行ごとにあるので、行で絞ってから押す
 */

const origin = 'http://127.0.0.1:3000';

const PLUGIN_ID = 'example-plugin';
const ADMIN_STORAGE = './e2e/.auth/admin.json';

/** publisher が宣言する資格情報の項目（`plugins/example-plugin/social.ts`）。 */
const HANDLE_FIELD_LABEL = 'サンプルSNSのハンドル';
const HANDLE_FIELD_DESCRIPTION = 'サンプルSNS 側の利用者名。';
const APP_PASSWORD_FIELD_LABEL = 'アプリパスワード';
const APP_PASSWORD_FIELD_DESCRIPTION = '保存後は再表示されません。';

/** publisher の無い provider の汎用の欄。 */
const GENERIC_FIELD_LABEL = '資格情報（アクセストークン等）';

const SET_CREDENTIAL = '資格情報を設定';
const CLEAR_CREDENTIAL = '資格情報を消す';
const CLEAR_CONFIRM_TITLE = '資格情報を消しますか？';

/** この spec が作ったアカウント。`afterAll` で消す（投稿も一緒に消える）。 */
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

/** `beforeAll` / `afterAll` はテスト用の fixture を使えないので、自分で作る。 */
async function adminContext(
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<APIRequestContext> {
  return playwright.request.newContext({ baseURL: origin, storageState: ADMIN_STORAGE });
}

interface Account {
  readonly id: string;
  readonly displayName: string;
}

/** API でアカウントを作る。`credentials` を渡さなければ資格情報なし・未接続。 */
async function createAccount(
  request: APIRequestContext,
  provider: string,
  credentials?: Record<string, string>,
): Promise<Account> {
  const displayName = `E2E 資格情報 ${unique()}`;
  const response = await postJson(request, '/api/v1/social/accounts', {
    provider,
    displayName,
    handle: `@${unique()}`,
    ...(credentials === undefined ? {} : { credentials }),
    status: credentials === undefined ? 'disconnected' : 'connected',
  });
  expect(response.status(), await response.text()).toBe(201);

  const id = ((await response.json()) as { data: { id: string } }).data.id;
  createdAccountIds.push(id);
  return { id, displayName };
}

async function credentialConfigured(request: APIRequestContext, id: string): Promise<boolean> {
  const response = await request.get(`/api/v1/social/accounts/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: { credentialConfigured: boolean } }).data
    .credentialConfigured;
}

/** アカウント一覧の行（投稿一覧にも表示名が出るので、「資格情報を設定」を持つ行で絞る）。 */
function accountRow(page: Page, displayName: string): Locator {
  return page
    .getByRole('row')
    .filter({ hasText: displayName })
    .filter({ has: page.getByRole('button', { name: SET_CREDENTIAL }) });
}

/** 行の「資格情報を設定」を押し、開いた Modal を返す。 */
async function openCredentialDialog(page: Page, displayName: string): Promise<Locator> {
  await accountRow(page, displayName).getByRole('button', { name: SET_CREDENTIAL }).click();
  const dialog = page.getByRole('dialog', { name: SET_CREDENTIAL });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 投稿一覧（`SocialPosts`）の行。手動投稿待ちの区画と区別するため「編集」を持つ行で絞る。 */
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
 * **必ず無効化して削除する。** 後に走る `social-publishing.spec.ts` / `social.spec.ts` は
 * Plugin の無い状態から始まる（「サービス」の選択肢と provider の表示名が変わる）。
 */
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
/* #35 入れ直し                                                                  */
/* -------------------------------------------------------------------------- */

test.describe('#35 行の「資格情報を設定」で入れ直す', () => {
  test('#35 未設定のアカウントに 2 つの値を入れて保存すると、行が「••••••••」「接続済み」になり値が DOM に残らない', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'example');
    const handle = `e2e_handle_${unique()}`;
    const appPassword = `e2e-app-password-${unique()}`;

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);

    await expect(dialog).toContainText('現在の状態：未設定');
    await expect(dialog.getByLabel(HANDLE_FIELD_LABEL)).toHaveValue('');
    await expect(dialog.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveValue('');

    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill(handle);
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill(appPassword);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();

    await expect(page.getByText('資格情報を保存しました。')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    const row = accountRow(page, account.displayName);
    await expect(row).toContainText('••••••••');
    await expect(row).toContainText('接続済み');

    const content = await page.content();
    expect(content).not.toContain(handle);
    expect(content).not.toContain(appPassword);

    expect(await credentialConfigured(request, account.id)).toBe(true);
  });

  test('#35 保存の後にもう一度開くと「現在の状態：設定済み」で、2 つの欄が空', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'example');
    const handle = `e2e_handle_${unique()}`;
    const appPassword = `e2e-app-password-${unique()}`;

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill(handle);
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill(appPassword);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const reopened = await openCredentialDialog(page, account.displayName);

    await expect(reopened).toContainText('現在の状態：設定済み');
    await expect(reopened.getByLabel(HANDLE_FIELD_LABEL)).toHaveValue('');
    await expect(reopened.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveValue('');
    const content = await page.content();
    expect(content).not.toContain(handle);
    expect(content).not.toContain(appPassword);
  });
});

/* -------------------------------------------------------------------------- */
/* #36 投稿一覧の Badge                                                           */
/* -------------------------------------------------------------------------- */

test.describe('#36 保存の後、投稿一覧の「資格情報 未設定」が再読み込みなしで消える', () => {
  test('#36 未来の auto の予約の行の Badge が、保存の後に消える', async ({ page, request }) => {
    const account = await createAccount(request, 'example');
    const body = `E2E 資格情報待ちの予約 ${unique()}`;
    const created = await postJson(request, '/api/v1/social/posts', {
      socialAccountId: account.id,
      body,
      status: 'scheduled',
      deliveryMode: 'auto',
      scheduledAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });
    expect(created.status(), await created.text()).toBe(201);

    await page.goto('/social');
    const postRow = postListRow(page, body);
    await expect(postRow).toBeVisible();
    await expect(postRow.getByText('資格情報 未設定')).toBeVisible();

    const dialog = await openCredentialDialog(page, account.displayName);
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill(`e2e_handle_${unique()}`);
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill(`e2e-app-password-${unique()}`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // **page.reload() を呼ばない。** router.refresh() で Server Component が描き直す（設計 §7.3.4）。
    await expect(postRow.getByText('資格情報 未設定')).toHaveCount(0);
    await expect(postRow).toBeVisible();
  });
});

/* -------------------------------------------------------------------------- */
/* #37 消す                                                                     */
/* -------------------------------------------------------------------------- */

test.describe('#37 「資格情報を消す」で消す', () => {
  test('#37 確認ダイアログの「消す」で、行が「未設定」「未接続」になり、API でも未設定', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'example', {
      handle: `e2e_handle_${unique()}`,
      appPassword: `e2e-app-password-${unique()}`,
    });

    await page.goto('/social');
    const row = accountRow(page, account.displayName);
    await expect(row).toContainText('••••••••');

    const dialog = await openCredentialDialog(page, account.displayName);
    await expect(dialog).toContainText('現在の状態：設定済み');
    await dialog.getByRole('button', { name: CLEAR_CREDENTIAL }).click();

    const confirm = page.getByRole('dialog', { name: CLEAR_CONFIRM_TITLE });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(account.displayName);
    await confirm.getByRole('button', { name: '消す', exact: true }).click();

    await expect(page.getByText('資格情報を消しました。')).toBeVisible();
    await expect(page.getByRole('dialog', { name: SET_CREDENTIAL })).toHaveCount(0);
    await expect(row).toContainText('未設定');
    await expect(row).toContainText('未接続');
    await expect(row).not.toContainText('••••••••');

    expect(await credentialConfigured(request, account.id)).toBe(false);
  });

  test('#37 未設定のアカウントの Modal には「資格情報を消す」が無い', async ({ page, request }) => {
    const account = await createAccount(request, 'example');

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);

    await expect(dialog.getByRole('button', { name: CLEAR_CREDENTIAL })).toHaveCount(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #38 片方だけ                                                                  */
/* -------------------------------------------------------------------------- */

test.describe('#38 項目が欠けていれば保存しない', () => {
  test('#38 片方だけ入れて「保存」すると「すべての項目を入力してください。」で、閉じず、要求を出さない', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'example');
    const patches: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() === 'PATCH' && sent.url().includes('/api/v1/social/accounts/')) {
        patches.push(sent.url());
      }
    });

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill(`e2e_handle_${unique()}`);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();

    await expect(dialog.getByText('すべての項目を入力してください。')).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(patches).toHaveLength(0);
    expect(await credentialConfigured(request, account.id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #39 閉じたら入力値を捨てる                                                       */
/* -------------------------------------------------------------------------- */

test.describe('#39 閉じて開き直すと欄が空', () => {
  test('#39 入力してから「キャンセル」で閉じて開き直すと欄が空で、値が DOM に残らない', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'example');
    const handle = `e2e_discarded_handle_${unique()}`;
    const appPassword = `e2e-discarded-password-${unique()}`;

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill(handle);
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill(appPassword);
    await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const reopened = await openCredentialDialog(page, account.displayName);

    await expect(reopened.getByLabel(HANDLE_FIELD_LABEL)).toHaveValue('');
    await expect(reopened.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveValue('');
    const content = await page.content();
    expect(content).not.toContain(handle);
    expect(content).not.toContain(appPassword);
    expect(await credentialConfigured(request, account.id)).toBe(false);
  });

  test('#39 入力してから Escape で閉じて開き直すと欄が空で、値が DOM に残らない', async ({
    page,
    request,
  }) => {
    const account = await createAccount(request, 'example');
    const handle = `e2e_escaped_handle_${unique()}`;
    const appPassword = `e2e-escaped-password-${unique()}`;

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);
    await dialog.getByLabel(HANDLE_FIELD_LABEL).fill(handle);
    await dialog.getByLabel(APP_PASSWORD_FIELD_LABEL).fill(appPassword);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    const reopened = await openCredentialDialog(page, account.displayName);

    await expect(reopened.getByLabel(HANDLE_FIELD_LABEL)).toHaveValue('');
    await expect(reopened.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveValue('');
    const content = await page.content();
    expect(content).not.toContain(handle);
    expect(content).not.toContain(appPassword);
  });
});

/* -------------------------------------------------------------------------- */
/* #40 publisher の無い provider                                                 */
/* -------------------------------------------------------------------------- */

test.describe('#40 publisher の無い provider（x）の Modal は汎用の欄', () => {
  test('#40 「資格情報（アクセストークン等）」の欄が 1 つと「形式を確かめずに」の説明が出る', async ({
    page,
    request,
  }) => {
    // E2E では X の配信 Plugin を導入しないので、x には publisher が無い（free）。
    const account = await createAccount(request, 'x');

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);

    await expect(dialog.getByLabel(GENERIC_FIELD_LABEL)).toHaveCount(1);
    await expect(dialog.getByLabel(GENERIC_FIELD_LABEL)).toBeVisible();
    await expect(dialog).toContainText('形式を確かめずに');
    await expect(dialog.getByLabel(HANDLE_FIELD_LABEL)).toHaveCount(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #54 項目の説明                                                                */
/* -------------------------------------------------------------------------- */

test.describe('#54 publisher が宣言した項目の説明が欄の説明になる', () => {
  test('#54 アカウント追加の Modal で、2 つの欄が説明を持つ', async ({ page }) => {
    await page.goto('/social');
    await page.getByRole('button', { name: '+ アカウントを追加' }).click();

    const dialog = page.getByRole('dialog', { name: 'SNSアカウントを追加' });
    await dialog.getByLabel('サービス').selectOption({ label: 'サンプルSNS' });

    await expect(dialog.getByLabel(HANDLE_FIELD_LABEL)).toHaveAccessibleDescription(
      HANDLE_FIELD_DESCRIPTION,
    );
    await expect(dialog.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveAccessibleDescription(
      APP_PASSWORD_FIELD_DESCRIPTION,
    );
  });

  test('#54 入れ直しの Modal で、2 つの欄が説明を持つ', async ({ page, request }) => {
    const account = await createAccount(request, 'example');

    await page.goto('/social');
    const dialog = await openCredentialDialog(page, account.displayName);

    await expect(dialog.getByLabel(HANDLE_FIELD_LABEL)).toHaveAccessibleDescription(
      HANDLE_FIELD_DESCRIPTION,
    );
    await expect(dialog.getByLabel(APP_PASSWORD_FIELD_LABEL)).toHaveAccessibleDescription(
      APP_PASSWORD_FIELD_DESCRIPTION,
    );
  });
});
