import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename as fsRename,
  rm,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { BUNDLED_MARKER, hashPluginTree, QUARANTINE_MARKER } from './tree-hash.js';
import { compareVersions } from './version.js';

/**
 * 同梱 Plugin の同期（docs/設計/050-bundled-plugin-sync/設計.md §6.2〜§6.4・§6.6）。
 *
 * コンテナイメージは同梱 Plugin の写しを Volume の外に持つ。起動の最初に、その写しと
 * plugins の Volume を突き合わせ、**同梱 Plugin のフォルダだけ**を更新する。
 * 利用者が導入した Plugin・利用者が中身を変えた同梱 Plugin には触れない。
 *
 * 判定（§6.3）は観測値だけを受ける純関数に切り出し、ファイルシステムへの適用（§6.4）と分ける。
 */

const MARKER_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * 印（`.torifune-bundled`）の中身を読み、有効な印ならその `hash` を返す（§6.2.2）。
 *
 * JSON として読めて、`hash` が `sha256:<64 桁の 16 進>` のものだけが有効。
 * 読めない・形が違う印は「印が無い」として扱うので `null` を返す。
 */
export function parseMarker(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const hash = (parsed as Record<string, unknown>)['hash'];
  return typeof hash === 'string' && MARKER_HASH.test(hash) ? hash : null;
}

/** Volume の `<plugins>/<id>` の観測値。 */
export type VolumeState =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'present';
      readonly quarantined: boolean;
      /** H：Volume のフォルダの木のハッシュ */
      readonly hash: string;
      /** M：有効な印の hash（有効な印が無ければ null） */
      readonly markerHash: string | null;
      /** Volume の plugin.json の version（読めない・文字列でなければ null） */
      readonly version: string | null;
    };

export type BundledDecision =
  | { readonly result: 'restored' }
  | { readonly result: 'unchanged' }
  | { readonly result: 'adopted' }
  /** `backup: true` が legacy（印の無い古い写しを退避してから置き換える） */
  | { readonly result: 'updated'; readonly backup: boolean }
  | {
      readonly result: 'skipped';
      readonly reason: 'quarantined' | 'modified' | 'unreadable manifest';
    }
  | {
      readonly result: 'skipped';
      readonly reason: 'newer version';
      readonly installedVersion: string;
    };

/**
 * 同梱の写しにある ID の判定（§6.3 の #1〜#8）。**上から順に最初に当たった行**を返す。
 *
 * `I` = 同梱の写しの木のハッシュ、`H` = Volume のフォルダの木のハッシュ、`M` = 有効な印の hash。
 */
export function decideBundled(input: {
  readonly bundledHash: string;
  readonly bundledVersion: string;
  readonly volume: VolumeState;
}): BundledDecision {
  const { bundledHash: I, bundledVersion, volume } = input;

  // #1 フォルダが無い → 写しを置く
  if (volume.kind === 'missing') {
    return { result: 'restored' };
  }

  // #2 隔離されたものは触らない（原因を調べるためにファイルを残す約束）
  if (volume.quarantined) {
    return { result: 'skipped', reason: 'quarantined' };
  }

  const { hash: H, markerHash: M } = volume;

  // #3 中身が同梱と同じ → 中身は触らず、印が無い・食い違うときだけ印を書く
  if (H === I) {
    return M === I ? { result: 'unchanged' } : { result: 'adopted' };
  }

  if (M !== null) {
    // #4 同期が書いたまま誰も触っていない → 黙って更新する（退避は要らない）
    // #5 同期の後に中身が変わった → 利用者のもの。触らない
    return H === M
      ? { result: 'updated', backup: false }
      : { result: 'skipped', reason: 'modified' };
  }

  // 印の無い古い Volume は版番号で補う
  // #6 plugin.json が読めない → 判断の材料が無いので触らない
  if (volume.version === null) {
    return { result: 'skipped', reason: 'unreadable manifest' };
  }
  // #7 Volume の版が新しい → 利用者が更新したもの。版を下げない
  if (compareVersions(volume.version, bundledVersion) > 0) {
    return { result: 'skipped', reason: 'newer version', installedVersion: volume.version };
  }
  // #8 同じか古い → 古いイメージから写された同梱 Plugin とみなし、退避してから置き換える
  return { result: 'updated', backup: true };
}

