import { describe, expect, it } from 'vitest';
import {
  BREAKDOWN_KEY_MAX_LENGTH,
  MAX_RANGE_DAYS,
  isValidBreakdownKey,
  isValidRange,
  rangeDays,
} from './analytics';

/**
 * 内訳キーの検証（028-analytics-dashboard-redesign 設計 §5.2、実装プラン T1）。
 *
 * `isValidBreakdownKey(value)`：長さ 500 以下、制御文字を含まない。**空文字は可**（キーを持たない指標）。
 */

describe('isValidBreakdownKey', () => {
  it('空文字を受け付ける（キーを持たない指標）', () => {
    expect(isValidBreakdownKey('')).toBe(true);
  });

  it('パスやホスト名を受け付ける', () => {
    expect(isValidBreakdownKey('/pricing')).toBe(true);
    expect(isValidBreakdownKey('www.example.com')).toBe(true);
    expect(isValidBreakdownKey('(direct)')).toBe(true);
    expect(isValidBreakdownKey('08')).toBe(true);
  });

  /** 500 は PATH_MAX_LENGTH と同じ。パスを key に入れるため。 */
  it('500 文字を受け付ける', () => {
    expect(isValidBreakdownKey('a'.repeat(500))).toBe(true);
  });

  it('501 文字を受け付けない', () => {
    expect(isValidBreakdownKey('a'.repeat(501))).toBe(false);
  });

  it.each([
    ['改行 (0x0a)', 10],
    ['復帰 (0x0d)', 13],
    ['タブ (0x09)', 9],
    ['NUL (0x00)', 0],
    ['単位区切り (0x1f)', 31],
    ['DEL (0x7f)', 127],
  ])('制御文字を含むと受け付けない: %s', (_label, code) => {
    expect(isValidBreakdownKey(`/a${String.fromCharCode(code)}b`)).toBe(false);
  });

  it('上限の定数は 500', () => {
    expect(BREAKDOWN_KEY_MAX_LENGTH).toBe(500);
  });
});

/**
 * 期間の検証（029-scheduled-jobs 検証の反映。受け入れ条件 #79 / #80。security-reviewer M-1）。
 *
 * `isValidRange` が形式（`^\d{4}-\d{2}-\d{2}$`）と文字列比較だけだと、`0000-00-00` /
 * `9999-99-99` / `2026-02-30` のような**カレンダー上は存在しない日付**が通る。
 * その先の `rangeDays` は `Date.parse` に依るので `NaN` になり、
 * **`NaN > MAX_RANGE_DAYS` が `false`** になって幅の検査を素通りする（フェイルオープン）。
 *
 * `analytics.read` しか持たない閲覧者が `POST /analytics/rollup` へ
 * `{"from":"0000-00-00","to":"9999-99-99"}` を投げると、422 で弾かれずにロックを取得でき、
 * `job_runs` に任意の `error` 行を積める（`GET /jobs` の監視信号を汚せる）。
 *
 * **入口（`isValidRange`）で実在日付を確かめて、全経路（`POST /analytics/rollup` /
 * `GET /analytics` の `assertRange` / `app/analytics/page.tsx`）をまとめて塞ぐ。**
 */
describe('isValidRange', () => {
  /** #79 */
  it('通常の日付を受け付ける', () => {
    expect(isValidRange('2026-09-01', '2026-09-30')).toBe(true);
    expect(isValidRange('2026-09-04', '2026-09-04')).toBe(true);
  });

  /** #79。閏年の 2/29 は実在する。 */
  it('閏年の 2 月 29 日を受け付ける', () => {
    expect(isValidRange('2024-02-29', '2024-02-29')).toBe(true);
  });

  /** #79。**実在しない日付を受け付けない。** */
  it.each([
    ['0000-00-00', '9999-99-99'],
    ['2026-02-30', '2026-03-01'],
    ['2026-01-01', '2026-02-30'],
    ['2025-02-29', '2025-03-01'],
    ['2026-13-01', '2026-13-02'],
    ['2026-00-10', '2026-01-10'],
    ['2026-04-31', '2026-05-01'],
    ['2026-01-32', '2026-02-01'],
  ])('実在しない日付を受け付けない: %s 〜 %s', (from, to) => {
    expect(isValidRange(from, to)).toBe(false);
  });

  /** #79。形式そのものが違うものは従来どおり弾く。 */
  it.each([
    ['2026/09/01', '2026-09-30'],
    ['20260901', '2026-09-30'],
    ['not-a-date', '2026-09-30'],
    ['', ''],
    ['2026-9-1', '2026-09-30'],
  ])('形式が違うものを受け付けない: %s 〜 %s', (from, to) => {
    expect(isValidRange(from, to)).toBe(false);
  });

  /** #79。逆転は従来どおり弾く。 */
  it('逆転した期間を受け付けない', () => {
    expect(isValidRange('2026-09-30', '2026-09-01')).toBe(false);
  });
});

describe('rangeDays', () => {
  /** #80。両端を含む。 */
  it('同じ日は 1 日、翌日までは 2 日', () => {
    expect(rangeDays('2026-09-04', '2026-09-04')).toBe(1);
    expect(rangeDays('2026-09-04', '2026-09-05')).toBe(2);
  });

  /** #80。上限の定数と、ちょうど上限になる期間。 */
  it('上限の定数は 400 で、400 日ちょうどの期間が作れる', () => {
    expect(MAX_RANGE_DAYS).toBe(400);
    // 2026-09-04 から 399 日後。
    expect(rangeDays('2025-08-01', '2026-09-04')).toBe(400);
  });

  /**
   * #80。**`isValidRange` を通った期間なら必ず有限値になる。**
   *
   * `rangeDays` 自体は `Date.parse` 依存のままでよい（実在しない日付は入口で弾かれる）。
   * この前提が崩れると `NaN > MAX_RANGE_DAYS === false` のフェイルオープンが戻る。
   */
  it.each([
    ['2026-09-04', '2026-09-04'],
    ['2024-02-29', '2024-03-01'],
    ['2025-08-01', '2026-09-04'],
    ['1000-01-01', '1000-01-02'],
  ])('isValidRange が真なら有限の日数を返す: %s 〜 %s', (from, to) => {
    expect(isValidRange(from, to)).toBe(true);

    const days = rangeDays(from, to);

    expect(Number.isFinite(days)).toBe(true);
    expect(Number.isNaN(days)).toBe(false);
    expect(days).toBeGreaterThanOrEqual(1);
  });

  /** #80。フェイルオープンの再現。実在しない日付は `isValidRange` で先に落とす。 */
  it('実在しない日付では日数の比較が当てにならないので、isValidRange で先に落とす', () => {
    // `NaN` との比較はすべて false になる（`NaN > 400` も `NaN < 1` も false）。
    const days = rangeDays('0000-00-00', '9999-99-99');
    if (Number.isNaN(days)) {
      expect(days > MAX_RANGE_DAYS).toBe(false);
    }

    // だからこそ、入口で弾けていなければならない。
    expect(isValidRange('0000-00-00', '9999-99-99')).toBe(false);
  });
});
