import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './runner.js';

/** 失敗することを期待する呼び出しから Error を取り出す。 */
async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('失敗するはずの処理が成功した');
}

/**
 * 結合テスト。PostgreSQL を必要とする。
 *
 * DATABASE_URL が無いときは**失敗させる**。スキップにすると、CI で DB が落ちていても
 * 緑になり、テストが意味を失うため。
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

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;

/** マイグレーションは DDL を伴うため、テストごとに使い捨てのデータベースを作る。 */
async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `torifune_mig_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropScratchDatabase(name: string): Promise<void> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

async function queryScratch<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

function put(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf8');
}

beforeAll(() => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 4 });
});

afterAll(async () => {
  await adminPool.end();
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'torifune-runner-'));
  const scratch = await createScratchDatabase();
  databaseName = scratch.name;
  databaseUrl = scratch.url;
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(databaseName);
});

describe('applyMigrations', () => {
  it('空のDBへ適用し、schema_migrations に記録する', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');

    const result = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(result.applied.map((m) => m.version)).toEqual(['001']);
    const rows = await queryScratch<{ version: string; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    );
    expect(rows).toEqual([{ version: '001', name: 'create_a' }]);
  });

  it('二度目の実行では何も適用しない', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    await applyMigrations({ databaseUrl, migrationsDir: dir });

    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['001']);
  });

  it('二度目の実行で既存データが変化しない', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    await applyMigrations({ databaseUrl, migrationsDir: dir });
    await queryScratch('INSERT INTO a (id) VALUES (42)');

    await applyMigrations({ databaseUrl, migrationsDir: dir });

    const rows = await queryScratch<{ id: number }>('SELECT id FROM a');
    expect(rows).toEqual([{ id: 42 }]);
  });

  it('適用済みマイグレーションが書き換えられていたらエラーで止まる', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');
    await applyMigrations({ databaseUrl, migrationsDir: dir });

    put('001_create_a.sql', 'CREATE TABLE a (id bigint PRIMARY KEY);');

    await expect(applyMigrations({ databaseUrl, migrationsDir: dir })).rejects.toThrowError(/001/);
  });

  it('バージョン番号の昇順で適用する', async () => {
    put('010_third.sql', 'CREATE TABLE c (id int);');
    put('002_second.sql', 'CREATE TABLE b (id int);');
    put('001_first.sql', 'CREATE TABLE a (id int);');

    const result = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(result.applied.map((m) => m.version)).toEqual(['001', '002', '010']);
  });

  it('途中で失敗したら、その版の変更はロールバックされ、以降は適用されない', async () => {
    put('001_ok.sql', 'CREATE TABLE a (id int);');
    put('002_broken.sql', 'CREATE TABLE b (id int); THIS IS NOT SQL;');
    put('003_never.sql', 'CREATE TABLE c (id int);');

    await expect(applyMigrations({ databaseUrl, migrationsDir: dir })).rejects.toThrowError(/002/);

    const tables = await queryScratch<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const names = tables.map((t) => t.table_name);
    expect(names).toContain('a');
    expect(names).not.toContain('b');
    expect(names).not.toContain('c');
  });

  it('失敗したマイグレーションは schema_migrations に記録されない', async () => {
    put('001_ok.sql', 'CREATE TABLE a (id int);');
    put('002_broken.sql', 'THIS IS NOT SQL;');

    await expect(applyMigrations({ databaseUrl, migrationsDir: dir })).rejects.toThrowError();

    const rows = await queryScratch<{ version: string }>('SELECT version FROM schema_migrations');
    expect(rows.map((r) => r.version)).toEqual(['001']);
  });

  it('同時に実行しても二重適用されない', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int PRIMARY KEY);');

    const results = await Promise.all([
      applyMigrations({ databaseUrl, migrationsDir: dir }),
      applyMigrations({ databaseUrl, migrationsDir: dir }),
      applyMigrations({ databaseUrl, migrationsDir: dir }),
    ]);

    const appliedCount = results.reduce((sum, r) => sum + r.applied.length, 0);
    expect(appliedCount).toBe(1);

    const rows = await queryScratch<{ version: string }>('SELECT version FROM schema_migrations');
    expect(rows).toHaveLength(1);
  });

  it('dryRun では適用せず、対象の一覧だけを返す', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int);');

    const result = await applyMigrations({ databaseUrl, migrationsDir: dir, dryRun: true });

    expect(result.pending.map((m) => m.version)).toEqual(['001']);
    expect(result.applied).toEqual([]);

    const tables = await queryScratch<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.map((t) => t.table_name)).not.toContain('a');
  });

  it('エラーメッセージに接続文字列が含まれない', async () => {
    put('001_broken.sql', 'THIS IS NOT SQL;');

    const error = await errorFrom(applyMigrations({ databaseUrl, migrationsDir: dir }));

    const text = `${error.message}\n${error.stack ?? ''}`;
    expect(text).not.toContain('torifune:torifune');
    expect(text).not.toContain(databaseUrl);
  });

  it('接続できないときは接続情報を伏せたエラーになる', async () => {
    put('001_create_a.sql', 'CREATE TABLE a (id int);');
    const badUrl = 'postgresql://nobody:sekret@127.0.0.1:1/nothing';

    const error = await errorFrom(applyMigrations({ databaseUrl: badUrl, migrationsDir: dir }));

    expect(error).toBeInstanceOf(Error);
    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain('sekret');
  });
});

describe('Torifune の初期スキーマ', () => {
  const repoMigrations = join(import.meta.dirname, '..', '..', '..', '..', 'migrations');

  beforeEach(async () => {
    await applyMigrations({ databaseUrl, migrationsDir: repoMigrations });
  });

  it('繰り返し適用しても壊れない', async () => {
    const second = await applyMigrations({ databaseUrl, migrationsDir: repoMigrations });
    expect(second.applied).toEqual([]);
  });

  it('login_id が大文字小文字を区別せず一意である', async () => {
    await queryScratch(
      "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-00000000000a', 'Alice', 'a@example.com', 'Alice')",
    );

    await expect(
      queryScratch(
        "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-00000000000b', 'alice', 'b@example.com', 'alice')",
      ),
    ).rejects.toThrowError();
  });

  it('email が大文字小文字を区別せず一意である', async () => {
    await queryScratch(
      "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-00000000000c', 'bob', 'Bob@example.com', 'Bob')",
    );

    await expect(
      queryScratch(
        "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-00000000000d', 'bob2', 'bob@example.com', 'Bob2')",
      ),
    ).rejects.toThrowError();
  });

  it('users.status に定義外の値を入れられない', async () => {
    await expect(
      queryScratch(
        "INSERT INTO users (id, login_id, email, display_name, status) VALUES ('01900000-0000-7000-8000-00000000000e', 'carol', 'c@example.com', 'Carol', 'zombie')",
      ),
    ).rejects.toThrowError();
  });

  it('ユーザーを削除すると user_roles と sessions も消える', async () => {
    await queryScratch(
      "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-00000000000f', 'dave', 'd@example.com', 'Dave')",
    );
    await queryScratch(
      "INSERT INTO user_roles (user_id, role_id) VALUES ('01900000-0000-7000-8000-00000000000f', '01900000-0000-7000-8000-000000000003')",
    );
    await queryScratch(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('01900000-0000-7000-8000-0000000000f0', '01900000-0000-7000-8000-00000000000f', 'hash-1', now() + interval '1 day')",
    );

    await queryScratch("DELETE FROM users WHERE id = '01900000-0000-7000-8000-00000000000f'");

    expect(await queryScratch('SELECT * FROM user_roles')).toEqual([]);
    expect(await queryScratch('SELECT * FROM sessions')).toEqual([]);
  });

  it('ユーザーを削除しても監査ログは残り、user_id が NULL になる', async () => {
    await queryScratch(
      "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-0000000000aa', 'erin', 'e@example.com', 'Erin')",
    );
    await queryScratch(
      "INSERT INTO auth_audit_logs (id, event, user_id) VALUES ('01900000-0000-7000-8000-0000000000ab', 'login.succeeded', '01900000-0000-7000-8000-0000000000aa')",
    );

    await queryScratch("DELETE FROM users WHERE id = '01900000-0000-7000-8000-0000000000aa'");

    const rows = await queryScratch<{ event: string; user_id: string | null }>(
      'SELECT event, user_id FROM auth_audit_logs',
    );
    expect(rows).toEqual([{ event: 'login.succeeded', user_id: null }]);
  });

  it('sessions.token_hash が一意である', async () => {
    await queryScratch(
      "INSERT INTO users (id, login_id, email, display_name) VALUES ('01900000-0000-7000-8000-0000000000ba', 'frank', 'f@example.com', 'Frank')",
    );
    await queryScratch(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('01900000-0000-7000-8000-0000000000bb', '01900000-0000-7000-8000-0000000000ba', 'same-hash', now() + interval '1 day')",
    );

    await expect(
      queryScratch(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ('01900000-0000-7000-8000-0000000000bc', '01900000-0000-7000-8000-0000000000ba', 'same-hash', now() + interval '1 day')",
      ),
    ).rejects.toThrowError();
  });

  it('初期 Role が3件、初期 Permission が10件ある', async () => {
    const roles = await queryScratch<{ name: string }>('SELECT name FROM roles ORDER BY name');
    expect(roles.map((r) => r.name)).toEqual(['administrator', 'editor', 'viewer']);

    // 003 で content.* を取り下げたため 9 件（改訂履歴.md 2026-08-24）。
    const permissions = await queryScratch<{ name: string }>('SELECT name FROM permissions');
    expect(permissions).toHaveLength(10);
  });

  it('administrator が全 Permission を持つ', async () => {
    const rows = await queryScratch<{ missing: string }>(`
      SELECT p.name AS missing
      FROM permissions p
      WHERE NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        JOIN roles r ON r.id = rp.role_id
        WHERE r.name = 'administrator' AND rp.permission_name = p.name
      )
    `);
    expect(rows).toEqual([]);
  });

  it('viewer は read 系の Permission だけを持つ', async () => {
    const rows = await queryScratch<{ permission_name: string }>(`
      SELECT rp.permission_name
      FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id
      WHERE r.name = 'viewer'
      ORDER BY rp.permission_name
    `);
    expect(rows.map((r) => r.permission_name)).toEqual(['site.read', 'social.read']);
  });

  it('Permission 名の形式が強制される', async () => {
    await expect(
      queryScratch("INSERT INTO permissions (name, display_name) VALUES ('NotValid', 'x')"),
    ).rejects.toThrowError();
  });
});
