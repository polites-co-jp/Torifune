import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { validateManifest, type PluginManifest } from '@torifune/plugin-api';
import yauzl from 'yauzl';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * Plugin Package（zip）の展開（012-plugin-manager 設計 §8）。
 *
 * **Plugin の導入は実質的にアプリへのコード導入**であり、
 * 実行するコードの中身は信頼する前提に立つ（`CLAUDE.md`）。
 * ただし**展開そのもの**は攻撃面になるため、Plugin の外へ書き込ませない。
 *
 * **すべての名前を検証してから、1バイトも書かない。**
 * 途中まで書いてから弾くと、壊れた状態が残る。
 */

/** 展開後の合計サイズの上限。zip bomb でディスクを埋められないようにする。 */
function maxBytes(): number {
  return Number(process.env['TORIFUNE_PLUGIN_MAX_BYTES'] ?? 32 * 1024 * 1024);
}

function maxFiles(): number {
  return Number(process.env['TORIFUNE_PLUGIN_MAX_FILES'] ?? 2000);
}

/** Unix のファイル種別。zip の external attributes の上位16bitに入る。 */
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export class PluginPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginPackageError';
  }
}

export interface PackageEntry {
  /** トップレベルディレクトリを除いた相対パス。 */
  readonly path: string;
  readonly data: Buffer;
}

export interface InspectedPackage {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly entries: readonly PackageEntry[];
}

function isUnsafePath(name: string): boolean {
  // zip の仕様上、区切りは `/`。`\` を含むものは Windows で作られた不正なもの。
  if (name.includes('\\')) return true;
  if (name.startsWith('/')) return true;
  // C:\ や C:/ のようなドライブ付き絶対パス。
  if (/^[a-zA-Z]:/.test(name)) return true;
  return name.split('/').some((segment) => segment === '..');
}

interface RawEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly isSymlink: boolean;
  readonly isDirectory: boolean;
}

