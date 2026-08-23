import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/api/cookies';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { getSite } from '@/application/site/site-use-cases';
import { NotFoundError } from '@/domain/repository';
import { AppShell } from '@/ui/layout/app-shell';
import { SiteForm } from '@/ui/site/site-form';

export const dynamic = 'force-dynamic';

export default async function EditSitePage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const { id } = await params;

  const context = await buildAuthorizationContext(cookieStore.get(SESSION_COOKIE)?.value, {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  });

  if (context.identity === null) {
    redirect('/login');
  }
  if (!context.permissions.has('site.write')) {
    notFound();
  }

  let site;
  try {
    site = await getSite(context, { id });
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  return (
    <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
      <SiteForm
        title="Webサイトを編集"
        siteId={site.id}
        initial={{
          name: site.name,
          url: site.url,
          description: site.description,
          status: site.status,
        }}
      />
    </AppShell>
  );
}
