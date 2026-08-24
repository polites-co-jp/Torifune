import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret, secretStatusOf } from '@/domain/secret';
import { decryptSecret, encryptSecret } from './cipher';
import { EncryptionKeyError, KEY_BYTES, loadEncryptionKey, type EncryptionKey } from './key';

const key: EncryptionKey = { id: 'k1', material: randomBytes(KEY_BYTES) };
const otherKey: EncryptionKey = { id: 'k1', material: randomBytes(KEY_BYTES) };
const rotatedKey: EncryptionKey = { id: 'k2', material: randomBytes(KEY_BYTES) };

describe('暗号化', () => {
  it('暗号文が元の平文を含まない', () => {
    const plaintext = 'super-secret-access-token';
    expect(encryptSecret(plaintext, key)).not.toContain(plaintext);
  });

  it('同じ平文でも毎回異なる暗号文になる', () => {
    // IV が毎回変わること。同じになると、同じ値かどうかを外から判別できてしまう。
    expect(encryptSecret('same', key)).not.toBe(encryptSecret('same', key));
  });

  it('復号すると元に戻る', () => {
    const result = decryptSecret(encryptSecret('hello', key), key);
    expect(result.ok && result.secret.expose()).toBe('hello');
  });

  it('空文字を往復できる', () => {
    const result = decryptSecret(encryptSecret('', key), key);
    expect(result.ok && result.secret.expose()).toBe('');
  });

  it('マルチバイト文字を往復できる', () => {
    const value = 'とりふね🐦のトークン';
    const result = decryptSecret(encryptSecret(value, key), key);
    expect(result.ok && result.secret.expose()).toBe(value);
  });

  it('長い値を往復できる', () => {
    const value = 'a'.repeat(1024 * 1024);
    const result = decryptSecret(encryptSecret(value, key), key);
    expect(result.ok && result.secret.expose()).toBe(value);
  });
});

/**
 * 指定した位置のバイトを反転させる。
 *
 * base64 の末尾文字は全ビットを使わないため、文字を1つ書き換えても
 * デコード結果が変わらないことがある。**バイト列で操作する。**
 */
function flipByte(encoded: string, partIndex: number): string {
  const parts = encoded.split('.');
  const buffer = Buffer.from(parts[partIndex] as string, 'base64url');
  buffer[0] = (buffer[0] as number) ^ 0xff;
  parts[partIndex] = buffer.toString('base64url');
  return parts.join('.');
}

