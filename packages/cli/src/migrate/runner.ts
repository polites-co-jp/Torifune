import pg from 'pg';
import { redact, secretsOf } from '../redact.js';
import { loadMigrations, type Migration } from './loader.js';
import { withMigrationLock } from './lock.js';

export interface ApplyMigrationsOptions {
  readonly databaseUrl: string;
  readonly migrationsDir: string;
  /** true なら適用せず、適用対象の一覧だけを返す。 */
  readonly dryRun?: boolean;
  /** 進行状況の出力先。既定では何も出力しない。 */
  readonly log?: (message: string) => void;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly executionMs: number;
}

export interface ApplyMigrationsResult {
  /** 実際に適用したもの。dryRun のときは空。 */
  readonly applied: readonly AppliedMigration[];
  /** 適用対象（dryRun でも埋まる）。 */
  readonly pending: readonly Migration[];
  /** すでに適用済みだったバージョン。 */
  readonly alreadyApplied: readonly string[];
}

const CREATE_SCHEMA_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version      text        PRIMARY KEY,
    name         text        NOT NULL,
    checksum     text        NOT NULL,
    applied_at   timestamptz NOT NULL DEFAULT now(),
    execution_ms integer     NOT NULL
  )
`;

interface AppliedRow extends pg.QueryResultRow {
  version: string;
  name: string;
  checksum: string;
}

/**
 * 未適用のマイグレーションを順に適用する。
 *
 * * バージョン昇順
 * * 1本 = 1トランザクション。`schema_migrations` への記録も同じトランザクションに含める
 * * 適用済みの版のファイルが変わっていたら、適用せずエラーで止める
 * * advisory lock により、同時実行しても二重適用しない
 */
export async function applyMigrations(
  options: ApplyMigrationsOptions,
): Promise<ApplyMigrationsResult> {
  const { databaseUrl, migrationsDir, dryRun = false, log } = options;
  const secrets = secretsOf(databaseUrl);

  // ファイルの読み込みと形式検証は接続前に行う。
  // 接続してから形式エラーで落ちるより、先に落ちたほうが原因が分かりやすい。
  const migrations = loadMigrations(migrationsDir);

  const client = new pg.Client({ connectionString: databaseUrl });

  try {
    await client.connect();
  } catch (error) {
    throw redact(error, secrets);
  }

  try {
    return await withMigrationLock(client, async () => {
      await client.query(CREATE_SCHEMA_MIGRATIONS);

      const { rows } = await client.query<AppliedRow>(
        'SELECT version, name, checksum FROM schema_migrations',
      );
      const appliedByVersion = new Map(rows.map((row) => [row.version, row]));

      // 適用済みの版が書き換えられていないかを、1本でも適用する前に全件検査する。
      for (const migration of migrations) {
        const applied = appliedByVersion.get(migration.version);
        if (applied !== undefined && applied.checksum !== migration.checksum) {
          throw new Error(
            `適用済みマイグレーション ${migration.version} (${applied.name}) が変更されている。` +
              '適用済みのファイルは書き換えず、新しいバージョンを追加すること。',
          );
        }
      }

      const pending = migrations.filter((m) => !appliedByVersion.has(m.version));
      const alreadyApplied = migrations
        .filter((m) => appliedByVersion.has(m.version))
        .map((m) => m.version);

      if (dryRun) {
        for (const migration of pending) {
          log?.(`[dry-run] ${migration.fileName}`);
        }
        return { applied: [], pending, alreadyApplied };
      }

      const applied: AppliedMigration[] = [];

      for (const migration of pending) {
        const startedAt = process.hrtime.bigint();
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          const executionMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
          await client.query(
            'INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)',
            [migration.version, migration.name, migration.checksum, executionMs],
          );
          await client.query('COMMIT');
          applied.push({ version: migration.version, name: migration.name, executionMs });
          log?.(`applied ${migration.fileName} (${executionMs}ms)`);
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          const redacted = redact(error, secrets);
          // 元の例外を cause に付けない。pg の例外には接続文字列が混ざりうるため、
          // 伏せたものだけを外へ出す。原因の特定に必要な情報は message に含めてある。
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            `マイグレーション ${migration.version} (${migration.fileName}) の適用に失敗した: ${redacted.message}`,
          );
        }
      }

      return { applied, pending, alreadyApplied };
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
