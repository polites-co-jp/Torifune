import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 同梱 Plugin の同期の適用（050-bundled-plugin-sync 設計 §6.3・§6.4・§6.6.2、
 * 受け入れ条件 #17〜#19・#21〜#23・#25・#26、#14 の観測）。
 *
 * 一時ディレクトリの配置：
 *
 * ```text
 * <root>/
 *   bundled/<id>/…   … 同梱の写し（イメージの /app/.torifune-bundled-plugins に当たる）
 *   plugins/<id>/…   … Volume（/app/plugins に当たる）
 * ```
 *
 * **モジュールはまだ無い**（実装プラン T1。T2・T4 で足す）。型検査を通すため、
 * 指定子を変数にした動的 import で読み、実装プラン §2「モジュールの形」の型を当てる。
 */

interface SyncSummary {
  readonly updated: number;
  readonly restored: number;
  readonly adopted: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly kept: number;
  readonly failed: number;
  readonly untouched: number;
}

interface SyncModule {
  syncBundledPlugins(options: {
    readonly bundledDir: string;
    readonly pluginsDir: string;
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
    readonly now?: () => Date;
  }): Promise<{ readonly exitCode: 0 | 1; readonly summary: SyncSummary }>;
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
    '[sync-bundled.test] この環境ではシンボリックリンクを作れないため、#17 のリンクの件を飛ばす',
  );
}

const PREFIX = '[torifune] bundled plugins: ';
const MARKER = '.torifune-bundled';
const QUARANTINE = '.torifune-quarantine';
const BACKUP_DIR = '.torifune-bundled-backup';
const NOW = new Date('2026-10-02T03:04:05.000Z');
const OLD_SYNCED_AT = '2026-01-01T00:00:00.000Z';
const FOREIGN_HASH = `sha256:${'f'.repeat(64)}`;

/** 同梱の写しの中身（新しいイメージ）。 */
const BUNDLED_FILES: Readonly<Record<string, string>> = {
  'index.ts': 'export function activate() {}\n',
  'help/credentials.md': '# 手順\n\n本文\n',
  'new.ts': 'export const added = true;\n',
};

/** Volume に残った古い中身（古いイメージ）。 */
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

/**
 * Plugin のフォルダを作る。`manifest` を省くと `{ id, name, version }` の plugin.json を置く。
 * `null` なら plugin.json を置かない。文字列ならそのまま置く。
 */
async function writePlugin(
  dir: string,
  options: {
    readonly id: string;
    readonly version?: string;
    readonly files: Readonly<Record<string, string>>;
    readonly manifest?: string | null;
  },
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const manifest =
    options.manifest === undefined
      ? JSON.stringify(
          { id: options.id, name: options.id, version: options.version ?? '1.0.0' },
          null,
          2,
        )
      : options.manifest;
  if (manifest !== null) {
    await writeFile(join(dir, 'plugin.json'), manifest);
  }
  for (const [relative, content] of Object.entries(options.files)) {
    await put(dir, relative, content);
  }
}

/** 同梱の写しに Plugin を置き、その木のハッシュ（I）を返す。 */
async function bundle(id: string, version = '1.0.0', files = BUNDLED_FILES): Promise<string> {
  const dir = join(bundledDir, id);
  await writePlugin(dir, { id, version, files });
  return hashPluginTree(dir);
}

/** Volume のフォルダに印を書く。 */
async function writeMarker(dir: string, hash: string, version = '1.0.0'): Promise<void> {
  await writeFile(
    join(dir, MARKER),
    JSON.stringify({ schema: 1, note: 'test', hash, version, syncedAt: OLD_SYNCED_AT }, null, 2),
  );
}

async function readMarkerRaw(dir: string): Promise<string | null> {
  try {
    return await readFile(join(dir, MARKER), 'utf8');
  } catch {
    return null;
  }
}

async function readMarker(dir: string): Promise<Record<string, unknown>> {
  const raw = await readMarkerRaw(dir);
  if (raw === null) {
    throw new Error('印が無い');
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

/** 「前後で変わらない」を見るための観測（木のハッシュと印の生の文字列）。 */
async function snapshot(dir: string): Promise<{ hash: string; marker: string | null }> {
  return { hash: await hashPluginTree(dir), marker: await readMarkerRaw(dir) };
}

async function sync(now: Date = NOW): Promise<{
  exitCode: 0 | 1;
  summary: SyncSummary;
  out: string;
  err: string;
  lines: string[];
}> {
  const { syncBundledPlugins } = await loadSync();
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
    now: () => now,
  });
  return { ...result, out, err, lines: out.split('\n').filter((line) => line !== '') };
}

