import { listSites } from '@/application/site/site-use-cases';
import { CampaignForm } from '@/ui/campaign/campaign-form';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/** 今日を `YYYY-MM-DD` で返す。開始日の既定にする。 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function NewCampaignPage() {
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('campaign.write')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  // サイトを選ばせるために一覧が要る。権限が無ければ選択肢を出さない。
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
        title="キャンペーンの新規作成"
        sites={sites.items.map((site) => ({ id: site.id, name: site.name }))}
        initial={{
          name: '',
          description: '',
          status: 'draft',
          startsOn: today(),
          endsOn: null,
          siteIds: [],
        }}
      />
    </AppShell>
  );
}
