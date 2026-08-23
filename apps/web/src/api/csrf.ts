import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * CSRF 対策（04_認証設計.md §12、07_開発者向けガイド.md §34）。
 *
 * 2段構えにしている。
 *
 * 1. Origin / Sec-Fetch-Site が同一オリジンか
 * 2. Cookie のトークンと、送信されたトークンが一致するか
 *
 * 1 だけにしないのは、特殊な経路で Origin が落ちることがあるため。
 * 2 だけにしないのは、サブドメインからの Cookie 書き込みで破られうるため。
 */

/** CSRF トークンを生成する。 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * リクエストが届いたホスト名を求める。
 *
 * **`request.url` を使わない。** Next.js は Route Handler へ渡す `request.url` を
 * `localhost` に正規化するため、実際のホストと一致しない。
 *
 * 優先順位:
 * 1. `APP_URL`（本番で明示するのが最も確実）
 * 2. `x-forwarded-host`（Reverse Proxy の背後）
 * 3. `host`
 */
function expectedHost(request: Request): string | null {
  const appUrl = process.env['APP_URL'];
  if (appUrl !== undefined && appUrl !== '') {
    try {
      return new URL(appUrl).host;
    } catch {
      // 設定が壊れているときはヘッダへ落とす。
    }
  }

  const forwarded = request.headers.get('x-forwarded-host');
  if (forwarded !== null && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() ?? null;
  }

  const host = request.headers.get('host');
  return host === null || host === '' ? null : host;
}

/**
 * 同一オリジンからのリクエストかを判定する。
 *
 * **判断材料が無いときは false**。通してしまうと、ヘッダを送らないクライアントから
 * CSRF を通せてしまう。
 */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');

  if (origin !== null) {
    const host = expectedHost(request);
    if (host === null) {
      return false;
    }
    try {
      // 比較するのはホストとポート。スキームは Reverse Proxy で変わりうるため見ない
      // （TLS 終端の有無で判定が揺れると、本番だけ通らないという壊れ方をする）。
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  return site === 'same-origin';
}

export interface CsrfInput {
  /** Cookie に入っているトークン。 */
  readonly cookieToken: string | undefined;
  /** リクエストボディから渡されたトークン（ヘッダで送らない場合）。 */
  readonly bodyToken?: string | undefined;
}

/** 長さの違いを漏らさずに比較する。 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function verifyCsrf(request: Request, input: CsrfInput): boolean {
  if (!isSameOriginRequest(request)) {
    return false;
  }

  const cookieToken = input.cookieToken;
  if (cookieToken === undefined || cookieToken === '') {
    return false;
  }

  const sent = request.headers.get('x-csrf-token') ?? input.bodyToken;
  if (sent === undefined || sent === null || sent === '') {
    return false;
  }

  return constantTimeEquals(cookieToken, sent);
}
