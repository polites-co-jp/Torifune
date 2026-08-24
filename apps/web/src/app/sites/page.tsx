import { listSites } from '@/application/site/site-use-cases';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginActions } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { SiteList } from '@/ui/site/site-list';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * Webサイト一覧。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */
export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  if (!permissions.has('site.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const result = await listSites(context, {
    page,
    perPage,
    status: null,
    keyword: null,
    sort: [{ field: 'created_at', direction: 'desc' }],
  });

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <PluginActions location="site.list.actions" permissions={permissions} context={context} />
      <ExtensionPoint point="site.list.actions" permissions={permissions} context={context} />
      <SiteList
        initialSites={result.items.map((site) => ({
          id: site.id,
          name: site.name,
          url: site.url,
          status: site.status,
        }))}
        total={result.total}
        page={page}
        perPage={perPage}
        permissions={[...permissions]}
      />
    </AppShell>
  );
}
