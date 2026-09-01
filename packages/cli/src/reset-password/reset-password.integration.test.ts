import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hash, verify } from '@node-rs/argon2';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../migrate/runner.js';
import { InvalidPasswordError, resetPassword, UserNotFoundError } from './reset-password.js';

/**
 * 結合テスト。PostgreSQL を必要とする。
 *
 * DATABASE_URL が無いときは**失敗させる**。スキップにすると、CI で DB が落ちていても
 * 緑になり、テストが意味を失うため（`migrate/runner.integration.test.ts` と同じ方針）。
 */
const ADMIN_URL = process.env['TORIFUNE_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];

if (ADMIN_URL === undefined || ADMIN_URL === '') {
  throw new Error(
    '結合テストには TORIFUNE_TEST_DATABASE_URL または DATABASE_URL が必要。' +
      'ローカルでは `docker compose up -d postgres-test` を実行し、' +
      'TORIFUNE_TEST_DATABASE_URL=postgresql://torifune:torifune@localhost:21701/torifune_test を設定する。',
  );
}

const adminUrl: string = ADMIN_URL;

/** リポジトリ同梱の migrations/。packages/cli/src/reset-password → リポジトリルート。 */
const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'migrations');

let adminPool: pg.Pool;
let databaseName: string;
let databaseUrl: string;
let userId: string;

async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('失敗するはずの処理が成功した');
}

async function query<T extends pg.QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<T>(sql, params as unknown[]);
    return result.rows;
  } finally {
    await client.end();
  }
}

/** セッションを1本作る。`revoked` が true なら最初から失効させておく。 */
async function insertSession(revoked: boolean): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, revoked_at)
     VALUES ($1, $2, $3, now() + interval '7 days', $4)`,
    [id, userId, randomUUID(), revoked ? new Date() : null],
  );
  return id;
}

beforeAll(() => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 4 });
});

afterAll(async () => {
  await adminPool.end();
});

beforeEach(async () => {
  databaseName = `torifune_reset_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  await applyMigrations({ databaseUrl, migrationsDir: MIGRATIONS_DIR });

  userId = randomUUID();
  await query(
    `INSERT INTO users (id, login_id, email, display_name, password_hash)
     VALUES ($1, 'Admin', 'admin@example.com', '管理者', $2)`,
    [userId, await hash('old-password')],
  );
});

afterEach(async () => {
  await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
});