describe('改ざん検出', () => {
  it('暗号文を変えると復号に失敗する', () => {
    expect(decryptSecret(flipByte(encryptSecret('hello', key), 4), key)).toEqual({
      ok: false,
      reason: 'tampered',
    });
  });

  it('認証タグを変えると復号に失敗する', () => {
    expect(decryptSecret(flipByte(encryptSecret('hello', key), 3), key)).toEqual({
      ok: false,
      reason: 'tampered',
    });
  });

  it('IV を変えると復号に失敗する', () => {
    expect(decryptSecret(flipByte(encryptSecret('hello', key), 2), key)).toEqual({
      ok: false,
      reason: 'tampered',
    });
  });

  it('形式が壊れていれば malformed', () => {
    expect(decryptSecret('not-encrypted', key)).toEqual({ ok: false, reason: 'malformed' });
    expect(decryptSecret('v1.k1.a.b', key)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('形式バージョンが違えば malformed', () => {
    const encoded = encryptSecret('hello', key).replace(/^v1\./, 'v9.');
    expect(decryptSecret(encoded, key)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('IV の長さが違えば malformed', () => {
    const parts = encryptSecret('hello', key).split('.');
    parts[2] = Buffer.alloc(8).toString('base64url');
    expect(decryptSecret(parts.join('.'), key)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('失敗は例外ではなく結果として返る', () => {
    // 例外にすると、呼び出し側が握り潰して「復号できなかったのに処理が続く」状態を作りやすい。
    expect(() => decryptSecret('garbage', key)).not.toThrow();
  });
});

describe('鍵', () => {
  it('暗号文に鍵IDが含まれる', () => {
    expect(encryptSecret('x', key).split('.')[1]).toBe('k1');
  });

  it('暗号文に鍵そのものが含まれない', () => {
    const encoded = encryptSecret('x', key);
    expect(encoded).not.toContain(key.material.toString('base64'));
    expect(encoded).not.toContain(key.material.toString('base64url'));
    expect(encoded).not.toContain(key.material.toString('hex'));
  });

  it('別の鍵では復号できない', () => {
    expect(decryptSecret(encryptSecret('hello', key), otherKey)).toEqual({
      ok: false,
      reason: 'tampered',
    });
  });

  it('鍵IDが違えば wrong_key を返す', () => {
    // ローテーション中に旧鍵で試すべきことを、呼び出し側が判断できるようにする。
    expect(decryptSecret(encryptSecret('hello', key), rotatedKey)).toEqual({
      ok: false,
      reason: 'wrong_key',
    });
  });
});

describe('loadEncryptionKey', () => {
  const valid = randomBytes(KEY_BYTES).toString('base64');

  it('正しい鍵を読める', () => {
    expect(loadEncryptionKey({ TORIFUNE_ENCRYPTION_KEY: valid }).material.length).toBe(KEY_BYTES);
  });

  it('未設定なら例外', () => {
    // 黙って平文保存へ落ちる実装は、動いて見えるぶん危険。
    expect(() => loadEncryptionKey({})).toThrowError(EncryptionKeyError);
  });

  it('空文字なら例外', () => {
    expect(() => loadEncryptionKey({ TORIFUNE_ENCRYPTION_KEY: '   ' })).toThrowError(
      EncryptionKeyError,
    );
  });

  it('長さが違えば例外', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => loadEncryptionKey({ TORIFUNE_ENCRYPTION_KEY: short })).toThrowError(
      EncryptionKeyError,
    );
  });

  it('例外メッセージに鍵の値が含まれない', () => {
    const short = randomBytes(16).toString('base64');
    try {
      loadEncryptionKey({ TORIFUNE_ENCRYPTION_KEY: short });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });

  it('鍵IDを指定できる', () => {
    expect(
      loadEncryptionKey({ TORIFUNE_ENCRYPTION_KEY: valid, TORIFUNE_ENCRYPTION_KEY_ID: 'k7' }).id,
    ).toBe('k7');
  });

  it('鍵IDの既定は k1', () => {
    expect(loadEncryptionKey({ TORIFUNE_ENCRYPTION_KEY: valid }).id).toBe('k1');
  });
});

describe('Secret 型', () => {
  const secret = new Secret('top-secret-value');

  it('JSON.stringify で平文が出ない', () => {
    expect(JSON.stringify({ token: secret })).not.toContain('top-secret-value');
  });

  it('String() で平文が出ない', () => {
    expect(String(secret)).not.toContain('top-secret-value');
  });

  it('util.inspect（console.log 相当）で平文が出ない', () => {
    expect(inspect(secret)).not.toContain('top-secret-value');
    expect(inspect({ nested: { deep: secret } }, { depth: 5 })).not.toContain('top-secret-value');
  });

  it('テンプレートリテラルで平文が出ない', () => {
    expect(`token=${secret}`).not.toContain('top-secret-value');
  });

  it('文字列連結で平文が出ない', () => {
    expect('token=' + String(secret)).not.toContain('top-secret-value');
  });

  it('expose() で明示的に取り出せる', () => {
    expect(secret.expose()).toBe('top-secret-value');
  });

  it('Object.keys で内部の値が見えない', () => {
    expect(Object.keys(secret)).toEqual([]);
  });

  it('スプレッドで平文が漏れない', () => {
    expect(JSON.stringify({ ...secret })).not.toContain('top-secret-value');
  });
});

describe('secretStatusOf', () => {
  it('値があれば設定済み', () => {
    expect(secretStatusOf(new Secret('x'))).toEqual({ configured: true });
  });

  it('null なら未設定', () => {
    expect(secretStatusOf(null)).toEqual({ configured: false });
  });

  it('空文字なら未設定', () => {
    expect(secretStatusOf(new Secret(''))).toEqual({ configured: false });
  });

  it('結果に平文が含まれない', () => {
    expect(JSON.stringify(secretStatusOf(new Secret('top-secret-value')))).not.toContain(
      'top-secret-value',
    );
  });
});
