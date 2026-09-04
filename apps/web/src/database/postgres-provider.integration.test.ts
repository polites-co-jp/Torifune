import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetLogger, setLogger, type LogRecord } from '../infrastructure/logging';
import { useScratchDatabase, type ScratchDatabase } from '../test-support/database';
import { createPostgresProvider } from './postgres-provider';
import type { DatabaseProvider } from './provider';

/** 失敗することを期待する呼び出しから Error を取り出す。 */
async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('失敗するはずの処理が成功した');
}

/** 結合テスト。PostgreSQL を必要とする。このファイル専用のデータベースを使う。 */
let scratch: ScratchDatabase;
let databaseUrl: string;

let provider: DatabaseProvider;

beforeAll(async () => {
  scratch = await useScratchDatabase('dbprovider');
  databaseUrl = scratch.connectionString;
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(() => {
  provider = createPostgresProvider({ connectionString: databaseUrl, maxConnections: 4 });
});

afterEach(async () => {
  await provider.disconnect();
});

describe('healthCheck', () => {
  it('接続できるとき true を返す', async () => {
    await expect(provider.healthCheck()).resolves.toBe(true);
  });

  it('接続できないときは例外を投げず false を返す', async () => {
    const broken = createPostgresProvider({
      connectionString: 'postgresql://nobody:sekret@127.0.0.1:1/nothing',
      maxConnections: 1,
    });

    await expect(broken.healthCheck()).resolves.toBe(false);

    await broken.disconnect();
  });

  it('disconnect したあとに呼んでも例外を投げない', async () => {
    await provider.disconnect();

    await expect(provider.healthCheck()).resolves.toBe(false);
  });
});

describe('connect', () => {
  it('クエリを実行できる', async () => {
    const connection = await provider.connect();

    const rows = await connection.db.selectFrom('roles').select(['name']).orderBy('name').execute();

    expect(rows.map((r) => r.name)).toEqual(['administrator', 'editor', 'viewer']);
  });

  it('disconnect 後の connect は失敗する', async () => {
    await provider.disconnect();

    await expect(provider.connect()).rejects.toThrowError();
  });
});

describe('transaction', () => {
  it('正常終了すると変更がコミットされる', async () => {
    const connection = await provider.connect();
    const id = '01900000-0000-7000-8000-0000000000c1';

    await connection.transaction(async (tx) => {
      await tx.db
        .insertInto('users')
        .values({
          id,
          login_id: 'tx-commit',
          email: 'tx-commit@example.com',
          display_name: 'tx',
        })
        .execute();
    });

    const found = await connection.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(found?.id).toBe(id);

    await connection.db.deleteFrom('users').where('id', '=', id).execute();
  });

  it('例外を投げると変更がすべてロールバックされる', async () => {
    const connection = await provider.connect();
    const id = '01900000-0000-7000-8000-0000000000c2';

    await expect(
      connection.transaction(async (tx) => {
        await tx.db
          .insertInto('users')
          .values({
            id,
            login_id: 'tx-rollback',
            email: 'tx-rollback@example.com',
            display_name: 'tx',
          })
          .execute();
        throw new Error('意図的な失敗');
      }),
    ).rejects.toThrowError('意図的な失敗');

    const found = await connection.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(found).toBeUndefined();
  });

  it('戻り値をそのまま返す', async () => {
    const connection = await provider.connect();

    const result = await connection.transaction(async () => 'done');

    expect(result).toBe('done');
  });

  it('トランザクションの内と外で同じ形の Connection を渡す', async () => {
    const connection = await provider.connect();

    // 同じ Repository 実装がトランザクションの内外どちらでも動くことを、
    // Connection を受け取る関数が両方で成立することで確かめる。
    const countRoles = async (c: { db: typeof connection.db }): Promise<number> => {
      const rows = await c.db.selectFrom('roles').select('id').execute();
      return rows.length;
    };

    const outside = await countRoles(connection);
    const inside = await connection.transaction((tx) => countRoles(tx));

    expect(inside).toBe(outside);
  });

  it('入れ子のトランザクションでも、外側の失敗で全体がロールバックされる', async () => {
    const connection = await provider.connect();
    const id = '01900000-0000-7000-8000-0000000000c3';

    await expect(
      connection.transaction(async (tx) => {
        await tx.transaction(async (inner) => {
          await inner.db
            .insertInto('users')
            .values({
              id,
              login_id: 'tx-nested',
              email: 'tx-nested@example.com',
              display_name: 'tx',
            })
            .execute();
        });
        throw new Error('外側で失敗');
      }),
    ).rejects.toThrowError('外側で失敗');

    const found = await connection.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(found).toBeUndefined();
  });
});

describe('接続エラーの扱い', () => {
  it('接続失敗のエラーに接続文字列が含まれない', async () => {
    const broken = createPostgresProvider({
      connectionString: 'postgresql://nobody:sekret@127.0.0.1:1/nothing',
      maxConnections: 1,
    });

    const error = await errorFrom(broken.connect());
    await broken.disconnect();

    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain('sekret');
  });

  /**
   * 接続断をログに出す（029-scheduled-jobs 検証の反映。受け入れ条件 #86。security-reviewer L-2）。
   *
   * `pool.on('error', () => undefined)` と、貸出中クライアントの `client.on('error', () => undefined)` は
   * **プロセスを落とさないために要る**（購読者が 0 だと EventEmitter が uncaughtException を投げる）が、
   * 握ったまま何も出さないと接続断が**どこにも残らない**。
   * 029 の主題は「障害を `busy` に丸めず見えるようにする」ことなので、握るなら記録する。
   *
   * ログは `log.warn('database connection error', { reason })`。
   * `reason` は自由文なので `redactSecrets` を通す（`maskSecrets` はキー名判定で効かない）。
   */
  describe('接続断のログ', () => {
    /** この使い捨て DB へ張られている、自分以外のバックエンドを落とす。 */
    async function terminateOtherBackends(): Promise<number> {
      const client = new pg.Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const result = await client.query<{ pid: number }>(
          `SELECT pg_terminate_backend(pid) AS ok, pid FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()`,
        );
        return result.rowCount ?? 0;
      } finally {
        await client.end();
      }
    }

    /** #86 */
    it('接続が切られると database connection error の warn が出る', async () => {
      const records: LogRecord[] = [];
      setLogger({
        log(level, message, fields) {
          records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
        },
      });

      try {
        // Pool に接続を作らせてから返す（アイドルの接続を用意する）。
        const connection = await provider.connect();
        await sql`SELECT 1`.execute(connection.db);

        const terminated = await terminateOtherBackends();
        expect(terminated, 'このデータベースへの接続が見つからない').toBeGreaterThan(0);

        // 'error' はソケットが閉じたときに非同期で届く。
        for (let i = 0; i < 50; i += 1) {
          if (records.some((record) => record.message === 'database connection error')) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const logged = records.filter((record) => record.message === 'database connection error');
        expect(logged.length, '接続断が一切ログに出ていない').toBeGreaterThanOrEqual(1);
        expect(logged[0]?.level).toBe('warn');
        expect(String(logged[0]?.fields?.['reason'] ?? '').length).toBeGreaterThan(0);
      } finally {
        resetLogger();
      }
    }, 20_000);

    /** #86。`reason` は `redactSecrets` を通す（接続文字列を残さない）。 */
    it('切断のログに接続文字列が出ない', async () => {
      const records: LogRecord[] = [];
      setLogger({
        log(level, message, fields) {
          records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
        },
      });

      try {
        const connection = await provider.connect();
        await sql`SELECT 1`.execute(connection.db);
        await terminateOtherBackends();

        for (let i = 0; i < 50; i += 1) {
          if (records.some((record) => record.message === 'database connection error')) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        const serialized = JSON.stringify(records);
        expect(serialized).not.toContain(databaseUrl);
        // 使い捨て DB の接続文字列の credential 部（`user:password@`）。
        const credential = databaseUrl.slice(0, databaseUrl.indexOf('@') + 1);
        expect(credential.length).toBeGreaterThan(0);
        expect(serialized).not.toContain(credential);
      } finally {
        resetLogger();
      }
    }, 20_000);
  });
});
