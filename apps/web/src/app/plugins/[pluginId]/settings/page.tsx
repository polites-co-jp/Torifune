import { notFound } from 'next/navigation';
import { getPluginSettings } from '@/application/plugin/plugin-settings-use-cases';
import { NotFoundError } from '@/domain/repository';
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

  let settings;
  try {
    settings = await getPluginSettings(context, { pluginId });
  } catch (error) {
    if (error instanceof NotFoundError) {
      notFound();
    }
    throw error;
  }

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>{settings.pluginName}</h1>
      <PluginSettingsForm
        pluginId={settings.pluginId}
        pluginName={settings.pluginName}
        fields={settings.fields.map((field) => ({ ...field }))}
      />
    </AppShell>
  );
}
