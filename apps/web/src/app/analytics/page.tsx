import { headers } from 'next/headers';
import { analyticsTimeZone } from '@/application/analytics/timezone';
import { daysAgoInTimeZone } from '@/domain/analytics/day';
import { originFromHeaders } from '@/api/absolute-url';
import {
  listAnalytics,
  listAnalyticsBreakdown,
  listTrackedSites,
} from '@/application/analytics/analytics-use-cases';
import { AnalyticsView } from '@/ui/analytics/analytics-view';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

function asString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * アナリティクス画面（06_画面設計.md §15）。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('analytics.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  // 既定は直近30日。広すぎる期間は UseCase 側が拒否する。
  // **集計と同じ境目で「今日」を決める。** サーバーのローカル日付で
  // 作ると、集計が畳んだ日と食い違って常に 0 件になる期間ができる。
  const timeZone = analyticsTimeZone();
  const from = asString(params['from']) ?? daysAgoInTimeZone(29, timeZone);
  const to = asString(params['to']) ?? daysAgoInTimeZone(0, timeZone);
  const siteId = asString(params['siteId']);

  const range = { siteId, from, to, source: null };

  // 日次の表に要る指標だけを、キー無しの行に絞って読む（028 設計 §6.1）。
  // 上位ページは集計値（`path_pageviews`）の内訳から引く。生ログは読まない。
  const [points, topPathsPage] = await Promise.all([
    listAnalytics(context, { ...range, metrics: ['pageviews', 'visitors'], key: '' }),
    listAnalyticsBreakdown(context, { ...range, metric: 'path_pageviews', page: 1, perPage: 20 }),
  ]);
  const topPaths = topPathsPage.items.map((item) => ({ path: item.key, pageviews: item.value }));

  // 計測タグを出すために公開キーが要る（Site の一覧 API は公開キーを返さない）。
  const sites = permissions.has('site.read') ? await listTrackedSites(context, {}) : [];

  // **計測タグの src は絶対 URL で出す。** 相対パスのまま貼られると、
  // 貼った先のサーバーの `/t.js` を探しに行って計測が届かない。
  // 送信先は `t.js` が APP_URL から組み立てるので、ここも同じ優先順位にそろえる。
  const scriptOrigin = originFromHeaders(await headers());

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <AnalyticsView
        points={points}
        topPaths={topPaths}
        sites={sites}
        scriptOrigin={scriptOrigin}
        timeZone={timeZone}
        selectedSiteId={siteId}
        from={from}
        to={to}
      />
    </AppShell>
  );
}
