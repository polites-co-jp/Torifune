#!/usr/bin/env node
/**
 * `plugins/` を走査して、Plugin のレジストリを生成する。
 *
 * **ビルド時に実行する**（決定事項 D-02）。Next.js は要求されたモジュールしか
 * 読み込まないため、静的な import を並べたファイルを生成する必要がある。
 *
 * 出力: apps/web/src/plugin/generated-registry.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const pluginsDir = join(repoRoot, 'plugins');
const outputPath = join(repoRoot, 'apps', 'web', 'src', 'plugin', 'generated-registry.ts');

const HEADER = `/* eslint-disable */
/**
 * **自動生成されたファイル。手で編集しない。**
 *
 * \`pnpm generate:plugins\`（ビルド時に自動実行）が
 * \`plugins/\` を走査して作る。
 */
import type { Plugin } from '@torifune/plugin-api';

export interface PluginModuleEntry {
  /** plugins/ 配下のディレクトリ名。 */
  readonly directory: string;
  readonly manifest: unknown;
  readonly module: Plugin | unknown;
}
`;

function discover() {
  if (!existsSync(pluginsDir)) {
    return [];
  }

  const entries = [];
  for (const name of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;

    // 隔離マークのあるものは読み込まない。
    // ビルドを壊した Plugin を置いたままにすると、次のビルドも失敗し続ける。
    if (existsSync(join(pluginsDir, name.name, '.torifune-quarantine'))) {
      console.warn(`[plugins] ${name.name}: 隔離されているため読み込まない`);
      continue;
    }

    const manifestPath = join(pluginsDir, name.name, 'plugin.json');
    if (!existsSync(manifestPath)) continue;

    // エントリポイントは index.ts / index.tsx のどちらか。
    const candidates = ['index.ts', 'index.tsx'];
    const entry = candidates.find((file) => existsSync(join(pluginsDir, name.name, file)));
    if (entry === undefined) {
      console.warn(`[plugins] ${name.name}: index.ts が無いため読み込まない`);
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      console.warn(`[plugins] ${name.name}: plugin.json を読めない`, error);
      continue;
    }

    entries.push({ directory: name.name, manifest, entry });
  }

  return entries.sort((a, b) => a.directory.localeCompare(b.directory));
}

function generate(entries) {
  const imports = entries
    .map(
      (e, i) =>
        `import plugin${i} from '../../../../plugins/${e.directory}/${e.entry.replace(/\.tsx?$/, '')}';`,
    )
    .join('\n');

  const list = entries
    .map(
      (e, i) =>
        `  {\n    directory: ${JSON.stringify(e.directory)},\n    manifest: ${JSON.stringify(e.manifest)},\n    module: plugin${i},\n  },`,
    )
    .join('\n');

  return `${HEADER}${imports === '' ? '' : `\n${imports}\n`}
export const PLUGIN_MODULES: readonly PluginModuleEntry[] = [
${list}
];
`;
}

const entries = discover();
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, generate(entries), 'utf8');
console.log(`[plugins] ${entries.length} 件のプラグインをレジストリへ書き出した`);
