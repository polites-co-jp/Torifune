import { resolveAnalyticsTimeZone } from '@/application/analytics/timezone';
import { listAnalytics, listTrackedSites } from '@/application/analytics/analytics-use-cases';
import { listRecentActivities } from '@/application/audit-use-cases';
import { listCampaigns } from '@/application/campaign/campaign-use-cases';
import { listSites } from '@/application/site/site-use-cases';
import { listSocialPosts, listSocialPostsByIds } from '@/application/social/social-use-cases';
import type { AnalyticsPoint } from '@/domain/analytics/analytics';
import { formatDateTimeInTimeZone, shiftDays, todayInTimeZone } from '@/domain/analytics/day';
import {
  campaignProgress,
  delta,
  deltaPt,
  summarize,
  summarizeBySite,
  summarizeDaily,
} from '@/domain/analytics/summary';
import { countPostsByStatus } from '@/domain/campaign/campaign-analysis';
import type { SocialPost } from '@/domain/social/social';
import { Card } from '@/ui/components';
import {
  AccessOverview,
  ActiveCampaigns,
  RecentActivities,
  RecentPosts,
  type ActiveCampaignRow,
  type DailyAccess,
  type SiteAccessRow,
} from '@/ui/dashboard/core-widgets';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginWidgets } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';

export const dynamic = 'force-dynamic';

/** 直近 7 日。期間を選ばせない（014 設計 §3.5）。 */
const PERIOD_DAYS = 7;

/** 当期・前期で使う指標。キー無しの行に絞って読む（028 設計 §6.1 / §7.2）。 */
const DASHBOARD_METRICS = ['pageviews', 'visitors', 'sessions', 'bounces'] as const;

/** Bot は含めない。ダッシュボードにスイッチは置かない（設計 §7.2）。 */
const SUMMARY_OPTIONS = { includeBots: false } as const;

/** `from` 〜 `to` の日付列（両端を含む）。 */
function datesBetween(from: string, to: string): readonly string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = shiftDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

/**
 * ダッシュボード（06_画面設計.md §9-10、028 設計 §7.2）。
 *
 * **Widget は Permission で出し分ける。** 権限が無い人に
 * 「読み込めない箱」を見せない（014 設計 §3.3）。出し分けは表示制御であって
 * 認可ではない。認可は UseCase が行う。
 */
