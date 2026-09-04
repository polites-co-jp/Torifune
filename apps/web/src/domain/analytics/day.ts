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
 * `YYYY-MM-DD` を日数だけ動かす。
 *
 * 日付だけを UTC の暦で動かすので、タイムゾーンや夏時間でずれない。
 */
export function shiftDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 期間プリセット（028-analytics-dashboard-redesign 設計 §7.3.1）。
 *
 * `custom` は from / to を直接受けるので、ここには含めない。
 */
export type PeriodPreset = '7d' | '30d' | '90d' | 'month' | 'prev-month';

export const PERIOD_PRESETS: readonly PeriodPreset[] = ['7d', '30d', '90d', 'month', 'prev-month'];

export function isPeriodPreset(value: string): value is PeriodPreset {
  return (PERIOD_PRESETS as readonly string[]).includes(value);
}

export interface DateRange {
  /** `YYYY-MM-DD`。 */
  readonly from: string;
  /** `YYYY-MM-DD`。 */
  readonly to: string;
}

/**
 * プリセットから期間を出す。
 *
 * **`today` は引数で受ける。** 「今日」は運用タイムゾーンで決まる（`todayInTimeZone`）ので、
 * ここで時計を読むと境目の時間帯だけずれる。
 *
 * | preset | from | to |
 * | --- | --- | --- |
 * | `7d` / `30d` / `90d` | `today − 6 / 29 / 89` 日 | `today` |
 * | `month` | 今月 1 日 | `today` |
 * | `prev-month` | 前月 1 日 | 前月末日 |
 */
export function presetRange(preset: PeriodPreset, today: string): DateRange {
  switch (preset) {
    case '7d':
      return { from: shiftDays(today, -6), to: today };
    case '30d':
      return { from: shiftDays(today, -29), to: today };
    case '90d':
      return { from: shiftDays(today, -89), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'prev-month': {
      // 今月 1 日の前日が前月末。そこから月初を取る。
      const previousMonthEnd = shiftDays(`${today.slice(0, 7)}-01`, -1);
      return { from: `${previousMonthEnd.slice(0, 7)}-01`, to: previousMonthEnd };
    }
  }
}

/**
 * 直前の同じ長さの期間 `[from − len, from − 1]`（`len = to − from + 1` 日）。
 *
 * **月の期間でも日数で戻す**（前月そのものにはしない）。すべてのプリセットで同じ規則。
 */
export function previousRange(from: string, to: string): DateRange {
  const length = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000),
  );
  return { from: shiftDays(from, -(length + 1)), to: shiftDays(from, -1) };
}

/**
 * ある瞬間を、そのタイムゾーンの `YYYY-MM-DD HH:mm` にする（最終受信・最終集計の表示用）。
 *
 * 24 時間表記。`hour12: false` は環境によって 0 時を `24` と出すので `hourCycle: 'h23'` を使う。
 */
export function formatDateTimeInTimeZone(instant: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) {
    throw new InvalidTimeZoneError(timeZone);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? '';

  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
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
