import type { AuthorizationContext } from '@/application/authorization/authorize';
import { withConnection } from '@/application/transaction';
import type { Connection } from '@/database/provider';
import type { DependencyCandidate } from './dependencies';
import { discoverPlugins, type DiscoveryProblem } from './loader';
import { enablePlugin, listPluginRecords } from './lifecycle';
import { isLoaded, resetPluginRegistry } from './registry';

/**
 * Plugin の起動。
 *
 * `plugins/` にあり、かつ **DB で `enabled` になっている**ものだけを動かす。
 * ファイルを置いただけで勝手に動くと、意図しないコードが実行される。
 *
 * **1度だけ実行する。** リクエストごとに `activate` を呼ぶと、
 * 登録が積み重なってメニューが増殖する。
 */

let bootPromise: Promise<BootResult> | null = null;

export interface BootResult {
  readonly enabled: readonly string[];
  readonly failed: readonly { pluginId: string; reason: string }[];
  readonly problems: readonly DiscoveryProblem[];
}

async function boot(authorization: AuthorizationContext): Promise<BootResult> {
  const discovery = discoverPlugins();
  const enabled: string[] = [];
  const failed: { pluginId: string; reason: string }[] = [];

  await withConnection(async (connection: Connection) => {
    const records = await listPluginRecords(connection);
    const statusById = new Map(records.map((record) => [record.id, record.status]));

    // 依存の検証には**導入済みのすべて**を渡す。
    const candidates = new Map<string, DependencyCandidate>(
      discovery.plugins
        .filter((entry) => statusById.has(entry.manifest.id))
        .map((entry) => [
          entry.manifest.id,
          { manifest: entry.manifest, enabled: statusById.get(entry.manifest.id) === 'enabled' },
        ]),
    );

    for (const entry of discovery.plugins) {
      if (statusById.get(entry.manifest.id) !== 'enabled') {
        continue;
      }
      if (isLoaded(entry.manifest.id)) {
        continue;
      }

      const outcome = await enablePlugin({
        connection,
        manifest: entry.manifest,
        plugin: entry.plugin,
        authorization,
        candidates,
      });

      if (outcome.ok) {
        enabled.push(entry.manifest.id);
      } else {
        // 有効化に失敗しても本体は起動する。
        // Plugin ひとつの不具合で Torifune 全体が使えなくなるのは重すぎる。
        failed.push({ pluginId: entry.manifest.id, reason: outcome.reason });
      }
    }
  });

  return { enabled, failed, problems: discovery.problems };
}

/** 有効な Plugin を起動する。すでに起動済みなら何もしない。 */
export async function ensurePluginsStarted(
  authorization: AuthorizationContext,
): Promise<BootResult> {
  bootPromise ??= boot(authorization);
  return bootPromise;
}

/** テストと、Plugin の有効・無効を切り替えた直後に使う。 */
export function resetPluginRuntime(): void {
  bootPromise = null;
  resetPluginRegistry();
}
