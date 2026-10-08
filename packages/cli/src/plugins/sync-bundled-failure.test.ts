import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 同期の失敗と前回の残骸（050-bundled-plugin-sync 設計 §6.4・§6.6.1・§6.6.2、受け入れ条件 #29〜#33）。
 *
 * ファイル操作の口（`SyncFileOps`）を、本物（`nodeFileOps`）を包んだもので差し替えて失敗を注入する
 * （実装プラン §2「テストの方法」）。外部境界（ファイルシステムの失敗）だけを差し替え、判定と手順は本物を通す。
 *
 * **モジュールはまだ無い**（実装プラン T1。T2・T4・T5 で足す）。型検査を通すため、
 * 指定子を変数にした動的 import で読み、実装プラン §2「モジュールの形」の型を当てる。
 */

interface SyncFileOps {
  copyDir(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

interface SyncModule {
  readonly nodeFileOps: SyncFileOps;
  syncBundledPlugins(options: {
    readonly bundledDir: string;
    readonly pluginsDir: string;
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    readonly ops?: SyncFileOps;
    readonly now?: () => Date;
  }): Promise<{ readonly exitCode: 0 | 1; readonly summary: { readonly failed: number } }>;
}

interface TreeHashModule {
  hashPluginTree(dir: string): Promise<string>;
}

const SYNC_MODULE = './sync-bundled.js';
const TREE_HASH_MODULE = './tree-hash.js';
let syncModule: Promise<SyncModule> | undefined;
let treeHashModule: Promise<TreeHashModule> | undefined;

function loadSync(): Promise<SyncModule> {
  syncModule ??= import(/* @vite-ignore */ SYNC_MODULE) as Promise<SyncModule>;
  return syncModule;
}

async function hashPluginTree(dir: string): Promise<string> {
  treeHashModule ??= import(/* @vite-ignore */ TREE_HASH_MODULE) as Promise<TreeHashModule>;
  return (await treeHashModule).hashPluginTree(dir);
}

const PREFIX = '[torifune] bundled plugins: ';
const MARKER = '.torifune-bundled';
const BACKUP_DIR = '.torifune-bundled-backup';
const TMP_OF = (id: string): string => `.torifune-sync-${id}.tmp`;

const BUNDLED_FILES: Readonly<Record<string, string>> = {
  'index.ts': 'export function activate() {}\n',
  'help/credentials.md': '# 手順\n\n本文\n',
  'new.ts': 'export const added = true;\n',
};

const OLD_FILES: Readonly<Record<string, string>> = {
  'index.ts': 'export function activate() { /* old */ }\n',
  'old.ts': 'export const removed = true;\n',
};

let root: string;
let bundledDir: string;
let pluginsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'torifune-sync-'));
  bundledDir = join(root, 'bundled');
  pluginsDir = join(root, 'plugins');
  await mkdir(bundledDir);
  await mkdir(pluginsDir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(base: string, relative: string, content: string): Promise<void> {
  const path = join(base, ...relative.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writePlugin(
  dir: string,
  id: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  for (const [relative, content] of Object.entries(files)) {
    await put(dir, relative, content);
  }
}

async function bundle(id: string): Promise<string> {
  await writePlugin(join(bundledDir, id), id, BUNDLED_FILES);
  return hashPluginTree(join(bundledDir, id));
}

/** 同期が書いたまま誰も触っていない古い同梱（設計 §6.3 #4 → updated、退避なし）。 */
async function volumeSyncedOld(id: string): Promise<{ hash: string; marker: string }> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, id, OLD_FILES);
  const hash = await hashPluginTree(dir);
  const marker = JSON.stringify({
    schema: 1,
    hash,
    version: '1.0.0',
    syncedAt: '2026-01-01T00:00:00.000Z',
  });
  await writeFile(join(dir, MARKER), marker);
  return { hash, marker };
}

/** 印の無い古い写し（設計 §6.3 #8 → updated: legacy、退避あり）。 */
async function volumeLegacy(id: string): Promise<{ hash: string; marker: null }> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, id, OLD_FILES);
  return { hash: await hashPluginTree(dir), marker: null };
}

async function readMarkerRaw(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, MARKER), 'utf8');
  } catch {
    return null;
  }
}

/** OS のエラーを模した例外。`message` と `stack` に絶対パスとスタックを含める（#33）。 */
function osError(code: string, path: string): Error {
  const message = `SECRET-MESSAGE-7Q2 ${code}: operation failed, '${path}'`;
  const error = Object.assign(new Error(message), { code, path });
  error.stack = `Error: ${message}\n    at copyDir (${join(root, 'internal.js')}:10:5)\n    at async sync (node:internal/fs:1:1)`;
  return error;
}

type Inject = (base: SyncFileOps) => SyncFileOps;

