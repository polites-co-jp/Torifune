import { notFound } from 'next/navigation';
import { getPluginHelpIndex } from '@/application/plugin/plugin-help-use-cases';
import { NotFoundError } from '@/domain/repository';
import { HelpIndexView } from '@/ui/help/help-document';
import { AppShell } from '@/ui/layout/app-shell';
import { requirePageSession } from '@/ui/server/page-session';

export const dynamic = 'force-dynamic';

/**
 * Plugin の手順書の一覧（041-plugin-help-docs 設計 §7.2・§7.3.1）。
 *
 * **catch-all より優先される**（`settings` と同じ）。Plugin が同じルートを登録していても Core の画面が出る。
 * 認可は UseCase が行う：読み込まれた Plugin は認証済みなら誰でも、読み込まれていない Plugin は
 * `plugin.manage` だけ（持たなければ 404。存在を明かさない）。
 */
export default async function PluginHelpIndexPage({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  let index;
  try {
    index = await getPluginHelpIndex(context, { pluginId });
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <HelpIndexView index={index} canManagePlugins={permissions.has('plugin.manage')} />
    </AppShell>
  );
}
