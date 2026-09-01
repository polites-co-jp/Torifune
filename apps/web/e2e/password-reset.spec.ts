import { expect, test } from '@playwright/test';

/**
 * パスワード再設定の画面（019-notification 設計 §3.5、§3.6）。
 *
 * フロー全体（要求 → リンク → 再設定 → 旧セッション失効）は
 * `auth.integration.test.ts`「配られたリンクから再設定まで通る」で検証している。
 * E2E からは平文トークンを取り出せない（DB にはハッシュしか無い）ため、
 * ここでは画面の振る舞いだけを見る。
 */

test.beforeEach(async ({ page }) => {
  // 再設定は未認証で使う画面。
  await page.context().clearCookies();
});

/**
 * **表示できるだけでは足りない。** 実際に送信できるところまで見る。
 *
 * CSP を入れたとき、静的に生成されたページは HTML が出るのに
 * スクリプトが全部ブロックされて操作できない、という壊れ方をした。
 * 「見えること」だけを確かめるテストは、それを通してしまう。
 */
test('要求画面から送信できる', async ({ page }) => {
  await page.goto('/password-reset');

  await page.getByLabel('メールアドレス').fill('nobody@example.com');
  await page.getByRole('button', { name: '再設定用のリンクを送る' }).click();

  // 登録の有無にかかわらず同じ結果になる（04_認証設計.md §24）。
  await expect(page).toHaveURL(/\/login$/);
});

test('リンクからたどり着く再設定画面が表示される', async ({ page }) => {
  await page.goto('/password-reset/confirm?token=some-token');

  await expect(page.getByLabel('新しいパスワード')).toBeVisible();
  // 何が起きるのかを事前に伝える。黙ってログアウトさせない。
  await expect(page.getByText(/セッションはすべて終了/)).toBeVisible();
});

test('トークンが無ければ入力欄を出さない', async ({ page }) => {
  await page.goto('/password-reset/confirm');

  await expect(page.getByLabel('新しいパスワード')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
});

/**
 * 無効・期限切れ・使用済みを区別しない（設計 §3.6）。
 * 区別すると、トークンの有効性を調べる手段になる。
 */
test('無効なトークンでは再設定できず、理由を明かさない', async ({ page }) => {
  await page.goto('/password-reset/confirm?token=definitely-not-a-real-token');

  await page.getByLabel('新しいパスワード').fill('a brand new passphrase');
  await page.getByRole('button', { name: 'パスワードを設定する' }).click();

  const alert = page.getByRole('main').getByRole('alert');
  await expect(alert).toBeVisible();

  // 「期限切れ」「使用済み」「存在しない」を書き分けない。
  const text = (await alert.textContent()) ?? '';
  expect(text).not.toMatch(/期限|使用済み|存在しません/);
});
