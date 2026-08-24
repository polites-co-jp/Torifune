import { createPostgresProvider } from './postgres-provider';
import type { Connection, DatabaseProvider } from './provider';

/**
 * Database Provider の登録と解決。
 *
 * 標準では PostgreSQL Provider を使う。Plugin が差し替えることで別の接続方式を
 * 実装できる（01_アーキテクチャ設計.md §9）。差し替えの口は
 * `011-plugin-runtime` でここへ繋ぐ。
 *
 * ビジネスロジックは、どの Provider が使われているかを知らない。
 */

let provider: DatabaseProvider | null = null;

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('DATABASE_URL が設定されていない');
    this.name = 'DatabaseNotConfiguredError';
  }
}

function createDefaultProvider(): DatabaseProvider {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new DatabaseNotConfiguredError();
  }
  return createPostgresProvider({ connectionString });
}

/** 現在の Provider を返す。未設定なら標準 Provider を生成する。 */
export function getDatabaseProvider(): DatabaseProvider {
  provider ??= createDefaultProvider();
  return provider;
}

/**
 * Provider を差し替える。
 *
 * Plugin の Database Provider と、テストの差し替えのための入口。
 * 既存の Provider は呼び出し側の責任で切断する（ここで勝手に切ると、
 * 差し替え中に走っているリクエストが道連れになる）。
 */
export function setDatabaseProvider(next: DatabaseProvider | null): void {
  provider = next;
}

/** 接続を1つ取得する。 */
export function getConnection(): Promise<Connection> {
  return getDatabaseProvider().connect();
}
