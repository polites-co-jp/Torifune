import { notFound } from 'next/navigation';
import { getPluginSettingsPage } from '@/application/plugin/plugin-settings-use-cases';
import { NotFoundError } from '@/domain/repository';
import { PluginSettingsHelp } from '@/ui/help/plugin-settings-help';
import { AppShell } from '@/ui/layout/app-shell';
import { PluginSettingsForm } from '@/ui/plugin/plugin-settings-form';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * Plugin の設定画面（06_画面設計.md §27）。
 *
 * **catch-all より優先される。** Next.js はより具体的なルートを先に選ぶ。
 * Plugin が `/plugins/<id>/settings` を自分で登録していても、こちらが出る。
 *
 * 読み込まれた Plugin が**設定か手順書の少なくとも一方**を持つときに出る
 * （041-plugin-help-docs 設計 §7.5）。手順書の一覧を設定のフォームより上に置く。
 */
export default async function PluginSettingsPage({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('plugin.manage')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  let view;
  try {
    view = await getPluginSettingsPage(context, { pluginId });
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  const { settings } = view;

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>{view.pluginName}</h1>
      <PluginSettingsHelp helpDocs={view.helpDocs} hasSettings={settings !== null} />
      {settings !== null && (
        <PluginSettingsForm
          pluginId={settings.pluginId}
          pluginName={settings.pluginName}
          fields={settings.fields.map((field) => ({ ...field }))}
        />
      )}
    </AppShell>
  );
}
