import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/api/cookies';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { listSites } from '@/application/site/site-use-cases';
import { AppShell } from '@/ui/layout/app-shell';
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
  const cookieStore = await cookies();
  const headerStore = await headers();
  const params = await searchParams;

  const context = await buildAuthorizationContext(cookieStore.get(SESSION_COOKIE)?.value, {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  });

  if (context.identity === null) {
    redirect('/login');
  }

  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  const permissions = [...context.permissions];

  if (!context.permissions.has('site.read')) {
    return (
      <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
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
    <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
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
        permissions={permissions}
      />
    </AppShell>
  );
}
