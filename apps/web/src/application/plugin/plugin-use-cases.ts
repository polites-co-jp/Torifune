import { rm } from 'node:fs/promises';
import type { PluginManifest } from '@torifune/plugin-api';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import { trustedKeys, verifyPackage } from '@/domain/plugin/package-signature';
import { isNewerVersion } from '@/domain/plugin/version-order';
import { NotFoundError, ValidationError } from '@/domain/repository';
import type { DependencyCandidate } from '@/plugin/dependencies';
import {
  disablePlugin,
  enablePlugin,
  findPluginRecord,
  installPlugin,
  listPluginRecords,
  uninstallPlugin,
  type PluginStatus,
} from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import {
  findOperation,
  recentOperations,
  startOperation,
  markOperation,
  type PluginOperation,
} from '@/plugin/operations';
import { extractPackage, inspectPackage, PluginPackageError } from '@/plugin/package';
import { pluginDir, pluginsDir } from '@/plugin/paths';
import { canSelfRestart, requestRebuild } from '@/plugin/rebuild';
import {
  fetchPackage,
  fetchRegistryIndex,
  registryUrl,
  searchEntries,
  type RegistryEntry,
} from '@/plugin/registry-client';
import {
  currentTorifuneVersion,
  evaluateRegistryEntry,
  type InstalledPluginState,
  type RegistryCompatibility,
} from '@/plugin/registry-compatibility';
import { isLoaded, loadedPlugin } from '@/plugin/registry';

/**
 * Plugin 管理の UseCase（012-plugin-manager）。
 *
 * **すべて `plugin.manage` を要求する。**
 * Plugin の導入は実質的にアプリへのコード導入にあたるため、
 * サイト運用者に配ってよい権限ではない。
 *
 * 認可は `defineUseCase` が行う（決定事項 D-06）。
 */

export interface PluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** 未導入なら null。 */
  readonly status: PluginStatus | null;
  /** 実際に読み込まれて動いているか。 */
  readonly loaded: boolean;
  readonly permissions: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly description: string | null;
  /**
   * 作者（03_プラグイン設計.md §11 §13）。Manifest の任意項目なので、無ければ null。
   *
   * **誰が作ったものかを画面に出す。** 出さないと、導入の判断材料が1つ減る。
   */
  readonly author: string | null;
}

export interface PluginListOutput {
  readonly installed: readonly PluginSummary[];
  /** `plugins/` にあるが `plugins` テーブルに行が無いもの。 */
  readonly detected: readonly PluginSummary[];
  /** 読み込めなかったもの。**黙って消さない。** */
  readonly problems: readonly { pluginId: string; message: string }[];
  readonly operations: readonly PluginOperation[];
  /** 監視ループのある環境か。画面の案内を変える。 */
  readonly canSelfRestart: boolean;
}

function summarize(manifest: PluginManifest, status: PluginStatus | null): PluginSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    status,
    loaded: isLoaded(manifest.id),
    permissions: manifest.permissions ?? [],
    dependencies: manifest.dependencies ?? {},
    description: manifest.description ?? null,
    // 任意項目。壊れた値が画面へ流れないよう、文字列でなければ無いものとして扱う。
    author:
      typeof manifest.author === 'string' && manifest.author.trim() !== '' ? manifest.author : null,
  };
}

export const listPlugins = defineUseCase<void, PluginListOutput>({
  name: 'plugin.list',
  permission: 'plugin.manage',
  handler: async (context) => {
    const discovery = discoverPlugins();
    const records = await listPluginRecords(context.connection);
    const statusById = new Map(records.map((record) => [record.id, record.status]));

    const installed: PluginSummary[] = [];
    const detected: PluginSummary[] = [];

    for (const entry of discovery.plugins) {
      const status = statusById.get(entry.manifest.id);
      if (status === undefined) {
        detected.push(summarize(entry.manifest, null));
      } else {
        installed.push(summarize(entry.manifest, status));
      }
    }

    // ファイルが消えた Plugin も見せる。行だけ残ると、
    // 一覧に出ないのに削除もできない状態になる。
    const known = new Set(discovery.plugins.map((entry) => entry.manifest.id));
    for (const record of records) {
      if (known.has(record.id)) continue;
      installed.push({
        id: record.id,
        name: record.id,
        version: record.version,
        status: record.status,
        loaded: false,
        permissions: [],
        dependencies: {},
        description: 'ファイルが見つからない',
        author: null,
      });
    }

    return {
      installed,
      detected,
      problems: discovery.problems,
      operations: await recentOperations(context.connection),
      canSelfRestart: canSelfRestart(),
    };
  },
});

