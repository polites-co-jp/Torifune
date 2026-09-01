import { listAnalytics } from '@/application/analytics/analytics-use-cases';
import { listSocialPosts } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
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

/** ローカルの `YYYY-MM-DD` を日数だけ戻して返す。 */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  const activities = await withConnection((connection) =>
    connection.db
      .selectFrom('audit_logs')
      .leftJoin('users', 'users.id', 'audit_logs.actor_user_id')
      .select([
        'audit_logs.id',
        'audit_logs.action',
        'audit_logs.resource_type',
        'audit_logs.occurred_at',
        'users.display_name',
      ])
      .orderBy('audit_logs.occurred_at', 'desc')
      .limit(10)
      .execute(),
  );

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

        <RecentActivities
          activities={activities.map((row) => ({
            id: row.id,
            // 消えたユーザーの操作も残る（audit_logs は ON DELETE SET NULL）。
            actor: row.display_name ?? '（削除されたユーザー）',
            action: row.action,
            resourceType: row.resource_type,
            occurredAt: formatDateTime(row.occurred_at),
          }))}
        />
      </div>

      {/* Plugin の Widget。何が入るかは本体が知らない（03_プラグイン設計.md §9）。 */}
      <PluginWidgets location="dashboard" permissions={permissions} context={context} />

      <ExtensionPoint point="dashboard.after" permissions={permissions} context={context} />
    </AppShell>
  );
}
