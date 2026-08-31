import { listSocialAccounts, listSocialPosts } from '@/application/social/social-use-cases';
import { providerLabel } from '@/domain/social/social';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { SocialAccounts } from '@/ui/social/social-accounts';
import { SocialPosts } from '@/ui/social/social-posts';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * SNS画面（06_画面設計.md §13）。
 *
 * アカウントと投稿を1枚に並べる。**読み取りは Server Component から
 * UseCase を直接呼ぶ**（決定事項 D-06）。認可は UseCase 側で行われる。
 */
export default async function SocialPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('social.read')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const postPage = Math.max(1, Number(params['postPage'] ?? 1) || 1);
  const postPerPage = 20;

  const accounts = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });
  const posts = await listSocialPosts(context, {
    page: postPage,
    perPage: postPerPage,
    socialAccountId: null,
    status: null,
  });

  // 投稿一覧はアカウントIDではなく人が読める名前で出す。
  const accountNames = Object.fromEntries(
    accounts.items.map((account) => [
      account.id,
      `${account.displayName}（${providerLabel(account.provider)}）`,
    ]),
  );

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <ExtensionPoint point="social.list.actions" permissions={permissions} context={context} />
      <SocialAccounts
        initialAccounts={accounts.items.map((account) => ({
          id: account.id,
          provider: account.provider,
          displayName: account.displayName,
          handle: account.handle,
          status: account.status,
          credentialConfigured: account.credentialConfigured,
        }))}
        permissions={[...permissions]}
      />
      <SocialPosts
        initialPosts={posts.items.map((post) => ({
          id: post.id,
          socialAccountId: post.socialAccountId,
          body: post.body,
          scheduledAt: post.scheduledAt?.toISOString() ?? null,
          status: post.status,
          publishedAt: post.publishedAt?.toISOString() ?? null,
        }))}
        accountNames={accountNames}
        total={posts.total}
        page={postPage}
        perPage={postPerPage}
        permissions={[...permissions]}
      />
    </AppShell>
  );
}
