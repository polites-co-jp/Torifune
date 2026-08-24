import { describe, expect, it } from 'vitest';
import { isCommand, parseMigrateArgs, usage } from './index.js';

describe('isCommand', () => {
  it('既知のコマンドを受け付ける', () => {
    expect(isCommand('migrate')).toBe(true);
  });

  it('未知のコマンドを拒否する', () => {
    expect(isCommand('drop-everything')).toBe(false);
  });
});

describe('usage', () => {
  it('migrate の使い方を含む', () => {
    expect(usage()).toContain('migrate');
    expect(usage()).toContain('--database-url');
  });
});

describe('parseMigrateArgs', () => {
  const env = { DATABASE_URL: 'postgresql://env-host/db' };

  it('--database-url=<url> を読む', () => {
    const result = parseMigrateArgs(['--database-url=postgresql://a/b'], {});
    expect(result.ok && result.value.databaseUrl).toBe('postgresql://a/b');
  });

  it('--database-url <url> の形も読む', () => {
    const result = parseMigrateArgs(['--database-url', 'postgresql://a/b'], {});
    expect(result.ok && result.value.databaseUrl).toBe('postgresql://a/b');
  });

  it('引数が無ければ DATABASE_URL を使う', () => {
    const result = parseMigrateArgs([], env);
    expect(result.ok && result.value.databaseUrl).toBe('postgresql://env-host/db');
  });

  it('引数は環境変数より優先される', () => {
    const result = parseMigrateArgs(['--database-url=postgresql://arg/db'], env);
    expect(result.ok && result.value.databaseUrl).toBe('postgresql://arg/db');
  });

  it('接続先がどこにも無ければエラーになる', () => {
    const result = parseMigrateArgs([], {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/--database-url|DATABASE_URL/);
  });

  it('--migrations-dir を読む', () => {
    const result = parseMigrateArgs(['--migrations-dir=/tmp/m'], env);
    expect(result.ok && result.value.migrationsDir).toBe('/tmp/m');
  });

  it('--migrations-dir が無ければ既定値を使う', () => {
    const result = parseMigrateArgs([], env);
    expect(result.ok && result.value.migrationsDir).toMatch(/migrations$/);
  });

  it('--dry-run を読む', () => {
    const result = parseMigrateArgs(['--dry-run'], env);
    expect(result.ok && result.value.dryRun).toBe(true);
  });

  it('--dry-run が無ければ false', () => {
    const result = parseMigrateArgs([], env);
    expect(result.ok && result.value.dryRun).toBe(false);
  });

  it('未知のオプションはエラーになる', () => {
    const result = parseMigrateArgs(['--drop-tables'], env);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--drop-tables');
  });

  it('値の無い --database-url はエラーになる', () => {
    const result = parseMigrateArgs(['--database-url'], env);
    expect(result.ok).toBe(false);
  });

  it('エラーメッセージに接続文字列が現れない', () => {
    const result = parseMigrateArgs(['--database-url=postgresql://u:sekret@h/db', '--nope'], {});
    expect(!result.ok && result.error).not.toContain('sekret');
  });
});