// ─── Volume の状態を作る（設計 §6.3 の各行） ───

/** #4：同期が書いたまま誰も触っていない古い同梱（印が一致）。 */
async function volumeSyncedOld(id: string): Promise<string> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, { id, files: OLD_FILES });
  const hash = await hashPluginTree(dir);
  await writeMarker(dir, hash);
  return hash;
}

/** #8：印の無い古い写し（050 より前の Volume）。 */
async function volumeLegacy(id: string, version = '1.0.0'): Promise<string> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, { id, version, files: OLD_FILES });
  return hashPluginTree(dir);
}

/** #5：同期の後に利用者が中身を変えた（印は残るが一致しない）。 */
async function volumeModified(id: string): Promise<void> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, { id, files: OLD_FILES });
  await writeMarker(dir, FOREIGN_HASH);
}

/** #7：印が無く、Volume の版が新しい。 */
async function volumeNewer(id: string): Promise<void> {
  await writePlugin(join(pluginsDir, id), { id, version: '1.1.0', files: OLD_FILES });
}

/** #6：印が無く、plugin.json が無い。 */
async function volumeUnreadable(id: string): Promise<void> {
  await writePlugin(join(pluginsDir, id), { id, files: OLD_FILES, manifest: null });
}

/** #2：隔離マークがある（印は一致しているので、隔離が無ければ #4 で更新される）。 */
async function volumeQuarantined(id: string): Promise<void> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, { id, files: OLD_FILES });
  await writeMarker(dir, await hashPluginTree(dir));
  await writeFile(join(dir, QUARANTINE), 'rebuild failed');
}

/**
 * #3：中身が同梱と同じ（Docker が Volume を初めて作ったときに写した状態）。写しをそのまま写す。
 * `marker` が true なら一致する印も書く。
 */
async function volumeSameAsBundled(
  id: string,
  bundledHash: string,
  marker: boolean,
): Promise<void> {
  const dir = join(pluginsDir, id);
  await cp(join(bundledDir, id), dir, { recursive: true });
  if (marker) {
    await writeMarker(dir, bundledHash);
  }
}

/** #9：写しに無い ID で、有効な印がある（以前は同梱だった）。 */
async function volumeNoLongerBundled(id: string): Promise<void> {
  const dir = join(pluginsDir, id);
  await writePlugin(dir, { id, files: OLD_FILES });
  await writeMarker(dir, await hashPluginTree(dir));
}

/** #10：写しに無い ID で、印が無い（利用者の Plugin）。 */
async function volumeUser(id: string): Promise<void> {
  await writePlugin(join(pluginsDir, id), {
    id,
    version: '0.3.0',
    files: { 'index.ts': `export function activate() { /* ${id} */ }\n` },
  });
}