export default async function DashboardPage() {
  // Server Component から Application 層を直接呼ぶ（決定事項 D-06）。
  const { context, displayName, permissions } = await requirePageSession();

  const canReadAnalytics = permissions.has('analytics.read');
  const canReadSocial = permissions.has('social.read');
  const canReadSites = permissions.has('site.read');
  const canReadCampaigns = permissions.has('campaign.read');
  // 監査ログから「最近の活動」を作る。専用のテーブルを作らない（014 設計 §3.4）。
  //
  // **`system.manage` を持つ人にだけ見せる。** 「誰が何を消したか」まで含むため、
  // 閲覧権限しか無い利用者に管理者の操作を見せてしまわないようにする。
  const canReadAudit = permissions.has('system.manage');

  // 集計と同じ境目で「今日」を決める（`application/analytics/timezone.ts`）。
  const timeZone = await resolveAnalyticsTimeZone();
  const today = todayInTimeZone(timeZone);
  const from = shiftDays(today, -(PERIOD_DAYS - 1));
  // 前期間は「その前の 7 日」。当期と合わせて 1 回で読み、日付で分ける。
  const previousFrom = shiftDays(from, -PERIOD_DAYS);

  const points: readonly AnalyticsPoint[] = canReadAnalytics
    ? await listAnalytics(context, {
        siteId: null,
        from: previousFrom,
        to: today,
        source: null,
        metrics: [...DASHBOARD_METRICS],
        key: '',
      })
    : [];
  const currentPoints = points.filter((point) => point.metricDate >= from);
  const previousPoints = points.filter((point) => point.metricDate < from);

  const current = summarize(currentPoints, SUMMARY_OPTIONS);
  const previous = summarize(previousPoints, SUMMARY_OPTIONS);
  const currentBySite = summarizeBySite(currentPoints, SUMMARY_OPTIONS);
  const previousBySite = summarizeBySite(previousPoints, SUMMARY_OPTIONS);

  // 日次は 7 日ぶん揃える（記録の無い日は 0）。記録が 1 つも無ければ空状態にする。
  const dailyByDate = new Map(
    summarizeDaily(currentPoints, SUMMARY_OPTIONS).map((d) => [d.date, d]),
  );
  const daily: readonly DailyAccess[] =
    currentPoints.length === 0
      ? []
      : datesBetween(from, today).map((date) => ({
          date,
          pageviews: dailyByDate.get(date)?.pageviews ?? 0,
          visitors: dailyByDate.get(date)?.visitors ?? 0,
        }));

  // 最近の投稿（5 件）と全体の件数は同じ呼び出しから取れる。配信済みの件数だけ別に数える。
  const posts = canReadSocial
    ? await listSocialPosts(context, { page: 1, perPage: 5, socialAccountId: null, status: null })
    : { items: [], total: 0 };
  const publishedTotal = canReadSocial
    ? (
        await listSocialPosts(context, {
          page: 1,
          perPage: 1,
          socialAccountId: null,
          status: 'published',
        })
      ).total
    : 0;

  // サイト別の行。名前順、`archived` を除く既定（設計 §7.2）。
  const sites =
    canReadAnalytics && canReadSites
      ? (
          await listSites(context, {
            page: 1,
            perPage: 100,
            status: null,
            keyword: null,
            sort: [{ field: 'name', direction: 'asc' }],
          })
        ).items
      : [];
  const siteRows: readonly SiteAccessRow[] = sites.map((site) => ({
    id: site.id,
    name: site.name,
    pageviews: currentBySite.get(site.id)?.pageviews ?? 0,
    visitors: currentBySite.get(site.id)?.visitors ?? 0,
    delta: delta(
      currentBySite.get(site.id)?.pageviews ?? 0,
      previousBySite.get(site.id)?.pageviews ?? 0,
    ),
  }));

  // 実施中のキャンペーン。開始日の新しい順に 5 件（設計 §7.2）。
  const campaigns = canReadCampaigns
    ? (
        await listCampaigns(context, {
          page: 1,
          perPage: 5,
          status: 'running',
          keyword: null,
          activeOn: null,
          siteId: null,
          sort: [{ field: 'starts_on', direction: 'desc' }],
        })
      ).items
    : [];

  // 対象サイトの名前と未設置（`analyticsLastSeenAt === null`）は `site.read` が要る。
  // 無ければ名前は ID で出し、「未計測」は添えない。
  const siteNames = new Map(sites.map((site) => [site.id, site.name]));
  const trackedSites =
    canReadCampaigns && canReadSites && campaigns.length > 0
      ? await listTrackedSites(context, {})
      : [];
  const untrackedSiteIds = new Set(
    trackedSites.filter((site) => site.analyticsLastSeenAt === null).map((site) => site.id),
  );
  for (const site of trackedSites) {
    if (!siteNames.has(site.id)) {
      siteNames.set(site.id, site.name);
    }
  }

  // 紐づく投稿は全キャンペーンぶんをまとめて引く（1 件ずつ引くと件数分の往復になる）。
  const campaignPosts: readonly SocialPost[] =
    canReadSocial && campaigns.length > 0
      ? await listSocialPostsByIds(context, {
          ids: [...new Set(campaigns.flatMap((campaign) => campaign.socialPostIds))],
        })
      : [];
  const postById = new Map(campaignPosts.map((post) => [post.id, post]));

  const campaignRows: readonly ActiveCampaignRow[] = campaigns.map((campaign) => {
    const sum = (bySite: ReadonlyMap<string, { pageviews: number }>): number =>
      campaign.siteIds.reduce((total, siteId) => total + (bySite.get(siteId)?.pageviews ?? 0), 0);
    const pageviews = sum(currentBySite);
    const linkedPosts = campaign.socialPostIds
      .map((id) => postById.get(id))
      .filter((post): post is SocialPost => post !== undefined);
    const counts = countPostsByStatus(linkedPosts);

    return {
      id: campaign.id,
      name: campaign.name,
      startsOn: campaign.startsOn,
      endsOn: campaign.endsOn,
      siteNames: campaign.siteIds.map((siteId) => siteNames.get(siteId) ?? siteId),
      untrackedCount: campaign.siteIds.filter((siteId) => untrackedSiteIds.has(siteId)).length,
      progress: campaignProgress(campaign.startsOn, campaign.endsOn, today),
      pageviews,
      delta: delta(pageviews, sum(previousBySite)),
      posts: canReadSocial
        ? { published: counts.published, scheduled: counts.scheduled, failed: counts.failed }
        : null,
    };
  });

  const activities = canReadAudit ? await listRecentActivities(context, { limit: 10 }) : [];

  const formatDateTime = (value: Date): string => formatDateTimeInTimeZone(value, timeZone);

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ marginTop: 0 }}>ダッシュボード</h1>

      <ExtensionPoint point="dashboard.before" permissions={permissions} context={context} />

      <div style={{ display: 'grid', gap: 'var(--tf-space-6)' }}>
        {canReadAnalytics ? (
          <AccessOverview
            from={from}
            to={today}
            pageviews={{
              value: current.pageviews,
              delta: delta(current.pageviews, previous.pageviews),
            }}
            visitors={{
              value: current.visitors,
              delta: delta(current.visitors, previous.visitors),
            }}
            bounceRate={{
              value: current.bounceRate,
              // 直帰率だけ「下がると良い」（設計 §7.3.5）。
              delta: deltaPt(current.bounceRate, previous.bounceRate, true),
            }}
            socialPosts={canReadSocial ? { total: posts.total, published: publishedTotal } : null}
            daily={daily}
            sites={canReadSites ? siteRows : null}
          />
        ) : (
          <Card>
            <p style={{ margin: 0 }}>
              とりふねへログインしています。左のメニューから機能を選んでください。
            </p>
          </Card>
        )}

        {canReadCampaigns && <ActiveCampaigns campaigns={campaignRows} />}

        <div
          style={{
            display: 'grid',
            // 狭い画面では 1 列に畳む。下限を固定値だけにすると、それより狭い画面で横にはみ出す。
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(20rem, 100%), 1fr))',
            gap: 'var(--tf-space-6)',
            alignItems: 'start',
          }}
        >
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
      </div>

      {/* Plugin の Widget。何が入るかは本体が知らない（03_プラグイン設計.md §9）。 */}
      <PluginWidgets location="dashboard" permissions={permissions} context={context} />

      <ExtensionPoint point="dashboard.after" permissions={permissions} context={context} />
    </AppShell>
  );
}
