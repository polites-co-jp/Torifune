import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * キャンペーンの作成・編集フォームで、紐づけ先の誤りを欄の下に出す
 * （045-campaign-input-500 設計 §7、受け入れ条件 #31・#32）。
 *
 * フォームを開いた後に、対象のサイト・SNS 投稿が別の要求で消された場合。
 * 保存は 422（`details.siteIds` / `details.socialPostIds`）になり、画面に留まったまま
 * 上の Alert に固定の文言、「対象サイト」「関連するSNS投稿」の欄の下にそれぞれの文言が出る。
 *
 * API の叩き方は `campaigns.spec.ts`・`social.spec.ts` の非公開の関数を写した。
 * E2E の DB は共有なので、作るものの名前に一意の接尾辞を付ける。
 */

const origin = 'http://127.0.0.1:3000';

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

async function post(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  const token = await csrf(request);
  const response = await request.post(path, {
    headers: headers(token),
    data: { ...data, csrfToken: token },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data;
}

async function remove(request: APIRequestContext, path: string): Promise<void> {
  const token = await csrf(request);
  const response = await request.delete(path, {
    headers: headers(token),
    data: { csrfToken: token },
  });
  expect(response.status()).toBe(204);
}

/** ラベルの文字列がちょうど `label` の `FormField`（ラベル・説明・入力・エラーの枠）。 */
function formField(page: Page, label: string): Locator {
  return page.locator('form label', { hasText: new RegExp(`^${label}`) }).locator('xpath=..');
}

test('#31 編集画面：開いた後に対象サイトが消されると、画面に留まり「対象サイト」の欄に文言が出る', async ({
  page,
}) => {
  const suffix = unique();
  const site = await post(page.request, '/api/v1/sites', {
    name: `消されるサイト ${suffix}`,
    url: `https://deleted-${suffix}.example.com`,
    description: '',
    status: 'active',
  });
  const campaign = await post(page.request, '/api/v1/campaigns', {
    name: `サイトが消える施策 ${suffix}`,
    startsOn: '2026-04-01',
    siteIds: [site.id],
  });

  await page.goto(`/campaigns/${campaign.id}/edit`);
  await expect(page.getByLabel('名前')).toHaveValue(`サイトが消える施策 ${suffix}`);

  // 別の要求でサイトを消す（フォームは開いた時点の siteIds を持ったまま）。
  await remove(page.request, `/api/v1/sites/${site.id}`);

  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByText('入力内容を確認してください。')).toBeVisible();
  await expect(formField(page, '対象サイト')).toContainText(
    '存在しないWebサイトが含まれています。',
  );
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaign.id}/edit$`));

  await remove(page.request, `/api/v1/campaigns/${campaign.id}`);
});

test('#32 作成画面：選んだSNS投稿が消されると、画面に留まり「関連するSNS投稿」の欄に文言が出る', async ({
  page,
}) => {
  const suffix = unique();
  const account = await post(page.request, '/api/v1/social/accounts', {
    provider: 'x',
    displayName: `E2E ${suffix}`,
    handle: `@${suffix}`,
    status: 'connected',
  });
  const body = `消される投稿 ${suffix}`;
  // 作成画面の候補（新しい順に 100 件）に入るよう、画面を開く直前に作る。
  const socialPost = await post(page.request, '/api/v1/social/posts', {
    socialAccountId: account.id,
    body,
    status: 'draft',
  });

  await page.goto('/campaigns/new');
  const name = `投稿が消える施策 ${suffix}`;
  await page.getByLabel('名前').fill(name);
  await page.getByLabel('開始日').fill('2026-06-01');
  await page.getByRole('checkbox', { name: new RegExp(body) }).check();

  // 別の要求で投稿を消す（フォームは選んだ socialPostIds を持ったまま）。
  await remove(page.request, `/api/v1/social/posts/${socialPost.id}`);

  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByText('入力内容を確認してください。')).toBeVisible();
  await expect(formField(page, '関連するSNS投稿')).toContainText(
    '存在しないSNS投稿が含まれています。',
  );
  await expect(page).toHaveURL(/\/campaigns\/new$/);

  // 作られていないこと（名前で探して 0 件）。
  const listed = await page.request.get(`/api/v1/campaigns?q=${encodeURIComponent(suffix)}`);
  expect(((await listed.json()) as { data: unknown[] }).data).toEqual([]);

  await remove(page.request, `/api/v1/social/accounts/${account.id}`);
});
