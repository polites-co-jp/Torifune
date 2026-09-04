import { listAnalyticsBreakdown } from '@/application/analytics/analytics-use-cases';
import { DEFAULT_PER_PAGE, MAX_PER_PAGE } from '@/api/query';
import { pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  analyticsBreakdownPageSchema,
  analyticsBreakdownQuerySchema,
} from '@/api/schemas/analytics';

/**
 * 内訳 API（028 設計 §6.2、05_API設計.md §20）。
 *
 * 期間内の集計値を key ごとに合算して返す。パス別（`path_pageviews`）、
 * 参照元別（`referrer`）、時間帯別（`pageviews_hour`）などはすべてここから引く。
 * `GET /analytics?kind=topPaths` の置き換え先。
 *
 * **生ログは読まない。** 集計値（`analytics`）だけを見るので、日次集計を流すまで出ない。
 */

export const GET = defineRoute({
  operationId: 'listAnalyticsBreakdown',
  method: 'GET',
  path: '/analytics/breakdown',
  summary: '集計値の内訳（key ごとの期間合計）を取得する',
  permission: 'analytics.read',
  query: analyticsBreakdownQuerySchema,
  response: analyticsBreakdownPageSchema,
  handler: async ({ context, query }) => {
    // 上限は他の一覧 API と同じ値で丸める（`api/query.ts`）。
    const requested = query.perPage ?? DEFAULT_PER_PAGE;
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, requested));
    const page = Math.max(1, query.page);

    const result = await listAnalyticsBreakdown(context, {
      siteId: query.siteId ?? null,
      from: query.from,
      to: query.to,
      metric: query.metric,
      source: query.source ?? null,
      page,
      perPage,
    });

    return pageResponse(result.items, { page, perPage, total: result.total });
  },
});
