import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/api/cookies';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { AppShell } from '@/ui/layout/app-shell';
import { SiteForm } from '@/ui/site/site-form';

export const dynamic = 'force-dynamic';

export default async function NewSitePage() {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const context = await buildAuthorizationContext(cookieStore.get(SESSION_COOKIE)?.value, {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  });

  if (context.identity === null) {
    redirect('/login');
  }
  // 権限が無ければ画面を出さない。ただし本体の認可は API 側にある。
  if (!context.permissions.has('site.write')) {
    notFound();
  }

  return (
    <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
      <SiteForm
        title="Webサイトを追加"
        initial={{ name: '', url: '', description: '', status: 'active' }}
      />
    </AppShell>
  );
}