function candidates(): Map<string, DependencyCandidate> {
  return new Map();
}

async function candidatesFor(
  context: Parameters<Parameters<typeof defineUseCase>[0]['handler']>[0],
): Promise<Map<string, DependencyCandidate>> {
  const discovery = discoverPlugins();
  const records = await listPluginRecords(context.connection);
  const statusById = new Map(records.map((record) => [record.id, record.status]));

  const result = candidates();
  for (const entry of discovery.plugins) {
    const status = statusById.get(entry.manifest.id);
    if (status === undefined) continue;
    result.set(entry.manifest.id, { manifest: entry.manifest, enabled: status === 'enabled' });
  }
  return result;
}

function requireDiscovered(pluginId: string): { manifest: PluginManifest; plugin: unknown } {
  const entry = discoverPlugins().plugins.find((candidate) => candidate.manifest.id === pluginId);
  if (entry === undefined) {
    throw new NotFoundError('Plugin', pluginId);
  }
  return entry;
}

/**
 * 更新できる版か。
 *
 * **版を下げる更新は許さない**（020-plugin-registry 設計 §2.4）。
 * 下げたい理由があるなら、それは別の要求として設計する。
 */
function assertUpgradable(currentVersion: string, nextVersion: string): void {
  if (!isNewerVersion(nextVersion, currentVersion)) {
    throw new ValidationError(
      'Plugin',
      'version',
      `導入済みの版（${currentVersion}）より新しい版が必要です。指定された版: ${nextVersion}`,
    );
  }
}

export interface EnableResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

export const enablePluginUseCase = defineUseCase<{ pluginId: string }, EnableResult>({
  name: 'plugin.enable',
  permission: 'plugin.manage',
  audit: { action: 'enabled', resourceType: 'plugin', resourceId: (input) => input.pluginId },
  handler: async (context, input) => {
    const entry = requireDiscovered(input.pluginId);
    const record = await findPluginRecord(context.connection, input.pluginId);
    if (record === null) {
      throw new NotFoundError('Plugin', input.pluginId);
    }

    // **有効化では再ビルドしない。** レジストリはすでにビルドに含まれている。
    const outcome = await enablePlugin({
      connection: context.connection,
      manifest: entry.manifest,
      plugin: entry.plugin as Parameters<typeof enablePlugin>[0]['plugin'],
      authorization: context,
      candidates: await candidatesFor(context),
    });

    return outcome.ok ? { ok: true, reason: null } : { ok: false, reason: outcome.reason };
  },
});

export const disablePluginUseCase = defineUseCase<
  { pluginId: string },
  { disabled: readonly string[] }
>({
  name: 'plugin.disable',
  permission: 'plugin.manage',
  audit: {
    action: 'disabled',
    resourceType: 'plugin',
    resourceId: (input) => input.pluginId,
    // 依存元も連鎖して無効化される。何が巻き添えになったかを残す。
    detail: (_input, result) => ({ disabled: result.disabled }),
  },
  handler: async (context, input) => {
    const entry = requireDiscovered(input.pluginId);
    const record = await findPluginRecord(context.connection, input.pluginId);
    if (record === null) {
      throw new NotFoundError('Plugin', input.pluginId);
    }

    const disabled = await disablePlugin({
      connection: context.connection,
      manifest: entry.manifest,
      plugin: entry.plugin as Parameters<typeof disablePlugin>[0]['plugin'],
      authorization: context,
      candidates: await candidatesFor(context),
    });

    return { disabled };
  },
});

export interface InstallResult {
  readonly operationId: string;
  readonly willRestart: boolean;
  readonly message: string;
}

/**
 * 配置済みの Plugin を導入する。
 *
 * ファイルは `plugins/` にある前提。zip の受け取りは `uploadPluginPackage`。
 */
