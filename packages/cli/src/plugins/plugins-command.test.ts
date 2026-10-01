import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isCommand, run, usage, type ParseResult, type RunIo } from '../index.js';

/**
 * `torifune plugins` サブコマンド（050-bundled-plugin-sync 設計 §6.6、受け入れ条件 #24・#27・#28）。
 *
 * `run()` は既にあるので直に読む。引数の解釈（`command.ts`）と指紋（`tree-hash.ts`）は
 * **まだ無い**（実装プラン T1。T2・T6 で足す）ので、型検査を通すため、指定子を変数にした
 * 動的 import で読み、実装プラン §2「モジュールの形」の型を当てる。
 *
 * `run()` に既定の `/app/plugins` を使わせない（テストの環境に書かない）。既定値は引数の解釈の
 * 戻り値で見て、`run()` には一時ディレクトリへ向けた `env` を渡す（実装プラン §8 の 7）。
 */

type Env = Readonly<Record<string, string | undefined>>;

interface CommandModule {
  parseSyncBundledArgs(
    argv: readonly string[],
    env: Env,
  ): ParseResult<{ readonly bundledDir: string | null; readonly pluginsDir: string }>;
  parseFingerprintArgs(
    argv: readonly string[],
    env: Env,
  ): ParseResult<{ readonly pluginsDir: string }>;
}

interface TreeHashModule {
  hashPluginTree(dir: string): Promise<string>;
  fingerprintPlugins(pluginsDir: string): Promise<string>;
}

const COMMAND_MODULE = './command.js';
const TREE_HASH_MODULE = './tree-hash.js';
let commandModule: Promise<CommandModule> | undefined;
let treeHashModule: Promise<TreeHashModule> | undefined;

function loadCommand(): Promise<CommandModule> {
  commandModule ??= import(/* @vite-ignore */ COMMAND_MODULE) as Promise<CommandModule>;
  return commandModule;
}

function loadTreeHash(): Promise<TreeHashModule> {
  treeHashModule ??= import(/* @vite-ignore */ TREE_HASH_MODULE) as Promise<TreeHashModule>;
  return treeHashModule;
}

const PREFIX = '[torifune] bundled plugins: ';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'torifune-sync-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writePlugin(dir: string, id: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  await writeFile(join(dir, 'index.ts'), `export function activate() { /* ${id} */ }\n`);
}

async function runCli(
  argv: readonly string[],
  env: Env,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: RunIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    env,
    readStdin: async () => '',
  };
  const code = await run(argv, io);
  return { code, out, err };
}

