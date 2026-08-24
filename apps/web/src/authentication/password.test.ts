import { describe, expect, it } from 'vitest';
import { hashPassword, MAX_PASSWORD_BYTES, PasswordTooLongError, verifyPassword } from './password';

// テストではハッシュ計算を弱めて速くする。強度の検証は形式で行う。
const fast = { memoryCost: 8, timeCost: 1, parallelism: 1 } as const;

describe('hashPassword', () => {
  it('同じパスワードでも毎回異なるハッシュになる', async () => {
    const a = await hashPassword('correct horse battery staple', fast);
    const b = await hashPassword('correct horse battery staple', fast);
    expect(a).not.toBe(b);
  });

  it('Argon2id の形式である', async () => {
    const hash = await hashPassword('pw', fast);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('空のパスワードを拒否する', async () => {
    await expect(hashPassword('', fast)).rejects.toThrowError();
  });

  it('空白だけのパスワードを拒否する', async () => {
    await expect(hashPassword('   ', fast)).rejects.toThrowError();
  });

  it('長すぎるパスワードを拒否する', async () => {
    const long = 'a'.repeat(MAX_PASSWORD_BYTES + 1);
    await expect(hashPassword(long, fast)).rejects.toThrowError(PasswordTooLongError);
  });

  it('上限ちょうどのパスワードは受け付ける', async () => {
    const atLimit = 'a'.repeat(MAX_PASSWORD_BYTES);
    await expect(hashPassword(atLimit, fast)).resolves.toBeTypeOf('string');
  });

  it('マルチバイト文字はバイト数で判定する', async () => {
    // 「あ」は UTF-8 で3バイト。文字数ではなくバイト数で上限を見ていること。
    const tooLong = 'あ'.repeat(Math.floor(MAX_PASSWORD_BYTES / 3) + 1);
    await expect(hashPassword(tooLong, fast)).rejects.toThrowError(PasswordTooLongError);
  });
});

describe('verifyPassword', () => {
  it('正しいパスワードを受け入れる', async () => {
    const hash = await hashPassword('s3cret', fast);
    await expect(verifyPassword(hash, 's3cret')).resolves.toBe(true);
  });

  it('誤ったパスワードを拒否する', async () => {
    const hash = await hashPassword('s3cret', fast);
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('ハッシュが壊れていても例外を投げず false を返す', async () => {
    await expect(verifyPassword('not-a-hash', 'anything')).resolves.toBe(false);
  });

  it('長すぎる入力でも例外を投げず false を返す', async () => {
    const hash = await hashPassword('s3cret', fast);
    await expect(verifyPassword(hash, 'a'.repeat(MAX_PASSWORD_BYTES + 1))).resolves.toBe(false);
  });
});

describe('verifyPasswordAgainstDummy', () => {
  it('存在しないユーザーでも同じだけ計算する（呼べて false を返す）', async () => {
    const { verifyPasswordAgainstDummy } = await import('./password');
    await expect(verifyPasswordAgainstDummy('anything')).resolves.toBe(false);
  });
});
