import { analyticsTimeZone } from '@/application/analytics/timezone';
import { daysAgoInTimeZone } from '@/domain/analytics/day';
import { listAnalytics } from '@/application/analytics/analytics-use-cases';
import { listRecentActivities } from '@/application/audit-use-cases';
import { listSocialPosts } from '@/application/social/social-use-cases';
import { Card } from '@/ui/components';
import {
  AccessSummary,
  AccessTrend,
  RecentActivities,
  RecentPosts,
  type DailyAccess,
} from '@/ui/dashboard/core-widgets';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginWidgets } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';

export const dynamic = 'force-dynamic';

/** 集計と同じ境目で日付を戻す（`application/analytics/timezone.ts`）。 */
function daysAgo(days: number): string {
  return daysAgoInTimeZone(days, analyticsTimeZone());
}

function formatDateTime(value: Date): string {
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * ダッシュボード（06_画面設計.md §9-10）。
 *
 * **Widget は Permission で出し分ける。** 権限が無い人に
 * 「読み込めない箱」を見せない（設計 §3.3）。
 */
export default async function DashboardPage() {
  // Server Component から Application 層を直接呼ぶ（決定事項 D-06）。
  const { context, displayName, permissions } = await requirePageSession();

  const canReadAnalytics = permissions.has('analytics.read');
  const canReadSocial = permissions.has('social.read');

  // 直近7日。期間を選ばせない（設計 §3.5）。
  const from = daysAgo(6);
  const to = daysAgo(0);

  const points = canReadAnalytics
    ? await listAnalytics(context, { siteId: null, from, to, source: null })
    : [];

  // 日ごとに畳む。出所（core / Plugin）をまたいで足す。
  const byDate = new Map<string, { pageviews: number; visitors: number }>();
  for (const point of points) {
    const current = byDate.get(point.metricDate) ?? { pageviews: 0, visitors: 0 };
    if (point.metric === 'pageviews') current.pageviews += point.value;
    if (point.metric === 'visitors') current.visitors += point.value;
    byDate.set(point.metricDate, current);
  }
  const daily: readonly DailyAccess[] = [...byDate.entries()]
    .map(([date, value]) => ({ date, ...value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const posts = canReadSocial
    ? await listSocialPosts(context, { page: 1, perPage: 5, socialAccountId: null, status: null })
    : { items: [], total: 0 };

  // 監査ログから「最近の活動」を作る。専用のテーブルを作らない（設計 §3.4）。
  //
  // **`system.manage` を持つ人にだけ見せる。** 「誰が何を消したか」まで含むため、
  // 閲覧権限しか無い利用者に管理者の操作を見せてしまわないようにする。
  const canReadAudit = permissions.has('system.manage');
  const activities = canReadAudit ? await listRecentActivities(context, { limit: 10 }) : [];

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>ダッシュボード</h1>

      <ExtensionPoint point="dashboard.before" permissions={permissions} context={context} />

      <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
        {canReadAnalytics ? (
          <>
            <AccessSummary daily={daily} postCount={posts.total} />
            <AccessTrend daily={daily} />
          </>
        ) : (
          <Card>
            <p style={{ margin: 0 }}>
              とりふねへログインしています。左のメニューから機能を選んでください。
            </p>
          </Card>
        )}

        {canReadSocial && (
          <RecentPosts
            posts={posts.items.map((post) => ({
              id: post.id,
              body: post.body,
              status: post.status,
              updatedAt: formatDateTime(post.updatedAt),
            }))}
          />
        )}

        {canReadAudit && (
          <RecentActivities
            activities={activities.map((row) => ({
              id: row.id,
              // 消えたユーザーの操作も残る（audit_logs は ON DELETE SET NULL）。
              actor: row.actorDisplayName ?? '（削除されたユーザー）',
              action: row.action,
              resourceType: row.resourceType,
              occurredAt: formatDateTime(row.occurredAt),
            }))}
          />
        )}
      </div>

      {/* Plugin の Widget。何が入るかは本体が知らない（03_プラグイン設計.md §9）。 */}
      <PluginWidgets location="dashboard" permissions={permissions} context={context} />

      <ExtensionPoint point="dashboard.after" permissions={permissions} context={context} />
    </AppShell>
  );
}
