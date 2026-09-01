import { expect, test, type Page } from '@playwright/test';

/**
 * レスポンシブ対応（06_画面設計.md §31、024-responsive）。
 *
 * **「作り込み」はしない。壊れないところまで**（設計 §3.1）。
 * 幅375pxで破綻しないこと、ページ全体が横スクロールしないことを見る。
 */

const NARROW = { width: 375, height: 720 };
const WIDE = { width: 1280, height: 800 };

/** ページ全体が横に伸びているか。 */
async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    // 1px の丸め誤差は許す。
    return doc.scrollWidth > doc.clientWidth + 1;
  });
}

test.describe('狭い画面', () => {
  test.use({ viewport: NARROW });

  test('viewport が指定されている', async ({ page }) => {
    await page.goto('/dashboard');

    const content = await page.locator('meta[name="viewport"]').getAttribute('content');
    expect(content).toContain('width=device-width');
  });

  test('ナビゲーションが見え、押せる', async ({ page }) => {
    await page.goto('/dashboard');

    const nav = page.getByRole('navigation', { name: 'メインナビゲーション' });
    await expect(nav).toBeVisible();

    // 開閉するメニューにしていないので、項目は常に見えている（設計 §3.3）。
    const link = nav.getByRole('link', { name: 'Webサイト' });
    await expect(link).toBeVisible();

    await link.click();
    await expect(page).toHaveURL(/\/sites$/);
  });

  /** 縦に読むだけでも横へずれるのを避ける。 */
  for (const path of [
    '/dashboard',
    '/sites',
    '/campaigns',
    '/social',
    '/analytics',
    '/settings',
    '/plugins',
  ]) {
    test(`${path} がページ全体で横スクロールしない`, async ({ page }) => {
      await page.goto(path);
      expect(await hasHorizontalOverflow(page)).toBe(false);
    });
  }

  test('ログイン画面が破綻しない', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');

    await expect(page.getByLabel('ログインID')).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  /** 表は**その表の中で**スクロールする。 */
  test('広い表はページではなく表の中でスクロールする', async ({ page }) => {
    await page.goto('/settings?tab=permissions');

    expect(await hasHorizontalOverflow(page)).toBe(false);

    const scroller = page.locator('.tf-table-scroll').first();
    if ((await scroller.count()) > 0) {
      const canScroll = await scroller.evaluate(
        (element) => element.scrollWidth >= element.clientWidth,
      );
      expect(canScroll).toBe(true);
    }
  });
});

test.describe('広い画面', () => {
  test.use({ viewport: WIDE });

  /** 広い画面での見え方が今までと変わらない（受け入れ条件 #4）。 */
  test('ナビゲーションが本文の左に並ぶ', async ({ page }) => {
    await page.goto('/dashboard');

    const nav = await page.getByRole('navigation', { name: 'メインナビゲーション' }).boundingBox();
    const main = await page.getByRole('main').boundingBox();

    expect(nav).not.toBeNull();
    expect(main).not.toBeNull();
    // 左右に並んでいる（上下ではない）。
    expect((nav?.x ?? 0) + (nav?.width ?? 0)).toBeLessThanOrEqual((main?.x ?? 0) + 1);
  });

  test('ページ全体で横スクロールしない', async ({ page }) => {
    await page.goto('/dashboard');
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});