function readZip(archive: Buffer): Promise<readonly RawEntry[]> {
  return new Promise((resolve, reject) => {
    // **名前の検証を yauzl に任せない。**
    // 任せると拒否の理由が2箇所に分かれ、こちらの検証が試されないまま残る。
    // decodeStrings: false で yauzl の検証を外し、ここで一括して見る。
    yauzl.fromBuffer(archive, { lazyEntries: true, decodeStrings: false }, (openError, zip) => {
      if (openError !== null || zip === undefined) {
        reject(new PluginPackageError('zip として読めない'));
        return;
      }

      const entries: RawEntry[] = [];
      let totalBytes = 0;

      zip.on('error', (error: unknown) => {
        reject(new PluginPackageError(`zip の読み込みに失敗: ${String(error)}`));
      });

      zip.on('end', () => {
        resolve(entries);
      });

      zip.on('entry', (entry: yauzl.Entry) => {
        if (entries.length >= maxFiles()) {
          reject(new PluginPackageError(`ファイル数が多すぎる（上限 ${maxFiles()}）`));
          return;
        }

        // decodeStrings: false のため fileName は Buffer で届く。
        const fileName = Buffer.isBuffer(entry.fileName)
          ? entry.fileName.toString('utf8')
          : String(entry.fileName);

        const mode = entry.externalFileAttributes >>> 16;
        const isSymlink = (mode & S_IFMT) === S_IFLNK;
        const isDirectory = fileName.endsWith('/');

        // 展開する前に、宣言されたサイズで足切りする。
        totalBytes += entry.uncompressedSize;
        if (totalBytes > maxBytes()) {
          reject(new PluginPackageError(`展開後のサイズが大きすぎる（上限 ${maxBytes()} バイト）`));
          return;
        }

        if (isDirectory) {
          entries.push({
            name: fileName,
            data: Buffer.alloc(0),
            isSymlink: false,
            isDirectory: true,
          });
          zip.readEntry();
          return;
        }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            reject(new PluginPackageError(`展開に失敗: ${fileName}`));
            return;
          }

          const chunks: Buffer[] = [];
          let seen = 0;

          stream.on('data', (chunk: Buffer) => {
            seen += chunk.length;
            // 宣言サイズを信じきらない。嘘の宣言でメモリを食い潰せる。
            if (seen > maxBytes()) {
              stream.destroy();
              reject(new PluginPackageError('展開後のサイズが宣言と食い違う'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (error: unknown) => {
            reject(new PluginPackageError(`展開に失敗: ${String(error)}`));
          });
          stream.on('end', () => {
            entries.push({
              name: fileName,
              data: Buffer.concat(chunks),
              isSymlink,
              isDirectory: false,
            });
            zip.readEntry();
          });
        });
      });

      zip.readEntry();
    });
  });
}

/**
 * zip を読んで検証する。**ファイルシステムには何も書かない。**
 *
 * 要求 Permission を導入前に見せるため、展開と導入を分ける必要がある。
 */
export async function inspectPackage(archive: Buffer): Promise<InspectedPackage> {
  const raw = await readZip(archive);

  if (raw.length === 0) {
    throw new PluginPackageError('中身が空');
  }

  const topLevels = new Set<string>();
  for (const entry of raw) {
    if (isUnsafePath(entry.name)) {
      // Plugin の外へ書き込める。
      throw new PluginPackageError(`安全でないパスが含まれている: ${entry.name}`);
    }
    if (entry.isSymlink) {
      // 展開後にリンク経由で外を読み書きできる。
      throw new PluginPackageError(`シンボリックリンクが含まれている: ${entry.name}`);
    }
    const top = entry.name.split('/')[0];
    if (top !== undefined && top !== '') {
      topLevels.add(top);
    }
  }

  if (topLevels.size !== 1) {
    // どれが Plugin か決められない。
    throw new PluginPackageError(
      `トップレベルは1つのディレクトリにする（${topLevels.size} 個ある）`,
    );
  }

  const pluginId = [...topLevels][0] as string;
  const prefix = `${pluginId}/`;

  const manifestEntry = raw.find((entry) => entry.name === `${prefix}plugin.json`);
  if (manifestEntry === undefined) {
    throw new PluginPackageError('plugin.json が無い');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch {
    throw new PluginPackageError('plugin.json を読めない');
  }

  const validation = validateManifest(parsed, { knownPermissions: [...CORE_PERMISSIONS] });
  if (!validation.ok) {
    // **ビルドに入る前に弾く。** 通すと、壊れた Plugin で再ビルドが失敗する。
    throw new PluginPackageError(
      `plugin.json が不正: ${validation.problems.map((p) => `${p.field}: ${p.message}`).join(' / ')}`,
    );
  }

  if (validation.manifest.id !== pluginId) {
    // 食い違うと、ファイルを見て「どの Plugin か」が分からなくなる。
    throw new PluginPackageError(
      `ディレクトリ名と Plugin ID が一致しない（ディレクトリ: ${pluginId} / id: ${validation.manifest.id}）`,
    );
  }

  const hasEntryPoint = raw.some(
    (entry) => entry.name === `${prefix}index.ts` || entry.name === `${prefix}index.tsx`,
  );
  if (!hasEntryPoint) {
    throw new PluginPackageError('index.ts（または index.tsx）が無い');
  }

  const entries = raw
    .filter((entry) => !entry.isDirectory)
    .map((entry) => ({ path: entry.name.slice(prefix.length), data: entry.data }))
    .filter((entry) => entry.path !== '');

  return { pluginId, manifest: validation.manifest, entries };
}

export interface ExtractOptions {
  readonly pluginsDir: string;
  /** すでに同じ ID があるときに上書きするか。既定は上書きしない。 */
  readonly overwrite?: boolean;
}

/**
 * 検証済みの Package を `plugins/<id>/` へ書き出す。
 *
 * `inspectPackage` を通ったものだけを渡す。
 */
export async function extractPackage(
  inspected: InspectedPackage,
  options: ExtractOptions,
): Promise<string> {
  const target = join(options.pluginsDir, inspected.pluginId);

  if (options.overwrite === true) {
    await rm(target, { recursive: true, force: true });
  }

  await mkdir(target, { recursive: true });

  for (const entry of inspected.entries) {
    const destination = join(target, entry.path);

    // 二重の確認。join のあとで対象の外へ出ていないかを見る。
    // 検証を1箇所に頼ると、そこを直したときに気づけない。
    if (!destination.startsWith(target + sep)) {
      throw new PluginPackageError(`安全でないパス: ${entry.path}`);
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
  }

  return target;
}
