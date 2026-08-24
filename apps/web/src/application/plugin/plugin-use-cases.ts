import { rm } from 'node:fs/promises';
import type { PluginManifest } from '@torifune/plugin-api';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
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

export interface EnableResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

export const enablePluginUseCase = defineUseCase<{ pluginId: string }, EnableResult>({
  name: 'plugin.enable',
  permission: 'plugin.manage',
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
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);
    const entry = requireDiscovered(input.pluginId);

    const existing = await findPluginRecord(context.connection, input.pluginId);
    if (existing !== null) {
      throw new ValidationError('Plugin', 'pluginId', 'すでに導入されている');
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
    if (existing !== null || loadedPlugin(inspected.pluginId) !== null) {
      // 黙って上書きすると、動いている Plugin が入れ替わる。
      throw new ValidationError(
        'Plugin',
        'id',
        `すでに同じ ID の Plugin がある: ${inspected.pluginId}`,
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
      throw new ValidationError(
        'Plugin',
        'id',
        `すでに同じ ID の Plugin がある: ${inspected.pluginId}`,
      );
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

    await uninstallPlugin(context.connection, input.pluginId, { deleteData: input.deleteData });

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