async function sync(inject?: Inject): Promise<{
  exitCode: 0 | 1;
  failed: number;
  out: string;
  err: string;
}> {
  const { syncBundledPlugins, nodeFileOps } = await loadSync();
  let out = '';
  let err = '';
  const result = await syncBundledPlugins({
    bundledDir,
    pluginsDir,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ops: inject === undefined ? nodeFileOps : inject(nodeFileOps),
    now: () => new Date('2026-10-02T03:04:05.000Z'),
  });
  return { exitCode: result.exitCode, failed: result.summary.failed, out, err };
}

/** §6.4.1 の 1：alpha の作業用 T への写しが、途中まで書いたところで ENOSPC で失敗する。 */
const failCopyHalfway: Inject = (base) => ({
  ...base,
  copyDir: async (from, to) => {
    if (basename(to) === TMP_OF('alpha')) {
      await mkdir(to, { recursive: true });
      await writeFile(join(to, 'plugin.json'), '{"id":"alpha"');
      throw osError('ENOSPC', join(to, 'index.ts'));
    }
    return base.copyDir(from, to);
  },
});

/** §6.4.1 の 5：alpha の T を D へ動かす最後の rename が失敗する。 */
const failFinalRename: Inject = (base) => ({
  ...base,
  rename: async (from, to) => {
    if (basename(from) === TMP_OF('alpha')) {
      throw osError('EACCES', to);
    }
    return base.rename(from, to);
  },
});

/** §6.4.1 の 2：写しは正常に返るが、T から 1 ファイルが欠けている。 */
const dropFileAfterCopy: Inject = (base) => ({
  ...base,
  copyDir: async (from, to) => {
    await base.copyDir(from, to);
    if (basename(to) === TMP_OF('alpha')) {
      await unlink(join(to, 'new.ts'));
    }
  },
});

describe('失敗の注入', () => {
  describe('#29 写しの途中で失敗する', () => {
    it('#29 D の木のハッシュは前のまま', async () => {
      await bundle('alpha');
      await bundle('beta');
      const before = await volumeSyncedOld('alpha');

      await sync(failCopyHalfway);

      expect(await hashPluginTree(join(pluginsDir, 'alpha'))).toBe(before.hash);
      expect(await readMarkerRaw(join(pluginsDir, 'alpha'))).toBe(before.marker);
    });

    it('#29 作業用の T は残らない', async () => {
      await bundle('alpha');
      await bundle('beta');
      await volumeSyncedOld('alpha');

      await sync(failCopyHalfway);

      expect(await exists(join(pluginsDir, TMP_OF('alpha')))).toBe(false);
    });

    it('#29 その ID は FAILED（標準エラー）', async () => {
      await bundle('alpha');
      await bundle('beta');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(result.err).toContain(`${PREFIX}alpha FAILED: ENOSPC`);
      expect(result.failed).toBe(1);
    });

    it('#29 失敗した ID があっても他の ID は処理される', async () => {
      await bundle('alpha');
      const beta = await bundle('beta');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(await hashPluginTree(join(pluginsDir, 'beta'))).toBe(beta);
      expect(result.out).toContain(`${PREFIX}beta restored`);
    });

    it('#29 終了コードは 1', async () => {
      await bundle('alpha');
      await bundle('beta');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(result.exitCode).toBe(1);
    });

    it('#29 要約の failed に数える', async () => {
      await bundle('alpha');
      await bundle('beta');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(result.out).toMatch(
        /\[torifune\] bundled plugins: summary updated=0 restored=1 adopted=0 unchanged=0 skipped=0 kept=0 failed=1 untouched=0\n?$/,
      );
    });
  });

  describe.each<
    readonly [string, (id: string) => Promise<{ hash: string; marker: string | null }>]
  >([
    ['updated（印つき。D は O へ動いている）', volumeSyncedOld],
    ['updated: legacy（D は退避へ動いている）', volumeLegacy],
  ])('#30 最後の rename で失敗する：%s', (_label, arrange) => {
    it('#30 動かした中身が D に戻る（木のハッシュと印が前と等しい）', async () => {
      await bundle('alpha');
      const before = await arrange('alpha');

      await sync(failFinalRename);

      const dir = join(pluginsDir, 'alpha');
      expect(await hashPluginTree(dir)).toBe(before.hash);
      expect(await readMarkerRaw(dir)).toBe(before.marker);
    });

    it('#30 作業用の T は残らない', async () => {
      await bundle('alpha');
      await arrange('alpha');

      await sync(failFinalRename);

      expect(await exists(join(pluginsDir, TMP_OF('alpha')))).toBe(false);
    });

    it('#30 その ID は FAILED で、終了コードは 1', async () => {
      await bundle('alpha');
      await arrange('alpha');

      const result = await sync(failFinalRename);

      expect(result.err).toContain(`${PREFIX}alpha FAILED: EACCES`);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('#31 写した T の木のハッシュが I と違う', () => {
    it('#31 置き換えず、D は前のまま', async () => {
      await bundle('alpha');
      const before = await volumeSyncedOld('alpha');

      await sync(dropFileAfterCopy);

      const dir = join(pluginsDir, 'alpha');
      expect(await hashPluginTree(dir)).toBe(before.hash);
      expect(await readMarkerRaw(dir)).toBe(before.marker);
    });

    it('#31 その ID は FAILED（理由は copy mismatch）で、終了コードは 1', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');

      const result = await sync(dropFileAfterCopy);

      expect(result.err).toContain(`${PREFIX}alpha FAILED: copy mismatch`);
      expect(result.exitCode).toBe(1);
    });

    it('#31 作業用の T は残らない', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');

      await sync(dropFileAfterCopy);

      expect(await exists(join(pluginsDir, TMP_OF('alpha')))).toBe(false);
    });

    it('#31 フォルダが無い（restored）ときも、欠けた写しを置かない', async () => {
      await bundle('alpha');

      const result = await sync(dropFileAfterCopy);

      expect(await exists(join(pluginsDir, 'alpha'))).toBe(false);
      expect(result.err).toContain(`${PREFIX}alpha FAILED`);
    });
  });

  describe('#33 FAILED の理由', () => {
    it('#33 OS のエラーコード（ENOSPC）を出す', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(result.err).toContain('ENOSPC');
    });

    it('#33 絶対パスを含めない', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      const all = result.err + result.out;
      expect(all).not.toContain(root);
      expect(all).not.toContain(root.replaceAll('\\', '/'));
      expect(all).not.toContain(pluginsDir);
    });

    it('#33 例外の message の文字列を含めない', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(result.err + result.out).not.toContain('SECRET-MESSAGE-7Q2');
      expect(result.err + result.out).not.toContain('operation failed');
    });

    it('#33 スタックトレースを含めない', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');

      const result = await sync(failCopyHalfway);

      expect(result.err + result.out).not.toMatch(/\n\s+at /);
      expect(result.err + result.out).not.toContain('internal.js');
    });

    it('#33 OS のエラーコードの形でない例外は unknown error とだけ出す', async () => {
      await bundle('alpha');
      await volumeSyncedOld('alpha');
      const inject: Inject = (base) => ({
        ...base,
        copyDir: async (from, to) => {
          if (basename(to) === TMP_OF('alpha')) {
            throw new Error(`SECRET-MESSAGE-7Q2 something odd at ${to}`);
          }
          return base.copyDir(from, to);
        },
      });

      const result = await sync(inject);

      expect(result.err).toContain(`${PREFIX}alpha FAILED: unknown error`);
      expect(result.err).not.toContain('SECRET-MESSAGE-7Q2');
      expect(result.err).not.toContain(root);
    });
  });
});

