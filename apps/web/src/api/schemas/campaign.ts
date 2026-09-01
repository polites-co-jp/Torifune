import { z } from 'zod';
import {
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

export const campaignListQuerySchema = z.object({
  page: z.coerce.number().int('整数を指定してください。').default(1),
  perPage: z.coerce.number().int('整数を指定してください。').default(20),
  status: campaignStatusSchema.optional(),
  q: z.string().max(200, '検索語が長すぎます。').optional(),
  /** この日に実施中のものだけを返す。 */
  activeOn: dateOnly.optional(),
  siteId: z.string().optional(),
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
  siteIds: z.array(z.string()).default([]),
  socialPostIds: z.array(z.string()).default([]),
  csrfToken: z.string().optional(),
});

export const updateCampaignSchema = z.object({
  name: z.string().min(1, '入力してください。').max(CAMPAIGN_NAME_MAX_LENGTH).optional(),
  description: z.string().max(2000, '説明が長すぎます。').optional(),
  status: campaignStatusSchema.optional(),
  startsOn: dateOnly.optional(),
  endsOn: dateOnly.nullish(),
  siteIds: z.array(z.string()).optional(),
  socialPostIds: z.array(z.string()).optional(),
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
