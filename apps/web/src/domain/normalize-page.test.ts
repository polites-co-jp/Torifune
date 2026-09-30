import { describe, expect, it } from 'vitest';
import { normalizePage, normalizePagination } from './repository';

/**
 * 画面の `?page=` を読む部品 `normalizePage`（044-screen-page-param 設計 §4、受け入れ条件 #1〜#8）。
 *
 * 規則は `normalizePagination` の `page` と同一。
 *
 * 1. `undefined` / `null` → 1
 * 2. それ以外は `Number(値)`。有限の数にならなければ 1
 * 3. 小数は切り捨てる
 * 4. 1 以上 `Number.MAX_SAFE_INTEGER` 以下に丸める
 */

const MAX = Number.MAX_SAFE_INTEGER;

/** `bigint`（PostgreSQL の `OFFSET`）の上限。 */
const BIGINT_MAX = 9223372036854775807n;

/** 画面で最大の `perPage`（`/analytics` の表）。 */
const LARGEST_PER_PAGE = 50n;

const ABSENT: readonly (readonly [unknown, number])[] = [
  [undefined, 1],
  [null, 1],
];

const TRUNCATED: readonly (readonly [unknown, number])[] = [
  ['3', 3],
  [3, 3],
  [' 7 ', 7],
  ['2.9', 2],
  ['1.01', 1],
  [2.9, 2],
];

const BELOW_ONE: readonly (readonly [unknown, number])[] = [
  ['0', 1],
  ['-5', 1],
  ['-0.5', 1],
  ['', 1],
  [' ', 1],
  [0, 1],
  [-5, 1],
];

const NOT_FINITE: readonly (readonly [unknown, number])[] = [
  ['Infinity', 1],
  ['-Infinity', 1],
  ['NaN', 1],
  ['abc', 1],
  ['1e400', 1],
  [Infinity, 1],
  [-Infinity, 1],
  [NaN, 1],
];

const TOO_LARGE: readonly (readonly [unknown, number])[] = [
  ['1e18', MAX],
  ['1e300', MAX],
  [1e18, MAX],
  [String(MAX + 2), MAX],
  [String(MAX), MAX],
];

const REPEATED_KEY: readonly (readonly [unknown, number])[] = [
  [['2', '3'], 1],
  [['abc', '1e18'], 1],
  [[], 1],
];

/** 表示用。`JSON.stringify` は `undefined`・`NaN`・`Infinity` を正しく書けない。 */
function show(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`;
  return String(value);
}

function expectedLabel(expected: number): string {
  return expected === MAX ? 'Number.MAX_SAFE_INTEGER' : String(expected);
}

/** 値ごとに `normalizePage(値)` が期待どおりかを見るテストを並べる。 */
function eachCase(criterion: string, list: readonly (readonly [unknown, number])[]): void {
  for (const [value, expected] of list) {
    it(`${criterion} ${show(value)} → ${expectedLabel(expected)}`, () => {
      expect(normalizePage(value)).toBe(expected);
    });
  }
}

/** #1〜#6 のすべての値。 */
const ALL_VALUES: readonly unknown[] = [
  ...ABSENT,
  ...TRUNCATED,
  ...BELOW_ONE,
  ...NOT_FINITE,
  ...TOO_LARGE,
  ...REPEATED_KEY,
].map(([value]) => value);

describe('#1 normalizePage は省略・null を 1 にする', () => {
  eachCase('#1', ABSENT);
});

describe('#2 normalizePage は数に変換できる値の小数を切り捨てる', () => {
  eachCase('#2', TRUNCATED);
});

describe('#3 normalizePage は 1 未満の値を 1 にする', () => {
  eachCase('#3', BELOW_ONE);
});

describe('#4 normalizePage は有限の数にならない値を 1 にする', () => {
  eachCase('#4', NOT_FINITE);
});

describe('#5 normalizePage は Number.MAX_SAFE_INTEGER までに丸める', () => {
  eachCase('#5', TOO_LARGE);
});

describe('#6 normalizePage は同じキーを重ねた配列を 1 にする', () => {
  eachCase('#6', REPEATED_KEY);
});

describe('#7 normalizePage は normalizePagination の page と同じ値を返す（規則が 1 か所）', () => {
  for (const value of ALL_VALUES) {
    it(`#7 ${show(value)} で normalizePagination({ page }).page と等しい`, () => {
      expect(normalizePage(value)).toBe(normalizePagination({ page: value }).page);
    });
  }
});

describe('#8 normalizePage の結果は安全な整数で、OFFSET が bigint に収まる', () => {
  for (const value of ALL_VALUES) {
    it(`#8 ${show(value)} の結果が 1 以上の安全な整数で、(結果 − 1) × 50 が bigint の上限以下`, () => {
      const page = normalizePage(value);

      expect(Number.isSafeInteger(page)).toBe(true);
      expect(page).toBeGreaterThanOrEqual(1);
      expect(BigInt(page - 1) * LARGEST_PER_PAGE <= BIGINT_MAX).toBe(true);
    });
  }
});
