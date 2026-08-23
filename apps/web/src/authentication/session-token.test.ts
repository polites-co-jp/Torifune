import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken, SESSION_TOKEN_BYTES } from './session-token';

describe('generateSessionToken', () => {
  it('毎回異なる値を返す', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateSessionToken()));
    expect(seen.size).toBe(100);
  });

  it('256bit 相当の長さがある', () => {
    expect(SESSION_TOKEN_BYTES).toBeGreaterThanOrEqual(32);
    // base64url は 3 バイト → 4 文字。
    expect(generateSessionToken().length).toBeGreaterThanOrEqual(43);
  });

  it('URL に安全な文字だけを含む', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateSessionToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('hashSessionToken', () => {
  it('同じトークンには同じハッシュを返す', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('違うトークンには違うハッシュを返す', () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(
      hashSessionToken(generateSessionToken()),
    );
  });

  it('ハッシュからトークンが復元できない（元の文字列を含まない）', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toContain(token);
  });

  it('16進64文字（SHA-256）を返す', () => {
    expect(hashSessionToken('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
