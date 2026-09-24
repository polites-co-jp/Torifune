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

/**
 * ページング指定を安全な範囲へ丸める。
 *
 * 1. `undefined` / `null` は省略（`page` は 1、`perPage` は 20）
 * 2. それ以外は `Number(値)` で数にする。**有限の数にならない値**（`NaN`・`Infinity`・`'abc'` など）は省略と同じ
 * 3. 小数は切り捨てる
 * 4. `page` は 1〜`Number.MAX_SAFE_INTEGER`、`perPage` は 1〜100 に丸める
 *
 * 引数を `unknown` の値で受けるのは、JavaScript で書いた Plugin が Data API に `'3'` や `NaN` を
 * 渡しうるため（043-api-input-fixes-rest 設計 §9.2）。どの値でも `LIMIT` / `OFFSET` に負の値・過大な値・
 * `NaN` が届かない。
 */
export function normalizePagination(
  input: { readonly page?: unknown; readonly perPage?: unknown } | undefined,
): Pagination {
  const page = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, integerOr(input?.page, 1)));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, integerOr(input?.perPage, DEFAULT_PER_PAGE)));
  return { page, perPage };
}

/** 有限の数に変換できれば小数を切り捨てた値、できなければ `fallback`。 */
function integerOr(value: unknown, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
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
    /**
     * 複数のフィールドにまたがる問題。
     *
     * 省略すると `{ [field]: [detail] }` と同じ意味。
     * 1 回の検証で複数の指摘が出る場面（Plugin の `validate()` など）のためにある。
     * `field` / `detail` には先頭の 1 件を入れ、UseCase を直接呼ぶ経路でも
     * 「少なくとも 1 件の理由」を読めるようにしておく。
     */
    readonly details?: Readonly<Record<string, readonly string[]>>,
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
