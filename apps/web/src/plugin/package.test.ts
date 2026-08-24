import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildZip, REGULAR_FILE_MODE, SYMLINK_MODE, validPackageZip } from '@/test-support/zip';
import { extractPackage, inspectPackage, PluginPackageError } from './package';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'torifune-pkg-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function manifestOf(pluginId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: pluginId,
    name: 'サンプル',
    version: '1.0.0',
    apiVersion: 1,
    ...overrides,
  });
}

describe('検証', () => {
  it('正しい Package を読める', async () => {
    const inspected = await inspectPackage(validPackageZip());

    expect(inspected.pluginId).toBe('sample-plugin');
    expect(inspected.manifest.version).toBe('1.0.0');
    expect(inspected.entries.map((entry) => entry.path).sort()).toEqual([
      'index.ts',
      'plugin.json',
    ]);
  });

  it('要求 Permission を取り出せる', async () => {
    // 導入前に見せるために要る（06_画面設計.md §39）。
    const inspected = await inspectPackage(
      validPackageZip('sample-plugin', { permissions: ['site.read', 'sample-plugin.report.read'] }),
    );

    expect(inspected.manifest.permissions).toEqual(['site.read', 'sample-plugin.report.read']);
  });

  it('zip でないものを拒否する', async () => {
    await expect(inspectPackage(Buffer.from('これは zip ではない'))).rejects.toBeInstanceOf(
      PluginPackageError,
    );
  });

  it('空の zip を拒否する', async () => {
    await expect(inspectPackage(buildZip([]))).rejects.toThrow('中身が空');
  });

  it('.. を含むパスを拒否する', async () => {
    // Plugin の外へ書き込める。
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
      { name: 'sample-plugin/index.ts', content: 'export default {};' },
      { name: 'sample-plugin/../../evil.txt', content: 'x' },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('安全でないパス');
  });

  it('絶対パスを拒否する', async () => {
    const zip = buildZip([
      { name: '/etc/passwd', content: 'x' },
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('安全でないパス');
  });

  it('ドライブ付き絶対パスを拒否する', async () => {
    const zip = buildZip([
      { name: 'C:/windows/evil.txt', content: 'x' },
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('安全でないパス');
  });

  it('区切りが逆スラッシュのものを拒否する', async () => {
    const zip = buildZip([
      { name: 'sample-plugin\\..\\evil.txt', content: 'x' },
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('安全でないパス');
  });

  it('シンボリックリンクを拒否する', async () => {
    // 展開後にリンク経由で外を読み書きできる。
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
      { name: 'sample-plugin/index.ts', content: 'export default {};' },
      { name: 'sample-plugin/link', content: '/etc/passwd', mode: SYMLINK_MODE },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('シンボリックリンク');
  });

  it('通常ファイルはシンボリックリンク扱いにしない', async () => {
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
      { name: 'sample-plugin/index.ts', content: 'export default {};', mode: REGULAR_FILE_MODE },
    ]);

    await expect(inspectPackage(zip)).resolves.toBeDefined();
  });

  it('トップレベルが複数あるものを拒否する', async () => {
    // どれが Plugin か決められない。
    const zip = buildZip([
      { name: 'a-plugin/plugin.json', content: manifestOf('a-plugin') },
      { name: 'b-plugin/plugin.json', content: manifestOf('b-plugin') },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('トップレベル');
  });

  it('plugin.json が無いものを拒否する', async () => {
    const zip = buildZip([{ name: 'sample-plugin/index.ts', content: 'export default {};' }]);

    await expect(inspectPackage(zip)).rejects.toThrow('plugin.json が無い');
  });

  it('壊れた plugin.json を拒否する', async () => {
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: '{ 壊れている' },
      { name: 'sample-plugin/index.ts', content: 'export default {};' },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('plugin.json を読めない');
  });

  it('不正な Manifest をビルドに入る前に拒否する', async () => {
    const zip = buildZip([
      {
        name: 'sample-plugin/plugin.json',
        content: JSON.stringify({ id: 'sample-plugin', name: 'x', version: 'いち', apiVersion: 1 }),
      },
      { name: 'sample-plugin/index.ts', content: 'export default {};' },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('plugin.json が不正');
  });

  it('ディレクトリ名と Plugin ID の不一致を拒否する', async () => {
    const zip = buildZip([
      { name: 'seo/plugin.json', content: manifestOf('seo-plugin') },
      { name: 'seo/index.ts', content: 'export default {};' },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('ディレクトリ名と Plugin ID');
  });

  it('エントリポイントが無いものを拒否する', async () => {
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow('index.ts');
  });

  it('index.tsx でもよい', async () => {
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
      { name: 'sample-plugin/index.tsx', content: 'export default {};' },
    ]);

    await expect(inspectPackage(zip)).resolves.toBeDefined();
  });

  it('ファイル数の上限を超えるものを拒否する', async () => {
    process.env['TORIFUNE_PLUGIN_MAX_FILES'] = '3';
    try {
      const zip = buildZip([
        { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
        { name: 'sample-plugin/index.ts', content: 'export default {};' },
        { name: 'sample-plugin/a.ts', content: '1' },
        { name: 'sample-plugin/b.ts', content: '2' },
        { name: 'sample-plugin/c.ts', content: '3' },
      ]);

      await expect(inspectPackage(zip)).rejects.toThrow('ファイル数が多すぎる');
    } finally {
      delete process.env['TORIFUNE_PLUGIN_MAX_FILES'];
    }
  });

  it('展開後のサイズの上限を超えるものを拒否する', async () => {
    // zip bomb でディスクを埋められないようにする。
    process.env['TORIFUNE_PLUGIN_MAX_BYTES'] = '64';
    try {
      const zip = buildZip([
        { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
        { name: 'sample-plugin/big.txt', content: 'x'.repeat(1024) },
      ]);

      await expect(inspectPackage(zip)).rejects.toThrow('大きすぎる');
    } finally {
      delete process.env['TORIFUNE_PLUGIN_MAX_BYTES'];
    }
  });
});

describe('展開', () => {
  it('plugins/<id>/ へ書き出す', async () => {
    const inspected = await inspectPackage(validPackageZip());

    const target = await extractPackage(inspected, { pluginsDir: workDir });

    expect(target).toBe(join(workDir, 'sample-plugin'));
    expect((await readdir(target)).sort()).toEqual(['index.ts', 'plugin.json']);
  });

  it('中身がそのまま書かれる', async () => {
    const inspected = await inspectPackage(validPackageZip());
    await extractPackage(inspected, { pluginsDir: workDir });

    const content = await readFile(join(workDir, 'sample-plugin', 'index.ts'), 'utf8');
    expect(content).toBe('export default { activate() {} };\n');
  });

  it('入れ子のディレクトリを作る', async () => {
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
      { name: 'sample-plugin/index.ts', content: 'export default {};' },
      { name: 'sample-plugin/ui/widget.tsx', content: 'export const W = () => null;' },
    ]);
    const inspected = await inspectPackage(zip);

    await extractPackage(inspected, { pluginsDir: workDir });

    const content = await readFile(join(workDir, 'sample-plugin', 'ui', 'widget.tsx'), 'utf8');
    expect(content).toBe('export const W = () => null;');
  });

  it('拒否したとき、1バイトも書かれていない', async () => {
    // 途中まで書いてから弾くと、壊れた状態が残る。
    const zip = buildZip([
      { name: 'sample-plugin/plugin.json', content: manifestOf('sample-plugin') },
      { name: 'sample-plugin/index.ts', content: 'export default {};' },
      { name: 'sample-plugin/../evil.txt', content: 'x' },
    ]);

    await expect(inspectPackage(zip)).rejects.toThrow();
    expect(await readdir(workDir)).toEqual([]);
  });
});
