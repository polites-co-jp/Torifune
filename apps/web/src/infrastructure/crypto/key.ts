/**
 * 暗号鍵の読み込みと検証。
 *
 * **鍵が未設定・不正なら例外にする。** 黙って平文保存へ落ちる実装は、
 * 「動いているから大丈夫」に見えてしまうぶん、より危険。
 *
 * 鍵は環境変数から読む。**DB へ保存してはならない**（02_データベース設計.md §13）。
 */

export const KEY_BYTES = 32;

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export interface EncryptionKey {
  /** 暗号文へ併記する識別子。**鍵そのものではない。** */
  readonly id: string;
  readonly material: Buffer;
}

/** 鍵の識別子。鍵素材から導かない（導くと、識別子から鍵の情報が漏れる余地ができる）。 */
const DEFAULT_KEY_ID = 'k1';

function decodeKey(raw: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, 'base64');
  } catch {
    throw new EncryptionKeyError('TORIFUNE_ENCRYPTION_KEY を Base64 として読めない');
  }

  if (decoded.length !== KEY_BYTES) {
    // 長さだけを伝える。値は伝えない。
    throw new EncryptionKeyError(
      `TORIFUNE_ENCRYPTION_KEY は ${KEY_BYTES} バイトである必要がある（実際: ${decoded.length}）`,
    );
  }

  return decoded;
}

/**
 * 環境変数から鍵を読む。
 *
 * `TORIFUNE_ENCRYPTION_KEY` は現行の鍵。
 * `TORIFUNE_ENCRYPTION_KEY_ID` を指定すると、暗号文へ併記する識別子を変えられる
 * （ローテーション時に、新旧を見分けるため）。
 */
export function loadEncryptionKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EncryptionKey {
  const raw = env['TORIFUNE_ENCRYPTION_KEY'];
  if (raw === undefined || raw.trim() === '') {
    throw new EncryptionKeyError(
      'TORIFUNE_ENCRYPTION_KEY が設定されていない。' +
        "node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64'))\" で生成する。",
    );
  }

  return {
    id: env['TORIFUNE_ENCRYPTION_KEY_ID'] ?? DEFAULT_KEY_ID,
    material: decodeKey(raw.trim()),
  };
}

let cached: EncryptionKey | null = null;

export function encryptionKey(): EncryptionKey {
  cached ??= loadEncryptionKey();
  return cached;
}

/** テストと鍵ローテーションのための差し替え口。 */
export function setEncryptionKey(key: EncryptionKey | null): void {
  cached = key;
}
