import { hash, verify } from '@node-rs/argon2';

/**
 * パスワードのハッシュ化と検証。
 *
 * アルゴリズムは Argon2id（04_認証設計.md §6）。
 * パラメータは @node-rs/argon2 の既定（OWASP 推奨相当）を使い、自前でひねらない。
 * 弱くする方向の間違いのほうが起きやすい。
 */

/**
 * パスワードの長さ上限（バイト）。
 *
 * 上限を設けないと、長大な入力でハッシュ計算に時間を使わされる（DoS）。
 * 文字数ではなくバイト数で判定する。
 */
export const MAX_PASSWORD_BYTES = 1024;

export interface HashOptions {
  readonly memoryCost?: number;
  readonly timeCost?: number;
  readonly parallelism?: number;
}

export class PasswordTooLongError extends Error {
  constructor() {
    super('パスワードが長すぎる');
    this.name = 'PasswordTooLongError';
  }
}

export class PasswordEmptyError extends Error {
  constructor() {
    super('パスワードが空である');
    this.name = 'PasswordEmptyError';
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertUsable(password: string): void {
  if (password.trim() === '') {
    throw new PasswordEmptyError();
  }
  if (byteLength(password) > MAX_PASSWORD_BYTES) {
    throw new PasswordTooLongError();
  }
}

export async function hashPassword(password: string, options?: HashOptions): Promise<string> {
  assertUsable(password);
  return hash(password, options);
}

/**
 * ハッシュとパスワードを照合する。
 *
 * **例外を投げない。** ハッシュが壊れている・入力が長すぎるといった事情を
 * 呼び出し側へ伝えると、認証エラーの理由を出し分ける実装を誘発する。
 * 「合っているか」だけを返す。
 */
export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  if (byteLength(password) > MAX_PASSWORD_BYTES) {
    return false;
  }
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

/**
 * 存在しないユーザーに対しても、実在するときと同じだけ計算する。
 *
 * 「IDが無いので即座に失敗」だと、応答時間の差からアカウントの存在を推測できる。
 * ダミーのハッシュに対して検証を走らせ、時間の差を埋める。
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZS1zdGF0aWMtc2FsdA$JXpTQnRQZmpqSlBRZWpMVW5UcGxBUQ';

export async function verifyPasswordAgainstDummy(password: string): Promise<boolean> {
  await verifyPassword(DUMMY_HASH, password);
  return false;
}
