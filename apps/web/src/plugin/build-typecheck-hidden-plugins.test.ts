import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLUGINS_DIR,
  REGISTRY_PATH,
  createBuildCompilerHost,
  createTypecheckProgram,
  formatErrors,
  generateRegistryWithout,
  listBundledPlugins,
  programOptions,
  readParsedConfig,
  registryPluginDirectories,
  typeErrors,
} from '@/test-support/build-typecheck';

/**
 * 本番のビルドの型検査の再現：同梱 Plugin のフォルダが無い（052-rebuild-without-tests 設計 §10.2）。
 *
 * 「X を隠す」は CompilerHost が `plugins/X/` を無いと答え、X を除いた写しで生成したレジストリを返すこと
 * （設計 §10 の定義）。ディスクの `plugins/` には触れない。
 *
 * 担当する受け入れ条件：#10・#11。
 * 隠し方そのもの（CompilerHost の答え）と、生成を写しの中で走らせたこと（リポジトリのレジストリが変わらない）も確かめる（判別力）。
 */

const PROGRAM_TIMEOUT = 120_000;

const bundled = listBundledPlugins();
const bundledIds = bundled.map((plugin) => plugin.id);

function readRepositoryRegistry(): string | null {
  return existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, 'utf8') : null;
}

let registryBefore: string | null = null;

beforeAll(() => {
  registryBefore = readRepositoryRegistry();
});

afterAll(() => {
  // 生成を写しの中で走らせたことの確かめ（リポジトリを書き換えない）。
  expect(readRepositoryRegistry()).toBe(registryBefore);
});

describe('#10 同梱 Plugin を 1 つずつ隠す', () => {
  it('同梱 Plugin が 1 つ以上ある（0 件で素通りしない）', () => {
    expect(bundledIds.length).toBeGreaterThan(0);
  });

  it.each(bundledIds)(
    '#10 %s を隠したとき、渡したレジストリに隠した Plugin が無く、ほかの同梱 Plugin はすべてある',
    (id) => {
      const directories = registryPluginDirectories(generateRegistryWithout([id]));
      expect(directories).not.toContain(id);
      expect([...directories].sort()).toEqual(bundledIds.filter((other) => other !== id).sort());
    },
  );

  it.each(bundledIds)(
    '#10 %s を隠しても、ビルドの設定のプログラムの誤りは 0 件',
    (id) => {
      const { program } = createTypecheckProgram({ config: 'build', hidden: [id] });
      const errors = typeErrors(program);
      expect(errors, formatErrors(errors)).toHaveLength(0);
    },
    PROGRAM_TIMEOUT,
  );
});

describe('#11 同梱 Plugin をすべて隠す', () => {
  it('#11 渡したレジストリは import が 0 件で、PLUGIN_MODULES が空', () => {
    const registry = generateRegistryWithout(bundledIds);
    expect(registryPluginDirectories(registry)).toEqual([]);
    expect(registry).not.toMatch(/^import plugin\d+ from /m);
    expect(registry).toMatch(
      /export const PLUGIN_MODULES: readonly PluginModuleEntry\[\] = \[\s*\];/,
    );
  });

  it(
    '#11 すべて隠しても、ビルドの設定のプログラムの誤りは 0 件',
    () => {
      const { program } = createTypecheckProgram({ config: 'build', hidden: bundledIds });
      const errors = typeErrors(program);
      expect(errors, formatErrors(errors)).toHaveLength(0);
    },
    PROGRAM_TIMEOUT,
  );
});

describe('（判別力）隠し方', () => {
  const [hiddenPlugin, ...visiblePlugins] = bundled;

  it('隠した Plugin のエントリについて、CompilerHost の fileExists は false・readFile は undefined', () => {
    expect(hiddenPlugin).toBeDefined();
    const host = createBuildCompilerHost(programOptions(readParsedConfig('check')), {
      hidden: [hiddenPlugin!.id],
    });
    expect(existsSync(hiddenPlugin!.entry)).toBe(true);
    expect(host.fileExists(hiddenPlugin!.entry)).toBe(false);
    expect(host.readFile(hiddenPlugin!.entry)).toBeUndefined();
    expect(host.directoryExists?.(`${PLUGINS_DIR}/${hiddenPlugin!.id}`)).toBe(false);
    expect(host.getDirectories?.(PLUGINS_DIR)).not.toContain(hiddenPlugin!.id);
  });

  it('隠していない Plugin のエントリについて、CompilerHost の fileExists は true', () => {
    const host = createBuildCompilerHost(programOptions(readParsedConfig('check')), {
      hidden: [hiddenPlugin!.id],
    });
    expect(visiblePlugins.length).toBeGreaterThan(0);
    for (const plugin of visiblePlugins) {
      expect(host.fileExists(plugin.entry), plugin.id).toBe(true);
    }
  });
});
