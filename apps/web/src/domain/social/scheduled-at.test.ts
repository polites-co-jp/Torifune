import { describe, expect, it } from 'vitest';
import { isValidScheduledAt, SCHEDULED_AT_MAX_MS, SCHEDULED_AT_MIN_MS } from './social';

/**
 * SNS 投稿の `scheduledAt` の範囲（046-input-500-nul-and-ranges 設計 §4.1・§6.5、受け入れ条件 #40）。
 *
 * 規則は `0001-01-01T00:00:00.000Z` 以上 `9999-12-31T23:59:59.999Z` 以下
 * （エポックミリ秒で `-62135596800000`〜`253402300799999`）。`Invalid Date` は偽。
 *
 * **定数を `Date.UTC(1, …)` と比べない。** 2 桁の年は 1900 年代になる。`Date.parse` の ISO 形式と比べる。
 */

describe('#40 定数が 0001-01-01T00:00:00.000Z と 9999-12-31T23:59:59.999Z', () => {
  it('#40 SCHEDULED_AT_MIN_MS === Date.parse(0001-01-01T00:00:00.000Z)', () => {
    expect(SCHEDULED_AT_MIN_MS).toBe(Date.parse('0001-01-01T00:00:00.000Z'));
  });

  it('#40 SCHEDULED_AT_MAX_MS === Date.parse(9999-12-31T23:59:59.999Z)', () => {
    expect(SCHEDULED_AT_MAX_MS).toBe(Date.parse('9999-12-31T23:59:59.999Z'));
  });

  it('#40 定数のエポックミリ秒が設計の値', () => {
    expect(SCHEDULED_AT_MIN_MS).toBe(-62135596800000);
    expect(SCHEDULED_AT_MAX_MS).toBe(253402300799999);
  });
});

describe('#40 isValidScheduledAt の境目', () => {
  it('#40 下の境目ちょうど（-62135596800000）→ 真', () => {
    expect(isValidScheduledAt(new Date(-62135596800000))).toBe(true);
  });

  it('#40 上の境目ちょうど（253402300799999）→ 真', () => {
    expect(isValidScheduledAt(new Date(253402300799999))).toBe(true);
  });

  it('#40 下の境目の 1 ミリ秒前（-62135596800001）→ 偽', () => {
    expect(isValidScheduledAt(new Date(-62135596800001))).toBe(false);
  });

  it('#40 上の境目の 1 ミリ秒後（253402300800000）→ 偽', () => {
    expect(isValidScheduledAt(new Date(253402300800000))).toBe(false);
  });

  it('#40 Invalid Date（new Date(NaN)）→ 偽', () => {
    expect(isValidScheduledAt(new Date(Number.NaN))).toBe(false);
  });

  it.each([
    ['JavaScript の Date の下限（-8.64e15）', -8.64e15],
    ['紀元前 4714 年 11 月 24 日（PostgreSQL の下限）', Date.parse('-004713-11-24T00:00:00Z')],
    ['西暦 0 年の末（0000-12-31T23:59:59.999Z）', Date.parse('0000-12-31T23:59:59.999Z')],
    ['西暦 10000 年（+010000-01-01T00:00:00Z）', Date.parse('+010000-01-01T00:00:00Z')],
    ['JavaScript の Date の上限（8.64e15）', 8.64e15],
  ])('#40 範囲外：%s → 偽', (_label, ms) => {
    expect(isValidScheduledAt(new Date(ms))).toBe(false);
  });

  it.each([
    ['エポック（1970-01-01）', 0],
    ['過去の日時（2000-01-01）', Date.parse('2000-01-01T00:00:00Z')],
    ['未来の日時（2030-01-01T09:00:00+09:00）', Date.parse('2030-01-01T09:00:00+09:00')],
  ])('#40 範囲内：%s → 真', (_label, ms) => {
    expect(isValidScheduledAt(new Date(ms))).toBe(true);
  });
});
