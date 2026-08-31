import type { AuthorizationContext } from '@/application/authorization/authorize';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { withConnection } from '@/application/transaction';
import type { Connection } from '@/database/provider';
import { processState } from '@/infrastructure/process-state';
import type { DependencyCandidate } from './dependencies';
import { discoverPlugins, type DiscoveryProblem } from './loader';
import { enablePlugin, listPluginRecords } from './lifecycle';
import { reconcileOperations } from './reconcile';
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

/** 起動状態もプロセスに1つ。理由は `process-state.ts`。 */
interface BootState {
  promise: Promise<BootResult> | null;
}

const bootState = processState<BootState>('runtime.boot', () => ({ promise: null }));

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
    // 再ビルドを跨いだ操作の成否をここで判定する。
    // 判定しないと、画面が「再ビルド中」のまま止まる。
    await reconcileOperations({
      connection,
      builtPluginIds: new Set(discovery.plugins.map((entry) => entry.manifest.id)),
    });

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
  bootState.promise ??= boot(authorization);
  return bootState.promise;
}

/** テストと、Plugin の有効・無効を切り替えた直後に使う。 */
export function resetPluginRuntime(): void {
  bootState.promise = null;
  resetPluginRegistry();
}

/**
 * 認証を通す前に Plugin を起動する。
 *
 * **認証方式を差し替える Plugin は、最初のログインより前に起動していなければ
 * 意味を持たない。** 起動していなければ `getAuthenticationProvider()` は
 * 標準認証を返し、差し替えたはずの Provider を誰も通らない。
 *
 * **匿名の認可文脈で起動する。** `activate()` が受け取る Data API は
 * 権限を1つも持たない。認証済みの誰かの権限で起動するより安全であり、
 * 「最初に画面を開いた人が誰か」で Plugin の起動条件が変わることも無くなる。
 * 画面の描画に使う Data API は、そのつど見ている人の権限で作り直される
 * （`ui/plugin/plugin-slot.tsx`）。
 */
export async function ensurePluginsStartedAnonymously(): Promise<BootResult> {
  if (bootState.promise !== null) {
    return bootState.promise;
  }

  const authorization = await buildAuthorizationContext(undefined, {
    ipAddress: null,
    userAgent: null,
  });
  return ensurePluginsStarted(authorization);
}
