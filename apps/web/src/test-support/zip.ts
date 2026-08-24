import { crc32 } from 'node:zlib';

/**
 * テスト用の最小の ZIP 書き出し（無圧縮）。
 *
 * **ライブラリを使わずに自前で書く。** 拒否したい形（シンボリックリンク、
 * `..` を含むパス、絶対パス）を作れる書き出しライブラリが無い。
 * 作れなければ、拒否できていることを確かめられない。
 */

export interface ZipEntry {
  readonly name: string;
  readonly content?: string | Buffer;
  /** Unix のファイルモード。省略すると通常ファイル（0o100644）。 */
  readonly mode?: number;
  readonly isDirectory?: boolean;
}

export const REGULAR_FILE_MODE = 0o100644;
export const SYMLINK_MODE = 0o120777;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

interface Prepared {
  readonly name: Buffer;
  readonly data: Buffer;
  readonly crc: number;
  readonly externalAttributes: number;
  readonly offset: number;
}

export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const prepared: Prepared[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDirectory = entry.isDirectory === true;
    const name = Buffer.from(
      isDirectory && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name,
      'utf8',
    );
    const data = isDirectory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content)
        ? entry.content
        : Buffer.from(entry.content ?? '', 'utf8');
    const crc = data.length === 0 ? 0 : crc32(data);
    const mode = entry.mode ?? (isDirectory ? 0o040755 : REGULAR_FILE_MODE);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIGNATURE, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // 無圧縮
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0, 12); // date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, name, data);
    prepared.push({ name, data, crc, externalAttributes: mode << 16, offset });
    offset += header.length + name.length + data.length;
  }

  const central: Buffer[] = [];
  let centralSize = 0;

  for (const entry of prepared) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(0x031e, 4); // version made by: Unix
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(entry.externalAttributes >>> 0, 38);
    header.writeUInt32LE(entry.offset, 42);

    central.push(header, entry.name);
    centralSize += header.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(prepared.length, 8);
  end.writeUInt16LE(prepared.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end]);
}

/** そのまま通る Plugin Package。テストの土台。 */
export function validPackageZip(
  pluginId = 'sample-plugin',
  manifestOverrides: Record<string, unknown> = {},
): Buffer {
  const manifest = {
    id: pluginId,
    name: 'サンプル',
    version: '1.0.0',
    apiVersion: 1,
    ...manifestOverrides,
  };

  return buildZip([
    { name: `${pluginId}/`, isDirectory: true },
    { name: `${pluginId}/plugin.json`, content: JSON.stringify(manifest) },
    { name: `${pluginId}/index.ts`, content: 'export default { activate() {} };\n' },
  ]);
}
