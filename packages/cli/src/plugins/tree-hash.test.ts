import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 木のハッシュと指紋（050-bundled-plugin-sync 設計 §6.2.1・§6.7.1、受け入れ条件 #1〜#6）。
 *
 * 木のハッシュは「フォルダの中身」を 1 つの値にする。同梱の写しと Volume のフォルダを比べる。
 * 指紋は「ビルドに入りうる Plugin のソース全体」を 1 つの値にする。
 *
 * **モジュールはまだ無い**（実装プラン T1。T2 で `tree-hash.ts` を足す）。型検査を通すため、
 * 指定子を変数にした動的 import で読み、実装プラン §2「モジュールの形」の型を当てる。
 */

interface TreeHashModule {
  readonly BUNDLED_MARKER: string;
  readonly QUARANTINE_MARKER: string;
  hashPluginTree(dir: string): Promise<string>;
  fingerprintPlugins(pluginsDir: string): Promise<string>;
}

const TREE_HASH_MODULE = './tree-hash.js';
let treeHashModule: Promise<TreeHashModule> | undefined;

function loadTreeHash(): Promise<TreeHashModule> {
  treeHashModule ??= import(/* @vite-ignore */ TREE_HASH_MODULE) as Promise<TreeHashModule>;
  return treeHashModule;
}

async function hashPluginTree(dir: string): Promise<string> {
  return (await loadTreeHash()).hashPluginTree(dir);
}

async function fingerprintPlugins(pluginsDir: string): Promise<string> {
  return (await loadTreeHash()).fingerprintPlugins(pluginsDir);
}

const HASH_FORM = /^sha256:[0-9a-f]{64}$/;

/**
 * シンボリックリンクを作れるか（設計 #4 の注。`plugin/help-files.test.ts` と同じ流儀）。
 *
 * Windows では権限（開発者モード・管理者）が無いとファイルのシンボリックリンクを作れない。
 * **作れない環境ではその件だけを飛ばし、飛ばしたことを出力に残す。** CI（Linux）では常に作れる。
 */
