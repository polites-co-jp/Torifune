import { z } from 'zod';
import { pageQuerySchema, perPageQuerySchema } from '@/api/query';
import {
  CAMPAIGN_LINK_MAX_ITEMS,
  CAMPAIGN_NAME_MAX_LENGTH,
  CAMPAIGN_STATUSES,
  type Campaign,
} from '@/domain/campaign/campaign';
import { dataEnvelope, pageEnvelope } from './envelope';

/**
 * Campaign API の Zod スキーマ（05_API設計.md §19）。
 *
 * `site.ts` と同じ形にそろえている。
 */

/**
 * 並び替えに使える公開名 → 内部キー。
 *
 * **DB のカラム名を直接指定させない**（05_API設計.md §35）。
 */
export const CAMPAIGN_SORT_FIELDS = {
  name: 'name',
  status: 'status',
  startsOn: 'starts_on',
  endsOn: 'ends_on',
  createdAt: 'created_at',
} as const;

export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES);

/** `YYYY-MM-DD`。時刻は受け取らない。 */
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で入力してください。');

/**
 * キャンペーンの紐づけ先（`siteIds` / `socialPostIds`）の配列。
 *
 * **Zod は件数の上限だけを見る**（OpenAPI の `maxItems` のため。045-campaign-input-500 設計 §4）。
 * 要素の形をここで見ると誤りのキーが `siteIds.0` になって画面の欄に出せず、
 * Data API と規則が 2 か所に分かれる。形・存在の検査は UseCase が行う。
 */
const linkIds = z
  .array(z.string())
  .max(CAMPAIGN_LINK_MAX_ITEMS, `${CAMPAIGN_LINK_MAX_ITEMS}件以内で指定してください。`);

/** 紐づけ先の説明（OpenAPI の `description`）。 */
function linkIdsDescription(what: string): string {
  return (
    `紐づける${what}の ID。UUID の形（8-4-4-4-12 の 16 進）で、存在する${what}の ID を ${CAMPAIGN_LINK_MAX_ITEMS} 件まで。` +
    '大文字・小文字は同じ ID として扱い、応答は小文字・重複なし・昇順。' +
    '形の誤り・存在しない ID・件数の超過は 422 で、何も書き込まない。'
  );
}

export const campaignListQuerySchema = z.object({
  page: pageQuerySchema,
  perPage: perPageQuerySchema,
  status: campaignStatusSchema.optional(),
  q: z.string().max(200, '検索語が長すぎます。').optional(),
  /**
   * この日に実施中のものだけを返す。形は Zod が、暦に無い日付（`2026-02-30` など）は
   * UseCase が 422 にする（045-campaign-input-500 設計 §6.2）。
   */
  activeOn: dateOnly
    .optional()
    .describe(
      'この日（YYYY-MM-DD）に実施中のキャンペーンだけを返す。形の誤りと存在しない日付（2026-02-30 など）は 422。',
    ),
  /**
   * このサイトを対象に含むものだけを返す。**UUID の形でなければ 422**（空文字も）。
   * 形の誤りで絞り込みが外れて全件が返ると、打ち間違いに気づけない（043-api-input-fixes-rest 設計 §6.3）。
   * 判定は 8-4-4-4-12 の 16 進で、大文字・小文字を問わず版と variant を見ない（`z.guid()`）。
   */
  siteId: z.guid('UUID の形で指定してください。').optional(),
  sort: z.string().optional(),
});

export const createCampaignSchema = z.object({
  name: z
    .string()
    .min(1, '入力してください。')
    .max(CAMPAIGN_NAME_MAX_LENGTH, `${CAMPAIGN_NAME_MAX_LENGTH}文字以内で入力してください。`),
  description: z.string().max(2000, '説明が長すぎます。').default(''),
  status: campaignStatusSchema.default('draft'),
  startsOn: dateOnly,
  endsOn: dateOnly.nullish(),
  siteIds: linkIds.default([]).describe(linkIdsDescription('Webサイト')),
  socialPostIds: linkIds.default([]).describe(linkIdsDescription('SNS投稿')),
  csrfToken: z.string().optional(),
});

export const updateCampaignSchema = z.object({
  name: z.string().min(1, '入力してください。').max(CAMPAIGN_NAME_MAX_LENGTH).optional(),
  description: z.string().max(2000, '説明が長すぎます。').optional(),
  status: campaignStatusSchema.optional(),
  startsOn: dateOnly.optional(),
  endsOn: dateOnly.nullish(),
  siteIds: linkIds.optional().describe(linkIdsDescription('Webサイト')),
  socialPostIds: linkIds.optional().describe(linkIdsDescription('SNS投稿')),
  csrfToken: z.string().optional(),
});

/** API が返す形（OpenAPI 用）。`CampaignResponse` と同じ形にしておく。 */
export const campaignResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: campaignStatusSchema,
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  siteIds: z.array(z.string()),
  socialPostIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const campaignEnvelopeSchema = dataEnvelope(campaignResponseSchema);
export const campaignPageSchema = pageEnvelope(campaignResponseSchema);

export interface CampaignResponse {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteIds: readonly string[];
  readonly socialPostIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toCampaignResponse(campaign: Campaign): CampaignResponse {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    startsOn: campaign.startsOn,
    endsOn: campaign.endsOn,
    siteIds: campaign.siteIds,
    socialPostIds: campaign.socialPostIds,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}
