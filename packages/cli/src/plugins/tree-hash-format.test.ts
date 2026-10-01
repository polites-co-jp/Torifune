import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintPlugins, hashPluginTree } from './tree-hash.js';

/**
 * 木のハッシュと指紋の**値の形**（050-bundled-plugin-sync 設計 §6.2.1・§6.7.1）。
 *
 * `tree-hash.test.ts` は「変わる・変わらない」を見る。ここは設計が決めた**行の形と並べ方**そのものを固定する。
 *
 * * 既知の答え：小さな決まった木の値を、設計の式（`<種別>\0<相対パス>\0<SHA-256>\n` を相対パスの昇順に連結）で
 *   本体とは別に計算した値と比べる。値は設計の式だけから求めた（下の各定数の注）
 * * 列挙の順：`readdir` の返す順を逆にしても同じ値になる（並べ替えを落とした誤りを見分ける）。
 *   `readdir` は外部境界（ファイルシステム）なので、順だけを差し替える
 * * 行の各部：同じ並び順のままの改名・ファイルとシンボリックリンクの取り違え・名前と中身の入れ替えを見分ける
 */

/** `readdir` の結果を逆順にするか。既定は本物のまま。 */
const readdirOrder = vi.hoisted(() => ({ reverse: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const readdir = async (...args: unknown[]): Promise<unknown> => {
    const result = (await (actual.readdir as (...a: unknown[]) => Promise<unknown[]>)(
      ...args,
    )) as unknown[];
    return readdirOrder.reverse ? [...result].reverse() : result;
  };
  return { ...actual, readdir, default: { ...actual, readdir } };
});

/** シンボリックリンクを作れるか（`tree-hash.test.ts` と同じ。作れない環境ではその件だけを飛ばす）。 */
function probeFileLink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'torifune-sync-probe-'));
  try {
    writeFileSync(join(probe, 'target.txt'), 'x');
    symlinkSync('target.txt', join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const CAN_LINK_FILE = probeFileLink();
if (!CAN_LINK_FILE) {
  console.warn(
    '[tree-hash-format.test] この環境ではシンボリックリンクを作れないため、リンクを含む件を飛ばす',
  );
}

/**
 * 既知の答えの木。名前の選び方に意味がある：
 *
 * * `B.txt` と `a.txt`：JavaScript の文字列比較では `B` < `a`。大文字小文字を区別しない列挙（NTFS など）とは順が逆になる
 * * `lib-x.ts` と `lib/util.ts`：`-`（0x2D）< `/`（0x2F）なので `lib-x.ts` が先。
 *   ディレクトリごとに並べてたどる（`lib` → `lib/util.ts` → `lib-x.ts`）と順が逆になる
 * * `.torifune-bundled`：直下の印は除く（§6.2.1）
 */
const KNOWN_TREE: Readonly<Record<string, string>> = {
  'plugin.json': '{"id":"alpha","version":"1.0.0"}',
  'index.ts': 'export function activate() {}\n',
  'B.txt': 'upper\n',
  'a.txt': 'lower\n',
  'lib/util.ts': 'export const x = 1;\n',
  'lib-x.ts': 'export const y = 2;\n',
  '.torifune-bundled': '{"schema":1,"hash":"sha256:ignored"}',
};

/**
 * KNOWN_TREE の木のハッシュ。設計 §6.2.1 の式で次の 6 行（この順）を連結した SHA-256：
 * `f\0B.txt\0…`・`f\0a.txt\0…`・`f\0index.ts\0…`・`f\0lib-x.ts\0…`・`f\0lib/util.ts\0…`・`f\0plugin.json\0…`
 */
const KNOWN_TREE_HASH = 'sha256:77a5ff25a8deb631d08dae87caccb1537a7d5987196e6b808ba8ef59954b7dfb';

/** KNOWN_TREE に、リンク先の文字列が `a.txt` のシンボリックリンク `link.txt` を足した木（`l\0link.txt\0<sha256("a.txt")>` が最後の行の前に入る）。 */
const KNOWN_TREE_WITH_LINK_HASH =
  'sha256:521469d77c4a1e6495aadcbfbfdc681bb93f2def1506cc3e70d078f1c8892e81';

/** `plugin.json`（中身 `{"id":"zeta"}`）だけの木。 */
const SMALL_TREE_HASH = 'sha256:dc366e6dc8747141c64a7cf00c09ae1f19798c27163faa29ed94a10d72f4df4c';

/**
 * `beta`（KNOWN_TREE）と `Zeta`（`plugin.json` だけ）の plugins の指紋。設計 §6.7.1 の式で
 * `Zeta\0<SMALL_TREE_HASH>\n`・`beta\0<KNOWN_TREE_HASH>\n` の順（`Z` < `b`）に連結した SHA-256。
 */
const KNOWN_FINGERPRINT = 'sha256:062cf8f52e2c9c3fcbfede77d06160e95013095f459c470a23c9c3f06eb3083c';

let root: string;

beforeEach(async () => {
  readdirOrder.reverse = false;
  root = await mkdtemp(join(tmpdir(), 'torifune-sync-'));
});

afterEach(async () => {
  readdirOrder.reverse = false;
  await rm(root, { recursive: true, force: true });
});

async function put(base: string, relative: string, content: string): Promise<void> {
  const path = join(base, ...relative.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

/** 木を作る。`order` でファイルを置く順を変えられる。 */
async function makeTree(
  dir: string,
  files: Readonly<Record<string, string>>,
  order: 'forward' | 'reverse' = 'forward',
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const entries = Object.entries(files);
  for (const [relative, content] of order === 'forward' ? entries : entries.reverse()) {
    await put(dir, relative, content);
  }
}

async function makeKnownPlugins(pluginsDir: string): Promise<void> {
  await makeTree(join(pluginsDir, 'beta'), KNOWN_TREE);
  await makeTree(join(pluginsDir, 'Zeta'), { 'plugin.json': '{"id":"zeta"}' });
  await makeTree(join(pluginsDir, '.hidden'), { 'plugin.json': '{}' });
  await put(pluginsDir, 'README.md', '# plugins\n');
}

describe('木のハッシュの既知の答え（§6.2.1）', () => {
  it('決まった木の木のハッシュは、設計の式で求めた値と等しい', async () => {
    const dir = join(root, 'alpha');
    await makeTree(dir, KNOWN_TREE);

    expect(await hashPluginTree(dir)).toBe(KNOWN_TREE_HASH);
  });

  it('ファイルを逆の順に作っても、設計の式で求めた値と等しい', async () => {
    const dir = join(root, 'alpha');
    await makeTree(dir, KNOWN_TREE, 'reverse');

    expect(await hashPluginTree(dir)).toBe(KNOWN_TREE_HASH);
  });

  it('ディレクトリの列挙の順を逆にしても、設計の式で求めた値と等しい（相対パスの昇順に並べる）', async () => {
    const dir = join(root, 'alpha');
    await makeTree(dir, KNOWN_TREE);

    readdirOrder.reverse = true;

    expect(await hashPluginTree(dir)).toBe(KNOWN_TREE_HASH);
  });

  it.skipIf(!CAN_LINK_FILE)(
    'シンボリックリンクを含む決まった木の木のハッシュは、設計の式（種別 l・リンク先の文字列のハッシュ）で求めた値と等しい',
    async () => {
      const dir = join(root, 'alpha');
      await makeTree(dir, KNOWN_TREE);
      await symlink('a.txt', join(dir, 'link.txt'), 'file');

      expect(await hashPluginTree(dir)).toBe(KNOWN_TREE_WITH_LINK_HASH);
    },
  );
});

describe('木のハッシュの行の各部（§6.2.1）', () => {
  it('並び順の変わらない改名（index.ts → index2.ts）でも木のハッシュが変わる（行に相対パスを含む）', async () => {
    const dir = join(root, 'alpha');
    await makeTree(dir, KNOWN_TREE);
    const before = await hashPluginTree(dir);

    // a.txt < index.ts < index2.ts < lib-x.ts なので、行の並びは変わらない。
    await rename(join(dir, 'index.ts'), join(dir, 'index2.ts'));

    expect(await hashPluginTree(dir)).not.toBe(before);
  });

  it.skipIf(!CAN_LINK_FILE)(
    '並び順の変わらないシンボリックリンクの改名（link.txt → link2.txt）でも木のハッシュが変わる',
    async () => {
      const dir = join(root, 'alpha');
      await makeTree(dir, KNOWN_TREE);
      await symlink('a.txt', join(dir, 'link.txt'), 'file');
      const before = await hashPluginTree(dir);

      // lib/util.ts < link.txt < link2.txt < plugin.json なので、行の並びは変わらない。
      await rename(join(dir, 'link.txt'), join(dir, 'link2.txt'));

      expect(await hashPluginTree(dir)).not.toBe(before);
    },
  );

  it.skipIf(!CAN_LINK_FILE)(
    '中身がリンク先の文字列と同じ通常のファイルと、そのシンボリックリンクとは、木のハッシュが違う（種別を区別する）',
    async () => {
      const asFile = join(root, 'as-file');
      const asLink = join(root, 'as-link');
      await makeTree(asFile, KNOWN_TREE);
      await makeTree(asLink, KNOWN_TREE);
      await writeFile(join(asFile, 'link.txt'), 'a.txt');
      await symlink('a.txt', join(asLink, 'link.txt'), 'file');

      expect(await hashPluginTree(asFile)).not.toBe(await hashPluginTree(asLink));
    },
  );
});

describe('指紋の既知の答え（§6.7.1）', () => {
  it('決まった plugins の指紋は、設計の式で求めた値と等しい', async () => {
    const pluginsDir = join(root, 'plugins');
    await makeKnownPlugins(pluginsDir);

    expect(await hashPluginTree(join(pluginsDir, 'Zeta'))).toBe(SMALL_TREE_HASH);
    expect(await fingerprintPlugins(pluginsDir)).toBe(KNOWN_FINGERPRINT);
  });

  it('ディレクトリの列挙の順を逆にしても、設計の式で求めた値と等しい（名前の昇順に並べる）', async () => {
    const pluginsDir = join(root, 'plugins');
    await makeKnownPlugins(pluginsDir);

    readdirOrder.reverse = true;

    expect(await fingerprintPlugins(pluginsDir)).toBe(KNOWN_FINGERPRINT);
  });
});

describe('指紋の行の各部（§6.7.1）', () => {
  it('2 つの Plugin の中身を名前の間で入れ替えると指紋が変わる', async () => {
    const first = join(root, 'first');
    const second = join(root, 'second');
    await makeTree(join(first, 'alpha'), KNOWN_TREE);
    await makeTree(join(first, 'beta'), { 'plugin.json': '{"id":"zeta"}' });
    await makeTree(join(second, 'alpha'), { 'plugin.json': '{"id":"zeta"}' });
    await makeTree(join(second, 'beta'), KNOWN_TREE);

    expect(await fingerprintPlugins(first)).not.toBe(await fingerprintPlugins(second));
  });

  it('並び順の変わらないディレクトリの改名（alpha → alpha2）でも指紋が変わる（行にディレクトリ名を含む）', async () => {
    const pluginsDir = join(root, 'plugins');
    await makeTree(join(pluginsDir, 'alpha'), KNOWN_TREE);
    await makeTree(join(pluginsDir, 'beta'), { 'plugin.json': '{"id":"zeta"}' });
    const before = await fingerprintPlugins(pluginsDir);

    // alpha < alpha2 < beta なので、行の並びは変わらない。
    await rename(join(pluginsDir, 'alpha'), join(pluginsDir, 'alpha2'));

    expect(await fingerprintPlugins(pluginsDir)).not.toBe(before);
  });
});

/** 隔離マークの見方（§6.7.1。生成スクリプトと揃える：辿らずに、何かの項目としてあれば隔離）。 */
describe('指紋の隔離マーク', () => {
  it.skipIf(!CAN_LINK_FILE)(
    'リンク先の無いシンボリックリンクの隔離マークも「隔離されている」として指紋から除く',
    async () => {
      const pluginsDir = join(root, 'plugins');
      await makeKnownPlugins(pluginsDir);
      const before = await fingerprintPlugins(pluginsDir);

      await makeTree(join(pluginsDir, 'broken'), { 'plugin.json': '{"id":"broken"}' });
      await symlink('no-such-target', join(pluginsDir, 'broken', '.torifune-quarantine'), 'file');

      expect(await fingerprintPlugins(pluginsDir)).toBe(before);
    },
  );
});
