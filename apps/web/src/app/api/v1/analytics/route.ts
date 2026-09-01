import {
  listAnalyticsPage,
  listTopPathsPage,
  type AnalyticsPage,
} from '@/application/analytics/analytics-use-cases';
import type { AnalyticsPoint, TopPath } from '@/domain/analytics/analytics';
import { DEFAULT_PER_PAGE, MAX_PER_PAGE } from '@/api/query';
import { pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { analyticsListQuerySchema, analyticsPageSchema } from '@/api/schemas/analytics';

/**
 * Analytics API（05_API設計.md §20）。
 *
 * 期間指定・絞り込み・Pagination を提供する。**期間の上限を設けている**（設計 §5）。
 *
 * **`GET /analytics/{id}` は無い。** analytics は
 * `(site_id, metric_date, source, metric)` の複合キーで保存する集計値の集合で、
 * 単一リソースを指す id が存在しない。id を発明すると、
 * 「集計をやり直すと id が変わる」か「集計値と id の対応表を別に持つ」ことになり、
 * どちらも利用者に何の得も無い（仕様書 §20 / `改訂履歴.md` 2026-09-01）。
 */

export const GET = defineRoute({
  operationId: 'listAnalytics',
  method: 'GET',
  path: '/analytics',
  summary: 'アクセス・分析データを取得する',
  permission: 'analytics.read',
  query: analyticsListQuerySchema,
  response: analyticsPageSchema,
  handler: async ({ context, query }) => {
    const range = {
      siteId: query.siteId ?? null,
      from: query.from,
      to: query.to,
      source: query.source ?? null,
    };

    // `limit` は `perPage` の旧名。**明示された `perPage` を優先する。**
    // 上限は他の一覧 API と同じ値で丸める（`api/query.ts`）。
    const requested = query.perPage ?? query.limit ?? DEFAULT_PER_PAGE;
    const perPage = Math.min(MAX_PER_PAGE, Math.max(1, requested));
    const page = Math.max(1, query.page);

    const input = { ...range, page, perPage };

    const result: AnalyticsPage<AnalyticsPoint | TopPath> =
      query.kind === 'topPaths'
        ? await listTopPathsPage(context, input)
        : await listAnalyticsPage(context, input);

    return pageResponse(result.items, { page, perPage, total: result.total });
  },
});
