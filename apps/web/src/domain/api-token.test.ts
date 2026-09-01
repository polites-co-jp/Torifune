import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_PREFIX,
  bearerTokenOf,
  effectiveTokenPermissions,
  generateApiToken,
  hashApiToken,
  isUsable,
  isValidApiTokenName,
  type ApiToken,
} from './api-token';

function token(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 'id',
    userId: 'user',
    name: 'CI',
    prefix: 'tfp_abcd1234',
    scopes: ['site.read'],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('generateApiToken', () => {
  it('毎回異なる値を返す', () => {
    expect(generateApiToken().plaintext).not.toBe(generateApiToken().plaintext);
  });

  it('接頭辞を付ける', () => {
    // ログや設定に紛れ込んだときに Torifune の Token だと気づけるようにする。
    expect(generateApiToken().plaintext.startsWith(API_TOKEN_PREFIX)).toBe(true);
  });

  it('ハッシュは平文と一致しない', () => {
    const generated = generateApiToken();
    expect(generated.tokenHash).not.toBe(generated.plaintext);
    expect(generated.tokenHash).toBe(hashApiToken(generated.plaintext));
  });

  it('prefix だけでは平文を復元できない', () => {
    const generated = generateApiToken();
    expect(generated.plaintext.startsWith(generated.prefix)).toBe(true);
    expect(generated.prefix.length).toBeLessThan(generated.plaintext.length / 2);
  });

  it('総当たりできない長さがある', () => {
    expect(generateApiToken().plaintext.length).toBeGreaterThan(40);
  });
});

describe('isUsable', () => {
  const now = new Date('2026-06-01T00:00:00Z');

  it('無期限・未失効なら使える', () => {
    expect(isUsable(token(), now)).toBe(true);
  });

  it('失効していれば使えない', () => {
    expect(isUsable(token({ revokedAt: new Date('2026-05-01') }), now)).toBe(false);
  });

  it('期限が切れていれば使えない', () => {
    expect(isUsable(token({ expiresAt: new Date('2026-05-31T23:59:59Z') }), now)).toBe(false);
  });

  it('期限内なら使える', () => {
    expect(isUsable(token({ expiresAt: new Date('2026-06-02') }), now)).toBe(true);
  });

  /** 失効が期限より優先される。期限内でも失効していたら使えない。 */
  it('期限内でも失効していれば使えない', () => {
    expect(
      isUsable(
        token({ expiresAt: new Date('2026-12-31'), revokedAt: new Date('2026-05-01') }),
        now,
      ),
    ).toBe(false);
  });
});

describe('effectiveTokenPermissions', () => {
  it('所有者の権限と Scope の交差を返す', () => {
    const result = effectiveTokenPermissions(new Set(['site.read', 'site.write']), [
      'site.read',
      'social.read',
    ]);
    expect([...result]).toEqual(['site.read']);
  });

  /**
   * Token は権限を増やせない。
   * ロールを外されたユーザーの Token が、外す前の権限で動き続けてはならない。
   */
  it('所有者が持たない Scope は効かない', () => {
    const result = effectiveTokenPermissions(new Set(['site.read']), ['user.manage']);
    expect(result.size).toBe(0);
  });

  it('Scope が空なら何もできない', () => {
    expect(effectiveTokenPermissions(new Set(['site.read']), []).size).toBe(0);
  });
});

describe('bearerTokenOf', () => {
  it('Bearer を取り出す', () => {
    expect(bearerTokenOf('Bearer tfp_abc')).toBe('tfp_abc');
  });

  it('大文字小文字を区別しない', () => {
    expect(bearerTokenOf('bearer tfp_abc')).toBe('tfp_abc');
  });

  it.each([null, '', 'tfp_abc', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer  ', 'Bearer a b'])(
    'Bearer でなければ null: %s',
    (header) => {
      expect(bearerTokenOf(header)).toBeNull();
    },
  );
});

describe('isValidApiTokenName', () => {
  it('空を拒否する', () => {
    expect(isValidApiTokenName('   ')).toBe(false);
  });

  it('長すぎる名前を拒否する', () => {
    expect(isValidApiTokenName('a'.repeat(101))).toBe(false);
  });

  it('通常の名前を受け入れる', () => {
    expect(isValidApiTokenName('CI 用')).toBe(true);
  });
});
