import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import {
  isRegisteredPermission,
  registerPermission,
  unregisterPermissionsOf,
} from '@/application/authorization/permission-registry';
import { uuidv7 } from 'uuidv7';
import type { Connection } from '@/database/provider';
import { authAuditRepository } from '@/infrastructure/auth-audit-repository';
import { log } from '@/infrastructure/logging';
import { buildPluginContext } from './context';
import { checkDependencies, dependentsOf, type DependencyCandidate } from './dependencies';
import { registerLoadedPlugin, unregisterPlugin } from './registry';

/**
 * Plugin のライフサイクル（03_プラグイン設計.md §12）。
 *
 * ```text
 * （ファイルがある） ──install──→ installed ──enable──→ enabled
 *                                     ▲                  │
 *                                     └─────disable──────┘
 * ```
 *
 * **`plugins` に行が無い Plugin は動かない。**
 * ファイルを置いただけで勝手に動くと、意図しないコードが実行される。
 */

export type PluginStatus = 'installed' | 'enabled' | 'disabled';

export interface PluginRecord {
  readonly id: string;
  readonly version: string;
  readonly status: PluginStatus;
  /** `install()` を呼んだ時刻。null なら未実行（020-plugin-registry 設計 §2.5）。 */
  readonly installedHookAt: Date | null;
}

export type EnableOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export async function listPluginRecords(connection: Connection): Promise<readonly PluginRecord[]> {
  const rows = await connection.db
    .selectFrom('plugins')
    .select(['id', 'version', 'status', 'installed_hook_at'])
    .orderBy('id')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    status: row.status as PluginStatus,
    installedHookAt: row.installed_hook_at,
  }));
}

export async function findPluginRecord(
  connection: Connection,
  pluginId: string,
): Promise<PluginRecord | null> {
  const row = await connection.db
    .selectFrom('plugins')
    .select(['id', 'version', 'status', 'installed_hook_at'])
    .where('id', '=', pluginId)
    .executeTakeFirst();

  return row === undefined
    ? null
    : {
        id: row.id,
        version: row.version,
        status: row.status as PluginStatus,
        installedHookAt: row.installed_hook_at,
      };
}

/** 導入する。既に導入済みなら版だけ更新する。 */
export async function installPlugin(
  connection: Connection,
  manifest: PluginManifest,
): Promise<void> {
  await connection.db
    .insertInto('plugins')
    .values({ id: manifest.id, version: manifest.version, status: 'installed' })
    .onConflict((oc) =>
      // 二重に導入しても行が増えない。状態は変えない
      // （有効なものを導入し直して勝手に無効化されると困る）。
      oc.column('id').doUpdateSet({ version: manifest.version, updated_at: new Date() }),
    )
    .execute();
}

async function setStatus(
  connection: Connection,
  pluginId: string,
  status: PluginStatus,
): Promise<void> {
  await connection.db
    .updateTable('plugins')
    .set({
      status,
      updated_at: new Date(),
      ...(status === 'enabled' ? { enabled_at: new Date() } : {}),
    })
    .where('id', '=', pluginId)
    .execute();
}

export interface EnableDeps {
  readonly connection: Connection;
  readonly manifest: PluginManifest;
  readonly plugin: Plugin;
  readonly authorization: AuthorizationContext;
  /** 導入済みの Plugin（依存の検証に使う）。 */
  readonly candidates: ReadonlyMap<string, DependencyCandidate>;
}

/**
 * 有効化する。
 *
 * 依存を満たさなければ有効化しない。
 * **`activate` が例外を投げたら `disabled` へ落とす。**
 * 本体が起動できなくなるより、その Plugin を止めるほうがよい。
 */
