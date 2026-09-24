import { z } from 'zod';

/**
 * 一覧のクエリパラメータ（05_API設計.md §33-35）。
 *
 * **Sorting はホワイトリスト方式にする。**
 * 任意の Database Column を指定できる仕様にすると、
 * DB の内部構造が API の契約に漏れ、カラム名の推測にも使われる。
 */

export const DEFAULT_PER_PAGE = 20;
export const MAX_PER_PAGE = 100;

export interface Pagination {
  readonly page: number;
  readonly perPage: number;
}

export interface SortField<TKey extends string> {
  readonly field: TKey;
  readonly direction: 'asc' | 'desc';
}

/** 公開名 → 内部の並び替えキーの対応表。 */
export type SortMap = Readonly<Record<string, string>>;

/**
 * Pagination の Zod スキーマ。
 *
 * 数値でない値は 422 にする（黙って既定値へ落とすと、
 * 打ち間違いに気づけないまま別のページを見ることになる）。
 * 範囲外の値は丸める（0 ページ目や 10 万件の要求は、拒否よりも丸めるほうが親切）。
 */
export const paginationSchema = z.object({
  page: z.coerce
    .number()
    .int('整数を指定してください。')
    .transform((value) => Math.max(1, value))
    .default(1),
  perPage: z.coerce
    .number()
    .int('整数を指定してください。')
    .transform((value) => Math.min(MAX_PER_PAGE, Math.max(1, value)))
    .default(DEFAULT_PER_PAGE),
});

/**
 * 一覧のクエリの `page` / `perPage` の部品（042-social-api-input-fixes 設計 §6.2、043-api-input-fixes-rest 設計 §6.2）。
 *
 * **規則は上の `paginationSchema` と同じ**（`page` は 1 未満を 1、`perPage` は 1〜100 に丸める。
 * 整数でなければ 422。既定は 1 / 20）。範囲外の整数は意図が明らかなので断らずに丸め、打ち間違い（`abc`）は断る。
 *
 * `paginationSchema` の形（`transform` の後ろに `.default()`）のまま使うと OpenAPI から `default` が消えるので、
 * `.default()` を `transform` の前に置く（042 実装プラン §8 の 1）。
 * `.int()` が出す `minimum` / `maximum`（安全な整数の範囲）はキーごと消す。書くと「範囲外は断られる」と読めて、
 * 実際の振る舞い（丸める）と食い違う（042 設計 §6.2 末尾）。
 *
 * SNS の一覧（`api/schemas/social.ts`）と `/sites`・`/users`・`/campaigns` の一覧が同じ部品を使う。
 */
export const pageQuerySchema = z.coerce
  .number()
  .int('整数を指定してください。')
  .default(1)
  .transform((value) => Math.max(1, value))
  .meta({
    description: '1 以上。範囲外は 1 に丸める。',
    minimum: undefined,
    maximum: undefined,
  });

export const perPageQuerySchema = z.coerce
  .number()
  .int('整数を指定してください。')
  .default(DEFAULT_PER_PAGE)
  .transform((value) => Math.min(MAX_PER_PAGE, Math.max(1, value)))
  .meta({
    description: `1〜${MAX_PER_PAGE}。範囲外は 1〜${MAX_PER_PAGE} に丸める。`,
    minimum: undefined,
    maximum: undefined,
  });

export function offsetOf(pagination: Pagination): number {
  return (pagination.page - 1) * pagination.perPage;
}

export class UnknownSortFieldError extends Error {
  constructor(readonly field: string) {
    super('並び替えに使えないフィールド');
    this.name = 'UnknownSortFieldError';
  }
}

/**
 * `sort=name,-createdAt` を解釈する。
 *
 * ホワイトリストに無い名前は例外にする。**無視しない。**
 * 無視すると、指定したつもりの並び順が効かないまま気づけない。
 */
export function parseSort<TMap extends SortMap>(
  raw: string | null | undefined,
  allowed: TMap,
  fallback: readonly SortField<string>[],
): readonly SortField<string>[] {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const fields: SortField<string>[] = [];

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }

    const descending = trimmed.startsWith('-');
    const publicName = descending ? trimmed.slice(1) : trimmed;

    const internal = Object.prototype.hasOwnProperty.call(allowed, publicName)
      ? allowed[publicName]
      : undefined;
    if (internal === undefined) {
      throw new UnknownSortFieldError(publicName);
    }

    fields.push({ field: internal, direction: descending ? 'desc' : 'asc' });
  }

  return fields.length === 0 ? fallback : fields;
}

/** URLSearchParams をプレーンなオブジェクトへ。同名が複数あれば最後を採る。 */
export function searchParamsToObject(url: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) {
    result[key] = value;
  }
  return result;
}
