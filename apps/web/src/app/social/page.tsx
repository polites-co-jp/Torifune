import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/api/cookies';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { listSocialAccounts } from '@/application/social/social-use-cases';
import { AppShell } from '@/ui/layout/app-shell';
import { SocialAccounts } from '@/ui/social/social-accounts';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

export default async function SocialPage() {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const context = await buildAuthorizationContext(cookieStore.get(SESSION_COOKIE)?.value, {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  });

  if (context.identity === null) {
    redirect('/login');
  }

  if (!context.permissions.has('social.read')) {
    return (
      <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const page = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });

  return (
    <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
      <SocialAccounts
        initialAccounts={page.items.map((account) => ({
          id: account.id,
          provider: account.provider,
          displayName: account.displayName,
          handle: account.handle,
          status: account.status,
          credentialConfigured: account.credentialConfigured,
        }))}
        permissions={[...context.permissions]}
      />
    </AppShell>
  );
}
