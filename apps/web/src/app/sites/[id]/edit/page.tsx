import { notFound } from 'next/navigation';
import { getSite } from '@/application/site/site-use-cases';
import { NotFoundError } from '@/domain/repository';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, hasExtensions } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { SiteForm } from '@/ui/site/site-form';

export const dynamic = 'force-dynamic';

export default async function EditSitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('site.write')) {
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
    <AppShell displayName={displayName} permissions={permissions}>
      <SiteForm
        title="Webサイトを編集"
        siteId={site.id}
        initial={{
          name: site.name,
          url: site.url,
          description: site.description,
          status: site.status,
        }}
        // Plugin は編集画面の**脇**に自分の欄を足せる（06_画面設計.md §26）。
        // フォームは Client Component なので拡張点を自分で描けない。
        // ここ（Server Component）で描いたものを渡す。
        // **描くものがあるときだけ渡す。** 常に渡すと、Plugin を何も
        // 入れていない環境でも脇の列が確保され、フォームがその分狭くなる。
        sidebar={
          hasExtensions('site.edit.sidebar', permissions) ? (
            <ExtensionPoint
              point="site.edit.sidebar"
              permissions={permissions}
              context={context}
              props={{ siteId: id }}
            />
          ) : undefined
        }
      />
    </AppShell>
  );
}
