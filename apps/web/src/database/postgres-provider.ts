import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Connection, DatabaseProvider } from './provider';
import type { Schema } from './schema';

export interface PostgresProviderOptions {
  readonly connectionString: string;
  /** Pool の上限。既定は 10。 */
  readonly maxConnections?: number;
  /** 接続確立のタイムアウト（ミリ秒）。既定は 5000。 */
  readonly connectionTimeoutMs?: number;
  /** アイドル接続を切るまでの時間（ミリ秒）。既定は 30000。 */
  readonly idleTimeoutMs?: number;
}

/**
 * 接続文字列にはパスワードが含まれる。
 * pg の例外やスタックトレースへ混ざったまま外へ出ると、ログに平文が残る。
 */
function redact(error: unknown, connectionString: string): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const secrets = [connectionString];
  try {
    const url = new URL(connectionString);
    if (url.password !== '') {
      secrets.push(url.password);
    }
  } catch {
    // URL として解釈できないときは全体を伏せるだけにする。
  }

  let message = original.message;
  for (const secret of secrets) {
    if (secret !== '') {
      message = message.split(secret).join('***');
    }
  }

  const redacted = new Error(message, { cause: undefined });
  redacted.stack = `${redacted.name}: ${message}`;
  return redacted;
}

/**
 * Kysely のハンドルを Connection として包む。
 *
 * 既にトランザクションの中にいる場合、`transaction()` は**新しいトランザクションを
 * 開始せず、外側のトランザクションに参加する**。
 *
 * こうしているのは、UseCase が別の UseCase を呼ぶ構成を成り立たせるため。
 * どちらもトランザクション境界を張ろうとしたときに、内側が独立してコミットできると
 * 「外側が失敗したのに内側の変更だけ残る」という壊れ方をする。
 * 参加方式なら、外側の失敗で必ず全体が取り消される。
 *
 * 内側だけを独立して取り消したい場合は SAVEPOINT が要るが、
 * その必要が出るまで導入しない。
 */
function connectionOf(db: Kysely<Schema>, inTransaction: boolean): Connection {
  return {
    db,
    async transaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T> {
      if (inTransaction) {
        return fn(connectionOf(db, true));
      }
      return db.transaction().execute((tx) => fn(connectionOf(tx as Kysely<Schema>, true)));
    },
  };
}

/**
 * 標準の Database Provider。
 *
 * 単一の PostgreSQL データベースへ接続する（02_データベース設計.md §2.2）。
 * テナントごとの切り替えのような別方式は、Plugin が Provider を差し替えて実現する。
 */
export function createPostgresProvider(options: PostgresProviderOptions): DatabaseProvider {
  const {
    connectionString,
    maxConnections = 10,
    connectionTimeoutMs = 5_000,
    idleTimeoutMs = 30_000,
  } = options;

  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    connectionTimeoutMillis: connectionTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
  });

  // アイドル接続がサーバー側で切られたときに、プロセスごと落ちるのを防ぐ。
  pool.on('error', () => undefined);

  const db = new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });

  let closed = false;

  return {
    async connect(): Promise<Connection> {
      if (closed) {
        throw new Error('Database provider は既に切断されている');
      }
      try {
        // 実際に取得できることを確かめてから Connection を返す。
        // 「接続オブジェクトは返るが最初のクエリで落ちる」を避ける。
        const client = await pool.connect();
        client.release();
      } catch (error) {
        throw redact(error, connectionString);
      }
      return connectionOf(db, false);
    },

    async disconnect(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await db.destroy().catch(() => undefined);
    },

    async healthCheck(): Promise<boolean> {
      if (closed) {
        return false;
      }
      try {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1');
          return true;
        } finally {
          client.release();
        }
      } catch {
        return false;
      }
    },
  };
}
