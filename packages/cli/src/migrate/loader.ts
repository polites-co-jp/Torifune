import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 連番SQL 1本を表す。 */
export interface Migration {
  /** 3桁のバージョン番号。ファイル名の先頭から取る。 */
  readonly version: string;
  /** バージョン番号を除いたファイル名。 */
  readonly name: string;
  /** 元のファイル名。エラーメッセージ用。 */
  readonly fileName: string;
  /** SQL本文。 */
  readonly sql: string;
  /** 適用済みマイグレーションの改変を検出するためのハッシュ。 */
  readonly checksum: string;
}

const FILE_NAME_PATTERN = /^(\d{3})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;

/**
 * SQL本文のハッシュを計算する。
 *
 * 改行コードと末尾の空白は正規化する。
 * Windows でチェックアウトして CRLF になったファイルが「改変された」と誤検出されると、
 * 環境によってマイグレーションが通らなくなるため。
 */
export function checksumOf(sql: string): string {
  const normalized = sql.replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * ディレクトリから連番SQLを読み込み、バージョン昇順で返す。
 *
 * 形式が崩れているファイルやバージョン重複は、適用前にエラーにする。
 * 「読めたものだけ適用する」という寛容な振る舞いは、
 * 適用漏れに気づけないまま進むほうが危険なので採らない。
 */
export function loadMigrations(directory: string): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (cause) {
    throw new Error(`マイグレーションディレクトリを読めない: ${directory}`, { cause });
  }

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries.filter((e) => e.endsWith('.sql')).sort()) {
    const matched = FILE_NAME_PATTERN.exec(entry);
    if (matched === null) {
      throw new Error(
        `マイグレーションのファイル名が不正: ${entry}（NNN_name.sql の形式にする。例: 001_initial.sql）`,
      );
    }

    const version = matched[1] as string;
    const name = matched[2] as string;

    const duplicate = seen.get(version);
    if (duplicate !== undefined) {
      throw new Error(
        `マイグレーションのバージョンが重複している: ${version}（${duplicate} と ${entry}）`,
      );
    }
    seen.set(version, entry);

    const sql = readFileSync(join(directory, entry), 'utf8');
    if (sql.trim() === '') {
      throw new Error(`マイグレーションの中身が空: ${entry}`);
    }

    migrations.push({ version, name, fileName: entry, sql, checksum: checksumOf(sql) });
  }

  migrations.sort((a, b) => a.version.localeCompare(b.version));
  return migrations;
}
