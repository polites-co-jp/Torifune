import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Plugin のフォルダの木のハッシュと、plugins 全体の指紋
 * （docs/設計/050-bundled-plugin-sync/設計.md §6.2.1・§6.7.1）。
 *
 * 木のハッシュは同梱の写しと Volume のフォルダを比べるのに使い、
 * 指紋は「ビルドに入りうる Plugin のソース全体」といまのビルドを比べるのに使う。
 */

/** 同期が同梱 Plugin のフォルダの直下に置く印（§6.2.2）。 */
export const BUNDLED_MARKER = '.torifune-bundled';

/** 再ビルドに失敗した Plugin のフォルダに本体が置く隔離マーク。 */
export const QUARANTINE_MARKER = '.torifune-quarantine';

/** 木のハッシュから除く、フォルダの直下の名前。下の階層の同名のファイルは除かない。 */
const TOP_LEVEL_EXCLUDED: ReadonlySet<string> = new Set([BUNDLED_MARKER, QUARANTINE_MARKER]);

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JavaScript の文字列比較（UTF-16 のコード単位の順）。ロケールに依らない。 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface TreeEntry {
  readonly path: string;
  readonly line: string;
}

/**
 * フォルダを再帰的にたどり、通常のファイルとシンボリックリンクを項目にする。
 *
 * **シンボリックリンクは辿らない**（Windows の junction も同じ）。リンク先の文字列を数えるだけで、
 * フォルダの外を指していても外のファイルは読まない。ディレクトリそのもの・それ以外の種別は数えない。
 */
async function collect(dir: string, relative: string, out: TreeEntry[]): Promise<void> {
  const names = await readdir(dir);
  for (const name of names) {
    if (relative === '' && TOP_LEVEL_EXCLUDED.has(name)) {
      continue;
    }
    const path = join(dir, name);
    const rel = relative === '' ? name : `${relative}/${name}`;
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      out.push({ path: rel, line: `l\0${rel}\0${sha256Hex(target)}\n` });
    } else if (info.isDirectory()) {
      await collect(path, rel, out);
    } else if (info.isFile()) {
      out.push({ path: rel, line: `f\0${rel}\0${sha256Hex(await readFile(path))}\n` });
    }
  }
}

/**
 * フォルダの中身を 1 つの値（`sha256:<64 桁の 16 進>`）にする（§6.2.1）。
 *
 * 実行ビット・所有者・時刻は含めない。
 */
export async function hashPluginTree(dir: string): Promise<string> {
  const entries: TreeEntry[] = [];
  await collect(dir, '', entries);
  entries.sort((a, b) => compareStrings(a.path, b.path));
  return `sha256:${sha256Hex(entries.map((entry) => entry.line).join(''))}`;
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * plugins の Plugin のソースの指紋（§6.7.1）。
 *
 * 対象はトップレベルの**ディレクトリ**のうち、名前が `.` で始まらず、直下に隔離マークが無いもの
 * （生成スクリプトが走査する範囲と同じ。シンボリックリンクは数えない）。トップレベルのファイルは含めない。
 * 木のハッシュが印と隔離マークを除くので、同期が印を書いても指紋は変わらない。
 */
export async function fingerprintPlugins(pluginsDir: string): Promise<string> {
  const entries = await readdir(pluginsDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort(compareStrings);

  const lines: string[] = [];
  for (const name of names) {
    const dir = join(pluginsDir, name);
    if (await entryExists(join(dir, QUARANTINE_MARKER))) {
      continue;
    }
    lines.push(`${name}\0${await hashPluginTree(dir)}\n`);
  }
  return `sha256:${sha256Hex(lines.join(''))}`;
}
