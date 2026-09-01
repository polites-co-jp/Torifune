import { notFound } from 'next/navigation';
import { getSocialPost, listSocialAccounts } from '@/application/social/social-use-cases';
import { NotFoundError } from '@/domain/repository';
import { providerLabel } from '@/domain/social/social';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, hasExtensions } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { SocialPostForm } from '@/ui/social/social-post-form';

export const dynamic = 'force-dynamic';

export default async function EditSocialPostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('social.write')) {
    notFound();
  }

  let post;
  try {
    post = await getSocialPost(context, { id });
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  const accounts = await listSocialAccounts(context, { page: 1, perPage: 100, provider: null });

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <SocialPostForm
        title="投稿を編集"
        postId={post.id}
        accounts={accounts.items.map((account) => ({
          id: account.id,
          label: `${account.displayName}（${providerLabel(account.provider)}）`,
        }))}
        initial={{
          socialAccountId: post.socialAccountId,
          body: post.body,
          scheduledAtIso: post.scheduledAt?.toISOString() ?? null,
          status: post.status,
        }}
        // Plugin は編集画面の**脇**に自分の欄を足せる（06_画面設計.md §26）。
        // `site.edit.sidebar` と対になる、SNSドメイン側の拡張点。
        // フォームは Client Component なので拡張点を自分で描けない。
        // ここ（Server Component）で描いたものを渡す。
        // **描くものがあるときだけ渡す。** 常に渡すと、Plugin を何も
        // 入れていない環境でも脇の列が確保され、フォームがその分狭くなる。
        sidebar={
          hasExtensions('social.edit.sidebar', permissions) ? (
            <ExtensionPoint
              point="social.edit.sidebar"
              permissions={permissions}
              context={context}
              props={{ postId: id, socialAccountId: post.socialAccountId }}
            />
          ) : undefined
        }
      />
    </AppShell>
  );
}
