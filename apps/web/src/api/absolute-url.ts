/**
 * リクエストから絶対 URL を組み立てる。
 *
 * 外部 Provider へ渡す `redirect_uri` のように、
 * **アプリの外から戻ってこられる URL** を作るときに使う
 * （025-redirect-authentication 設計 §9）。
 *
 * **`request.url` を使わない。** Next.js は Route Handler へ渡す `request.url` を
 * `localhost` へ正規化するため、実際に到達したホストと一致しない。
 * `api/csrf.ts` が同一オリジン判定でホストを求めるときと同じ優先順位にそろえる。
 */

/** スキーム。TLS 終端が上流にある構成を考慮する。 */
function scheme(request: Request): string {
  const appUrl = process.env['APP_URL'];
  if (appUrl !== undefined && appUrl !== '') {
    try {
      return new URL(appUrl).protocol.replace(':', '');
    } catch {
      // 設定が壊れているときはヘッダへ落とす。
    }
  }

  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded !== null && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() === 'https' ? 'https' : 'http';
  }

  if (process.env['APP_ENV'] === 'production') {
    // 付け忘れより安全側に倒す（`api/cookies.ts` の Secure 判定と同じ考え方）。
    return 'https';
  }

  try {
    return new URL(request.url).protocol === 'https:' ? 'https' : 'http';
  } catch {
    return 'http';
  }
}

/**
 * ホスト。
 *
 * 1. `APP_URL`（本番で明示するのが最も確実）
 * 2. `x-forwarded-host`（Reverse Proxy の背後）
 * 3. `host`
 */
function host(request: Request): string | null {
  const appUrl = process.env['APP_URL'];
  if (appUrl !== undefined && appUrl !== '') {
    try {
      return new URL(appUrl).host;
    } catch {
      // 同上。
    }
  }

  const forwarded = request.headers.get('x-forwarded-host');
  if (forwarded !== null && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() ?? null;
  }

  const header = request.headers.get('host');
  return header === null || header === '' ? null : header;
}

export class AbsoluteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbsoluteUrlError';
  }
}

/**
 * アプリ内のパスから絶対 URL を作る。
 *
 * **ホストが分からないときは例外にする。** 適当な既定値
 * （`localhost` など）で組み立てると、外部 Provider に登録された
 * Redirect URI と食い違い、原因の分かりにくい失敗になる。
 */
export function absoluteUrl(request: Request, path: string): string {
  const found = host(request);
  if (found === null) {
    throw new AbsoluteUrlError('ホストを特定できない。APP_URL を設定すること。');
  }
  return `${scheme(request)}://${found}${path}`;
}
