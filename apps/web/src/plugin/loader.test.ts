import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginModuleEntry } from './generated-registry';
import { discoverPlugins } from './loader';

// ビルド時に生成されるレジストリを差し替える。
// 実ファイルに依存すると、`plugins/` に何を置いたかでテストが揺れる。
vi.mock('./generated-registry', () => ({
  get PLUGIN_MODULES() {
    return modules;
  },
}));

let modules: PluginModuleEntry[] = [];

const workingPlugin = { activate: () => undefined };

function entry(overrides: Partial<PluginModuleEntry> = {}): PluginModuleEntry {
  return {
    directory: 'sample-plugin',
    manifest: { id: 'sample-plugin', name: 'サンプル', version: '1.0.0', apiVersion: 1 },
    module: workingPlugin,
    ...overrides,
  };
}

beforeEach(() => {
  modules = [];
});

describe('discoverPlugins', () => {
  it('正しい Plugin を読み込む', () => {
    modules = [entry()];

    const result = discoverPlugins();

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]?.manifest.id).toBe('sample-plugin');
    expect(result.problems).toEqual([]);
  });

  it('Manifest が不正なものは読み込まない', () => {
    // 形式の誤りを黙って通すと、実行時に分かりにくい壊れ方をする。
    modules = [
      entry({ manifest: { id: 'Sample_Plugin', name: 'x', version: 'いち', apiVersion: 1 } }),
    ];

    const result = discoverPlugins();

    expect(result.plugins).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  it('読み込めなかったものを黙って捨てない', () => {
    // 管理画面で理由を見せるため、problems に残す。
    modules = [entry({ manifest: {} })];

    const result = discoverPlugins();

    expect(result.problems[0]?.pluginId).toBe('sample-plugin');
    expect(result.problems[0]?.message).not.toBe('');
  });

  it('ディレクトリ名と Plugin ID が食い違うものを弾く', () => {
    // 食い違うと、ファイルを見て「どの Plugin か」が分からなくなる。
    modules = [
      entry({
        directory: 'seo',
        manifest: { id: 'seo-plugin', name: 'SEO', version: '1.0.0', apiVersion: 1 },
      }),
    ];

    const result = discoverPlugins();

    expect(result.plugins).toEqual([]);
    expect(result.problems[0]?.message).toContain('ディレクトリ名');
  });

  it('activate を持たないものを弾く', () => {
    modules = [entry({ module: { hello: 'world' } })];

    const result = discoverPlugins();

    expect(result.plugins).toEqual([]);
    expect(result.problems[0]?.message).toContain('activate');
  });

  it('ID が重複したら後ろを弾く', () => {
    modules = [entry(), entry()];

    const result = discoverPlugins();

    expect(result.plugins).toHaveLength(1);
    expect(result.problems[0]?.message).toContain('重複');
  });

  it('1つ壊れていても他は読み込む', () => {
    // Plugin ひとつの不備で他が全部止まると、原因の切り分けができない。
    modules = [
      entry({ manifest: {} }),
      entry({
        directory: 'other-plugin',
        manifest: { id: 'other-plugin', name: 'ほか', version: '2.0.0', apiVersion: 1 },
      }),
    ];

    const result = discoverPlugins();

    expect(result.plugins.map((p) => p.manifest.id)).toEqual(['other-plugin']);
    expect(result.problems).toHaveLength(1);
  });

  it('本体に無い Permission を宣言していても読み込む', () => {
    // Plugin は自分の名前空間の Permission を新しく定義できる。
    modules = [
      entry({
        manifest: {
          id: 'sample-plugin',
          name: 'サンプル',
          version: '1.0.0',
          apiVersion: 1,
          permissions: ['sample-plugin.report.read'],
        },
      }),
    ];

    const result = discoverPlugins();

    expect(result.plugins).toHaveLength(1);
  });

  it('Plugin が無ければ空を返す', () => {
    const result = discoverPlugins();

    expect(result).toEqual({ plugins: [], problems: [] });
  });
});
