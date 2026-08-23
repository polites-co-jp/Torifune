import { createHash, randomBytes } from 'node:crypto';

/**
 * セッショントークンの生成とハッシュ化。
 *
 * Cookie に入れる値そのものは DB へ保存せず、ハッシュだけを保存する
 * （04_認証設計.md §7）。DB が漏れてもセッションを乗っ取れないようにするため。
 */

/** 256bit。総当たりが成立しない長さ。 */
export const SESSION_TOKEN_BYTES = 32;

/** Cookie に入れる値を生成する。 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * DB へ保存する形に変換する。
 *
 * Argon2 ではなく SHA-256 を使う。トークンは十分な長さの乱数なので総当たりが
 * 成立せず、ソルトやストレッチングの必要がない。毎リクエストの検証で
 * Argon2 を回すと遅すぎる。
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
