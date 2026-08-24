import { listSocialAccounts } from '@/application/social/social-use-cases';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { SocialAccounts } from '@/ui/social/social-accounts';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

export default async function SocialPage() {
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('social.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const page = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <ExtensionPoint point="social.list.actions" permissions={permissions} />
      <SocialAccounts
        initialAccounts={page.items.map((account) => ({
          id: account.id,
          provider: account.provider,
          displayName: account.displayName,
          handle: account.handle,
          status: account.status,
          credentialConfigured: account.credentialConfigured,
        }))}
        permissions={[...permissions]}
      />
    </AppShell>
  );
}
