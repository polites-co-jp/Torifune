import { headers } from 'next/headers';
import { originFromHeaders } from '@/api/absolute-url';
import {
  listAnalytics,
  listTopPaths,
  listTrackedSites,
} from '@/application/analytics/analytics-use-cases';
import { AnalyticsView } from '@/ui/analytics/analytics-view';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/** ローカルの `YYYY-MM-DD` を日数だけ戻して返す。 */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

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
  const from = asString(params['from']) ?? daysAgo(29);
  const to = asString(params['to']) ?? daysAgo(0);
  const siteId = asString(params['siteId']);

  const range = { siteId, from, to, source: null };

  const [points, topPaths] = await Promise.all([
    listAnalytics(context, range),
    listTopPaths(context, { ...range, limit: 20 }),
  ]);

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
        selectedSiteId={siteId}
        from={from}
        to={to}
      />
    </AppShell>
  );
}
