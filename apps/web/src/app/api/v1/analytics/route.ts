import { z } from 'zod';
import { listAnalytics, listTopPaths } from '@/application/analytics/analytics-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * Analytics API（05_API設計.md §20）。
 *
 * 期間指定と絞り込みを提供する。**期間の上限を設けている**（設計 §5）。
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で入力してください。');

export const GET = defineRoute({
  operationId: 'listAnalytics',
  method: 'GET',
  path: '/analytics',
  summary: 'アクセス・分析データを取得する',
  permission: 'analytics.read',
  query: z.object({
    siteId: z.string().optional(),
    from: dateOnly,
    to: dateOnly,
    source: z.string().max(100).optional(),
    /** 'points'（日次の値）か 'topPaths'（上位ページ）。 */
    kind: z.enum(['points', 'topPaths']).default('points'),
    limit: z.coerce.number().int().default(20),
  }),
  handler: async ({ context, query }) => {
    const range = {
      siteId: query.siteId ?? null,
      from: query.from,
      to: query.to,
      source: query.source ?? null,
    };

    if (query.kind === 'topPaths') {
      return dataResponse(await listTopPaths(context, { ...range, limit: query.limit }));
    }
    return dataResponse(await listAnalytics(context, range));
  },
});
