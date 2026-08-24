import { listPlugins } from '@/application/plugin/plugin-use-cases';
import { AppShell } from '@/ui/layout/app-shell';
import { PluginManager } from '@/ui/plugin/plugin-manager';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * Plugin管理画面（012-plugin-manager）。
 *
 * 読み取りは Server Component から UseCase を直接呼ぶ（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */
export default async function PluginsPage() {
  const { context, displayName, permissions } = await requirePageSession();

  if (!permissions.has('plugin.manage')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const result = await listPlugins(context, undefined);

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <PluginManager
        installed={result.installed.map((plugin) => ({ ...plugin }))}
        detected={result.detected.map((plugin) => ({ ...plugin }))}
        problems={result.problems.map((problem) => ({ ...problem }))}
        operations={result.operations.map((operation) => ({
          id: operation.id,
          pluginId: operation.pluginId,
          kind: operation.kind,
          status: operation.status,
          message: operation.message,
          startedAt: operation.startedAt.toISOString(),
          finishedAt: operation.finishedAt?.toISOString() ?? null,
        }))}
        canSelfRestart={result.canSelfRestart}
      />
    </AppShell>
  );
}
