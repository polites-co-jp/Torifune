import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncBundledPlugins } from './sync-bundled.js';
import { hashPluginTree } from './tree-hash.js';

/**
 * 同期の守り（050-bundled-plugin-sync 設計 §6.2.2・§6.6.2、実装プラン §8 の 4・5）。
 *
 * * 印を書くとき、そこにあるシンボリックリンクを辿らない（Volume の外のファイルを書き換えない）
 * * ログの行に、Plugin ID の形でない名前をそのまま出さない（行の偽装を防ぐ。JSON の文字列として出す）
 * * 同梱の写しの plugin.json が読めない ID・Volume の `<id>` がディレクトリでない ID は、何もせず FAILED にする
 */

/** シンボリックリンクを作れるか（`tree-hash.test.ts` と同じ。作れない環境ではその件だけを飛ばす）。 */
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
if (!CAN_LINK_FILE || !CAN_LINK_DIR) {
  console.warn(
    '[sync-bundled-hardening.test] この環境ではシンボリックリンクを作れないため、リンクの件を飛ばす',
  );
}

/** ファイル名に改行を使えるか（Windows の NTFS では使えない）。 */
const CAN_NEWLINE_NAME = process.platform !== 'win32';

const PREFIX = '[torifune] bundled plugins: ';
const MARKER = '.torifune-bundled';
const NOW = new Date('2026-10-02T03:04:05.000Z');
const OUTSIDE_CONTENT = 'OUTSIDE-ORIGINAL-CONTENT';

const BUNDLED_FILES: Readonly<Record<string, string>> = {
  'index.ts': 'export function activate() {}\n',
  'help/credentials.md': '# 手順\n\n本文\n',
};

const OLD_FILES: Readonly<Record<string, string>> = {
  'index.ts': 'export function activate() { /* old */ }\n',
};

let root: string;
let bundledDir: string;
let pluginsDir: string;
let outsideFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'torifune-sync-'));
  bundledDir = join(root, 'bundled');
  pluginsDir = join(root, 'plugins');
  outsideFile = join(root, 'outside.txt');
  await mkdir(bundledDir);
  await mkdir(pluginsDir);
  await writeFile(outsideFile, OUTSIDE_CONTENT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(base: string, relative: string, content: string): Promise<void> {
  const path = join(base, ...relative.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writePlugin(
  dir: string,
  id: string,
  files: Readonly<Record<string, string>>,
  manifest: string | null = JSON.stringify({ id, name: id, version: '1.0.0' }),
): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (manifest !== null) {
    await writeFile(join(dir, 'plugin.json'), manifest);
  }
  for (const [relative, content] of Object.entries(files)) {
    await put(dir, relative, content);
  }
}

async function bundle(id: string): Promise<string> {
  await writePlugin(join(bundledDir, id), id, BUNDLED_FILES);
  return hashPluginTree(join(bundledDir, id));
}

/** 写しに無い ID で、有効な印がある（以前は同梱だった → kept の行が出る）。 */
async function volumeNoLongerBundled(name: string): Promise<void> {
  const dir = join(pluginsDir, name);
  await writePlugin(dir, 'old-bundled', OLD_FILES);
  await writeFile(
    join(dir, MARKER),
    JSON.stringify({ schema: 1, hash: await hashPluginTree(dir), version: '1.0.0' }),
  );
}

async function sync(): Promise<{ exitCode: 0 | 1; failed: number; out: string; err: string }> {
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
    now: () => NOW,
  });
  return { exitCode: result.exitCode, failed: result.summary.failed, out, err };
}

async function readMarkerJson(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, MARKER), 'utf8')) as Record<string, unknown>;
}

describe('印を書くときにシンボリックリンクを辿らない', () => {
  it.skipIf(!CAN_LINK_FILE)(
    'adopted：印の場所が Volume の外のファイルを指すシンボリックリンクでも、外のファイルは書き換わらない',
    async () => {
      const bundledHash = await bundle('alpha');
      const dir = join(pluginsDir, 'alpha');
      await cp(join(bundledDir, 'alpha'), dir, { recursive: true });
      await symlink(outsideFile, join(dir, MARKER), 'file');

      const result = await sync();

      expect(result.out).toContain(`${PREFIX}alpha adopted`);
      expect(await readFile(outsideFile, 'utf8')).toBe(OUTSIDE_CONTENT);
      expect((await lstat(join(dir, MARKER))).isFile()).toBe(true);
      expect((await readMarkerJson(dir))['hash']).toBe(bundledHash);
    },
  );

  it.skipIf(!CAN_LINK_FILE)(
    'restored：同梱の写しの直下の印がシンボリックリンクでも、リンク先のファイルは書き換わらず、置いたフォルダの印は通常のファイルになる',
    async () => {
      await bundle('alpha');
      await symlink(outsideFile, join(bundledDir, 'alpha', MARKER), 'file');
      const bundledHash = await hashPluginTree(join(bundledDir, 'alpha'));

      const result = await sync();

      const dir = join(pluginsDir, 'alpha');
      expect(result.out).toContain(`${PREFIX}alpha restored`);
      expect(await readFile(outsideFile, 'utf8')).toBe(OUTSIDE_CONTENT);
      expect((await lstat(join(dir, MARKER))).isFile()).toBe(true);
      expect((await readMarkerJson(dir))['hash']).toBe(bundledHash);
    },
  );
});