export async function enablePlugin(deps: EnableDeps): Promise<EnableOutcome> {
  const { connection, manifest, plugin, authorization, candidates } = deps;

  const problems = checkDependencies(manifest.id, candidates);
  if (problems.length > 0) {
    const first = problems[0];
    const reason =
      first?.kind === 'cycle'
        ? `依存が循環している: ${first.pluginIds.join(' → ')}`
        : first?.kind === 'missing'
          ? `依存 Plugin が導入されていない: ${first.dependsOn}`
          : first?.kind === 'disabled'
            ? `依存 Plugin が無効: ${first.dependsOn}`
            : first?.kind === 'version_mismatch'
              ? `依存 Plugin のバージョンが範囲外: ${first.dependsOn} ${first.actual}（要求 ${first.required}）`
              : '依存を満たしていない';
    return { ok: false, reason };
  }

  registerLoadedPlugin({ manifest, plugin });

  // Plugin が宣言した Permission を登録する。
  for (const permission of manifest.permissions ?? []) {
    if (isRegisteredPermission(permission)) {
      // 本体の Permission を宣言している場合。登録し直さない。
      continue;
    }
    try {
      registerPermission({
        name: permission,
        displayName: permission,
        description: `${manifest.name} が要求`,
        owner: manifest.id,
      });
    } catch (error) {
      // **握り潰さない。** 握り潰すと、Plugin が権限を持たないまま
      // 有効化され、あとで分かりにくい失敗をする。
      unregisterPermissionsOf(manifest.id);
      await setStatus(connection, manifest.id, 'disabled');
      return {
        ok: false,
        reason: `Permission を登録できない: ${permission}（${
          error instanceof Error ? error.message : String(error)
        }）`,
      };
    }
  }

  // **`install()` は導入後の最初の有効化の直前に1度だけ呼ぶ**（設計 §2.5）。
  //
  // 導入は再ビルドを伴うため、導入の瞬間には Plugin のコードをまだ読み込めない。
  // 読み込めるようになるのは再ビルド後の起動から。
  const record = await findPluginRecord(connection, manifest.id);
  if (record !== null && record.installedHookAt === null) {
    try {
      await plugin.install?.(buildPluginContext({ manifest, connection, authorization }));
    } catch (error) {
      // **初期化に失敗した Plugin を動かさない。** 動かすと、あとで
      // 分かりにくい失敗をする。
      unregisterPlugin(manifest.id);
      unregisterPermissionsOf(manifest.id);
      await setStatus(connection, manifest.id, 'disabled');
      return {
        ok: false,
        reason: `初期化に失敗した: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    await connection.db
      .updateTable('plugins')
      .set({ installed_hook_at: new Date() })
      .where('id', '=', manifest.id)
      .execute();
  }

  try {
    await plugin.activate(buildPluginContext({ manifest, connection, authorization }));
  } catch (error) {
    // 有効化に失敗した Plugin を放置すると、壊れたまま動いているように見える。
    unregisterPlugin(manifest.id);
    unregisterPermissionsOf(manifest.id);
    await setStatus(connection, manifest.id, 'disabled');
    return {
      ok: false,
      reason: `有効化に失敗した: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  await setStatus(connection, manifest.id, 'enabled');

  // Plugin の有効化は、本体の Permission 集合と認証方式を変えうる。
  // Plugin の有効化ログだけでは弱いので、独立した事象として残す
  // （04_認証設計.md §26、015b-settings 設計 §3.4 §3.5）。
  await recordSecurityChanges(connection, manifest, authorization, 'enabled');

  return { ok: true };
}

/** Permission と認証方式の変化を監査ログへ残す。 */
async function recordSecurityChanges(
  connection: Connection,
  manifest: PluginManifest,
  authorization: AuthorizationContext,
  change: 'enabled' | 'disabled',
): Promise<void> {
  const userId = authorization.identity?.userId ?? null;
  const base = {
    userId,
    loginIdAttempted: null,
    ipAddress: authorization.request?.ipAddress ?? null,
    userAgent: authorization.request?.userAgent ?? null,
  };

  try {
    if ((manifest.permissions ?? []).length > 0) {
      await authAuditRepository.record(connection, {
        ...base,
        id: uuidv7(),
        event: 'permission.changed',
        detail: {
          pluginId: manifest.id,
          change,
          permissions: [...(manifest.permissions ?? [])],
        },
      });
    }

    if ((manifest.extensions ?? []).includes('authentication')) {
      await authAuditRepository.record(connection, {
        ...base,
        id: uuidv7(),
        event: 'auth.provider.changed',
        detail: { pluginId: manifest.id, change },
      });
    }
  } catch (error) {
    // 記録の失敗で有効化・無効化そのものを止めない。
    // 止めると、壊れた Plugin を外せなくなる。
    log.warn('failed to record security audit for plugin', {
      pluginId: manifest.id,
      change,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface DisableDeps {
  readonly connection: Connection;
  readonly manifest: PluginManifest;
  readonly plugin: Plugin;
  readonly authorization: AuthorizationContext;
  readonly candidates: ReadonlyMap<string, DependencyCandidate>;
}

/**
 * 無効化する。
 *
 * **依存されている Plugin を無効化したら、依存元も無効化する。**
 * 依存先が消えたまま動くと、Plugin が実行時に壊れる。
 */
export async function disablePlugin(deps: DisableDeps): Promise<readonly string[]> {
  const { connection, manifest, plugin, authorization, candidates } = deps;
  const disabled: string[] = [];

  // 依存元を先に無効化する。
  for (const dependentId of dependentsOf(manifest.id, candidates)) {
    const dependent = candidates.get(dependentId);
    if (dependent === undefined || !dependent.enabled) {
      continue;
    }
    unregisterPlugin(dependentId);
    unregisterPermissionsOf(dependentId);
    await setStatus(connection, dependentId, 'disabled');
    disabled.push(dependentId);
  }

  try {
    await plugin.deactivate?.(buildPluginContext({ manifest, connection, authorization }));
  } catch {
    // 後始末の失敗で無効化そのものを止めない。
    // 止めると、壊れた Plugin を外せなくなる。
  }

  unregisterPlugin(manifest.id);
  unregisterPermissionsOf(manifest.id);
  await setStatus(connection, manifest.id, 'disabled');
  disabled.push(manifest.id);

  await recordSecurityChanges(connection, manifest, authorization, 'disabled');

  return disabled;
}

/**
 * 削除する。**Plugin のデータを消すかは呼び出し側が決める**（03 §12.5）。
 *
 * `uninstall()` フックはここで呼ぶ。削除の時点では Plugin のコードが
 * 読み込まれている（有効化されていたか、少なくとも読み込み済み）ので、
 * `install()` と違って先送りする必要が無い。
 */
export async function uninstallPlugin(
  connection: Connection,
  pluginId: string,
  options: {
    readonly deleteData: boolean;
    /** 後始末のための文脈。読み込まれていない Plugin では省略される。 */
    readonly hook?: {
      readonly manifest: PluginManifest;
      readonly plugin: Plugin;
      readonly authorization: AuthorizationContext;
    };
  },
): Promise<void> {
  if (options.hook !== undefined) {
    try {
      await options.hook.plugin.uninstall?.(
        buildPluginContext({
          manifest: options.hook.manifest,
          connection,
          authorization: options.hook.authorization,
        }),
      );
    } catch (error) {
      // **後始末の失敗で削除そのものを止めない。**
      // 止めると、壊れた Plugin を外せなくなる（disable と同じ扱い）。
      log.warn('plugin uninstall hook failed', {
        pluginId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  unregisterPlugin(pluginId);
  unregisterPermissionsOf(pluginId);

  await connection.transaction(async (tx) => {
    if (options.deleteData) {
      await tx.db.deleteFrom('plugin_store').where('plugin_id', '=', pluginId).execute();
    }
    await tx.db.deleteFrom('plugins').where('id', '=', pluginId).execute();
  });
}
