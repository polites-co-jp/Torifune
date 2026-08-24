import type { PluginDatabaseConnection, PluginDatabaseProvider } from '@torifune/plugin-api';
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
import type { Connection, DatabaseProvider } from '@/database/provider';
import type { Schema } from '@/database/schema';

/**
 * Plugin の Database Provider を本体の Provider として使えるようにする。
 *
 * **公開契約にクエリビルダの型を出さない**（`plugin-api/database.ts`）ため、
 * Plugin が渡してくるのは `query(sql, params)` だけ。
 * ここで Kysely の Dialect を組み立てて橋渡しする。
 *
 * SQL の方言は PostgreSQL のまま。
 * マイグレーションが PostgreSQL の SQL で書かれており、
 * 方言まで差し替えるなら Plugin 側がそれも引き受けることになる。
 */

class PluginDriverConnection implements DatabaseConnection {
  constructor(private readonly connection: PluginDatabaseConnection) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const rows = await this.connection.query<R>(compiled.sql, compiled.parameters);
    return { rows: [...rows] };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    // **黙って空を返さない。** 対応していないことを呼び出し側へ伝える。
    throw new Error('Plugin の Database Provider はストリーム取得に対応していない');
  }
}

class PluginDriver implements Driver {
  private connection: PluginDatabaseConnection | null = null;

  constructor(private readonly provider: PluginDatabaseProvider) {}

  async init(): Promise<void> {
    this.connection = await this.provider.connect();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.connection === null) {
      this.connection = await this.provider.connect();
    }
    return new PluginDriverConnection(this.connection);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('BEGIN'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  releaseConnection(): Promise<void> {
    // Plugin 側が接続を持っている。ここでは何もしない。
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    // **ここでは Plugin を切らない。** Kysely はクエリを1度も流さないと
    // Driver を初期化せず、destroy も呼ばない。
    // 切断の責任は adaptPluginDatabaseProvider が持ち、1度だけ呼ぶ。
    this.connection = null;
    return Promise.resolve();
  }
}

function dialectFor(provider: PluginDatabaseProvider): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PluginDriver(provider),
    createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

function connectionOf(db: Kysely<Schema>, inTransaction: boolean): Connection {
  return {
    db,
    async transaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T> {
      // 既にトランザクションの中なら、新しく張らずに参加する。
      // 本体の PostgreSQL Provider と同じ約束にしておかないと、
      // Provider を差し替えたときだけ壊れ方が変わる。
      if (inTransaction) {
        return fn(connectionOf(db, true));
      }
      return db.transaction().execute((tx) => fn(connectionOf(tx as Kysely<Schema>, true)));
    },
  };
}

/** Plugin の Provider を本体の Provider として包む。 */
export function adaptPluginDatabaseProvider(provider: PluginDatabaseProvider): DatabaseProvider {
  let db: Kysely<Schema> | null = null;

  function handle(): Kysely<Schema> {
    db ??= new Kysely<Schema>({ dialect: dialectFor(provider) });
    return db;
  }

  return {
    connect(): Promise<Connection> {
      return Promise.resolve(connectionOf(handle(), false));
    },

    async disconnect(): Promise<void> {
      if (db !== null) {
        await db.destroy();
        db = null;
      }
      // Kysely を使ったかどうかによらず、Plugin へ必ず伝える。
      await provider.disconnect();
    },

    async healthCheck(): Promise<boolean> {
      // **例外を投げない。** Readiness プローブから呼ばれる。
      try {
        return await provider.healthCheck();
      } catch {
        return false;
      }
    },
  };
}