describe('ログの行に Plugin ID の形でない名前をそのまま出さない', () => {
  it('Plugin ID の形の名前は、そのまま出す（kept の行）', async () => {
    await volumeNoLongerBundled('old-bundled');

    const result = await sync();

    expect(result.out).toContain(`${PREFIX}old-bundled kept: no longer bundled\n`);
  });

  it('Plugin ID の形でない名前（大文字・空白）は、JSON の文字列として引用して出す（kept の行）', async () => {
    await volumeNoLongerBundled('Not An Id');

    const result = await sync();

    expect(result.out).toContain(`${PREFIX}"Not An Id" kept: no longer bundled\n`);
  });

  it('行区切りの文字（U+2028）を含む名前は、その文字をそのまま出さず、エスケープして出す（kept の行）', async () => {
    await volumeNoLongerBundled('evil\u2028[torifune] bundled plugins- fake');

    const result = await sync();

    expect(result.out).not.toContain('\u2028');
    expect(result.out).toContain(
      `${PREFIX}"evil\\u2028[torifune] bundled plugins- fake" kept: no longer bundled\n`,
    );
  });

  it.skipIf(!CAN_NEWLINE_NAME)('改行を含む名前で、偽の行を作れない（kept の行）', async () => {
    await volumeNoLongerBundled('evil\n[torifune] bundled plugins: summary failed=0');

    const result = await sync();

    const lines = result.out.split('\n');
    expect(lines.filter((line) => line.startsWith(`${PREFIX}summary`))).toHaveLength(1);
    expect(result.out).toContain(
      `${PREFIX}"evil\\n[torifune] bundled plugins: summary failed=0" kept: no longer bundled\n`,
    );
  });

  it('Plugin ID の形でない名前は、FAILED の行でも JSON の文字列として引用して出す', async () => {
    // 同梱の写しの plugin.json が無い → その ID は FAILED。
    await writePlugin(join(bundledDir, 'Bad\u2028Name'), 'bad', BUNDLED_FILES, null);

    const result = await sync();

    expect(result.err).not.toContain('\u2028');
    expect(result.err).toContain(`${PREFIX}"Bad\\u2028Name" FAILED: unreadable bundled manifest\n`);
  });
});

describe('同梱の写しの plugin.json が読めない（実装プラン §8 の 4）', () => {
  it.each<readonly [string, string | null]>([
    ['無い', null],
    ['JSON でない', '{ 壊れている'],
    ['version が文字列でない', JSON.stringify({ id: 'alpha', version: 1 })],
  ])(
    '写しの plugin.json が%s → その ID は FAILED: unreadable bundled manifest で、Volume のフォルダは前のまま',
    async (_label, manifest) => {
      await writePlugin(join(bundledDir, 'alpha'), 'alpha', BUNDLED_FILES, manifest);
      const dir = join(pluginsDir, 'alpha');
      await writePlugin(dir, 'alpha', OLD_FILES);
      const before = await hashPluginTree(dir);

      const result = await sync();

      expect(result.err).toContain(`${PREFIX}alpha FAILED: unreadable bundled manifest\n`);
      expect(await hashPluginTree(dir)).toBe(before);
      await expect(lstat(join(dir, MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('写しの plugin.json が読めない ID があっても、他の ID は処理され、終了コードは 1', async () => {
    await writePlugin(join(bundledDir, 'alpha'), 'alpha', BUNDLED_FILES, null);
    const beta = await bundle('beta');

    const result = await sync();

    expect(await hashPluginTree(join(pluginsDir, 'beta'))).toBe(beta);
    expect(result.out).toContain(`${PREFIX}beta restored`);
    expect(result.failed).toBe(1);
    expect(result.exitCode).toBe(1);
  });

  it('写しの plugin.json が読めず、Volume にフォルダが無いときも、何も置かない', async () => {
    await writePlugin(join(bundledDir, 'alpha'), 'alpha', BUNDLED_FILES, null);

    await sync();

    await expect(lstat(join(pluginsDir, 'alpha'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Volume の <id> がディレクトリでない（実装プラン §8 の 5）', () => {
  it('<id> が通常のファイル → その ID は FAILED: ENOTDIR で、ファイルは前のまま。他の ID は処理される', async () => {
    await bundle('alpha');
    const beta = await bundle('beta');
    await writeFile(join(pluginsDir, 'alpha'), 'not a directory');

    const result = await sync();

    expect(result.err).toContain(`${PREFIX}alpha FAILED: ENOTDIR\n`);
    expect(await readFile(join(pluginsDir, 'alpha'), 'utf8')).toBe('not a directory');
    expect(await hashPluginTree(join(pluginsDir, 'beta'))).toBe(beta);
    expect(result.exitCode).toBe(1);
  });

  it.skipIf(!CAN_LINK_DIR)(
    '<id> が Volume の外のフォルダを指すリンク → その ID は FAILED: ENOTDIR で、リンク先のフォルダは書き換わらない',
    async () => {
      await bundle('alpha');
      const outsideDir = join(root, 'outside-dir');
      await writePlugin(outsideDir, 'alpha', OLD_FILES);
      const before = await hashPluginTree(outsideDir);
      await symlink(outsideDir, join(pluginsDir, 'alpha'), dirLinkType());

      const result = await sync();

      expect(result.err).toContain(`${PREFIX}alpha FAILED: ENOTDIR\n`);
      expect(await hashPluginTree(outsideDir)).toBe(before);
      await expect(lstat(join(outsideDir, MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await lstat(join(pluginsDir, 'alpha'))).isSymbolicLink()).toBe(true);
    },
  );
});