describe('resetPassword', () => {
  it('パスワードを差し替える', async () => {
    const result = await resetPassword({
      databaseUrl,
      loginId: 'Admin',
      newPassword: 'new-password-1234',
    });

    expect(result.userId).toBe(userId);
    expect(result.loginId).toBe('Admin');

    const [row] = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    expect(await verify(row?.password_hash as string, 'new-password-1234')).toBe(true);
    expect(await verify(row?.password_hash as string, 'old-password')).toBe(false);
  });

  it('ログインIDの大文字小文字を区別しない', async () => {
    // users の一意索引が lower(login_id) のため、照合もそれに合わせる。
    const result = await resetPassword({
      databaseUrl,
      loginId: 'ADMIN',
      newPassword: 'new-password-1234',
    });
    expect(result.userId).toBe(userId);
  });

  /**
   * パスワードを変えた以上、既存のセッションは信用できない。
   * 乗っ取られていた場合、ここで追い出せなければリセットの意味がない
   * （`application/auth/password-reset.ts` と同じ扱い）。
   */
  it('有効なセッションをすべて失効させる', async () => {
    const live = await insertSession(false);
    const alsoLive = await insertSession(false);

    const result = await resetPassword({
      databaseUrl,
      loginId: 'admin',
      newPassword: 'new-password-1234',
    });

    expect(result.revokedSessions).toBe(2);

    const rows = await query<{ id: string; revoked_at: Date | null }>(
      'SELECT id, revoked_at FROM sessions WHERE id = ANY($1)',
      [[live, alsoLive]],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.revoked_at).not.toBeNull();
    }
  });

  it('すでに失効しているセッションの失効時刻を書き換えない', async () => {
    const revoked = await insertSession(true);
    const [before] = await query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM sessions WHERE id = $1',
      [revoked],
    );

    const result = await resetPassword({
      databaseUrl,
      loginId: 'admin',
      newPassword: 'new-password-1234',
    });

    expect(result.revokedSessions).toBe(0);

    const [after] = await query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM sessions WHERE id = $1',
      [revoked],
    );
    expect(after?.revoked_at.getTime()).toBe(before?.revoked_at.getTime());
  });

  it('監査ログに password.changed を残す', async () => {
    await resetPassword({ databaseUrl, loginId: 'admin', newPassword: 'new-password-1234' });

    const rows = await query<{ event: string; user_id: string; detail: Record<string, unknown> }>(
      'SELECT event, user_id, detail FROM auth_audit_logs WHERE user_id = $1',
      [userId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe('password.changed');
    expect(rows[0]?.user_id).toBe(userId);
    // 誰が変えたのかを後から追えるようにする。
    expect(rows[0]?.detail).toMatchObject({ via: 'cli' });
  });

  it('監査ログにパスワードを残さない', async () => {
    await resetPassword({ databaseUrl, loginId: 'admin', newPassword: 'super-secret-9999' });

    const rows = await query<{ detail: unknown }>('SELECT detail FROM auth_audit_logs');
    expect(JSON.stringify(rows)).not.toContain('super-secret-9999');
  });

  it('存在しないログインIDなら UserNotFoundError を投げる', async () => {
    const error = await errorFrom(
      resetPassword({ databaseUrl, loginId: 'nobody', newPassword: 'new-password-1234' }),
    );
    expect(error).toBeInstanceOf(UserNotFoundError);
  });

  it('存在しないログインIDのとき何も変更しない', async () => {
    await insertSession(false);
    const [before] = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );

    await errorFrom(
      resetPassword({ databaseUrl, loginId: 'nobody', newPassword: 'new-password-1234' }),
    );

    const [after] = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    );
    expect(after?.password_hash).toBe(before?.password_hash);

    const sessions = await query<{ count: string }>(
      'SELECT count(*) AS count FROM sessions WHERE revoked_at IS NOT NULL',
    );
    expect(sessions[0]?.count).toBe('0');

    const audit = await query<{ count: string }>('SELECT count(*) AS count FROM auth_audit_logs');
    expect(audit[0]?.count).toBe('0');
  });

  it('空のパスワードを拒否する', async () => {
    const error = await errorFrom(
      resetPassword({ databaseUrl, loginId: 'admin', newPassword: '   ' }),
    );
    expect(error).toBeInstanceOf(InvalidPasswordError);
  });

  it('長すぎるパスワードを拒否する', async () => {
    // 長大な入力でハッシュ計算に時間を使わされるのを防ぐ（authentication/password.ts と同じ上限）。
    const error = await errorFrom(
      resetPassword({ databaseUrl, loginId: 'admin', newPassword: 'a'.repeat(1025) }),
    );
    expect(error).toBeInstanceOf(InvalidPasswordError);
  });

  /**
   * 無効化されたユーザーのパスワードは変えられない。
   * 変えられると、無効化したはずのアカウントを復活させる裏口になる。
   */
  it('無効化されたユーザーには適用しない', async () => {
    await query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [userId]);

    const error = await errorFrom(
      resetPassword({ databaseUrl, loginId: 'admin', newPassword: 'new-password-1234' }),
    );
    expect(error).toBeInstanceOf(UserNotFoundError);
  });

  it('エラーメッセージに接続文字列が現れない', async () => {
    const url = new URL(databaseUrl);
    url.password = 'sekret';

    const error = await errorFrom(
      resetPassword({
        databaseUrl: url.toString(),
        loginId: 'admin',
        newPassword: 'new-password-1234',
      }),
    );
    expect(error.message).not.toContain('sekret');
  });
});