describe('置き換え', () => {
  it('#17 restored：フォルダが無ければ写しが置かれ、木のハッシュが I になる', async () => {
    const bundledHash = await bundle('alpha');

    await sync();

    expect(await hashPluginTree(join(pluginsDir, 'alpha'))).toBe(bundledHash);
  });

  it('#17 restored：印の hash が I、version が写しの版になる', async () => {
    const bundledHash = await bundle('alpha', '1.2.3');

    await sync();

    const marker = await readMarker(join(pluginsDir, 'alpha'));
    expect(marker['schema']).toBe(1);
    expect(marker['hash']).toBe(bundledHash);
    expect(marker['version']).toBe('1.2.3');
    expect(Date.parse(String(marker['syncedAt']))).toBe(NOW.getTime());
  });

  it('#17 restored：作業用の .torifune-sync-* が残らない', async () => {
    await bundle('alpha');

    await sync();

    const leftovers = (await readdir(pluginsDir)).filter((name) =>
      name.startsWith('.torifune-sync-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('#17 restored：終了コードは 0 で、要約の restored が 1', async () => {
    await bundle('alpha');

    const result = await sync();

    expect(result.exitCode).toBe(0);
    expect(result.summary.restored).toBe(1);
    expect(result.summary.failed).toBe(0);
  });

  it.skipIf(!CAN_LINK_FILE)(
    '#17 restored：写しのシンボリックリンクはリンク先の文字列を変えずに写され、木のハッシュが I になる',
    async () => {
      const source = join(bundledDir, 'alpha');
      await writePlugin(source, { id: 'alpha', files: BUNDLED_FILES });
      await symlink('index.ts', join(source, 'entry.ts'), 'file');
      const bundledHash = await hashPluginTree(source);

      const result = await sync();

      expect(result.exitCode).toBe(0);
      expect(await readlink(join(pluginsDir, 'alpha', 'entry.ts'))).toBe('index.ts');
      expect(await hashPluginTree(join(pluginsDir, 'alpha'))).toBe(bundledHash);
    },
  );

  it('#18 updated（印つき）：写しで消えたファイルは消え、足したファイルは現れる（足し合わせにならない）', async () => {
    await bundle('alpha');
    await volumeSyncedOld('alpha');

    await sync();

    const dir = join(pluginsDir, 'alpha');
    expect(await exists(join(dir, 'old.ts'))).toBe(false);
    expect(await exists(join(dir, 'new.ts'))).toBe(true);
    expect(await readFile(join(dir, 'index.ts'), 'utf8')).toBe(BUNDLED_FILES['index.ts']);
  });

  it('#18 updated（印つき）：木のハッシュと印の hash が新しい I になる', async () => {
    const bundledHash = await bundle('alpha');
    await volumeSyncedOld('alpha');

    await sync();

    const dir = join(pluginsDir, 'alpha');
    expect(await hashPluginTree(dir)).toBe(bundledHash);
    expect((await readMarker(dir))['hash']).toBe(bundledHash);
  });

  it('#18 updated（印つき）：退避は作られない', async () => {
    await bundle('alpha');
    await volumeSyncedOld('alpha');

    await sync();

    expect(await exists(join(pluginsDir, BACKUP_DIR))).toBe(false);
  });

  it('#19 updated: legacy：退避先の木のハッシュが置き換え前の H と等しい', async () => {
    await bundle('alpha');
    const before = await volumeLegacy('alpha');

    await sync();

    expect(await hashPluginTree(join(pluginsDir, BACKUP_DIR, 'alpha'))).toBe(before);
  });

  it('#19 updated: legacy：フォルダは写しで置き換わり、一致する印が付く', async () => {
    const bundledHash = await bundle('alpha');
    await volumeLegacy('alpha');

    await sync();

    const dir = join(pluginsDir, 'alpha');
    expect(await hashPluginTree(dir)).toBe(bundledHash);
    expect((await readMarker(dir))['hash']).toBe(bundledHash);
    expect(await exists(join(dir, 'old.ts'))).toBe(false);
  });

  it('#19 updated: legacy：同じ ID をもう一度 legacy で置き換えると、退避は新しい方の 1 つだけになる', async () => {
    await bundle('alpha');
    await volumeLegacy('alpha');
    await sync();

    // 1 回目の後に、印を消して中身を変える（同じ版のまま。もう一度 legacy に当たる）。
    const dir = join(pluginsDir, 'alpha');
    await rm(join(dir, MARKER));
    await put(dir, 'edited.ts', 'export const edited = true;\n');
    const beforeSecond = await hashPluginTree(dir);

    await sync();

    const backup = join(pluginsDir, BACKUP_DIR, 'alpha');
    expect(await hashPluginTree(backup)).toBe(beforeSecond);
    expect(await exists(join(backup, 'old.ts'))).toBe(false);
    expect(await readdir(join(pluginsDir, BACKUP_DIR))).toEqual(['alpha']);
  });

  it('#25 plugins の場所が存在しなければ作られ、すべての同梱 ID が restored になる', async () => {
    const alpha = await bundle('alpha');
    const beta = await bundle('beta', '2.0.0');
    pluginsDir = join(root, 'not-yet', 'plugins');

    const result = await sync();

    expect(result.exitCode).toBe(0);
    expect(await hashPluginTree(join(pluginsDir, 'alpha'))).toBe(alpha);
    expect(await hashPluginTree(join(pluginsDir, 'beta'))).toBe(beta);
    expect(result.summary.restored).toBe(2);
    expect(result.lines).toContain(`${PREFIX}alpha restored`);
    expect(result.lines).toContain(`${PREFIX}beta restored`);
  });
});

describe('触らないもの', () => {
  it('#21 利用者の Plugin（写しに無い ID・印なし）は、同期の前後で木のハッシュが等しく、印が足されない', async () => {
    await bundle('alpha');
    await volumeLegacy('alpha');
    await volumeUser('user-plugin');
    const dir = join(pluginsDir, 'user-plugin');
    const before = await snapshot(dir);

    await sync();

    expect(await snapshot(dir)).toEqual(before);
    expect(before.marker).toBeNull();
  });

  it.each<readonly [string, string, () => Promise<void>]>([
    ['skipped: modified', 'alpha', () => volumeModified('alpha')],
    ['skipped: newer version', 'alpha', () => volumeNewer('alpha')],
    ['skipped: unreadable manifest', 'alpha', () => volumeUnreadable('alpha')],
    ['skipped: quarantined', 'alpha', () => volumeQuarantined('alpha')],
    ['kept', 'old-bundled', () => volumeNoLongerBundled('old-bundled')],
  ])(
    '#22 %s のフォルダは、前後で木のハッシュも印の中身（syncedAt を含む）も変わらない',
    async (_label, id, arrange) => {
      await bundle('alpha');
      await arrange();
      const dir = join(pluginsDir, id);
      const before = await snapshot(dir);

      await sync();

      expect(await snapshot(dir)).toEqual(before);
    },
  );
});

describe('冪等', () => {
  /** 判定表のほぼ全行に当たる Volume を作る。 */
  async function arrangeMixed(): Promise<void> {
    const same = await bundle('a-same');
    await bundle('b-missing');
    await bundle('c-synced-old');
    await bundle('d-legacy');
    await bundle('e-modified');
    await bundle('f-newer');
    await bundle('g-unreadable');
    await bundle('h-quarantined');
    await volumeSameAsBundled('a-same', same, false);
    await volumeSyncedOld('c-synced-old');
    await volumeLegacy('d-legacy');
    await volumeModified('e-modified');
    await volumeNewer('f-newer');
    await volumeUnreadable('g-unreadable');
    await volumeQuarantined('h-quarantined');
    await volumeNoLongerBundled('old-bundled');
    await volumeUser('user-plugin');
  }

  /** plugins の直下のすべてのディレクトリの観測（退避のディレクトリも含める）。 */
  async function snapshotAll(): Promise<Record<string, { hash: string; marker: string | null }>> {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const result: Record<string, { hash: string; marker: string | null }> = {};
    for (const entry of entries.filter((item) => item.isDirectory())) {
      result[entry.name] = await snapshot(join(pluginsDir, entry.name));
    }
    return result;
  }

  it('#23 2 回続けて走らせると、2 回目はすべての同梱 ID が unchanged（または skipped / kept）になる', async () => {
    await arrangeMixed();
    await sync(new Date('2026-10-02T00:00:00.000Z'));

    const second = await sync(new Date('2026-10-03T00:00:00.000Z'));

    const results = second.lines
      .filter((line) => !line.startsWith(`${PREFIX}summary `))
      .map((line) => line.slice(PREFIX.length).split(' ').slice(1).join(' '));
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result).toMatch(/^(unchanged|skipped: .+|kept: no longer bundled)$/);
    }
    expect(second.summary).toMatchObject({ updated: 0, restored: 0, adopted: 0, failed: 0 });
    expect(second.exitCode).toBe(0);
  });

  it('#23 2 回目は、どのフォルダの木のハッシュも印の syncedAt も変わらない', async () => {
    await arrangeMixed();
    await sync(new Date('2026-10-02T00:00:00.000Z'));
    const afterFirst = await snapshotAll();

    await sync(new Date('2026-10-03T00:00:00.000Z'));

    expect(await snapshotAll()).toEqual(afterFirst);
  });
});