export const installPluginUseCase = defineUseCase<{ pluginId: string }, InstallResult>({
  name: 'plugin.install',
  permission: 'plugin.manage',
  // Plugin の導入は実質的にアプリへコードを入れる操作（CLAUDE.md）。
  // 最も記録が要る操作のひとつ。
  audit: { action: 'installed', resourceType: 'plugin', resourceId: (input) => input.pluginId },
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);
    const entry = requireDiscovered(input.pluginId);

    const existing = await findPluginRecord(context.connection, input.pluginId);
    if (existing !== null) {
      // **同じ ID の新しい版は「更新」として受け入れる**（020-plugin-registry 設計 §2.4）。
      // 拒否したままだと、入れ直す手段が無い（S-8 #4）。
      assertUpgradable(existing.version, entry.manifest.version);
    }

    const operation = await startOperation(context.connection, {
      pluginId: input.pluginId,
      kind: 'install',
      requestedBy: identity.userId,
    });

    await installPlugin(context.connection, entry.manifest);

    const rebuild = await requestRebuild();
    await markOperation(
      context.connection,
      operation.id,
      rebuild.willRestart ? 'restarting' : 'pending',
      rebuild.message,
    );

    return {
      operationId: operation.id,
      willRestart: rebuild.willRestart,
      message: rebuild.message,
    };
  },
});

export interface UploadInspectOutput {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly permissions: readonly string[];
  readonly description: string | null;
}

/**
 * Plugin Package を受け取って**検証だけ**する。
 *
 * **導入はしない。** 要求 Permission を見せてから同意させるため、
 * 展開して Manifest を読む段階と、導入を確定する段階を分ける。
 */
export const inspectPluginPackage = defineUseCase<{ archive: Buffer }, UploadInspectOutput>({
  name: 'plugin.package.inspect',
  permission: 'plugin.manage',
  handler: async (context, input) => {
    let inspected;
    try {
      inspected = await inspectPackage(input.archive);
    } catch (error) {
      if (error instanceof PluginPackageError) {
        throw new ValidationError('Plugin Package', 'archive', error.message);
      }
      throw error;
    }

    const existing = await findPluginRecord(context.connection, inspected.pluginId);
    const loaded = loadedPlugin(inspected.pluginId);
    if (existing !== null || loaded !== null) {
      // 黙って上書きすると、動いている Plugin が入れ替わる。
      // **新しい版なら更新として受け入れる**（020-plugin-registry 設計 §2.4）。
      assertUpgradable(
        existing?.version ?? loaded?.manifest.version ?? '0.0.0',
        inspected.manifest.version,
      );
    }

    return {
      pluginId: inspected.pluginId,
      name: inspected.manifest.name,
      version: inspected.manifest.version,
      permissions: inspected.manifest.permissions ?? [],
      description: inspected.manifest.description ?? null,
    };
  },
});

/**
 * Plugin Package を展開して導入する。
 *
 * 同意したあとに呼ぶ。検証は `inspectPackage` がもう一度行う
 * （**同意の前後で中身が入れ替わっていないことを、こちらで確かめる**）。
 */
export const installPluginPackage = defineUseCase<
  { archive: Buffer; expectedPluginId: string },
  InstallResult
>({
  name: 'plugin.package.install',
  permission: 'plugin.manage',
  audit: {
    action: 'installed',
    resourceType: 'plugin',
    resourceId: (input) => input.expectedPluginId,
    // アップロード経由であることを区別する。配置済みの導入とは経路が違う。
    detail: () => ({ via: 'package' }),
  },
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);

    let inspected;
    try {
      inspected = await inspectPackage(input.archive);
    } catch (error) {
      if (error instanceof PluginPackageError) {
        throw new ValidationError('Plugin Package', 'archive', error.message);
      }
      throw error;
    }

    if (inspected.pluginId !== input.expectedPluginId) {
      // 同意した Plugin と違うものを入れさせない。
      throw new ValidationError('Plugin Package', 'archive', '同意した Plugin と中身が一致しない');
    }

    const existing = await findPluginRecord(context.connection, inspected.pluginId);
    if (existing !== null) {
      // 同じ ID の新しい版は更新として受け入れる。
      // **Plugin のデータ（plugin_store）は消さない。** 消すと設定を入れ直すことになる。
      assertUpgradable(existing.version, inspected.manifest.version);
    }

    const operation = await startOperation(context.connection, {
      pluginId: inspected.pluginId,
      kind: 'install',
      requestedBy: identity.userId,
    });

    try {
      await extractPackage(inspected, { pluginsDir: pluginsDir() });
    } catch (error) {
      await markOperation(
        context.connection,
        operation.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      throw new ValidationError('Plugin Package', 'archive', 'Plugin を配置できなかった');
    }

    await installPlugin(context.connection, inspected.manifest);

    const rebuild = await requestRebuild();
    await markOperation(
      context.connection,
      operation.id,
      rebuild.willRestart ? 'restarting' : 'pending',
      rebuild.message,
    );

    return {
      operationId: operation.id,
      willRestart: rebuild.willRestart,
      message: rebuild.message,
    };
  },
});