describe('plugins sync-bundled', () => {
  it('#24 TORIFUNE_BUNDLED_PLUGINS_DIR が空 → 何もせず終了コード 0、no bundled directory の行を出す', async () => {
    const pluginsDir = join(root, 'plugins');

    const result = await runCli(['plugins', 'sync-bundled'], {
      TORIFUNE_BUNDLED_PLUGINS_DIR: '',
      TORIFUNE_PLUGINS_DIR: pluginsDir,
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain(`${PREFIX}no bundled directory, skipped`);
    expect(await exists(pluginsDir)).toBe(false);
  });

  it('#24 TORIFUNE_BUNDLED_PLUGINS_DIR が未設定 → 何もせず終了コード 0、no bundled directory の行を出す', async () => {
    const pluginsDir = join(root, 'plugins');

    const result = await runCli(['plugins', 'sync-bundled'], { TORIFUNE_PLUGINS_DIR: pluginsDir });

    expect(result.code).toBe(0);
    expect(result.out).toContain(`${PREFIX}no bundled directory, skipped`);
    expect(await exists(pluginsDir)).toBe(false);
  });

  it('#24 同梱の場所が存在しない → 何もせず終了コード 0、no bundled directory の行を出す', async () => {
    const pluginsDir = join(root, 'plugins');

    const result = await runCli(
      ['plugins', 'sync-bundled', `--bundled-dir=${join(root, 'nowhere')}`],
      { TORIFUNE_PLUGINS_DIR: pluginsDir },
    );

    expect(result.code).toBe(0);
    expect(result.out).toContain(`${PREFIX}no bundled directory, skipped`);
    expect(await exists(pluginsDir)).toBe(false);
  });
});

describe('plugins の引数', () => {
  it('#27 使い方に plugins sync-bundled と plugins fingerprint が載る（設計 §6.6.4）', () => {
    expect(usage()).toContain('plugins sync-bundled');
    expect(usage()).toContain('plugins fingerprint');
  });

  it('#27 plugins は既知のコマンド（設計 §6.6.4）', () => {
    expect(isCommand('plugins')).toBe(true);
  });

  it('#27 plugins sync-bundled --unknown は終了コード 1 で、未知のオプションの名前と使い方を出し、何もしない', async () => {
    const bundledDir = join(root, 'bundled');
    const pluginsDir = join(root, 'plugins');
    await writePlugin(join(bundledDir, 'alpha'), 'alpha');

    const result = await runCli(['plugins', 'sync-bundled', '--unknown'], {
      TORIFUNE_BUNDLED_PLUGINS_DIR: bundledDir,
      TORIFUNE_PLUGINS_DIR: pluginsDir,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('--unknown');
    expect(result.err).toContain('plugins sync-bundled');
    expect(await exists(pluginsDir)).toBe(false);
  });

  it('#27 plugins だけ（サブコマンドなし）は終了コード 1 と使い方', async () => {
    const result = await runCli(['plugins'], {});

    expect(result.code).toBe(1);
    expect(result.err).toContain('plugins sync-bundled');
    expect(result.err).toContain('plugins fingerprint');
  });

  it('#27 plugins foo（未知のサブコマンド）は終了コード 1 と使い方', async () => {
    const result = await runCli(['plugins', 'foo'], {});

    expect(result.code).toBe(1);
    expect(result.err).toContain('plugins sync-bundled');
    expect(result.err).toContain('plugins fingerprint');
  });

  it('#27 plugins fingerprint は sha256:<64 桁> と改行の 1 行を出して終了コード 0', async () => {
    const pluginsDir = join(root, 'plugins');
    await writePlugin(join(pluginsDir, 'alpha'), 'alpha');
    await writePlugin(join(pluginsDir, 'beta'), 'beta');

    const result = await runCli(['plugins', 'fingerprint', `--plugins-dir=${pluginsDir}`], {});

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^sha256:[0-9a-f]{64}\n$/);
  });

  it('#27 plugins fingerprint の出力は、その plugins の指紋（設計 §6.7.1）', async () => {
    const pluginsDir = join(root, 'plugins');
    await writePlugin(join(pluginsDir, 'alpha'), 'alpha');

    const result = await runCli(['plugins', 'fingerprint', `--plugins-dir=${pluginsDir}`], {});

    expect(result.out).toBe(`${await (await loadTreeHash()).fingerprintPlugins(pluginsDir)}\n`);
  });

  it('#28 sync-bundled：引数を省くと TORIFUNE_BUNDLED_PLUGINS_DIR・TORIFUNE_PLUGINS_DIR を使う', async () => {
    const { parseSyncBundledArgs } = await loadCommand();

    const result = parseSyncBundledArgs([], {
      TORIFUNE_BUNDLED_PLUGINS_DIR: '/opt/bundled',
      TORIFUNE_PLUGINS_DIR: '/srv/plugins',
    });

    expect(result).toEqual({
      ok: true,
      value: { bundledDir: '/opt/bundled', pluginsDir: '/srv/plugins' },
    });
  });

  it('#28 sync-bundled：引数を渡せば環境変数より引数を使う', async () => {
    const { parseSyncBundledArgs } = await loadCommand();

    const result = parseSyncBundledArgs(['--bundled-dir=/x/bundled', '--plugins-dir=/y/plugins'], {
      TORIFUNE_BUNDLED_PLUGINS_DIR: '/opt/bundled',
      TORIFUNE_PLUGINS_DIR: '/srv/plugins',
    });

    expect(result).toEqual({
      ok: true,
      value: { bundledDir: '/x/bundled', pluginsDir: '/y/plugins' },
    });
  });

  it.each<readonly [string, Env]>([
    ['空', { TORIFUNE_PLUGINS_DIR: '' }],
    ['未設定', {}],
  ])('#28 sync-bundled：TORIFUNE_PLUGINS_DIR が%sなら /app/plugins', async (_label, env) => {
    const { parseSyncBundledArgs } = await loadCommand();

    const result = parseSyncBundledArgs([], env);

    expect(result.ok && result.value.pluginsDir).toBe('/app/plugins');
  });

  it('#28 sync-bundled：TORIFUNE_BUNDLED_PLUGINS_DIR が未設定なら同梱の場所は null', async () => {
    const { parseSyncBundledArgs } = await loadCommand();

    const result = parseSyncBundledArgs([], {});

    expect(result.ok && result.value.bundledDir).toBeNull();
  });

  it('#28 fingerprint：引数を省くと TORIFUNE_PLUGINS_DIR を使い、渡せば引数を使う', async () => {
    const { parseFingerprintArgs } = await loadCommand();

    expect(parseFingerprintArgs([], { TORIFUNE_PLUGINS_DIR: '/srv/plugins' })).toEqual({
      ok: true,
      value: { pluginsDir: '/srv/plugins' },
    });
    expect(
      parseFingerprintArgs(['--plugins-dir=/y/plugins'], { TORIFUNE_PLUGINS_DIR: '/srv/plugins' }),
    ).toEqual({ ok: true, value: { pluginsDir: '/y/plugins' } });
  });

  it.each<readonly [string, Env]>([
    ['空', { TORIFUNE_PLUGINS_DIR: '' }],
    ['未設定', {}],
  ])('#28 fingerprint：TORIFUNE_PLUGINS_DIR が%sなら /app/plugins', async (_label, env) => {
    const { parseFingerprintArgs } = await loadCommand();

    const result = parseFingerprintArgs([], env);

    expect(result.ok && result.value.pluginsDir).toBe('/app/plugins');
  });

  it('#28 run()：引数を省いた sync-bundled は env の TORIFUNE_BUNDLED_PLUGINS_DIR から TORIFUNE_PLUGINS_DIR へ写す', async () => {
    const bundledDir = join(root, 'bundled');
    const pluginsDir = join(root, 'plugins');
    await writePlugin(join(bundledDir, 'alpha'), 'alpha');
    const { hashPluginTree } = await loadTreeHash();
    const bundledHash = await hashPluginTree(join(bundledDir, 'alpha'));

    const result = await runCli(['plugins', 'sync-bundled'], {
      TORIFUNE_BUNDLED_PLUGINS_DIR: bundledDir,
      TORIFUNE_PLUGINS_DIR: pluginsDir,
    });

    expect(result.code).toBe(0);
    expect(await readdir(pluginsDir)).toContain('alpha');
    expect(await hashPluginTree(join(pluginsDir, 'alpha'))).toBe(bundledHash);
  });

  it('#28 run()：引数を省いた fingerprint は env の TORIFUNE_PLUGINS_DIR の指紋を出す', async () => {
    const pluginsDir = join(root, 'plugins');
    await writePlugin(join(pluginsDir, 'alpha'), 'alpha');

    const result = await runCli(['plugins', 'fingerprint'], { TORIFUNE_PLUGINS_DIR: pluginsDir });

    expect(result.code).toBe(0);
    expect(result.out).toBe(`${await (await loadTreeHash()).fingerprintPlugins(pluginsDir)}\n`);
  });
});
