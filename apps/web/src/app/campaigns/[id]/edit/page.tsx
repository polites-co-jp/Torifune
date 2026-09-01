import { getCampaign } from '@/application/campaign/campaign-use-cases';
import { listSites } from '@/application/site/site-use-cases';
import { listSocialPosts } from '@/application/social/social-use-cases';
import { CampaignForm } from '@/ui/campaign/campaign-form';
import { postOptions } from '@/ui/campaign/post-options';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, hasExtensions } from '@/ui/plugin/plugin-slot';
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

  const posts = permissions.has('social.read')
    ? await listSocialPosts(context, {
        page: 1,
        perPage: 100,
        socialAccountId: null,
        status: null,
      })
    : { items: [], total: 0 };

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <CampaignForm
        title="キャンペーンの編集"
        campaignId={campaign.id}
        sites={sites.items.map((site) => ({ id: site.id, name: site.name }))}
        socialPosts={postOptions(posts.items)}
        initial={{
          name: campaign.name,
          description: campaign.description,
          status: campaign.status,
          startsOn: campaign.startsOn,
          endsOn: campaign.endsOn,
          siteIds: campaign.siteIds,
          socialPostIds: campaign.socialPostIds,
        }}
        // Plugin は編集画面の**脇**に自分の欄を足せる（06_画面設計.md §26）。
        // フォームは Client Component なので拡張点を自分で描けない。
        // ここ（Server Component）で描いたものを渡す。
        // **描くものがあるときだけ渡す。** 常に渡すと、Plugin を何も
        // 入れていない環境でも脇の列が確保され、フォームがその分狭くなる。
        sidebar={
          hasExtensions('campaign.edit.sidebar', permissions) ? (
            <ExtensionPoint
              point="campaign.edit.sidebar"
              permissions={permissions}
              context={context}
              props={{ campaignId: id }}
            />
          ) : undefined
        }
      />
    </AppShell>
  );
}
