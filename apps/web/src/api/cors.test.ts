import { describe, expect, it } from 'vitest';
import { allowedOrigins, corsHeaders, corsPreflightHeaders, CorsConfigurationError } from './cors';

/**
 * CORS（05_API設計.md §43）。
 */

const ALLOWED: Record<string, string | undefined> = {
  TORIFUNE_CORS_ORIGINS: 'https://app.example.com',
};

function preflight(
  origin: string | null,
  env: Record<string, string | undefined> = ALLOWED,
): Record<string, string> {
  return corsPreflightHeaders(
    new Request('https://api.example.com/api/v1/sites', {
      method: 'OPTIONS',
      ...(origin === null ? {} : { headers: { origin } }),
    }),
    env,
  );
}

describe('allowedOrigins', () => {
  it('既定では空', () => {
    expect(allowedOrigins({})).toEqual([]);
  });

  it('* を拒否する', () => {
    expect(() => allowedOrigins({ TORIFUNE_CORS_ORIGINS: '*' })).toThrow(CorsConfigurationError);
  });
});

describe('corsHeaders', () => {
  it('許可した Origin にヘッダを返す', () => {
    const headers = corsHeaders(
      new Request('https://api.example.com/', {
        headers: { origin: 'https://app.example.com' },
      }),
      ALLOWED,
    );
    expect(headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('許可していない Origin には返さない', () => {
    const headers = corsHeaders(
      new Request('https://api.example.com/', { headers: { origin: 'https://evil.example' } }),
      ALLOWED,
    );
    expect(headers).toEqual({});
  });
});

describe('corsPreflightHeaders', () => {
  it('許可したメソッドを返す', () => {
    const headers = preflight('https://app.example.com');
    expect(headers['Access-Control-Allow-Methods']).toContain('PATCH');
    expect(headers['Access-Control-Allow-Methods']).toContain('DELETE');
  });

  /**
   * これが無いと、更新系のクロスオリジン要求は必ずプリフライトで落ちる。
   * CSRF 対策が `x-csrf-token` を要求している（04_認証設計.md §12）ため、
   * CORS を有効にした時点で確実に踏む。
   */
  it('x-csrf-token を許可ヘッダに含める', () => {
    const headers = preflight('https://app.example.com');
    expect(headers['Access-Control-Allow-Headers']?.toLowerCase()).toContain('x-csrf-token');
  });

  it('Content-Type を許可ヘッダに含める', () => {
    const headers = preflight('https://app.example.com');
    expect(headers['Access-Control-Allow-Headers']?.toLowerCase()).toContain('content-type');
  });

  it('資格情報つきの要求を許可する', () => {
    expect(preflight('https://app.example.com')['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('保持してよい秒数を返す', () => {
    expect(Number(preflight('https://app.example.com')['Access-Control-Max-Age'])).toBeGreaterThan(
      0,
    );
  });

  /** 応答が別の要求へ再利用されないようにする。 */
  it('Vary に要求メソッドと要求ヘッダを含める', () => {
    const vary = preflight('https://app.example.com')['Vary'] ?? '';
    expect(vary).toContain('Origin');
    expect(vary).toContain('Access-Control-Request-Method');
    expect(vary).toContain('Access-Control-Request-Headers');
  });

  it('許可していない Origin には何も返さない', () => {
    expect(preflight('https://evil.example')).toEqual({});
  });

  it('CORS を設定していなければ何も返さない', () => {
    expect(preflight('https://app.example.com', {})).toEqual({});
  });

  it('Origin が無ければ何も返さない', () => {
    expect(preflight(null)).toEqual({});
  });
});
