import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * キャンペーン（05_API設計.md §19、06_画面設計.md §14、017-campaigns）。
 */

const origin = 'http://127.0.0.1:3000';

async function csrf(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/v1/auth/csrf');
  const body = (await response.json()) as { data: { csrfToken: string } };
  return body.data.csrfToken;
}

function headers(token: string): Record<string, string> {
  return { 'X-CSRF-Token': token, Origin: origin };
}

async function createCampaign(
  request: APIRequestContext,
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  const token = await csrf(request);
  const response = await request.post('/api/v1/campaigns', {
    headers: headers(token),
    data: { startsOn: '2026-04-01', csrfToken: token, ...data },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data;
}

test('APIから作成・取得・更新・削除ができる', async ({ request }) => {
  const created = await createCampaign(request, { name: 'e2e 施策', endsOn: '2026-04-30' });

  const got = await request.get(`/api/v1/campaigns/${created.id}`);
  expect(got.status()).toBe(200);
  const body = (await got.json()) as { data: { startsOn: string; endsOn: string } };
  // 日付がタイムゾーンでずれない。
  expect(body.data.startsOn).toBe('2026-04-01');
  expect(body.data.endsOn).toBe('2026-04-30');

  const token = await csrf(request);
  const patched = await request.patch(`/api/v1/campaigns/${created.id}`, {
    headers: headers(token),
    data: { name: '改名した施策', csrfToken: token },
  });
  expect(patched.status()).toBe(200);

  const deleted = await request.delete(`/api/v1/campaigns/${created.id}`, {
    headers: headers(token),
    data: { csrfToken: token },
  });
  expect(deleted.status()).toBe(204);

  expect((await request.get(`/api/v1/campaigns/${created.id}`)).status()).toBe(404);
});

test('終了日が開始日より前なら 422', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/campaigns', {
    headers: headers(token),
    data: { name: '逆転', startsOn: '2026-04-30', endsOn: '2026-04-01', csrfToken: token },
  });

  expect(response.status()).toBe(422);
});

test('存在しない日付は 422', async ({ request }) => {
  const token = await csrf(request);
  const response = await request.post('/api/v1/campaigns', {
    headers: headers(token),
    data: { name: '存在しない日', startsOn: '2026-02-31', csrfToken: token },
  });

  expect(response.status()).toBe(422);
});

test('未認証では 401', async ({ request }) => {
  expect((await request.get('/api/v1/campaigns', { headers: { Cookie: '' } })).status()).toBe(401);
});

test('対象サイトを持てる', async ({ request }) => {
  const token = await csrf(request);
  const site = await request.post('/api/v1/sites', {
    headers: headers(token),
    data: {
      name: 'campaign-target',
      url: 'https://campaign-target.example.com',
      description: '',
      status: 'active',
      csrfToken: token,
    },
  });
  const siteId = ((await site.json()) as { data: { id: string } }).data.id;

  const created = await createCampaign(request, { name: 'サイト付き', siteIds: [siteId] });

  const got = await request.get(`/api/v1/campaigns/${created.id}`);
  const body = (await got.json()) as { data: { siteIds: string[] } };
  expect(body.data.siteIds).toEqual([siteId]);

  // サイトを消してもキャンペーンは残る。
  const cleanup = await csrf(request);
  await request.delete(`/api/v1/sites/${siteId}`, {
    headers: headers(cleanup),
    data: { csrfToken: cleanup },
  });

  const after = await request.get(`/api/v1/campaigns/${created.id}`);
  expect(after.status()).toBe(200);
  expect(((await after.json()) as { data: { siteIds: string[] } }).data.siteIds).toEqual([]);
});

test('一覧画面が表示され、ナビゲーションから行ける', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'キャンペーン' }).click();

  await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByRole('heading', { name: 'キャンペーン' })).toBeVisible();
});

test('画面から作成・編集・削除ができる', async ({ page }) => {
  await page.goto('/campaigns/new');

  await page.getByLabel('名前').fill('画面から作った施策');
  await page.getByLabel('開始日').fill('2026-06-01');
  await page.getByLabel('終了日').fill('2026-06-30');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page).toHaveURL(/\/campaigns$/);
  await expect(page.getByRole('link', { name: '画面から作った施策' })).toBeVisible();
  // 期間が画面でもずれない。
  await expect(page.getByText('2026-06-01 〜 2026-06-30')).toBeVisible();

  await page.getByRole('link', { name: '画面から作った施策' }).click();
  await page.getByLabel('名前').fill('画面で直した施策');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByRole('link', { name: '画面で直した施策' })).toBeVisible();

  await page
    .getByRole('row', { name: /画面で直した施策/ })
    .getByRole('button', { name: '削除' })
    .click();
  await page.getByRole('button', { name: '削除する' }).click();

  await expect(page.getByRole('link', { name: '画面で直した施策' })).toHaveCount(0);
});

test('終了日を空欄にすると未定として扱われる', async ({ page }) => {
  await page.goto('/campaigns/new');

  await page.getByLabel('名前').fill('終わりが未定の施策');
  await page.getByLabel('開始日').fill('2026-07-01');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.getByText('2026-07-01 〜 （未定）')).toBeVisible();
});
