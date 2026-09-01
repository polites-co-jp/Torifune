import { z } from 'zod';

/**
 * 応答の外側の形（05_API設計.md §10・§33）。
 *
 * `api/response.ts` が組み立てる `{ data }` / `{ data, meta }` を、
 * **Zod スキーマとしても1箇所に持つ**。OpenAPI（§40）はこれを読む。
 *
 * 中身の型だけを宣言させて外側をここで包むので、
 * ルート側が `{ data: ... }` を書き忘れて仕様と実装がずれることがない。
 */

/** Pagination のメタ情報（`PageMeta` と同じ形）。 */
export const pageMetaSchema = z.object({
  page: z.number().int(),
  perPage: z.number().int(),
  /** そのページの件数ではなく、条件に合う全件数。 */
  total: z.number().int(),
});

/** 単体の応答。 */
export function dataEnvelope<T extends z.ZodType>(payload: T): z.ZodType {
  return z.object({ data: payload });
}

/** 一覧の応答。 */
export function pageEnvelope<T extends z.ZodType>(item: T): z.ZodType {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

/** ページングを持たない一覧の応答（件数が構造的に小さいもの）。 */
export function listEnvelope<T extends z.ZodType>(item: T): z.ZodType {
  return z.object({ data: z.array(item) });
}

/**
 * エラー応答（§11）。
 *
 * `api/errors.ts` の `ErrorBody` と同じ形。**内部情報を持たない**ことが型で分かる。
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** フィールド単位の入力エラーだけ。 */
    details: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

/** ISO8601 の日時。 */
export const isoDateTimeSchema = z.string();