function probeLink(kind: 'file' | 'dir'): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'torifune-sync-probe-'));
  try {
    const target = join(probe, kind === 'file' ? 'target.txt' : 'target');
    if (kind === 'file') {
      writeFileSync(target, 'x');
    } else {
      mkdirSync(target);
    }
    symlinkSync(target, join(probe, 'link'), kind === 'file' ? 'file' : dirLinkType());
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/** フォルダのリンクの種類。Windows では権限なしで作れる junction を使う。 */
function dirLinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

const CAN_LINK_FILE = probeLink('file');
const CAN_LINK_DIR = probeLink('dir');

if (!CAN_LINK_FILE) {
  console.warn(
    '[tree-hash.test] この環境ではファイルのシンボリックリンクを作れないため、#4 のリンクの件を飛ばす',
  );
}
if (!CAN_LINK_DIR) {
  console.warn(
    '[tree-hash.test] この環境ではフォルダのリンクを作れないため、#4 のフォルダのリンクの件を飛ばす',
  );
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'torifune-sync-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** `base` の下の `relative`（`/` 区切り）へファイルを置く。途中のフォルダは作る。 */
async function put(base: string, relative: string, content: string): Promise<void> {
  const path = join(base, ...relative.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** 決まった中身の Plugin のフォルダを作る。`order` でファイルを置く順を変えられる。 */
async function makePlugin(dir: string, order: 'forward' | 'reverse' = 'forward'): Promise<void> {
  const files: readonly (readonly [string, string])[] = [
    ['plugin.json', '{"id":"alpha","version":"1.0.0"}'],
    ['index.ts', 'export function activate() {}\n'],
    ['help/credentials.md', '# 手順\n\n本文\n'],
    ['lib/deep/util.ts', 'export const x = 1;\n'],
  ];
  const ordered = order === 'forward' ? files : [...files].reverse();
  await mkdir(dir, { recursive: true });
  for (const [relative, content] of ordered) {
    await put(dir, relative, content);
  }
}

describe('木のハッシュ', () => {
  it('#1 同じファイルを別の順序で作った 2 つのフォルダは、木のハッシュが等しい', async () => {
    const a = join(root, 'a', 'alpha');
    const b = join(root, 'b', 'other-name');
    await makePlugin(a, 'forward');
    await makePlugin(b, 'reverse');

    expect(await hashPluginTree(a)).toBe(await hashPluginTree(b));
  });

  it('#1 木のハッシュの形は sha256:<64 桁の 16 進>', async () => {
    const dir = join(root, 'alpha');
    await makePlugin(dir);

    expect(await hashPluginTree(dir)).toMatch(HASH_FORM);
  });

  it.each<readonly [string, (dir: string) => Promise<void>]>([
    [
      'ファイルの中身を 1 バイト変える',
      (dir) => put(dir, 'index.ts', 'export function activate() {}\r'),
    ],
    ['ファイルを足す', (dir) => put(dir, 'extra.ts', '')],
    ['ファイルを消す', (dir) => unlink(join(dir, 'help', 'credentials.md'))],
    ['ファイルの名前を変える', (dir) => rename(join(dir, 'index.ts'), join(dir, 'main.ts'))],
    [
      'ファイルを下の階層へ動かす',
      async (dir) => {
        await mkdir(join(dir, 'src'));
        await rename(join(dir, 'index.ts'), join(dir, 'src', 'index.ts'));
      },
    ],
  ])('#2 %s と木のハッシュが変わる', async (_label, mutate) => {
    const dir = join(root, 'alpha');
    await makePlugin(dir);
    const before = await hashPluginTree(dir);

    await mutate(dir);

    expect(await hashPluginTree(dir)).not.toBe(before);
  });

  it.each(['.torifune-bundled', '.torifune-quarantine'])(
    '#3 フォルダ直下の %s を足しても木のハッシュは変わらない',
    async (name) => {
      const dir = join(root, 'alpha');
      await makePlugin(dir);
      const before = await hashPluginTree(dir);

      await put(dir, name, '{"schema":1,"hash":"sha256:' + '0'.repeat(64) + '"}');

      expect(await hashPluginTree(dir)).toBe(before);
    },
  );

  it.each(['.torifune-bundled', '.torifune-quarantine'])(
    '#3 フォルダ直下の %s を書き換えても木のハッシュは変わらない',
    async (name) => {
      const dir = join(root, 'alpha');
      await makePlugin(dir);
      await put(dir, name, 'first');
      const before = await hashPluginTree(dir);

      await put(dir, name, 'second, longer content');

      expect(await hashPluginTree(dir)).toBe(before);
    },
  );

  it('#3 印と隔離マークの名前は設計 §6.2.1 のとおり公開されている', async () => {
    const module = await loadTreeHash();

    expect(module.BUNDLED_MARKER).toBe('.torifune-bundled');
    expect(module.QUARANTINE_MARKER).toBe('.torifune-quarantine');
  });

  it.each(['.torifune-bundled', '.torifune-quarantine'])(
    '#3 下の階層にある同名のファイル（%s）を足すと木のハッシュが変わる',
    async (name) => {
      const dir = join(root, 'alpha');
      await makePlugin(dir);
      const before = await hashPluginTree(dir);

      await put(dir, `lib/${name}`, 'x');

      expect(await hashPluginTree(dir)).not.toBe(before);
    },
  );

  it('#4 空のディレクトリを足しても木のハッシュは変わらない', async () => {
    const dir = join(root, 'alpha');
    await makePlugin(dir);
    const before = await hashPluginTree(dir);

    await mkdir(join(dir, 'empty'));
    await mkdir(join(dir, 'lib', 'nested', 'also-empty'), { recursive: true });

    expect(await hashPluginTree(dir)).toBe(before);
  });

  it.skipIf(!CAN_LINK_FILE)(
    '#4 フォルダの外を指すシンボリックリンクは辿らない（リンク先のファイルの中身を変えても木のハッシュは変わらない）',
    async () => {
      const dir = join(root, 'alpha');
      await makePlugin(dir);
      await writeFile(join(root, 'outside.txt'), 'OUTSIDE-1');
      await symlink(join('..', 'outside.txt'), join(dir, 'link.txt'), 'file');
      const before = await hashPluginTree(dir);

      await writeFile(join(root, 'outside.txt'), 'OUTSIDE-2 の別の中身');

      expect(await hashPluginTree(dir)).toBe(before);
    },
  );

  it.skipIf(!CAN_LINK_FILE)(
    '#4 シンボリックリンクのリンク先の文字列を変えると木のハッシュが変わる',
    async () => {
      const dir = join(root, 'alpha');
      await makePlugin(dir);
      // 2 つのリンク先は同じ中身にする（中身ではなく文字列で数えていることを確かめる）。
      await writeFile(join(root, 'outside-a.txt'), 'SAME');
      await writeFile(join(root, 'outside-b.txt'), 'SAME');
      await symlink(join('..', 'outside-a.txt'), join(dir, 'link.txt'), 'file');
      const before = await hashPluginTree(dir);

      await unlink(join(dir, 'link.txt'));
      await symlink(join('..', 'outside-b.txt'), join(dir, 'link.txt'), 'file');

      expect(await hashPluginTree(dir)).not.toBe(before);
    },
  );

  it.skipIf(!CAN_LINK_DIR)(
    '#4 フォルダの外のフォルダを指すリンクは辿らない（リンク先にファイルを足しても木のハッシュは変わらない）',
    async () => {
      const dir = join(root, 'alpha');
      const outside = join(root, 'outside-dir');
      await makePlugin(dir);
      await put(outside, 'secret.txt', 'OUTSIDE');
      await symlink(outside, join(dir, 'linked'), dirLinkType());
      const before = await hashPluginTree(dir);

      await put(outside, 'more.txt', 'MORE');

      expect(await hashPluginTree(dir)).toBe(before);
    },
  );
});

describe('指紋', () => {
  /** 同梱 Plugin 2 つと README だけの plugins を作る。 */
  async function makePlugins(pluginsDir: string): Promise<void> {
    await makePlugin(join(pluginsDir, 'alpha'));
    await makePlugin(join(pluginsDir, 'beta'), 'reverse');
    await put(pluginsDir, 'README.md', '# plugins\n');
  }

  it('#5 指紋の形は sha256:<64 桁の 16 進>', async () => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);

    expect(await fingerprintPlugins(pluginsDir)).toMatch(HASH_FORM);
  });

  it('#5 トップレベルの通常のディレクトリを足すと指紋が変わる', async () => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);
    const before = await fingerprintPlugins(pluginsDir);

    await makePlugin(join(pluginsDir, 'gamma'));

    expect(await fingerprintPlugins(pluginsDir)).not.toBe(before);
  });

  it('#5 トップレベルのディレクトリの中のファイルを変えると指紋が変わる', async () => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);
    const before = await fingerprintPlugins(pluginsDir);

    await put(pluginsDir, 'beta/lib/deep/util.ts', 'export const x = 2;\n');

    expect(await fingerprintPlugins(pluginsDir)).not.toBe(before);
  });

  it.each([
    ['.torifune-sync-gamma.tmp'],
    ['.torifune-sync-alpha.old'],
    ['.torifune-bundled-backup'],
    ['.hidden'],
  ])('#5 名前が . で始まるディレクトリ（%s）を足しても指紋は変わらない', async (name) => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);
    const before = await fingerprintPlugins(pluginsDir);

    // plugin.json を持たせても数えない（作業用の写しは plugin.json を持つ）。
    await makePlugin(join(pluginsDir, name));
    await makePlugin(join(pluginsDir, name, 'alpha'));

    expect(await fingerprintPlugins(pluginsDir)).toBe(before);
  });

  it('#5 隔離マークのあるディレクトリを足しても指紋は変わらない', async () => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);
    const before = await fingerprintPlugins(pluginsDir);

    await makePlugin(join(pluginsDir, 'broken'));
    await put(pluginsDir, 'broken/.torifune-quarantine', 'build failed');

    expect(await fingerprintPlugins(pluginsDir)).toBe(before);
  });

  it('#5 トップレベルのファイルを足しても指紋は変わらない', async () => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);
    const before = await fingerprintPlugins(pluginsDir);

    await put(pluginsDir, 'NOTES.txt', 'memo');
    await put(pluginsDir, 'README.md', '# plugins（書き換え）\n');

    expect(await fingerprintPlugins(pluginsDir)).toBe(before);
  });

  it('#5 各フォルダに印（.torifune-bundled）を書いても指紋は変わらない', async () => {
    const pluginsDir = join(root, 'plugins');
    await makePlugins(pluginsDir);
    const before = await fingerprintPlugins(pluginsDir);

    for (const id of ['alpha', 'beta']) {
      const hash = await hashPluginTree(join(pluginsDir, id));
      await put(
        pluginsDir,
        `${id}/.torifune-bundled`,
        JSON.stringify({ schema: 1, hash, version: '1.0.0', syncedAt: '2026-10-02T00:00:00.000Z' }),
      );
    }

    expect(await fingerprintPlugins(pluginsDir)).toBe(before);
  });

  it('#6 同じ中身を別の順に作った 2 つの plugins は、指紋が等しい', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');

    await makePlugin(join(first, 'alpha'), 'forward');
    await makePlugin(join(first, 'beta'), 'forward');
    await makePlugin(join(first, 'gamma'), 'forward');

    await makePlugin(join(second, 'gamma'), 'reverse');
    await makePlugin(join(second, 'alpha'), 'reverse');
    await makePlugin(join(second, 'beta'), 'reverse');

    expect(await fingerprintPlugins(first)).toBe(await fingerprintPlugins(second));
  });
});
