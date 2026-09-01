import { listCampaigns } from '@/application/campaign/campaign-use-cases';
import { CampaignList } from '@/ui/campaign/campaign-list';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginActions } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * キャンペーン一覧（06_画面設計.md §14）。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */
export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('campaign.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  const result = await listCampaigns(context, {
    page,
    perPage,
    status: null,
    keyword: null,
    activeOn: null,
    siteId: null,
    sort: [{ field: 'starts_on', direction: 'desc' }],
  });

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <PluginActions location="campaign.list.actions" permissions={permissions} context={context} />
      <ExtensionPoint point="campaign.list.actions" permissions={permissions} context={context} />
      <CampaignList
        initialCampaigns={result.items.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          status: campaign.status,
          startsOn: campaign.startsOn,
          endsOn: campaign.endsOn,
          siteCount: campaign.siteIds.length,
        }))}
        total={result.total}
        page={page}
        perPage={perPage}
        permissions={[...permissions]}
      />
    </AppShell>
  );
}
