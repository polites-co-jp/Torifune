import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DEFAULT_PER_PAGE,
  MAX_PER_PAGE,
  NotFoundError,
  normalizePagination,
  offsetOf,
} from './repository';

describe('normalizePagination', () => {
  it('未指定なら1ページ目・既定件数になる', () => {
    expect(normalizePagination(undefined)).toEqual({ page: 1, perPage: DEFAULT_PER_PAGE });
  });

  it('指定された値をそのまま使う', () => {
    expect(normalizePagination({ page: 3, perPage: 50 })).toEqual({ page: 3, perPage: 50 });
  });

  it('0以下のページを1に丸める', () => {
    expect(normalizePagination({ page: 0, perPage: 10 }).page).toBe(1);
    expect(normalizePagination({ page: -5, perPage: 10 }).page).toBe(1);
  });

  it('perPage の上限を超えたら上限に丸める', () => {
    expect(normalizePagination({ page: 1, perPage: 10_000 }).perPage).toBe(MAX_PER_PAGE);
  });

  it('perPage が0以下なら1に丸める', () => {
    expect(normalizePagination({ page: 1, perPage: 0 }).perPage).toBe(1);
  });

  it('小数を切り捨てる', () => {
    expect(normalizePagination({ page: 2.9, perPage: 10.7 })).toEqual({ page: 2, perPage: 10 });
  });
});

describe('offsetOf', () => {
  it('1ページ目の OFFSET は 0', () => {
    expect(offsetOf({ page: 1, perPage: 20 })).toBe(0);
  });

  it('2ページ目の OFFSET は perPage 分', () => {
    expect(offsetOf({ page: 2, perPage: 20 })).toBe(20);
  });
});

describe('NotFoundError', () => {
  it('リソース名とIDを保持する', () => {
    const error = new NotFoundError('Site', 'abc');
    expect(error.resource).toBe('Site');
    expect(error.id).toBe('abc');
    expect(error.name).toBe('NotFoundError');
  });

  it('メッセージにIDを含めない', () => {
    // 存在確認の差分から他人のリソースIDの有無を推測されないようにする。
    expect(new NotFoundError('Site', 'secret-id').message).not.toContain('secret-id');
  });
});

describe('ConflictError', () => {
  it('リソース名とフィールドを保持する', () => {
    const error = new ConflictError('User', 'email');
    expect(error.resource).toBe('User');
    expect(error.field).toBe('email');
    expect(error.name).toBe('ConflictError');
  });
});