describe('ログ', () => {
  /**
   * 判定表のすべての結果に 1 つずつ当たる配置。写しのトップレベルのファイルと `.` で始まる
   * ディレクトリは同梱 Plugin ではない（設計 §6.1）。plugins の `.` で始まるディレクトリと
   * トップレベルのファイルは利用者の Plugin に数えない。
   */
  async function arrangeAllResults(): Promise<void> {
    await bundle('a-restored');
    const unchanged = await bundle('b-unchanged');
    const adopted = await bundle('c-adopted');
    await bundle('d-updated');
    await bundle('e-legacy');
    await bundle('f-modified');
    await bundle('g-newer');
    await bundle('h-unreadable');
    await bundle('i-quarantined');
    await put(bundledDir, 'README.md', '# bundled\n');
    await writePlugin(join(bundledDir, '.hidden'), { id: 'hidden', files: BUNDLED_FILES });

    await volumeSameAsBundled('b-unchanged', unchanged, true);
    await volumeSameAsBundled('c-adopted', adopted, false);
    await volumeSyncedOld('d-updated');
    await volumeLegacy('e-legacy');
    await volumeModified('f-modified');
    await volumeNewer('g-newer');
    await volumeUnreadable('h-unreadable');
    await volumeQuarantined('i-quarantined');
    await volumeNoLongerBundled('old-bundled');
    await volumeUser('user-one');
    await volumeUser('user-two');
    await put(pluginsDir, 'README.md', '# plugins\n');
    await writePlugin(join(pluginsDir, BACKUP_DIR, 'zzz-earlier'), { id: 'zzz', files: OLD_FILES });
  }

  const SUMMARY = `${PREFIX}summary updated=2 restored=1 adopted=1 unchanged=1 skipped=4 kept=1 failed=0 untouched=2`;

  it('#26 写しの ID ごとに 1 行（設計 §6.6.2 の形）と、以前は同梱だった ID の行と、要約 1 行を出す', async () => {
    await arrangeAllResults();

    const result = await sync();

    expect([...result.lines].sort()).toEqual(
      [
        `${PREFIX}a-restored restored`,
        `${PREFIX}b-unchanged unchanged`,
        `${PREFIX}c-adopted adopted`,
        `${PREFIX}d-updated updated`,
        `${PREFIX}e-legacy updated: legacy (backup: .torifune-bundled-backup/e-legacy)`,
        `${PREFIX}f-modified skipped: modified`,
        `${PREFIX}g-newer skipped: newer version 1.1.0 installed`,
        `${PREFIX}h-unreadable skipped: unreadable manifest`,
        `${PREFIX}i-quarantined skipped: quarantined`,
        `${PREFIX}old-bundled kept: no longer bundled`,
        SUMMARY,
      ].sort(),
    );
  });

  it('#26 要約は最後の 1 行で、各件数が判定の結果と一致する', async () => {
    await arrangeAllResults();

    const result = await sync();

    expect(result.lines.at(-1)).toBe(SUMMARY);
    expect(result.summary).toEqual({
      updated: 2,
      restored: 1,
      adopted: 1,
      unchanged: 1,
      skipped: 4,
      kept: 1,
      failed: 0,
      untouched: 2,
    });
  });

  it('#26 利用者の Plugin の ID はログに出ない', async () => {
    await arrangeAllResults();

    const result = await sync();

    for (const id of ['user-one', 'user-two']) {
      expect(result.out).not.toContain(id);
      expect(result.err).not.toContain(id);
    }
  });

  it('#26 skipped を含んでも、すべての ID を処理できれば終了コードは 0（設計 §6.6.1）', async () => {
    await arrangeAllResults();

    const result = await sync();

    expect(result.exitCode).toBe(0);
  });
});

