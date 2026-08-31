import { notFound } from 'next/navigation';
import { listSocialAccounts } from '@/application/social/social-use-cases';
import { providerLabel } from '@/domain/social/social';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { SocialPostForm } from '@/ui/social/social-post-form';
import { AsyncState } from '@/ui/states/async-state';
import { Button } from '@/ui/components';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function NewSocialPostPage() {
  const { context, displayName, permissions } = await requirePageSession();

  // 権限が無ければ画面を出さない。ただし本体の認可は UseCase 側にある。
  if (!permissions.has('social.write')) {
    notFound();
  }

  const accounts = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });

  // 投稿先が1つも無ければフォームを出しても保存できない。
  // 空の Select を出して 422 にするより、先にアカウントを作らせる。
  if (accounts.items.length === 0) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState
          status="empty"
          emptyMessage="投稿先のSNSアカウントがありません。先にアカウントを登録してください。"
          emptyAction={
            <Link href="/social">
              <Button variant="primary">SNS画面へ</Button>
            </Link>
          }
        >
          {null}
        </AsyncState>
      </AppShell>
    );
  }

  const first = accounts.items[0];

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <SocialPostForm
        title="投稿を作成"
        accounts={accounts.items.map((account) => ({
          id: account.id,
          label: `${account.displayName}（${providerLabel(account.provider)}）`,
        }))}
        initial={{
          socialAccountId: first?.id ?? '',
          body: '',
          scheduledAtIso: null,
          status: 'draft',
        }}
      />
    </AppShell>
  );
}
