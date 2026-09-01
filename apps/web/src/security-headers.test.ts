import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders, generateNonce } from './security-headers';

/**
 * CSP / HSTS（04_認証設計.md §13、05_API設計.md §42）。
 */

function headersFor(url: string, extra?: Record<string, string>): Record<string, string> {
  return buildSecurityHeaders(new Request(url, { headers: extra }), 'test-nonce');
}

describe('generateNonce', () => {
  it('毎回異なる値を返す', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });

  it('base64 として扱える長さがある', () => {
    // 短すぎる nonce は総当たりで当てられ、CSP の意味が無くなる。
    expect(generateNonce().length).toBeGreaterThanOrEqual(16);
  });
});

describe('CSP', () => {
  it('script-src に nonce を載せる', () => {
    const csp = headersFor('https://example.com/')['Content-Security-Policy'] as string;
    expect(csp).toContain("script-src 'self' 'nonce-test-nonce'");
  });

  /** スクリプトに unsafe-inline を許すと、CSP を入れる意味がほぼ無くなる。 */
  it('script-src に unsafe-inline を許さない', () => {
    const csp = headersFor('https://example.com/')['Content-Security-Policy'] as string;
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('object-src と frame-ancestors を閉じる', () => {
    const csp = headersFor('https://example.com/')['Content-Security-Policy'] as string;
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('既定の取得元を self に閉じる', () => {
    const csp = headersFor('https://example.com/')['Content-Security-Policy'] as string;
    expect(csp).toContain("default-src 'self'");
  });
});

describe('HSTS', () => {
  it('HTTPS では付ける', () => {
    expect(headersFor('https://example.com/')['Strict-Transport-Security']).toContain('max-age=');
  });

  /**
   * HTTP で付けても効かず、http://localhost の開発環境を壊すだけ。
   */
  it('HTTP では付けない', () => {
    expect(headersFor('http://localhost:3000/')['Strict-Transport-Security']).toBeUndefined();
  });

  it('プロキシ越しの https を x-forwarded-proto で判断する', () => {
    const headers = headersFor('http://internal:3000/', { 'x-forwarded-proto': 'https' });
    expect(headers['Strict-Transport-Security']).toContain('max-age=');
  });
});

describe('その他のヘッダ', () => {
  it('MIME スニッフィングを止める', () => {
    expect(headersFor('https://example.com/')['X-Content-Type-Options']).toBe('nosniff');
  });

  it('Referrer を絞る', () => {
    expect(headersFor('https://example.com/')['Referrer-Policy']).toBe(
      'strict-origin-when-cross-origin',
    );
  });
});
