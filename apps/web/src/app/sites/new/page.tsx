import { notFound } from 'next/navigation';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';
import { SiteForm } from '@/ui/site/site-form';

export const dynamic = 'force-dynamic';

export default async function NewSitePage() {
  const { displayName, permissions } = await requirePageSession();

  // 権限が無ければ画面を出さない。ただし本体の認可は UseCase 側にある。
  if (!permissions.has('site.write')) {
    notFound();
  }

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <SiteForm
        title="Webサイトを追加"
        initial={{ name: '', url: '', description: '', status: 'active' }}
      />
    </AppShell>
  );
}
