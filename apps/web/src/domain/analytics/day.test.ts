import { describe, expect, it } from 'vitest';
import { rangeDays } from './analytics';
import {
  formatDateTimeInTimeZone,
  isPeriodPreset,
  presetRange,
  previousRange,
  type DateRange,
} from './day';

/**
 * 期間プリセット・前期間・日時表示。
 *
 * 028-analytics-dashboard-redesign 設計 §7.1 / §7.3.1（受け入れ条件 #54 / #55 / #66）を
 * **030-analytics-today 設計 §7.1.1 / §7.2 が改訂した**（受け入れ条件 #1〜#11）。
 *
 * ```ts
 * type PeriodPreset = '7d' | '30d' | '90d' | 'month' | 'prev-month';   // today は入れない（§7.1.2）
 * presetRange(preset: PeriodPreset, today: string): DateRange | null   // today は YYYY-MM-DD
 * previousRange(from: string, to: string): DateRange                   // 変更なし
 * formatDateTimeInTimeZone(instant: Date, timeZone: string): string    // 'YYYY-MM-DD HH:mm'。変更なし
 * ```
 *
 * **プリセットの `to` は昨日**（§7.1.1）。進行中の日を確定値の折れ線・合計に混ぜない。
 * 長さ（7 / 30 / 90 日）は保つので `from = today − N` になる。
 * `null` は「このプリセットに、確定値のある期間が存在しない」を表し、
 * **`month` で今日が月の 1 日のときだけ**返る（§7.2）。
 *
 * **`today` は引数で受ける。** 純関数にしておかないと、境目の時間帯だけ落ちるテストになる。
 */

/** `null` でない範囲を取る。`null` が返ったらそこで落とす（期待値の取り違えを隠さない）。 */
function rangeOf(preset: Parameters<typeof presetRange>[0], today: string): DateRange {
  const range = presetRange(preset, today);
  expect(range, `presetRange('${preset}', '${today}') が null`).not.toBeNull();
  return range as DateRange;
}