export interface UninstallInput {
  readonly pluginId: string;
  /** Plugin が保存したデータも消すか。**既定で消さない。** */
  readonly deleteData: boolean;
  /** 押し間違いを防ぐための確認。Plugin ID と一致させる。 */
  readonly confirm: string;
  /** ファイルごと消すか。false なら「検出済み・未導入」へ戻る。 */
  readonly deleteFiles: boolean;
}

export const uninstallPluginUseCase = defineUseCase<UninstallInput, InstallResult>({
  name: 'plugin.uninstall',
  permission: 'plugin.manage',
  audit: {
    action: 'uninstalled',
    resourceType: 'plugin',
    resourceId: (input) => input.pluginId,
    // データを消したかどうかは、後から復旧できるかを左右する。必ず残す。
    detail: (input) => ({ deleteData: input.deleteData, deleteFiles: input.deleteFiles }),
  },
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);

    if (input.confirm !== input.pluginId) {
      // 押し間違いで消えるものを作らない（06_画面設計.md §37）。
      throw new ValidationError('Plugin', 'confirm', '確認の入力が Plugin ID と一致しない');
    }

    const record = await findPluginRecord(context.connection, input.pluginId);
    if (record === null) {
      throw new NotFoundError('Plugin', input.pluginId);
    }

    // 有効なまま消すと、登録が残ったままになる。先に無効化する。
    if (record.status === 'enabled') {
      const entry = discoverPlugins().plugins.find(
        (candidate) => candidate.manifest.id === input.pluginId,
      );
      if (entry !== undefined) {
        await disablePlugin({
          connection: context.connection,
          manifest: entry.manifest,
          plugin: entry.plugin as Parameters<typeof disablePlugin>[0]['plugin'],
          authorization: context,
          candidates: await candidatesFor(context),
        });
      }
    }

    const operation = await startOperation(context.connection, {
      pluginId: input.pluginId,
      kind: 'uninstall',
      requestedBy: identity.userId,
    });

    // 読み込まれている Plugin なら uninstall() を呼ぶ（03_プラグイン設計.md §12）。
    // 読み込めない（ファイルが壊れている等）なら呼べないが、削除は続ける。
    const loaded = discoverPlugins().plugins.find(
      (candidate) => candidate.manifest.id === input.pluginId,
    );

    await uninstallPlugin(context.connection, input.pluginId, {
      deleteData: input.deleteData,
      ...(loaded === undefined
        ? {}
        : {
            hook: {
              manifest: loaded.manifest,
              plugin: loaded.plugin as Parameters<typeof disablePlugin>[0]['plugin'],
              authorization: context,
            },
          }),
    });

    if (input.deleteFiles) {
      await rm(pluginDir(input.pluginId), { recursive: true, force: true });
    }

    // ファイルを残すなら、ビルド成果物は変わらない。再ビルドは要らない。
    if (!input.deleteFiles) {
      await markOperation(context.connection, operation.id, 'succeeded', 'ファイルは残した');
      return {
        operationId: operation.id,
        willRestart: false,
        message: 'Plugin を削除した。ファイルは残っている。',
      };
    }

    const rebuild = await requestRebuild();
    await markOperation(
      context.connection,
      operation.id,
      rebuild.willRestart ? 'restarting' : 'pending',
      rebuild.message,
    );

    return {
      operationId: operation.id,
      willRestart: rebuild.willRestart,
      message: rebuild.message,
    };
  },
});

export const getPluginOperation = defineUseCase<{ id: string }, PluginOperation>({
  name: 'plugin.operation.get',
  permission: 'plugin.manage',
  handler: async (context, input) => {
    const operation = await findOperation(context.connection, input.id);
    if (operation === null) {
      throw new NotFoundError('Plugin 操作', input.id);
    }
    return operation;
  },
});

/**
 * Registry の一覧（03_プラグイン設計.md §14.1 §15）。
 *
 * **未設定なら空を返して「設定されていない」と伝える。**
 * 例外にすると、設定していない環境で画面が壊れる。
 */
export interface RegistryItem {
  readonly entry: RegistryEntry;
  /** 導入する前の判定（§15 §16 §17）。押してから失敗させない。 */
  readonly compatibility: RegistryCompatibility;
}

