/**
 * 「1日の境目」の扱い（018-analytics）。
 *
 * アクセスの記録は `timestamptz`（実質 UTC）で持つが、
 * **利用者が見る「今日」「昨日」は運用側のタイムゾーンの1日**である。
 * 集計・画面・訪問者ハッシュのソルトが、すべて同じ境目を使う必要がある。
 *
 * ずれると次のように壊れる。
 *
 * * 画面の「今日」に、まだ始まっていない日を指してしまい常に 0 件になる
 * * ソルトが1日の途中で回り、同じ訪問者が2人と数えられる
 *
 * **ここは環境変数を読まない。** 設定の解決は `application/analytics/timezone.ts`。
 */

export class InvalidTimeZoneError extends Error {
  constructor(readonly value: string) {
    super(`タイムゾーンの指定が不正: ${value}`);
    this.name = 'InvalidTimeZoneError';
  }
}

/** IANA のタイムゾーン名として解釈できるか。 */
export function isValidTimeZone(value: string): boolean {
  if (value === '') {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * ある瞬間が、そのタイムゾーンで何月何日かを `YYYY-MM-DD` で返す。
 *
 * **`toISOString().slice(0, 10)` を使わない。** それは常に UTC の日付になり、
 * UTC より東のタイムゾーンでは1日ずれる。
 */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new InvalidTimeZoneError(timeZone);
  }

  // en-CA は YYYY-MM-DD を返す。formatToParts で組み立てるより読みやすい。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** そのタイムゾーンでの「今日」。 */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  return dateInTimeZone(now, timeZone);
}

/**
 * そのタイムゾーンでの「今日」から `days` 日前の日付。
 *
 * **日付を数えるのであって、24時間を引くのではない。**
 * 夏時間のある地域では1日が23時間や25時間になり、時間で引くと日付がずれる。
 */
export function daysAgoInTimeZone(days: number, timeZone: string, now: Date = new Date()): string {
  const today = todayInTimeZone(timeZone, now);
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];

  // UTC の暦で日付だけを動かす。時刻を持たないので、夏時間の影響を受けない。
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() - days);

  return shifted.toISOString().slice(0, 10);
}

/**
 * PostgreSQL から返る `date` を `YYYY-MM-DD` に直す。
 *
 * **node-postgres は `date` をサーバープロセスのローカル0時として `Date` にする。**
 * そのまま `toISOString()` すると、UTC より東では1日前になる。
 * ローカルの暦の部品から組み立てる。
 */
export function dateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