describe('presetRange（末尾は昨日）', () => {
  /** #1 */
  it('7d は [today − 7, 昨日]（長さ 7 日）', () => {
    expect(presetRange('7d', '2026-09-05')).toEqual({ from: '2026-08-29', to: '2026-09-04' });
  });

  /** #2 */
  it('30d は [today − 30, 昨日]（長さ 30 日）', () => {
    expect(presetRange('30d', '2026-09-05')).toEqual({ from: '2026-08-06', to: '2026-09-04' });
  });

  /** #3 */
  it('90d は [today − 90, 昨日]（長さ 90 日）', () => {
    expect(presetRange('90d', '2026-09-05')).toEqual({ from: '2026-06-07', to: '2026-09-04' });
  });

  /**
   * #1〜#3。**長さを保つ。** `7d` を 6 日にすると、前期間比の分母まで 6 日になり
   * 「7日」というラベルの意味が変わる（設計 §7.1.1）。
   */
  it.each([
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s の日数は %i のまま', (preset, days) => {
    const range = rangeOf(preset, '2026-09-05');

    expect(rangeDays(range.from, range.to)).toBe(days);
  });

  /** #4 */
  it('month は今月 1 日〜昨日', () => {
    expect(presetRange('month', '2026-09-05')).toEqual({ from: '2026-09-01', to: '2026-09-04' });
  });

  /**
   * #5。今日が月の 1 日なら、確定値のある「今月」は 1 日も無い。
   *
   * **前月へ倒さない・今日 1 日に丸めない**（設計 §7.2）。`null` を返し、画面が空状態を出す。
   */
  it('month は今日が月の 1 日なら null', () => {
    expect(presetRange('month', '2026-09-01')).toBeNull();
  });

  /** #5 の対。2 日なら 1 日ぶんの確定値があるので `null` にならない。 */
  it('month は今日が月の 2 日なら 1 日だけの範囲', () => {
    expect(presetRange('month', '2026-09-02')).toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  /** #6。変更なし。 */
  it('prev-month は前月 1 日〜前月末日', () => {
    expect(presetRange('prev-month', '2026-09-05')).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  /** #7。閏年でない 2 月。変更なし。 */
  it('prev-month は閏年でない 2 月末を正しく取る', () => {
    expect(presetRange('prev-month', '2026-03-01')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  /** #6 / #7。閏年の 2 月も変わらない。 */
  it('prev-month は閏年の 2 月末を正しく取る', () => {
    expect(presetRange('prev-month', '2024-03-01')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  /** #6。1 月の前月は前年の 12 月。`month` と違い今日が 1 日でも `null` にならない。 */
  it('prev-month が年をまたぐ', () => {
    expect(presetRange('prev-month', '2026-01-01')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  /** #8。年をまたいでも暦で戻る。 */
  it('7d が年をまたぐ', () => {
    expect(presetRange('7d', '2026-01-01')).toEqual({ from: '2025-12-25', to: '2025-12-31' });
  });

  /** #9。月末をまたぐ。 */
  it('7d が月末をまたぐ', () => {
    expect(presetRange('7d', '2026-03-01')).toEqual({ from: '2026-02-22', to: '2026-02-28' });
  });

  /** #1〜#4。`7d` / `30d` / `90d` は `from ≤ 昨日` になるので `null` にならない。 */
  it.each(['7d', '30d', '90d'] as const)('%s は月の 1 日でも null にならない', (preset) => {
    expect(presetRange(preset, '2026-09-01')).not.toBeNull();
  });
});

describe('previousRange（変更しない）', () => {
  /** #10。`7d` の前期間が 7 日で、当期の直前に連続する。 */
  it('7d の前期間は [from − 7, from − 1]', () => {
    expect(previousRange('2026-08-29', '2026-09-04')).toEqual({
      from: '2026-08-22',
      to: '2026-08-28',
    });
  });

  /** #10 */
  it('同じ長さの直前の期間を返す', () => {
    expect(previousRange('2026-09-01', '2026-09-30')).toEqual({
      from: '2026-08-02',
      to: '2026-08-31',
    });
  });

  /** #10。前期間 = [from − len, from − 1]。 */
  it('前期間の終わりは from の前日', () => {
    expect(previousRange('2026-09-04', '2026-09-04')).toEqual({
      from: '2026-09-03',
      to: '2026-09-03',
    });
  });

  /** #10 */
  it('長さが揃う', () => {
    const previous = previousRange('2026-08-06', '2026-09-04');

    expect(rangeDays(previous.from, previous.to)).toBe(30);
    expect(previous.to).toBe('2026-08-05');
  });

  /** #10。年をまたぐ。 */
  it('年をまたいで戻る', () => {
    expect(previousRange('2026-01-01', '2026-01-07')).toEqual({
      from: '2025-12-25',
      to: '2025-12-31',
    });
  });

  /** #10。すべてのプリセットで同じ規則（月単位にはしない）。 */
  it('月の期間でも日数で戻す（前月そのものにはしない）', () => {
    // 31 日間の直前は、2024-02-29 で終わる 31 日間。
    expect(previousRange('2024-03-01', '2024-03-31')).toEqual({
      from: '2024-01-30',
      to: '2024-02-29',
    });
  });
});

/**
 * #11。`PeriodPreset` に `'today'` を入れない（設計 §7.1.2）。
 *
 * `PeriodPreset` は「`presetRange(preset, today)` で範囲が求まるもの」という契約を持つ。
 * 当日は確定値ではない別経路のデータなので、そこに入れると契約が崩れる。
 * 当日は `ui/analytics/labels.ts` の `AnalyticsPeriod` 側で表す。
 */
describe('isPeriodPreset', () => {
  /** #11 */
  it("'today' はプリセットではない", () => {
    expect(isPeriodPreset('today')).toBe(false);
  });

  /** #11 の対。既存の 5 つは変わらない。 */
  it.each(['7d', '30d', '90d', 'month', 'prev-month'])('%s はプリセット', (value) => {
    expect(isPeriodPreset(value)).toBe(true);
  });

  /** #11。`custom` も `PeriodPreset` ではない（現行どおり）。 */
  it("'custom' はプリセットではない", () => {
    expect(isPeriodPreset('custom')).toBe(false);
  });
});

describe('formatDateTimeInTimeZone', () => {
  /** #66（028）。当日のヘッダ行「{YYYY-MM-DD HH:mm} 時点の速報値」もこれで整形する（030 §7.4.1）。 */
  it('タイムゾーンの日時を YYYY-MM-DD HH:mm で返す', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-09-03T01:41:00Z'), 'Asia/Tokyo')).toBe(
      '2026-09-03 10:41',
    );
  });

  /** #66 */
  it('UTC ではそのままの時刻', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-09-03T01:41:00Z'), 'UTC')).toBe(
      '2026-09-03 01:41',
    );
  });

  /** #66。日付もタイムゾーンで変わる。24 時間表記。 */
  it('境目をまたぐと日付が進み、0 時は 00 と出る', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-09-02T15:30:00Z'), 'Asia/Tokyo')).toBe(
      '2026-09-03 00:30',
    );
  });

  /** #66。月・日・時・分をゼロ埋めする。 */
  it('1 桁の値をゼロ埋めする', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-01-05T03:07:00Z'), 'UTC')).toBe(
      '2026-01-05 03:07',
    );
  });

  /** #66。秒は出さない。 */
  it('秒を出さない', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-09-03T01:41:59Z'), 'UTC')).toBe(
      '2026-09-03 01:41',
    );
  });
});
