import { getCampaign } from '@/application/campaign/campaign-use-cases';
import { listSites } from '@/application/site/site-use-cases';
import { CampaignForm } from '@/ui/campaign/campaign-form';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

export default async function EditCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('campaign.write')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const campaign = await getCampaign(context, { id });

  const sites = permissions.has('site.read')
    ? await listSites(context, {
        page: 1,
        perPage: 100,
        status: null,
        keyword: null,
        sort: [{ field: 'name', direction: 'asc' }],
      })
    : { items: [], total: 0 };

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <CampaignForm
        title="キャンペーンの編集"
        campaignId={campaign.id}
        sites={sites.items.map((site) => ({ id: site.id, name: site.name }))}
        initial={{
          name: campaign.name,
          description: campaign.description,
          status: campaign.status,
          startsOn: campaign.startsOn,
          endsOn: campaign.endsOn,
          siteIds: campaign.siteIds,
        }}
      />
      <ExtensionPoint point="campaign.edit.sidebar" permissions={permissions} context={context} />
    </AppShell>
  );
}
