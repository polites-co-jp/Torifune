import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret } from '@/domain/secret';
import { encryptionKey, type EncryptionKey } from './key';

/**
 * Secret の暗号化と復号（AES-256-GCM）。
 *
 * 暗号文は1つの文字列に収める。カラムを増やすと、
 * テーブルごとに同じ設計を繰り返すことになる。
 *
 * ```text
 * v1.<keyId>.<iv>.<authTag>.<ciphertext>
 * ```
 *
 * GCM の認証タグを含めるため、**改ざんを検出できる**。
 */

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const ALGORITHM = 'aes-256-gcm';

export type DecryptResult =
  | { readonly ok: true; readonly secret: Secret }
  | { readonly ok: false; readonly reason: 'malformed' | 'wrong_key' | 'tampered' };

export function encryptSecret(plaintext: string, key: EncryptionKey = encryptionKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.material, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    key.id,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * 復号する。
 *
 * **失敗を例外ではなく結果として返す。**
 * 例外にすると、呼び出し側が `try/catch` で握り潰して
 * 「復号できなかったのに処理が続く」状態を作りやすい。
 */
export function decryptSecret(
  encoded: string,
  key: EncryptionKey = encryptionKey(),
): DecryptResult {
  const parts = encoded.split('.');
  if (parts.length !== 5) {
    return { ok: false, reason: 'malformed' };
  }

  const [version, keyId, ivPart, tagPart, ciphertextPart] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== FORMAT_VERSION) {
    return { ok: false, reason: 'malformed' };
  }

  if (keyId !== key.id) {
    // 別の鍵で暗号化されている。ローテーション中なら旧鍵で試す必要がある。
    return { ok: false, reason: 'wrong_key' };
  }

  try {
    const iv = Buffer.from(ivPart, 'base64url');
    const authTag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');

    if (iv.length !== IV_BYTES) {
      return { ok: false, reason: 'malformed' };
    }

    const decipher = createDecipheriv(ALGORITHM, key.material, iv);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, secret: new Secret(plaintext.toString('utf8')) };
  } catch {
    // 認証タグが合わない、または鍵が違う。どちらも「信用できない」で同じ扱いにする。
    return { ok: false, reason: 'tampered' };
  }
}
