import { expect, test } from '@playwright/test';

/**
 * 022-hardening の受け入れ条件（docs/設計/022-hardening/設計.md §7）。
 */

test.describe('セキュリティ応答ヘッダ', () => {
  test('CSP が付く', async ({ request }) => {
    const response = await request.get('/login');
    const csp = response.headers()['content-security-policy'];

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  /** 許すと CSP を入れる意味がほぼ無くなる。 */
  test('script-src に unsafe-inline を許さない', async ({ request }) => {
    const csp = (await request.get('/login')).headers()['content-security-policy'] ?? '';
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  test('リクエストごとに nonce が変わる', async ({ request }) => {
    const nonceOf = (csp: string): string | undefined => /'nonce-([^']+)'/.exec(csp)?.[1];

    const first = nonceOf((await request.get('/login')).headers()['content-security-policy'] ?? '');
    const second = nonceOf(
      (await request.get('/login')).headers()['content-security-policy'] ?? '',
    );

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  test('MIME スニッフィングを止める', async ({ request }) => {
    expect((await request.get('/login')).headers()['x-content-type-options']).toBe('nosniff');
  });

  /** HTTP で付けても効かず、開発環境を壊すだけ。E2E は http で動く。 */
  test('HTTP では HSTS を付けない', async ({ request }) => {
    expect((await request.get('/login')).headers()['strict-transport-security']).toBeUndefined();
  });

  /** CSP を入れて画面が壊れていないこと。壊れていたら本末転倒。 */
  test('CSP のもとで画面が動く', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) {
        violations.push(message.text());
      }
    });

    await page.goto('/sites');
    await expect(page.getByRole('heading', { name: 'Webサイト' })).toBeVisible();

    expect(violations).toEqual([]);
  });
});

test.describe('CORS の Preflight', () => {
  /**
   * CORS は既定で無効（TORIFUNE_CORS_ORIGINS 未設定）。
   * 許可していない Origin へ CORS ヘッダを返さないことを確かめる。
   */
  test('許可していない Origin には CORS ヘッダを返さない', async ({ request }) => {
    const response = await request.fetch('/api/v1/sites', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-csrf-token',
      },
    });

    expect(response.status()).toBe(204);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  });

  /** Preflight を本体の処理へ通さない。通せば認証や CSRF に当たって落ちる。 */
  test('Preflight は 204 で返り、本体の処理へ通らない', async ({ request }) => {
    const response = await request.fetch('/api/v1/sites', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });

    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
  });
});

// Rate Limit の検証は、上限を使い切って後続のテストを巻き込むため
// `z-rate-limit.spec.ts` に分けてある（実行順で最後になるようにしている）。
