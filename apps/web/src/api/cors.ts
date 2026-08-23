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
