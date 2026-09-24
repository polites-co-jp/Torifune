import { describe, expect, it } from 'vitest';
import { DEFAULT_PER_PAGE, normalizePagination } from './repository';

/**
 * `normalizePagination` の広げた規則（043-api-input-fixes-rest 設計 §9.2、受け入れ条件 #20）。
 *
 * 1. `undefined` / `null` は省略（`page` は 1、`perPage` は 20）
 * 2. それ以外は `Number(値)` で数にする。**有限の数にならない値**（`NaN`・`Infinity`・`-Infinity`・`'abc'`）は省略と同じ
 * 3. 小数は切り捨てる
 * 4. `page` は 1 以上 `Number.MAX_SAFE_INTEGER` 以下、`perPage` は 1〜100 に丸める
 *
 * 既存の 6 件（0 以下・上限・0・小数など）は `repository.test.ts` にあり、変更なしで通ることをそちらで見る。
 */

describe('#20 normalizePagination は省略・null を既定の値にする', () => {
  it('#20 undefined → page 1・perPage 20', () => {
    expect(normalizePagination(undefined)).toEqual({ page: 1, perPage: DEFAULT_PER_PAGE });
  });

  it('#20 { page: null, perPage: null } → page 1・perPage 20', () => {
    expect(normalizePagination({ page: null, perPage: null })).toEqual({
      page: 1,
      perPage: DEFAULT_PER_PAGE,
    });
  });
});

describe('#20 normalizePagination は有限の数にならない値を省略と同じにする', () => {
  it('#20 { page: NaN, perPage: Infinity } → page 1・perPage 20', () => {
    expect(normalizePagination({ page: NaN, perPage: Infinity })).toEqual({
      page: 1,
      perPage: DEFAULT_PER_PAGE,
    });
  });

  it("#20 { page: -Infinity, perPage: 'abc' } → page 1・perPage 20", () => {
    expect(normalizePagination({ page: -Infinity, perPage: 'abc' })).toEqual({
      page: 1,
      perPage: DEFAULT_PER_PAGE,
    });
  });
});

describe('#20 normalizePagination は数に変換できる文字列を数として扱う', () => {
  it("#20 { page: '3', perPage: '7' } → page 3・perPage 7（数の型で返る）", () => {
    expect(normalizePagination({ page: '3', perPage: '7' })).toEqual({ page: 3, perPage: 7 });
  });
});

describe('#20 normalizePagination は page を Number.MAX_SAFE_INTEGER までに丸める', () => {
  it('#20 { page: 1e300 } → page === Number.MAX_SAFE_INTEGER、perPage は既定の 20', () => {
    expect(normalizePagination({ page: 1e300 })).toEqual({
      page: Number.MAX_SAFE_INTEGER,
      perPage: DEFAULT_PER_PAGE,
    });
  });
});