/**
 * 同梱の写しに無い ID の判定（§6.3 の #9・#10）。どちらも何もしない。
 *
 * 有効な印があれば以前は同梱だった Plugin（`kept`）、無ければ利用者の Plugin（`untouched`）。
 */
export function decideUnbundled(markerHash: string | null): 'kept' | 'untouched' {
  return markerHash === null ? 'untouched' : 'kept';
}

/**
 * 適用が使うファイル操作の口（§6.6.1）。失敗を注入できるよう差し替えられる。
 */
export interface SyncFileOps {
  /** ディレクトリを再帰的に写す（§6.4.1 の 1）。シンボリックリンクは辿らず、リンク先の文字列のまま写す。 */
  copyDir(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** 再帰的に消す。無くても失敗しない。シンボリックリンクはリンクそのものだけを消す。 */
  remove(path: string): Promise<void>;
  /**
   * ファイルを書く。**そこにあるシンボリックリンクを辿らない**：先にその名前のもの（リンクならリンクそのもの）を
   * 消し、新しいファイルとして作る（作る前に何かが置かれていれば失敗する）。Volume の外のファイルを書き換えないため。
   */
  writeFile(path: string, data: string): Promise<void>;
}

export const nodeFileOps: SyncFileOps = {
  copyDir: (from, to) =>
    // verbatimSymlinks を立てないと相対リンクが絶対パスへ書き換わり、写しの木のハッシュが合わなくなる。
    cp(from, to, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    }),
  rename: (from, to) => fsRename(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
  writeFile: async (path, data) => {
    // rm はリンクを辿らずリンクそのものを消す。再帰はしない（ディレクトリなら失敗にする）。
    // 'wx'（O_CREAT | O_EXCL）は、消した後に誰かがリンクを置いても辿らずに失敗する。
    await rm(path, { force: true });
    await fsWriteFile(path, data, { flag: 'wx' });
  },
};

export interface SyncSummary {
  readonly updated: number;
  readonly restored: number;
  readonly adopted: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly kept: number;
  readonly failed: number;
  readonly untouched: number;
}

const LOG_PREFIX = '[torifune] bundled plugins: ';

/** Plugin ID の形（`packages/plugin-api/src/manifest.ts` と同じ）。 */
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * ログの行に出す名前。Plugin ID の形ならそのまま、そうでなければ JSON の文字列として引用し、
 * 表示できる ASCII 以外を `\uXXXX` にする（フォルダの名前で偽の行を作らせない。U+2028 などは
 * JSON.stringify がそのまま残すため）。
 */
function displayId(name: string): string {
  return PLUGIN_ID.test(name) ? name : quoteForLog(name);
}

/** 版の形（数字・英字・`.`・`-`・`+` だけ。semver とその崩れた形を含む）。 */
const VERSION_SHAPE = /^[0-9A-Za-z.+-]{1,64}$/;

/**
 * ログの行に出す版（Volume の plugin.json から読んだ値）。版の形ならそのまま、そうでなければ
 * {@link displayId} と同じく引用する（手で置いた plugin.json の版で偽の行を作らせない）。
 */
function displayVersion(version: string): string {
  return VERSION_SHAPE.test(version) ? version : quoteForLog(version);
}

/** JSON の文字列として引用し、表示できる ASCII 以外を `\uXXXX` にする。 */
function quoteForLog(value: string): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** legacy の置き換え前の中身を移す先（`<plugins>` の直下。`.` で始まるのでビルドにも指紋にも入らない）。 */
const BACKUP_DIR = '.torifune-bundled-backup';

const MARKER_NOTE =
  'Torifune が同梱 Plugin の更新に使う印。このフォルダの中身を変えると、以後このフォルダは自動では更新されない。';

/** 作業用のディレクトリ（§6.4.1 の T・O）。 */
function workPaths(pluginsDir: string, id: string): { readonly tmp: string; readonly old: string } {
  return {
    tmp: join(pluginsDir, `.torifune-sync-${id}.tmp`),
    old: join(pluginsDir, `.torifune-sync-${id}.old`),
  };
}

/** 失敗の理由として出す文字列を持つ例外。パスや内部の事情は持たせない。 */
class SyncFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 通常のファイルなら中身を読む。無い・通常のファイルでない（シンボリックリンクを含む）なら null。
 *
 * **シンボリックリンクを辿らない。** Volume の外のファイルを読まない。
 */
async function readRegularFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) {
      return null;
    }
    return await readFile(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** plugin.json の version。無い・JSON でない・文字列でなければ null。 */
async function readManifestVersion(dir: string): Promise<string | null> {
  const raw = await readRegularFile(join(dir, 'plugin.json'));
  if (raw === null) {
    return null;
  }
  try {
    const manifest: unknown = JSON.parse(raw);
    const version =
      typeof manifest === 'object' && manifest !== null
        ? (manifest as Record<string, unknown>)['version']
        : undefined;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

async function readMarkerHash(dir: string): Promise<string | null> {
  const raw = await readRegularFile(join(dir, BUNDLED_MARKER));
  return raw === null ? null : parseMarker(raw);
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Volume の `<plugins>/<id>` を観測する。ディレクトリでなければ（リンクを含む）辿らずに失敗にする。 */
async function observeVolume(dir: string): Promise<VolumeState> {
  let isDirectory: boolean;
  try {
    isDirectory = (await lstat(dir)).isDirectory();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }
  if (!isDirectory) {
    throw new SyncFailure('ENOTDIR');
  }
  return {
    kind: 'present',
    quarantined: await entryExists(join(dir, QUARANTINE_MARKER)),
    hash: await hashPluginTree(dir),
    markerHash: await readMarkerHash(dir),
    version: await readManifestVersion(dir),
  };
}

/** トップレベルの、名前が `.` で始まらないディレクトリ（シンボリックリンクは数えない）。名前順。 */
async function listPluginDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

function markerContent(hash: string, version: string, syncedAt: Date): string {
  return `${JSON.stringify(
    { schema: 1, note: MARKER_NOTE, hash, version, syncedAt: syncedAt.toISOString() },
    null,
    2,
  )}\n`;
}

interface ApplyContext {
  readonly pluginsDir: string;
  readonly ops: SyncFileOps;
  readonly now: () => Date;
}

/** 退避の置き場を用意する。あってもディレクトリでなければ（リンクを含む）その中へ書かない。 */
async function ensureBackupRoot(pluginsDir: string): Promise<string> {
  const backupRoot = join(pluginsDir, BACKUP_DIR);
  let isDirectory: boolean | null;
  try {
    isDirectory = (await lstat(backupRoot)).isDirectory();
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
    isDirectory = null;
  }
  if (isDirectory === false) {
    throw new SyncFailure('ENOTDIR');
  }
  if (isDirectory === null) {
    await mkdir(backupRoot);
  }
  return backupRoot;
}

/**
 * `<plugins>/<id>` を同梱の写しで置き換える（§6.4.1）。
 *
 * 作業用の T へ写してハッシュを確かめ、印を書いてから、D を退避（legacy）か O（印つきの更新）へ
 * rename し、T を D へ rename する。rename は同じファイルシステムの中で原子的なので、
 * D が半分だけ書き換わった状態は生じない。
 */
async function replaceWithBundled(
  ctx: ApplyContext,
  id: string,
  source: { readonly dir: string; readonly hash: string; readonly version: string },
  mode: 'restore' | 'update' | 'legacy',
): Promise<void> {
  const { pluginsDir, ops } = ctx;
  const target = join(pluginsDir, id);
  const { tmp, old } = workPaths(pluginsDir, id);

  // どこで失敗しても T を残さない。D は 4 で動かす前か、5 で戻した後の古い中身のまま
  let moved: string | null = null;
  try {
    // 1〜3：T へ写し、欠けていないことを確かめ、印を書く
    await ops.remove(tmp);
    await ops.copyDir(source.dir, tmp);
    if ((await hashPluginTree(tmp)) !== source.hash) {
      throw new SyncFailure('copy mismatch');
    }
    await ops.writeFile(
      join(tmp, BUNDLED_MARKER),
      markerContent(source.hash, source.version, ctx.now()),
    );

    // 4：D をどかす
    if (mode === 'legacy') {
      const backup = join(await ensureBackupRoot(pluginsDir), id);
      await ops.remove(backup); // ID ごとに最新の 1 つだけ残す
      await ops.rename(target, backup);
      moved = backup;
    } else if (mode === 'update') {
      await ops.remove(old);
      await ops.rename(target, old);
      moved = old;
    }

    // 5：T を D へ
    await ops.rename(tmp, target);
  } catch (error) {
    if (moved !== null) {
      // 4 で動かしたものを D へ戻す。戻せなければ次の起動で restored として置き直される
      await ops.rename(moved, target).catch(() => undefined);
    }
    await ops.remove(tmp).catch(() => undefined);
    throw error;
  }

  // 6：O を片付ける。D は既に新しい中身なので、消せなくても置き換えは済んでいる
  // （残った O は次の同期の最初に片付ける。§6.4.2）
  if (mode === 'update') {
    await ops.remove(old).catch(() => undefined);
  }
}

/** 前回の同期が途中で落ちたときの作業用ディレクトリ（§6.4.2）。利用者の中身を含まない。 */
const LEFTOVER = /^\.torifune-sync-.+\.(?:tmp|old)$/;

/**
 * `FAILED` の行に出す理由（§6.6.2）。OS のエラーコードまでとし、メッセージ・パス・スタックは出さない。
 */
export function failureReason(error: unknown): string {
  if (error instanceof SyncFailure) {
    return error.reason;
  }
  const code = errorCode(error);
  return code !== undefined && /^E[A-Z0-9]+$/.test(code) ? code : 'unknown error';
}

function describeDecision(id: string, decision: BundledDecision): string {
  switch (decision.result) {
    case 'updated':
      return decision.backup
        ? `updated: legacy (backup: ${BACKUP_DIR}/${displayId(id)})`
        : 'updated';
    case 'skipped':
      return decision.reason === 'newer version'
        ? `skipped: newer version ${displayVersion(decision.installedVersion)} installed`
        : `skipped: ${decision.reason}`;
    default:
      return decision.result;
  }
}

/** 同梱の写しにある ID を 1 つ観測し、判定して適用する。失敗は例外で返す。 */
async function syncOne(ctx: ApplyContext, id: string, sourceDir: string): Promise<BundledDecision> {
  const target = join(ctx.pluginsDir, id);

  const bundledHash = await hashPluginTree(sourceDir);
  const bundledVersion = await readManifestVersion(sourceDir);
  if (bundledVersion === null) {
    // イメージの誤り。版が分からなければ印も判定も作れないので、Volume に書かない
    throw new SyncFailure('unreadable bundled manifest');
  }

  const volume = await observeVolume(target);
  const decision = decideBundled({ bundledHash, bundledVersion, volume });
  const source = { dir: sourceDir, hash: bundledHash, version: bundledVersion };

  switch (decision.result) {
    case 'restored':
      await replaceWithBundled(ctx, id, source, 'restore');
      break;
    case 'updated':
      await replaceWithBundled(ctx, id, source, decision.backup ? 'legacy' : 'update');
      break;
    case 'adopted':
      // 中身は触らず印だけを書く。一時ファイルを経由しない（残ると木のハッシュに入り、
      // 以後 skipped: modified になる）。途中で壊れた印は次の起動で adopted として書き直される
      await ctx.ops.writeFile(
        join(target, BUNDLED_MARKER),
        markerContent(bundledHash, bundledVersion, ctx.now()),
      );
      break;
    default:
      break;
  }
  return decision;
}

/**
 * 同梱の写しと plugins を突き合わせ、同梱 Plugin のフォルダを更新する（§6.3・§6.4・§6.6.2）。
 *
 * 標準出力に、同梱の写しにある ID ごとに 1 行（以前は同梱だった ID の行を含む）と、最後に要約を 1 行出す。
 * 利用者の Plugin は ID を出さず件数（`untouched`）だけ数える。
 */
export async function syncBundledPlugins(options: {
  readonly bundledDir: string;
  readonly pluginsDir: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly ops?: SyncFileOps;
  readonly now?: () => Date;
}): Promise<{ readonly exitCode: 0 | 1; readonly summary: SyncSummary }> {
  const { bundledDir, pluginsDir, stdout, stderr } = options;
  const ctx: ApplyContext = {
    pluginsDir,
    ops: options.ops ?? nodeFileOps,
    now: options.now ?? (() => new Date()),
  };
  const counts = {
    updated: 0,
    restored: 0,
    adopted: 0,
    unchanged: 0,
    skipped: 0,
    kept: 0,
    failed: 0,
    untouched: 0,
  };
  const log = (id: string, text: string): void => stdout(`${LOG_PREFIX}${displayId(id)} ${text}\n`);

  // ID に結びつかない I/O の失敗（残骸の片付け・写しに無い ID の列挙）。終了コードだけを 1 にする
  let otherFailure = false;
  const failOther = (what: string, error: unknown): void => {
    otherFailure = true;
    stderr(`${LOG_PREFIX}${what} FAILED: ${failureReason(error)}\n`);
  };

  let bundledIds: string[];
  try {
    // 空の Volume・ホストのディレクトリを付けた場合。全部が restored で置かれる
    await mkdir(pluginsDir, { recursive: true });
    bundledIds = await listPluginDirs(bundledDir);
  } catch (error) {
    stderr(`${LOG_PREFIX}FAILED: ${failureReason(error)}\n`);
    return { exitCode: 1, summary: { ...counts } };
  }

  // 前回の残骸を片付ける（§6.4.2）。消せなくても、その ID の置き換えの最初にもう一度消す
  try {
    for (const name of await readdir(pluginsDir)) {
      if (LEFTOVER.test(name)) {
        await ctx.ops.remove(join(pluginsDir, name));
      }
    }
  } catch (error) {
    failOther('cleanup', error);
  }

  for (const id of bundledIds) {
    // 失敗した ID があっても残りの ID は処理する
    try {
      const decision = await syncOne(ctx, id, join(bundledDir, id));
      counts[decision.result] += 1;
      log(id, describeDecision(id, decision));
    } catch (error) {
      counts.failed += 1;
      stderr(`${LOG_PREFIX}${displayId(id)} FAILED: ${failureReason(error)}\n`);
    }
  }

  // 同梱の写しに無い ID：以前は同梱だったもの（印あり）は残す。利用者の Plugin は数えるだけ
  const bundledSet = new Set(bundledIds);
  let volumeIds: string[] = [];
  try {
    volumeIds = await listPluginDirs(pluginsDir);
  } catch (error) {
    failOther('listing', error);
  }
  for (const id of volumeIds) {
    if (bundledSet.has(id)) {
      continue;
    }
    let markerHash: string | null = null;
    try {
      markerHash = await readMarkerHash(join(pluginsDir, id));
    } catch {
      // 読めなければ印が無いものとして扱う。どちらにしても触らない
    }
    const decision = decideUnbundled(markerHash);
    counts[decision] += 1;
    if (decision === 'kept') {
      log(id, 'kept: no longer bundled');
    }
  }

  const summary = Object.entries(counts)
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  stdout(`${LOG_PREFIX}summary ${summary}\n`);

  return { exitCode: counts.failed === 0 && !otherFailure ? 0 : 1, summary: { ...counts } };
}
