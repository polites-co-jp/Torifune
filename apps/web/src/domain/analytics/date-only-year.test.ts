import { describe, expect, it } from 'vitest';
import { dateOnly } from './day';

/**
 * 年が 1000 未満の日付の表示（046-input-500-nul-and-ranges 設計 §6.4 の N4、受け入れ条件 #50。ユーザー裁定 4）。
 *
 * `dateOnly` は PostgreSQL の `date`（node-postgres がローカルの 0 時の `Date` にしたもの）を `YYYY-MM-DD` に直す。
 * 年を `getFullYear()` のまま文字列にすると `"1-01-01"` になるので、**年を 4 桁にそろえる**。
 *
 * **`new Date(1, 0, 1)` で作らない。** 0〜99 の年は 1900 年代になる。`setFullYear` で作る（実装プラン T22）。
 */

/** ローカルの暦で year-month-day の 0 時の `Date`。 */
function localDate(year: number, month: number, day: number): Date {
  const date = new Date(2000, 0, 1, 0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

describe('#50 dateOnly の年が 4 桁', () => {
  it.each([
    [1, 1, 1, '0001-01-01'],
    [100, 1, 1, '0100-01-01'],
    [999, 12, 31, '0999-12-31'],
    [99, 12, 31, '0099-12-31'],
  ])('#50 ローカルの暦で %i-%i-%i の Date → %s', (year, month, day, expected) => {
    expect(dateOnly(localDate(year, month, day))).toBe(expected);
  });

  it('#50 年が 1000 以上の値は変わらない（2026-09-25）', () => {
    expect(dateOnly(localDate(2026, 9, 25))).toBe('2026-09-25');
  });

  it('#50 年が 1000 ちょうどの値は変わらない（1000-01-01）', () => {
    expect(dateOnly(localDate(1000, 1, 1))).toBe('1000-01-01');
  });

  it('#50 作った Date が意図した年を指している（1900 年代に写っていない）', () => {
    expect(localDate(1, 1, 1).getFullYear()).toBe(1);
  });
});