export interface RegistryListOutput {
  readonly configured: boolean;
  /** 信頼する検証鍵が設定されているか。無ければ導入できない。 */
  readonly trusted: boolean;
  readonly items: readonly RegistryItem[];
  readonly error: string | null;
}

export const listRegistryPlugins = defineUseCase<{ keyword: string }, RegistryListOutput>({
  name: 'plugin.registry.list',
  permission: 'plugin.manage',
  handler: async (context, input) => {
    const url = registryUrl();
    const trusted = trustedKeys().length > 0;

    if (url === null) {
      return { configured: false, trusted, items: [], error: null };
    }

    try {
      const entries = await fetchRegistryIndex(url);

      // 依存を満たすかは、いま入っているものと突き合わせないと分からない。
      const records = await listPluginRecords(context.connection);
      const installed = new Map<string, InstalledPluginState>(
        records.map((record) => [
          record.id,
          { version: record.version, enabled: record.status === 'enabled' },
        ]),
      );
      const torifuneVersion = currentTorifuneVersion();

      return {
        configured: true,
        trusted,
        items: searchEntries(entries, input.keyword).map((entry) => ({
          entry,
          compatibility: evaluateRegistryEntry(entry, { installed, torifuneVersion }),
        })),
        error: null,
      };
    } catch (error) {
      // **画面を壊さない。** 取得できないことを伝えて、他の操作は続けられるようにする。
      return {
        configured: true,
        trusted,
        items: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

/**
 * Registry から導入する（03_プラグイン設計.md §14.1、§20.1）。
 *
 * **署名と checksum を必ず検証する。** ローカルの zip アップロードと違い、
 * 出所が自分ではないため、「信頼されたコード」の前提が成り立たない。
 */
export const installFromRegistry = defineUseCase<{ pluginId: string }, InstallResult>({
  name: 'plugin.registry.install',
  permission: 'plugin.manage',
  audit: {
    action: 'installed',
    resourceType: 'plugin',
    resourceId: (input) => input.pluginId,
    detail: () => ({ via: 'registry' }),
  },
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);

    const url = registryUrl();
    if (url === null) {
      throw new ValidationError('Plugin Registry', 'url', 'Registry が設定されていない');
    }

    const entries = await fetchRegistryIndex(url);
    const entry = entries.find((candidate) => candidate.id === input.pluginId);
    if (entry === undefined) {
      throw new NotFoundError('Plugin', input.pluginId);
    }

    const archive = await fetchPackage(entry);

    // **検証してから中身を見る。** 先に展開すると、検証前のコードを触ることになる。
    try {
      verifyPackage({
        archive,
        expectedChecksum: entry.sha256,
        signature: entry.signature,
        trustedKeys: trustedKeys(),
      });
    } catch (error) {
      throw new ValidationError(
        'Plugin Package',
        'signature',
        error instanceof Error ? error.message : String(error),
      );
    }

    let inspected;
    try {
      inspected = await inspectPackage(archive);
    } catch (error) {
      if (error instanceof PluginPackageError) {
        throw new ValidationError('Plugin Package', 'archive', error.message);
      }
      throw error;
    }

    if (inspected.pluginId !== entry.id) {
      // Registry の記載と中身が違う。署名は通っても、入れてよい理由にならない。
      throw new ValidationError('Plugin Package', 'archive', 'Registry の記載と中身が一致しない');
    }

    const existing = await findPluginRecord(context.connection, inspected.pluginId);
    if (existing !== null) {
      assertUpgradable(existing.version, inspected.manifest.version);
    }

    const operation = await startOperation(context.connection, {
      pluginId: inspected.pluginId,
      kind: 'install',
      requestedBy: identity.userId,
    });

    try {
      await extractPackage(inspected, { pluginsDir: pluginsDir() });
    } catch (error) {
      await markOperation(
        context.connection,
        operation.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      throw new ValidationError('Plugin Package', 'archive', 'Plugin を配置できなかった');
    }

    await installPlugin(context.connection, inspected.manifest);

    const rebuild = await requestRebuild();
    await markOperation(
      context.connection,
      operation.id,
      rebuild.willRestart ? 'restarting' : 'pending',
      rebuild.message,
    );

    return {
      operationId: operation.id,
      willRestart: rebuild.willRestart,
      message: rebuild.message,
    };
  },
});
