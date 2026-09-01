import { describe, expect, it } from 'vitest';
import { isCommand, parseMigrateArgs, parseResetPasswordArgs, usage } from './index.js';

describe('isCommand', () => {
  it('既知のコマンドを受け付ける', () => {
    expect(isCommand('migrate')).toBe(true);
  });

  it('reset-password を受け付ける', () => {
    expect(isCommand('reset-password')).toBe(true);
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

  it('reset-password の使い方を含む', () => {
    expect(usage()).toContain('reset-password');
    expect(usage()).toContain('--login-id');
  });
});

describe('parseResetPasswordArgs', () => {
  const env = { DATABASE_URL: 'postgresql://env-host/db' };

  it('--login-id=<id> を読む', () => {
    const result = parseResetPasswordArgs(['--login-id=admin'], env);
    expect(result.ok && result.value.loginId).toBe('admin');
  });

  it('--login-id <id> の形も読む', () => {
    const result = parseResetPasswordArgs(['--login-id', 'admin'], env);
    expect(result.ok && result.value.loginId).toBe('admin');
  });

  it('--login-id が無ければエラーになる', () => {
    const result = parseResetPasswordArgs([], env);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--login-id');
  });

  it('接続先がどこにも無ければエラーになる', () => {
    const result = parseResetPasswordArgs(['--login-id=admin'], {});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/--database-url|DATABASE_URL/);
  });

  it('引数が無ければ DATABASE_URL を使う', () => {
    const result = parseResetPasswordArgs(['--login-id=admin'], env);
    expect(result.ok && result.value.databaseUrl).toBe('postgresql://env-host/db');
  });

  it('--generate を読む', () => {
    const result = parseResetPasswordArgs(['--login-id=admin', '--generate'], env);
    expect(result.ok && result.value.generate).toBe(true);
  });

  it('--generate が無ければ false', () => {
    const result = parseResetPasswordArgs(['--login-id=admin'], env);
    expect(result.ok && result.value.generate).toBe(false);
  });

  it('未知のオプションはエラーになる', () => {
    const result = parseResetPasswordArgs(['--login-id=admin', '--drop-tables'], env);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('--drop-tables');
  });

  /**
   * パスワードを引数で受けない。
   * 引数に書くとシェル履歴と ps に平文で残る。
   */
  it('--password は受け付けない', () => {
    const result = parseResetPasswordArgs(['--login-id=admin', '--password=hunter2'], env);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).not.toContain('hunter2');
  });

  it('エラーメッセージに接続文字列が現れない', () => {
    const result = parseResetPasswordArgs(
      ['--database-url=postgresql://u:sekret@h/db', '--login-id=admin', '--nope'],
      {},
    );
    expect(!result.ok && result.error).not.toContain('sekret');
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