describe('判定の観測', () => {
  it.each<readonly [string, string | null]>([
    ['plugin.json が無い', null],
    ['plugin.json が JSON でない', '{ "id": "alpha", "version": '],
    ['version が文字列でない', JSON.stringify({ id: 'alpha', version: 1 })],
  ])(
    '#14 印が無く、%s → skipped: unreadable manifest で、フォルダは変わらない',
    async (_label, manifest) => {
      await bundle('alpha');
      const dir = join(pluginsDir, 'alpha');
      await writePlugin(dir, { id: 'alpha', files: OLD_FILES, manifest });
      const before = await snapshot(dir);

      const result = await sync();

      expect(result.lines).toContain(`${PREFIX}alpha skipped: unreadable manifest`);
      expect(await snapshot(dir)).toEqual(before);
    },
  );

  it('#9 中身が同梱と同じで印が無い → adopted で、中身は変えずに一致する印だけを書く', async () => {
    const bundledHash = await bundle('alpha', '1.4.0');
    await volumeSameAsBundled('alpha', bundledHash, false);

    const result = await sync();

    const dir = join(pluginsDir, 'alpha');
    expect(result.lines).toContain(`${PREFIX}alpha adopted`);
    expect(await hashPluginTree(dir)).toBe(bundledHash);
    const marker = await readMarker(dir);
    expect(marker['hash']).toBe(bundledHash);
    expect(marker['version']).toBe('1.4.0');
  });

  it('#9 中身が同梱と同じで印が壊れている → adopted で、印が書き直される', async () => {
    const bundledHash = await bundle('alpha');
    await volumeSameAsBundled('alpha', bundledHash, false);
    await writeFile(join(pluginsDir, 'alpha', MARKER), '{ broken');

    const result = await sync();

    expect(result.lines).toContain(`${PREFIX}alpha adopted`);
    expect((await readMarker(join(pluginsDir, 'alpha')))['hash']).toBe(bundledHash);
  });

  it('#9 中身が同梱と同じで印も一致 → unchanged で、印を書き直さない', async () => {
    const bundledHash = await bundle('alpha');
    await volumeSameAsBundled('alpha', bundledHash, true);
    const before = await readMarkerRaw(join(pluginsDir, 'alpha'));

    const result = await sync();

    expect(result.lines).toContain(`${PREFIX}alpha unchanged`);
    expect(await readMarkerRaw(join(pluginsDir, 'alpha'))).toBe(before);
  });
});
