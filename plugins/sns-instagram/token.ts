/**
 * 資格情報の形の検査と、トークンの期限の判定（038-sns-instagram 設計 §5.2 / §6.2 / §6.7）。
 *
 * **純関数だけ。** HTTP も時計も持たない。時刻は引数で受ける。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 延長を試みる閾値。**残りがこれを切っていたら**、公開に成功した後で延長する。
 *
 * 延長できるのは配信が成功したときだけなので、窓を広く取る（設計 §6.7。月 1 回の配信でも窓に入る）。
 */
export const TOKEN_REFRESH_THRESHOLD_MS = 30 * DAY_MS;

/**
 * 長期トークンの寿命として信じてよい上限。
 *
 * 長期トークンは 60 日で失効する。**これより先の期限は打ち間違いとみなす**（設計 §5.2）。
 * 信じると延長の判定が永久に働かず、トークンが黙って切れる。
 */
export const TOKEN_MAX_LIFETIME_MS = 61 * DAY_MS;

/** 期限が読めないことを表す値。資格情報の `accessTokenExpiresAt` にもこの綴りで書く。 */
export const UNKNOWN_EXPIRY = 'unknown';

export type TokenExpiry = Date | typeof UNKNOWN_EXPIRY;

/** URL のパスに入る。`../` や `?` を入れさせない。 */
const IG_USER_ID_PATTERN = /^[0-9]{1,64}$/;

/**
 * ヘッダ値に入る。印字可能な ASCII（`!`〜`~`）だけ。
 * 改行を含む値は HTTP の送信が同期で投げ、接続の失敗に化ける（設計 §6.2）。
 */
const ACCESS_TOKEN_PATTERN = /^[\x21-\x7E]{1,2048}$/;

/** Instagram のユーザー ID の形（数字だけ、64 桁まで）。 */
export function isValidIgUserId(value: unknown): value is string {
  return typeof value === 'string' && IG_USER_ID_PATTERN.test(value);
}

/** アクセストークンの形（空白・制御文字・非 ASCII を含まない、2048 文字まで）。 */
export function isValidAccessToken(value: unknown): value is string {
  return typeof value === 'string' && ACCESS_TOKEN_PATTERN.test(value);
}

/**
 * 資格情報の `accessTokenExpiresAt` を読む。
 *
 * 読めない値（`unknown`・空白・日付として読めない文字列）と、
 * **いまから 61 日より先**の値は `'unknown'` を返す（設計 §5.2）。過ぎた期限はそのまま返す。
 */
export function parseExpiry(value: unknown, now: Date): TokenExpiry {
  if (typeof value !== 'string') {
    return UNKNOWN_EXPIRY;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return UNKNOWN_EXPIRY;
  }
  const time = Date.parse(trimmed);
  if (!Number.isFinite(time)) {
    return UNKNOWN_EXPIRY;
  }
  if (time - now.getTime() > TOKEN_MAX_LIFETIME_MS) {
    return UNKNOWN_EXPIRY;
  }
  return new Date(time);
}

/** 延長を試みるか。期限が不明か、残りが 30 日を切っていれば試みる。 */
export function shouldRefresh(expiry: TokenExpiry, now: Date): boolean {
  if (expiry === UNKNOWN_EXPIRY) {
    return true;
  }
  return expiry.getTime() - now.getTime() < TOKEN_REFRESH_THRESHOLD_MS;
}

/**
 * 延長の応答の `expires_in`（秒）から、書き戻す期限を作る。
 *
 * 正の整数で 61 日以下のときだけ ISO 8601 の文字列。それ以外は `'unknown'`
 * （トークンは書き戻し、次の成功でもう一度延長を試みる。設計 §6.7）。
 */
export function expiryFromExpiresIn(expiresIn: unknown, now: Date): string {
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    return UNKNOWN_EXPIRY;
  }
  const lifetimeMs = expiresIn * 1000;
  if (lifetimeMs > TOKEN_MAX_LIFETIME_MS) {
    return UNKNOWN_EXPIRY;
  }
  return new Date(now.getTime() + lifetimeMs).toISOString();
}
