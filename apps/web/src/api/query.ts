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
