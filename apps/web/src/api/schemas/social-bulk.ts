import { z } from 'zod';
import {
  BULK_EFFECTS,
  BULK_FAILURE_REASONS,
  BULK_MAX_ITEMS,
  type BulkItemResult,
} from '@/domain/social/bulk';
import { dataEnvelope } from './envelope';
import { approvePostSchema, postResponseSchema, toPostResponse, type PostResponse } from './social';

/**
 * SNS 投稿の一括操作の要求と応答（054-bulk-post-actions 設計 §8.1・§8.2・§8.3・§8.4・§8.9）。
 *
 * **要求の形の誤りは、項目の誤りも含めてキー `items`（取り消しは `ids`）に集める**（設計 §8.1・#24）。
 * Zod の既定のままだと要素の誤りのキーが `items.0.expectedUpdatedAt` になるので、要素は配列の検査の中で調べる。
 * OpenAPI には要素の形をそのまま載せる（`meta` で要素の JSON Schema を渡す）。
 */

/** 一括の項目（承認・今すぐ送る）の形。 */
const bulkItemSchema = z.object({
  id: z
    .string()
    .min(1, '投稿の ID を入力してください。')
    .describe('投稿の ID。UUID の形でなければ、その項目は not_found。'),
  // 1 件の承認と同じ検査（ISO 8601 の文字列）。
  expectedUpdatedAt: approvePostSchema.shape.expectedUpdatedAt,
});

export type BulkItemRequest = z.output<typeof bulkItemSchema>;

/** `z.toJSONSchema` の出力から `$schema` を落とした、要素の JSON Schema。 */
function elementJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return rest;
}

const COUNT_MESSAGE = `1〜${BULK_MAX_ITEMS} 件で指定してください。`;
const DUPLICATE_MESSAGE = '同じ投稿が 2 回以上含まれています。';

/**
 * 1〜100 件・重複なしの配列。要素の誤りも配列のキーに積む。
 *
 * `elementOf` は要素を検査して値を返す（誤りは `null` と文言）。重複は `keyOf` の値（文字列の一致）で見る。
 */
function bulkArraySchema<T>(options: {
  readonly element: z.ZodType<T>;
  readonly keyOf: (value: T) => string;
  readonly description: string;
}): z.ZodType<T[]> {
  return z
    .array(z.unknown().meta(elementJsonSchema(options.element)))
    .min(1, COUNT_MESSAGE)
    .max(BULK_MAX_ITEMS, COUNT_MESSAGE)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      let duplicated = false;
      values.forEach((value, index) => {
        const parsed = options.element.safeParse(value);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            context.addIssue({ code: 'custom', message: `${index + 1} 件目：${issue.message}` });
          }
          return;
        }
        const key = options.keyOf(parsed.data);
        if (seen.has(key)) duplicated = true;
        seen.add(key);
      });
      if (duplicated) {
        context.addIssue({ code: 'custom', message: DUPLICATE_MESSAGE });
      }
    })
    .transform((values) => values.map((value) => options.element.parse(value)))
    .describe(options.description) as unknown as z.ZodType<T[]>;
}

/** 承認・今すぐ送るの `items`。 */
const bulkItemsSchema = bulkArraySchema({
  element: bulkItemSchema,
  keyOf: (item) => item.id,
  description: `1〜${BULK_MAX_ITEMS} 件。同じ id を 2 回以上含めない（重複は 422）。`,
});

/** 一括承認の要求（設計 §8.2）。日時の指定し直し（`scheduledAt`）は取らない。 */
export const bulkApproveSchema = z.object({
  publishTiming: z
    .enum(['now', 'scheduled'])
    .describe(
      '即投稿（now）か、それぞれの登録された希望日時に投稿（scheduled）。希望日時が無い・過ぎている項目は承認されない。',
    ),
  items: bulkItemsSchema,
  csrfToken: z.string().optional(),
});

/** 応答の項目（成功）。 */
const bulkSuccessSchema = z.object({
  id: z.string(),
  ok: z.literal(true),
  effect: z.enum(BULK_EFFECTS),
  post: postResponseSchema.nullable().describe('処理後の投稿。削除は null。'),
});

/** 応答の項目（失敗）。 */
const bulkFailureSchema = z.object({
  id: z.string(),
  ok: z.literal(false),
  reason: z.enum(BULK_FAILURE_REASONS),
  message: z.string(),
  field: z.string().nullable().describe('422 の details のキーにあたるもの。無ければ null。'),
});

/** 一括の操作の応答（設計 §8.1）。`results` は要求の並びと同じ順・同じ数。 */
export const bulkResultEnvelopeSchema = dataEnvelope(
  z.object({
    bulkId: z.string().describe('要求ごとの ID。各項目の監査の detail.bulkId と同じ値。'),
    results: z.array(z.discriminatedUnion('ok', [bulkSuccessSchema, bulkFailureSchema])),
  }),
);

export type BulkItemResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly effect: (typeof BULK_EFFECTS)[number];
      readonly post: PostResponse | null;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: (typeof BULK_FAILURE_REASONS)[number];
      readonly message: string;
      readonly field: string | null;
    };

export interface BulkResultResponse {
  readonly bulkId: string;
  readonly results: readonly BulkItemResponse[];
}

/** UseCase の出力を応答の形にする（投稿は `postResponseSchema` の形）。 */
export function toBulkResultResponse(output: {
  readonly bulkId: string;
  readonly results: readonly BulkItemResult[];
}): BulkResultResponse {
  return {
    bulkId: output.bulkId,
    results: output.results.map((result) =>
      result.ok
        ? {
            id: result.id,
            ok: true,
            effect: result.effect,
            post: result.post === null ? null : toPostResponse(result.post),
          }
        : {
            id: result.id,
            ok: false,
            reason: result.reason,
            message: result.message,
            field: result.field,
          },
    ),
  };
}
