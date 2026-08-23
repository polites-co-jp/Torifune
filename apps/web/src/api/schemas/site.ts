import { z } from 'zod';
import { SITE_NAME_MAX_LENGTH, SITE_STATUSES } from '@/domain/site/site';

/**
 * Webサイト API の Zod スキーマ。
 *
 * ここが OpenAPI の入力にもなる（`api/openapi.ts`）。
 */

/**
 * 並び替えに使える公開名 → 内部キー。
 *
 * **DB のカラム名を直接指定させない**（05_API設計.md §35）。
 * カラム名が変わっても API の契約が変わらない。
 */
export const SITE_SORT_FIELDS = {
  name: 'name',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export const siteStatusSchema = z.enum(SITE_STATUSES);

export const siteListQuerySchema = z.object({
  page: z.coerce.number().int('整数を指定してください。').default(1),
  perPage: z.coerce.number().int('整数を指定してください。').default(20),
  status: siteStatusSchema.optional(),
  q: z.string().max(200, '検索語が長すぎます。').optional(),
  sort: z.string().optional(),
});

export const createSiteSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, '入力してください。')
    .max(SITE_NAME_MAX_LENGTH, `${SITE_NAME_MAX_LENGTH}文字以内で入力してください。`),
  url: z.string().min(1, '入力してください。'),
  description: z.string().max(2000, '2000文字以内で入力してください。').default(''),
  status: siteStatusSchema.default('active'),
  csrfToken: z.string().optional(),
});

export const updateSiteSchema = z.object({
  name: z.string().trim().min(1, '入力してください。').max(SITE_NAME_MAX_LENGTH).optional(),
  url: z.string().min(1, '入力してください。').optional(),
  description: z.string().max(2000).optional(),
  status: siteStatusSchema.optional(),
  csrfToken: z.string().optional(),
});

/** API が返す形。内部の項目をそのまま返さず、明示的に選ぶ。 */
export interface SiteResponse {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toSiteResponse(site: {
  id: string;
  name: string;
  url: string;
  description: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SiteResponse {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    description: site.description,
    status: site.status,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}
