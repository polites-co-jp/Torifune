import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  packageChecksum,
  PackageVerificationError,
  trustedKeys,
  verifyPackage,
} from './package-signature';

/**
 * Package の署名検証（03_プラグイン設計.md §20.1、020-plugin-registry 設計 §2.2）。
 */

function keyPair(): { publicKey: string; sign: (message: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message) =>
      signMessage(null, Buffer.from(message, 'utf8'), privateKey).toString('base64'),
  };
}

const ARCHIVE = Buffer.from('pretend this is a zip');

describe('packageChecksum', () => {
  it('同じ中身なら同じ値', () => {
    expect(packageChecksum(ARCHIVE)).toBe(packageChecksum(Buffer.from('pretend this is a zip')));
  });

  it('1バイト違えば変わる', () => {
    expect(packageChecksum(ARCHIVE)).not.toBe(
      packageChecksum(Buffer.from('pretend this is a Zip')),
    );
  });
});

describe('trustedKeys', () => {
  it('未設定なら空', () => {
    expect(trustedKeys({})).toEqual([]);
    expect(trustedKeys({ TORIFUNE_PLUGIN_TRUSTED_KEYS: '   ' })).toEqual([]);
  });

  it('カンマ区切りで複数読む', () => {
    expect(trustedKeys({ TORIFUNE_PLUGIN_TRUSTED_KEYS: 'a, b ,c' })).toEqual(['a', 'b', 'c']);
  });
});

describe('verifyPackage', () => {
  it('正しい checksum と署名なら通る', () => {
    const { publicKey, sign } = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: checksum,
        signature: sign(checksum),
        trustedKeys: [publicKey],
      }),
    ).not.toThrow();
  });

  /** 壊れた・すり替わったファイルをまず弾く。 */
  it('checksum が合わなければ弾く', () => {
    const { publicKey, sign } = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: Buffer.from('a different zip'),
        expectedChecksum: checksum,
        signature: sign(checksum),
        trustedKeys: [publicKey],
      }),
    ).toThrow(
      expect.objectContaining({ kind: 'checksum_mismatch' }) as unknown as PackageVerificationError,
    );
  });

  /** 「署名は見るが誰の署名でもよい」は、検証していないのと同じ。 */
  it('信頼鍵が無ければ弾く', () => {
    const { sign } = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: checksum,
        signature: sign(checksum),
        trustedKeys: [],
      }),
    ).toThrow(
      expect.objectContaining({ kind: 'no_trusted_keys' }) as unknown as PackageVerificationError,
    );
  });

  it('別の鍵で署名されていれば弾く', () => {
    const trusted = keyPair();
    const attacker = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: checksum,
        signature: attacker.sign(checksum),
        trustedKeys: [trusted.publicKey],
      }),
    ).toThrow(
      expect.objectContaining({ kind: 'invalid_signature' }) as unknown as PackageVerificationError,
    );
  });

  /** 鍵の入れ替え中に両方を並べられる。 */
  it('複数の信頼鍵のどれかで通ればよい', () => {
    const oldKey = keyPair();
    const newKey = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: checksum,
        signature: newKey.sign(checksum),
        trustedKeys: [oldKey.publicKey, newKey.publicKey],
      }),
    ).not.toThrow();
  });

  it('署名が空なら弾く', () => {
    const { publicKey } = keyPair();

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: packageChecksum(ARCHIVE),
        signature: '',
        trustedKeys: [publicKey],
      }),
    ).toThrow(
      expect.objectContaining({
        kind: 'malformed_signature',
      }) as unknown as PackageVerificationError,
    );
  });

  it('検証鍵の形式が不正なら弾く', () => {
    const { sign } = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: checksum,
        signature: sign(checksum),
        trustedKeys: ['not-a-key'],
      }),
    ).toThrow(PackageVerificationError);
  });

  it('checksum の大文字小文字を区別しない', () => {
    const { publicKey, sign } = keyPair();
    const checksum = packageChecksum(ARCHIVE);

    expect(() =>
      verifyPackage({
        archive: ARCHIVE,
        expectedChecksum: checksum.toUpperCase(),
        signature: sign(checksum),
        trustedKeys: [publicKey],
      }),
    ).not.toThrow();
  });
});