describe('前回の残骸', () => {
  /** 4 と 5 の間で落ちた状態：D が無く、作業用の T と O、前の退避が残っている。 */
  async function arrangeLeftovers(): Promise<{ backupHash: string }> {
    await writePlugin(join(pluginsDir, TMP_OF('alpha')), 'alpha', { 'half.ts': 'x' });
    await writePlugin(join(pluginsDir, '.torifune-sync-alpha.old'), 'alpha', OLD_FILES);
    await writePlugin(join(pluginsDir, '.torifune-sync-gone.tmp'), 'gone', OLD_FILES);
    await writePlugin(join(pluginsDir, '.torifune-sync-gone.old'), 'gone', OLD_FILES);
    const backup = join(pluginsDir, BACKUP_DIR, 'alpha');
    await writePlugin(backup, 'alpha', { 'mine.ts': 'export const mine = 1;\n' });
    return { backupHash: await hashPluginTree(backup) };
  }

  it('#32 .torifune-sync-*.tmp と .torifune-sync-*.old は消える（写しに無い ID の残骸も）', async () => {
    await bundle('alpha');
    await arrangeLeftovers();

    await sync();

    const leftovers = (await readdir(pluginsDir)).filter((name) =>
      name.startsWith('.torifune-sync-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('#32 D は写しで restored になる', async () => {
    const bundledHash = await bundle('alpha');
    await arrangeLeftovers();

    const result = await sync();

    expect(await hashPluginTree(join(pluginsDir, 'alpha'))).toBe(bundledHash);
    expect(result.out).toContain(`${PREFIX}alpha restored`);
    expect(result.exitCode).toBe(0);
  });

  it('#32 退避（.torifune-bundled-backup）は残る', async () => {
    await bundle('alpha');
    const { backupHash } = await arrangeLeftovers();

    await sync();

    expect(await hashPluginTree(join(pluginsDir, BACKUP_DIR, 'alpha'))).toBe(backupHash);
  });
});
