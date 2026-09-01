/**
 * セキュリティ応答ヘッダ（04_認証設計.md §13、05_API設計.md §42）。
 *
 * `middleware.ts` から全リクエストへ付ける。
 * **ルートごとに付けると必ず抜ける**（CSRF や Rate Limit と同じ理屈）。
 */

/** HSTS の期間。2年。プリロードを見据えた一般的な値。 */
const HSTS_MAX_AGE = 63_072_000;

/** nonce の長さ（バイト）。短いと総当たりで当てられ、CSP の意味が無くなる。 */
const NONCE_BYTES = 16;

export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/** そのリクエストが HTTPS で受けたものか。プロキシ越しも見る。 */
function isHttps(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded !== null) {
    // 複数段のプロキシでは "https, http" のように連なる。最初が客側。
    return forwarded.split(',')[0]?.trim() === 'https';
  }
  return new URL(request.url).protocol === 'https:';
}

/**
 * CSP を組み立てる。
 *
 * **`script-src` に `unsafe-inline` を許さない。** 許すと CSP を入れる意味がほぼ無い。
 * Next.js の inline script は nonce で通す。
 *
 * `style-src` は `unsafe-inline` を許す。Next.js と Tailwind が
 * インラインの style 属性を使うためで、ここは XSS の主要経路ではない。
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // API は同一オリジン。外部への送信は既定で許さない。
    "connect-src 'self'",
    // 埋め込みプラグイン（Flash 等）を一切許さない。
    "object-src 'none'",
    // クリックジャッキング対策。X-Frame-Options の後継。
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function buildSecurityHeaders(request: Request, nonce: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': contentSecurityPolicy(nonce),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };

  // HTTP で付けても効かず、http://localhost の開発環境を壊すだけ。
  if (isHttps(request)) {
    headers['Strict-Transport-Security'] = `max-age=${HSTS_MAX_AGE}; includeSubDomains`;
  }

  return headers;
}
