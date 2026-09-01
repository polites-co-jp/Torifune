import { listPlugins } from '@/application/plugin/plugin-use-cases';
import { AppShell } from '@/ui/layout/app-shell';
import { PluginManager, type PluginManagerTab } from '@/ui/plugin/plugin-manager';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * Plugin管理画面（012-plugin-manager、020-plugin-registry）。
 *
 * 読み取りは Server Component から UseCase を直接呼ぶ（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 *
 * **Registry の一覧はここで取らない。** 外部への取得を伴うため、
 * 画面を開くたびに配布元を叩くことになる。Registry タブを選んだときに
 * `/api/v1/plugins/registry` から取る。
 */
function toTab(value: string | string[] | undefined): PluginManagerTab {
  return value === 'registry' ? 'registry' : 'installed';
}

export default async function PluginsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
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
        tab={toTab(params['tab'])}
      />
    </AppShell>
  );
}
