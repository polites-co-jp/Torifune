/**
 * Cookie の属性を一箇所で決める（04_認証設計.md §8）。
 *
 * 属性を各所で組み立てると、いつか `HttpOnly` を付け忘れる。
 * **Cookie を作る経路をここだけにする。**
 */

export const SESSION_COOKIE = 'torifune_session';
/** CSRF トークンは JavaScript が読む必要があるため、セッションとは別の Cookie にする。 */
export const CSRF_COOKIE = 'torifune_csrf';

/**
 * `Secure` を付けるかを、**リクエストのスキームから**決める。
 *
 * `NODE_ENV` では判定しない。`next start` は常に `NODE_ENV=production` を立てるため、
 * HTTP で提供している環境でも Secure が付き、Cookie が送られなくなる。
 *
 * `APP_ENV=production` を明示している場合は、TLS 終端が上流にあって
 * `x-forwarded-proto` が落ちていても Secure を付ける（付け忘れより安全側に倒す）。
 */
export function isSecureRequest(request: Request | undefined): boolean {
  if (process.env['APP_ENV'] === 'production') {
    return true;
  }
  if (request === undefined) {
    return false;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto !== null && forwardedProto !== '') {
    return forwardedProto.split(',')[0]?.trim() === 'https';
  }

  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

interface CookieOptions {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly maxAgeSeconds?: number | undefined;
  readonly expires?: Date | undefined;
}

function serialize(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Lax'];

  if (options.httpOnly) {
    parts.push('HttpOnly');
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }

  return parts.join('; ');
}

/** セッション Cookie。**必ず HttpOnly**（JavaScript から読ませない）。 */
export function sessionCookie(request: Request, token: string, expiresAt: Date): string {
  return serialize(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(request),
    expires: expiresAt,
  });
}

/** セッション Cookie を消す。 */
export function clearedSessionCookie(request: Request): string {
  return serialize(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: isSecureRequest(request),
    maxAgeSeconds: 0,
  });
}

/** CSRF Cookie。JavaScript が読めるよう HttpOnly を付けない。 */
export function csrfCookie(request: Request, token: string): string {
  return serialize(CSRF_COOKIE, token, { httpOnly: false, secure: isSecureRequest(request) });
}

/** Cookie ヘッダから1つ取り出す。 */
export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (header === null) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

/**
 * ヘッダから送信元 IP を取り出す（033-analytics-ip-exclusion 設計 §10.1）。
 *
 * Reverse Proxy 越しを想定する。信頼できるプロキシの背後にいることが前提。
 *
 * **取り出しを 1 か所にする。** リクエスト（API）と `headers()`（Server Component）で
 * 別々に書くと、**設定画面に出る IP と、実際に除外判定される IP がずれる。**
 * `Request` の `headers` も Next.js の `headers()` の戻り値も `get` を持つので、
 * 両方からこの関数を呼べる。
 */
export function clientIpOf(headers: Pick<Headers, 'get'>): string | null {
  const forwarded = headers.get('x-forwarded-for');
  const ipAddress =
    forwarded !== null && forwarded !== ''
      ? (forwarded.split(',')[0]?.trim() ?? null)
      : (headers.get('x-real-ip') ?? null);

  return ipAddress === '' ? null : ipAddress;
}

/** リクエストから IP と User-Agent を取り出す。 */
export function requestInfoOf(request: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    ipAddress: clientIpOf(request.headers),
    userAgent: request.headers.get('user-agent'),
  };
}
