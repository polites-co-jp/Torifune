/**
 * CORS（05_API設計.md §43）。
 *
 * **既定では無効。** 必要な人だけが `TORIFUNE_CORS_ORIGINS` で明示する。
 * 既定で開けておくと、開けていることに誰も気づかない。
 */

export class CorsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorsConfigurationError';
  }
}

/**
 * 許可する Origin を読む。
 *
 * `*` を拒否する。資格情報つきのリクエストで `*` は使えず、
 * 使えたとしても「誰でもよい」は本番で意図した設定になりえない。
 */
export function allowedOrigins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const raw = env['TORIFUNE_CORS_ORIGINS'];
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');

  if (origins.includes('*')) {
    throw new CorsConfigurationError(
      'TORIFUNE_CORS_ORIGINS に * は指定できない。許可する Origin を明示すること。',
    );
  }

  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.origin !== origin) {
        throw new CorsConfigurationError(`Origin の形式が不正: ${origin}`);
      }
    } catch (error) {
      if (error instanceof CorsConfigurationError) {
        throw error;
      }
      throw new CorsConfigurationError(`Origin の形式が不正: ${origin}`);
    }
  }

  return origins;
}

/** リクエストの Origin が許可されていれば、CORS ヘッダを返す。 */
export function corsHeaders(
  request: Request,
  env?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const origin = request.headers.get('origin');
  if (origin === null) {
    return {};
  }

  if (!allowedOrigins(env).includes(origin)) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

/** Preflight で許可するメソッド。API が実際に使うものだけを挙げる。 */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/**
 * Preflight で許可するヘッダ。
 *
 * **`x-csrf-token` を含める。** 含めないと、更新系のクロスオリジン要求が
 * 必ずプリフライトで落ちる（04_認証設計.md §12 が要求するヘッダなので、
 * CORS を有効にした時点で確実に踏む）。
 */
const ALLOWED_HEADERS = 'Content-Type, X-CSRF-Token';

/** ブラウザが Preflight の結果を保持してよい秒数。 */
const MAX_AGE_SECONDS = 600;

/**
 * Preflight（`OPTIONS`）への応答ヘッダ（05_API設計.md §43）。
 *
 * 許可していない Origin には**何も返さない**（空を返す）。
 * 呼び出し側は空なら CORS ヘッダ無しで 204 を返し、ブラウザ側で落とさせる。
 */
export function corsPreflightHeaders(
  request: Request,
  env?: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const base = corsHeaders(request, env);
  if (Object.keys(base).length === 0) {
    return {};
  }

  return {
    ...base,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': String(MAX_AGE_SECONDS),
    // Origin だけで振り分けると、プリフライトの応答が別の要求へ再利用されうる。
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}
