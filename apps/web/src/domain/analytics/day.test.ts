import { describe, expect, it } from 'vitest';
import { rangeDays } from './analytics';
import { formatDateTimeInTimeZone, presetRange, previousRange } from './day';

/**
 * 期間プリセット・前期間・日時表示（028-analytics-dashboard-redesign 設計 §7.1 / §7.3.1、受け入れ条件 #54 / #55 / #66）。
 *
 * 想定するシグネチャ（設計書の表と式から決めた最小の形）：
 *
 * ```ts
 * type PeriodPreset = '7d' | '30d' | '90d' | 'month' | 'prev-month';
 * presetRange(preset: PeriodPreset, today: string): { from: string; to: string }   // today は YYYY-MM-DD
 * previousRange(from: string, to: string): { from: string; to: string }
 * formatDateTimeInTimeZone(instant: Date, timeZone: string): string                // 'YYYY-MM-DD HH:mm'
 * ```
 *
 * **`today` は引数で受ける。** 純関数にしておかないと、境目の時間帯だけ落ちるテストになる。
 */

describe('presetRange', () => {
  /** #54 */
  it('7d は今日を含む 7 日', () => {
    expect(presetRange('7d', '2026-09-04')).toEqual({ from: '2026-08-29', to: '2026-09-04' });
  });

  /** #54 */
  it('30d は今日を含む 30 日', () => {
    expect(presetRange('30d', '2026-09-04')).toEqual({ from: '2026-08-06', to: '2026-09-04' });
  });

  /** #54 */
  it('90d は今日を含む 90 日', () => {
    expect(presetRange('90d', '2026-09-04')).toEqual({ from: '2026-06-07', to: '2026-09-04' });
  });

  /** #54。日数は暦で数える（24 時間を引くのではない）。 */
  it.each([
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const)('%s の日数は %i', (preset, days) => {
    const range = presetRange(preset, '2026-09-04');

    expect(rangeDays(range.from, range.to)).toBe(days);
  });

  /** #54。年をまたいでも暦で戻る。 */
  it('7d が年をまたぐ', () => {
    expect(presetRange('7d', '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
  });

  /** #54 */
  it('month は今月 1 日〜今日', () => {
    expect(presetRange('month', '2026-09-04')).toEqual({ from: '2026-09-01', to: '2026-09-04' });
  });

  /** #54。月初の日は 1 日だけの期間になる。 */
  it('month は今日が 1 日なら 1 日だけ', () => {
    expect(presetRange('month', '2026-09-01')).toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  /** #54 */
  it('prev-month は前月 1 日〜前月末日', () => {
    expect(presetRange('prev-month', '2026-03-01')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  /** #54。閏年の 2 月。 */
  it('prev-month は閏年の 2 月末を正しく取る', () => {
    expect(presetRange('prev-month', '2024-03-01')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  /** #54。1 月の前月は前年の 12 月。 */
  it('prev-month が年をまたぐ', () => {
    expect(presetRange('prev-month', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  /** #54。今日が月末でも、前月末で止まる。 */
  it('prev-month は今日の日付に左右されない', () => {
    expect(presetRange('prev-month', '2026-09-30')).toEqual({
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });
});

describe('previousRange', () => {
  /** #55 */
  it('同じ長さの直前の期間を返す', () => {
    expect(previousRange('2026-09-01', '2026-09-30')).toEqual({
      from: '2026-08-02',
      to: '2026-08-31',
    });
  });

  /** #55。前期間 = [from − len, from − 1]。 */
  it('前期間の終わりは from の前日', () => {
    expect(previousRange('2026-09-04', '2026-09-04')).toEqual({
      from: '2026-09-03',
      to: '2026-09-03',
    });
  });

  /** #55 */
  it('長さが揃う', () => {
    const previous = previousRange('2026-08-06', '2026-09-04');

    expect(rangeDays(previous.from, previous.to)).toBe(30);
    expect(previous.to).toBe('2026-08-05');
  });

  /** #55。年をまたぐ。 */
  it('年をまたいで戻る', () => {
    expect(previousRange('2026-01-01', '2026-01-07')).toEqual({
      from: '2025-12-25',
      to: '2025-12-31',
    });
  });

  /** #55。すべてのプリセットで同じ規則（月単位にはしない）。 */
  it('月の期間でも日数で戻す（前月そのものにはしない）', () => {
    // 31 日間の直前は、2024-02-29 で終わる 31 日間。
    expect(previousRange('2024-03-01', '2024-03-31')).toEqual({
      from: '2024-01-30',
      to: '2024-02-29',
    });
  });
});

describe('formatDateTimeInTimeZone', () => {
  /** #66 */
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
