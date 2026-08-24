import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { validateManifest } from '@torifune/plugin-api';
import { CORE_PERMISSIONS } from '@/domain/permission';
import { PLUGIN_MODULES } from './generated-registry';

/**
 * `plugins/` に置かれた Plugin の読み込み。
 *
 * **ビルド時に走査してレジストリを生成する**（決定事項 D-02）。
 * Next.js で UI 拡張を実行時ロードするには Module Federation か iframe が要り、
 * ビルド基盤・セキュリティ・型安全性のすべてでコストが跳ね上がる。
 *
 * 生成物は `generated-registry.ts`。`scripts/generate-plugin-registry.mjs` が作る。
 */

export interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly plugin: Plugin;
}

export interface DiscoveryProblem {
  readonly pluginId: string;
  readonly message: string;
}

export interface DiscoveryResult {
  readonly plugins: readonly DiscoveredPlugin[];
  /** 読み込めなかったもの。**黙って無視しない。** 管理画面で見せる。 */
  readonly problems: readonly DiscoveryProblem[];
}

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['activate'] === 'function'
  );
}

/**
 * ビルド時に集めた Plugin を検証して返す。
 *
 * Manifest が不正なものは読み込まない。
 * **形式の誤りを黙って通すと、実行時に分かりにくい壊れ方をする。**
 */
export function discoverPlugins(): DiscoveryResult {
  const plugins: DiscoveredPlugin[] = [];
  const problems: DiscoveryProblem[] = [];
  const seen = new Set<string>();

  for (const entry of PLUGIN_MODULES) {
    const validation = validateManifest(entry.manifest, {
      knownPermissions: [...CORE_PERMISSIONS],
    });

    if (!validation.ok) {
      problems.push({
        pluginId: entry.directory,
        message: validation.problems.map((p) => `${p.field}: ${p.message}`).join(' / '),
      });
      continue;
    }

    const manifest = validation.manifest;

    // ディレクトリ名と Plugin ID を一致させる。
    // 食い違うと、ファイルを見て「どの Plugin か」が分からなくなる。
    if (manifest.id !== entry.directory) {
      problems.push({
        pluginId: entry.directory,
        message: `ディレクトリ名と Plugin ID が一致しない（id: ${manifest.id}）`,
      });
      continue;
    }

    if (seen.has(manifest.id)) {
      problems.push({ pluginId: manifest.id, message: 'Plugin ID が重複している' });
      continue;
    }

    if (!isPlugin(entry.module)) {
      problems.push({
        pluginId: manifest.id,
        message: 'activate を持つオブジェクトを default export していない',
      });
      continue;
    }

    seen.add(manifest.id);
    plugins.push({ manifest, plugin: entry.module });
  }

  return { plugins, problems };
}
