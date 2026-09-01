import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

/**
 * Plugin Package の検証（03_プラグイン設計.md §20.1、07_開発者向けガイド.md §30）。
 *
 * **Domain 層。** HTTP も DB も知らない。
 *
 * 署名の対象は**配布物そのもの**（zip の SHA-256）。
 * マニフェストだけに署名すると、中身を差し替えられる。
 */

export class PackageVerificationError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'checksum_mismatch'
      | 'invalid_signature'
      | 'no_trusted_keys'
      | 'malformed_key'
      | 'malformed_signature',
  ) {
    super(message);
    this.name = 'PackageVerificationError';
  }
}

/** 配布物の SHA-256（16進）。 */
export function packageChecksum(archive: Buffer): string {
  return createHash('sha256').update(archive).digest('hex');
}

/**
 * 信頼する検証鍵を読む。
 *
 * ed25519 の公開鍵を base64（DER, SPKI）で、カンマ区切りに並べる。
 *
 * **未設定を「何でも通す」にしない。** 空のまま Registry から入れられると、
 * 署名を見ていないのと同じになる。
 */
export function trustedKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const raw = env['TORIFUNE_PLUGIN_TRUSTED_KEYS'];
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

/** base64 の SPKI から公開鍵オブジェクトを作る。 */
function toPublicKey(base64Key: string): ReturnType<typeof createPublicKey> {
  try {
    return createPublicKey({
      key: Buffer.from(base64Key, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw new PackageVerificationError('検証鍵の形式が不正', 'malformed_key');
  }
}

export interface VerifyPackageInput {
  readonly archive: Buffer;
  /** 配布元が示す SHA-256（16進）。 */
  readonly expectedChecksum: string;
  /** ed25519 署名（base64）。署名の対象は checksum の文字列。 */
  readonly signature: string;
  readonly trustedKeys: readonly string[];
}

/**
 * 配布物を検証する。
 *
 * 順番に意味がある。
 * 1. **checksum** … 壊れた・すり替わったファイルをまず弾く
 * 2. **信頼鍵の有無** … 鍵が無いなら検証しようがない
 * 3. **署名** … 誰が配ったものかを確かめる
 *
 * どれか1つでも通らなければ導入しない。
 */
export function verifyPackage(input: VerifyPackageInput): void {
  const actual = packageChecksum(input.archive);
  if (actual !== input.expectedChecksum.toLowerCase()) {
    throw new PackageVerificationError(
      '配布物が配布元の記録と一致しない（改竄または破損）',
      'checksum_mismatch',
    );
  }

  if (input.trustedKeys.length === 0) {
    throw new PackageVerificationError(
      '信頼する検証鍵が設定されていない。TORIFUNE_PLUGIN_TRUSTED_KEYS を設定する',
      'no_trusted_keys',
    );
  }

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(input.signature, 'base64');
  } catch {
    throw new PackageVerificationError('署名の形式が不正', 'malformed_signature');
  }
  if (signatureBytes.length === 0) {
    throw new PackageVerificationError('署名が空', 'malformed_signature');
  }

  // どれか1つの鍵で通ればよい。鍵の入れ替え中に両方を並べられるようにする。
  const message = Buffer.from(actual, 'utf8');
  for (const key of input.trustedKeys) {
    try {
      if (verifySignature(null, message, toPublicKey(key), signatureBytes)) {
        return;
      }
    } catch (error) {
      if (error instanceof PackageVerificationError) {
        throw error;
      }
      // この鍵では検証できなかっただけ。次の鍵を試す。
    }
  }

  throw new PackageVerificationError(
    '署名が信頼する鍵で検証できない（配布元が信頼されていない）',
    'invalid_signature',
  );
}
