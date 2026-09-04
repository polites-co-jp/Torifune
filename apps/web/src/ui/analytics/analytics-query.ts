import type { AnalyticsPeriod, AnalyticsTab } from './labels';

/**
 * アナリティクス画面の状態（028-analytics-dashboard-redesign 設計 §7.3.1）。
 *
 * **状態はすべて URL に持つ。** リロードしても、リンクを共有しても同じ画面になる。
 * 画面側の操作（期間・サイト・Bot・タブ・ページ送り）は、ここから新しい URL を組み立てて
 * `router.push` するだけで、自分では状態を持たない。
 */
export interface AnalyticsQuery {
  readonly siteId: string;
  readonly tab: AnalyticsTab;
  readonly period: AnalyticsPeriod;
  /** 実際に集計した期間（`YYYY-MM-DD`）。プリセットならそこから求めた値。 */
  readonly from: string;
  readonly to: string;
  /** 「Bot を集計に含める」。 */
  readonly includeBots: boolean;
  /** ページ / 参照元タブのページ番号（1 以上）。 */
  readonly page: number;
}

/**
 * 画面の状態から URL を組み立てる。
 *
 * 既定値（概要タブ・30 日・Bot を含めない・1 ページ目）は書かない。
 * 共有しやすい短い URL にするためで、読む側（`app/analytics/page.tsx`）は
 * 無いときに同じ既定を使う。
 */
export function analyticsHref(query: AnalyticsQuery): string {
  const params = new URLSearchParams();
  params.set('siteId', query.siteId);

  if (query.tab !== 'overview') {
    params.set('tab', query.tab);
  }

  if (query.period === 'custom') {
    params.set('period', 'custom');
    params.set('from', query.from);
    params.set('to', query.to);
  } else if (query.period !== '30d') {
    params.set('period', query.period);
  }

  if (query.includeBots) {
    params.set('bots', '1');
  }

  if (query.page > 1) {
    params.set('page', String(query.page));
  }

  return `/analytics?${params.toString()}`;
}
