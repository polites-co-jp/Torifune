import { analyticsTimeZone } from '@/application/analytics/timezone';
import { todayInTimeZone } from '@/domain/analytics/day';
import { listAnalytics } from '@/application/analytics/analytics-use-cases';
import { getCampaign } from '@/application/campaign/campaign-use-cases';
import { listSites } from '@/application/site/site-use-cases';
import { listSocialPostsByIds } from '@/application/social/social-use-cases';
import {
  analysisRange,
  countPostsByStatus,
  summarizeBySite,
} from '@/domain/campaign/campaign-analysis';
import { CampaignAnalytics, type CampaignPostRow } from '@/ui/campaign/campaign-analytics';
import { campaignStatusLabel } from '@/ui/campaign/labels';
import { postExcerpt } from '@/ui/campaign/post-options';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/** 集計と同じ境目で「今日」を返す（`application/analytics/timezone.ts`）。 */
function today(): string {
  return todayInTimeZone(analyticsTimeZone());
}

/**
 * キャンペーンの分析（06_画面設計.md §14）。
 *
 * **新しい集計テーブルを作らない。** 既存の `listAnalytics` と
 * SNS の UseCase を組み合わせて出す（026-screen-completion 設計 §3.2）。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */
export default async function CampaignAnalyticsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('campaign.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const campaign = await getCampaign(context, { id });
  const range = analysisRange(campaign.startsOn, campaign.endsOn, today());

  const canReadAnalytics = permissions.has('analytics.read');
  const canReadSocial = permissions.has('social.read');

  // サイト名は site.read が要る。無ければ ID で出す
  // （数字は出せるのに、どのサイトのものか分からない状態にはしない）。
  const siteNames = new Map<string, string>();
  if (permissions.has('site.read')) {
    const sites = await listSites(context, {
      page: 1,
      perPage: 200,
      status: null,
      keyword: null,
      sort: [{ field: 'name', direction: 'asc' }],
    });
    for (const site of sites.items) {
      siteNames.set(site.id, site.name);
    }
  }

  // サイトごとに引く。`listAnalytics` は siteId を1つしか受けないため。
  // 対象サイトは多くて数件で、1件ずつでも往復は増えない。
  const points = canReadAnalytics
    ? (
        await Promise.all(
          campaign.siteIds.map((siteId) =>
            listAnalytics(context, {
              siteId,
              from: range.from,
              to: range.to,
              source: null,
            }),
          ),
        )
      ).flat()
    : [];

  const summary = summarizeBySite(points);
  const siteRows = campaign.siteIds.map((siteId) => ({
    id: siteId,
    name: siteNames.get(siteId) ?? siteId,
    pageviews: summary.get(siteId)?.pageviews ?? 0,
    visitors: summary.get(siteId)?.visitors ?? 0,
  }));

  const posts = canReadSocial
    ? await listSocialPostsByIds(context, { ids: campaign.socialPostIds })
    : [];

  const postRows: readonly CampaignPostRow[] = posts.map((post) => ({
    id: post.id,
    excerpt: postExcerpt(post.body),
    status: post.status,
    // 配信済みなら配信時刻、失敗なら失敗時刻。まだ結果が無ければ空。
    resultAt: (post.publishedAt ?? post.failedAt)?.toISOString() ?? null,
    failureReason: post.failureReason,
  }));

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <CampaignAnalytics
        campaignId={campaign.id}
        name={campaign.name}
        statusLabel={campaignStatusLabel(campaign.status)}
        startsOn={campaign.startsOn}
        endsOn={campaign.endsOn}
        from={range.from}
        to={range.to}
        truncated={range.truncated}
        sites={siteRows}
        posts={postRows}
        postCounts={countPostsByStatus(posts)}
        canReadAnalytics={canReadAnalytics}
        canReadSocial={canReadSocial}
      />
    </AppShell>
  );
}
