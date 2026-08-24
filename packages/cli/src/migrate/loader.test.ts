import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksumOf, loadMigrations } from './loader.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'torifune-migrations-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf8');
}

describe('loadMigrations', () => {
  it('連番SQLをバージョン昇順で返す', () => {
    put('002_second.sql', 'SELECT 2;');
    put('001_first.sql', 'SELECT 1;');
    put('010_tenth.sql', 'SELECT 10;');

    const migrations = loadMigrations(dir);

    expect(migrations.map((m) => m.version)).toEqual(['001', '002', '010']);
    expect(migrations.map((m) => m.name)).toEqual(['first', 'second', 'tenth']);
  });

  it('SQL本文を読み込む', () => {
    put('001_first.sql', 'CREATE TABLE a (id int);');

    const [migration] = loadMigrations(dir);

    expect(migration?.sql).toBe('CREATE TABLE a (id int);');
  });

  it('SQL本文の checksum を計算する', () => {
    put('001_first.sql', 'SELECT 1;');

    const [migration] = loadMigrations(dir);

    expect(migration?.checksum).toBe(checksumOf('SELECT 1;'));
  });

  it('.sql 以外のファイルを無視する', () => {
    put('001_first.sql', 'SELECT 1;');
    put('README.md', '# not a migration');
    put('notes.txt', 'ignored');

    expect(loadMigrations(dir)).toHaveLength(1);
  });

  it('マイグレーションが1件も無ければ空配列を返す', () => {
    expect(loadMigrations(dir)).toEqual([]);
  });

  it('ファイル名が NNN_name.sql の形式でなければエラーになる', () => {
    put('001_first.sql', 'SELECT 1;');
    put('oops.sql', 'SELECT 2;');

    expect(() => loadMigrations(dir)).toThrowError(/oops\.sql/);
  });

  it('バージョン番号が3桁でなければエラーになる', () => {
    put('1_first.sql', 'SELECT 1;');

    expect(() => loadMigrations(dir)).toThrowError(/1_first\.sql/);
  });

  it('バージョン番号が重複していればエラーになる', () => {
    put('001_first.sql', 'SELECT 1;');
    put('001_duplicate.sql', 'SELECT 2;');

    expect(() => loadMigrations(dir)).toThrowError(/001/);
  });

  it('存在しないディレクトリを指すとエラーになる', () => {
    expect(() => loadMigrations(join(dir, 'missing'))).toThrowError();
  });

  it('中身が空のSQLファイルはエラーになる', () => {
    put('001_empty.sql', '   \n  ');

    expect(() => loadMigrations(dir)).toThrowError(/001_empty\.sql/);
  });
});

describe('checksumOf', () => {
  it('同じ内容には同じ値を返す', () => {
    expect(checksumOf('SELECT 1;')).toBe(checksumOf('SELECT 1;'));
  });

  it('内容が変われば値が変わる', () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });

  it('改行コードの違いを無視する', () => {
    // Windows でチェックアウトしても checksum が変わらないこと。
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
  });

  it('末尾の空白を無視する', () => {
    expect(checksumOf('SELECT 1;\n')).toBe(checksumOf('SELECT 1;'));
  });
});
