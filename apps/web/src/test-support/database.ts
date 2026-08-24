import { applyMigrations } from '@torifune/cli/migrate/runner';
import { join } from 'node:path';
import pg from 'pg';
import { createPostgresProvider } from '../database/postgres-provider';
import type { DatabaseProvider } from '../database/provider';
import { setDatabaseProvider } from '../database/registry';

/**
 * 結合テスト用の使い捨てデータベース。
 *
 * **テストファイルごとに専用のデータベースを作る。**
 * 共有すると、あるファイルの後始末（`DELETE FROM users` など）が
 * 並列実行中の別ファイルの前提を壊す。実行順に依存するテストは信用できない。
 *
 * `DATABASE_URL` が無いときは失敗させる。スキップにすると、
 * CI で DB が落ちていても緑になり、テストが意味を失う。
 */

function adminUrl(): string {
  const url = process.env['TORIFUNE_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      '結合テストには TORIFUNE_TEST_DATABASE_URL または DATABASE_URL が必要。' +
        'ローカルでは `docker compose up -d postgres-test` を実行する。',
    );
  }
  return url;
}

function migrationsDir(): string {
  // apps/web/src/test-support → リポジトリルート
  return join(import.meta.dirname, '..', '..', '..', '..', 'migrations');
}

export interface ScratchDatabase {
  readonly provider: DatabaseProvider;
  /** この使い捨てデータベースへの接続文字列。 */
  readonly connectionString: string;
  /** 後始末。データベースごと落とす。 */
  dispose(): Promise<void>;
}

/**
 * 使い捨てデータベースを作り、マイグレーションを適用して Provider を差し替える。
 *
 * `beforeAll` で呼び、返ってきた `dispose` を `afterAll` で呼ぶ。
 */
export async function useScratchDatabase(label: string): Promise<ScratchDatabase> {
  const url = adminUrl();
  const safeLabel = label.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const name = `torifune_t_${safeLabel}_${Math.random().toString(36).slice(2, 8)}`;

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const scratchUrl = new URL(url);
  scratchUrl.pathname = `/${name}`;
  const connectionString = scratchUrl.toString();

  await applyMigrations({ databaseUrl: connectionString, migrationsDir: migrationsDir() });

  const provider = createPostgresProvider({ connectionString, maxConnections: 4 });
  setDatabaseProvider(provider);

  return {
    provider,
    connectionString,
    async dispose(): Promise<void> {
      setDatabaseProvider(null);
      await provider.disconnect();

      const cleanup = new pg.Client({ connectionString: url });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
