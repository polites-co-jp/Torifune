/**
 * Repository の共通型。
 *
 * **このファイルは Domain 層にある。DB 製品に依存してはならない。**
 * `pg` も `kysely` も import しない（ESLint で検査している）。
 *
 * Repository の実装は Infrastructure 層に置き、`Connection` を受け取る。
 * `Connection` の実体が Pool 由来かトランザクション由来かを Repository は知らないため、
 * 同じ実装がトランザクションの内外どちらでも動く。
 */

/** 一覧取得のページング指定。 */
export interface Pagination {
  /** 1始まり。 */
  readonly page: number;
  readonly perPage: number;
}

/** 並び順の指定。並べ替え可能なフィールドは呼び出し側がホワイトリストで絞る。 */
export interface SortOrder<TField extends string> {
  readonly field: TField;
  readonly direction: 'asc' | 'desc';
}

/** 一覧取得の結果。 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

/** ページング指定を安全な範囲へ丸める。 */
export function normalizePagination(input: Partial<Pagination> | undefined): Pagination {
  const page = Math.max(1, Math.trunc(input?.page ?? 1));
  const requested = Math.trunc(input?.perPage ?? DEFAULT_PER_PAGE);
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, requested));
  return { page, perPage };
}

/** ページング指定から OFFSET を求める。 */
export function offsetOf(pagination: Pagination): number {
  return (pagination.page - 1) * pagination.perPage;
}

/** 取得しようとしたリソースが存在しない。 */
export class NotFoundError extends Error {
  constructor(
    readonly resource: string,
    readonly id: string,
  ) {
    super(`${resource} が見つからない`);
    this.name = 'NotFoundError';
  }
}

/**
 * 入力が業務ルールを満たさない。
 *
 * API Layer の Zod でも検証するが、UseCase を直接呼ぶ経路がある
 * （Server Component、Plugin の Data API）ため、Domain 側でも表現できる必要がある。
 */
export class ValidationError extends Error {
  constructor(
    readonly resource: string,
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${resource} の ${field} が不正`);
    this.name = 'ValidationError';
  }
}

/** 一意制約に反する登録・更新。 */
export class ConflictError extends Error {
  constructor(
    readonly resource: string,
    readonly field: string,
  ) {
    super(`${resource} の ${field} が既に使われている`);
    this.name = 'ConflictError';
  }
}
