import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `024_social_posts_due_index.sql` の結合テスト
 * （035-social-publishing 設計 §5.1.2 / §5.2、受け入れ条件 #116。3 回目の検証、裁定 #13-b の低-C）。
 *
 * `social-publish-skip-migration.integration.test.ts` と同じ 2 段適用。
 * 001〜023 を一時ディレクトリへコピーして適用 → 既存行と `permissions` の件数・列の数を控える
 * → 024 を足して適用。**索引が 1 本増えるだけで、行も列も Permission も変わらない**ことを見る。
 *
 * **`022` / `023` は適用済みなので書き換えない。** そのことは静的検査
 * （`application/social/static-checks.test.ts` の #85 / #116）が SHA-256 で固定する。
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

/** apps/web/src/database → リポジトリルート/migrations */
const REPO_MIGRATIONS = join(import.meta.dirname, '..', '..', '..', '..', 'migrations');
const TARGET_MIGRATION = '024_social_posts_due_index.sql';

/** 走査に使う索引（設計 §5.1.2）。 */
const DUE_INDEX = 'social_posts_due_idx';
/** `005_social.sql` から居る索引。**消さない**（設計 §5.2）。 */
const LEGACY_INDEX = 'social_posts_status_scheduled_idx';

/** 024 を当てる前から居る行。 */
const LEGACY_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000e1';
const LEGACY_POST_ID = '01900000-0000-7000-8000-0000000000e2';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** 024 を当てる前の `permissions` の件数と `social_posts` の列の数。 */
let permissionsBefore: number;
let columnsBefore: number;

async function queryScratch<T extends pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<T>(text, [...values]);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function countOf(text: string): Promise<number> {
  const rows = await queryScratch<{ count: string }>(text);
  return Number(rows[0]?.count ?? '0');
}

async function countPermissions(): Promise<number> {
  return countOf('SELECT count(*)::text AS count FROM permissions');
}

async function countColumns(): Promise<number> {
  return countOf(
    `SELECT count(*)::text AS count
       FROM information_schema.columns
      WHERE table_name = 'social_posts'`,
  );
}

async function indexDefinitionOf(name: string): Promise<string | null> {
  const rows = await queryScratch<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'social_posts' AND indexname = $1`,
    [name],
  );
  return rows[0]?.indexdef ?? null;
}

/** リポジトリの migrations/ から、版番号が `upTo` 以下のものだけを一時ディレクトリへ写す。 */
function copyMigrationsUpTo(upTo: string): void {
  for (const name of readdirSync(REPO_MIGRATIONS)) {
    if (!name.endsWith('.sql')) continue;
    const version = name.slice(0, 3);
    if (version <= upTo) {
      copyFileSync(join(REPO_MIGRATIONS, name), join(dir, name));
    }
  }
}

/** 024 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['024']);
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-sdi-'));
  databaseName = `torifune_sdi_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('023');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  // 024 より前から居る投稿。索引を足しても行の意味は変わらない。
  await queryScratch(
    `INSERT INTO social_accounts (id, provider, display_name, status)
     VALUES ($1, 'x', '公式', 'connected')`,
    [LEGACY_ACCOUNT_ID],
  );
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status, scheduled_at)
     VALUES ($1, $2, '024 より前からある投稿', 'scheduled', now() - interval '1 minute')`,
    [LEGACY_POST_ID, LEGACY_ACCOUNT_ID],
  );

  permissionsBefore = await countPermissions();
  columnsBefore = await countColumns();

  await applyTarget();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await adminPool.end();
});

describe('#116 024_social_posts_due_index', () => {
  /** #116。キーセットの行比較が索引のシークになる並び。 */
  it('social_posts に (status, scheduled_at, id) の索引が足される', async () => {
    const definition = await indexDefinitionOf(DUE_INDEX);

    expect(definition, `${DUE_INDEX} が無い`).not.toBeNull();
    expect((definition ?? '').replaceAll(' ', '')).toContain('(status,scheduled_at,id)');
  });

  /** #116。**既存の索引は消さない**（取り出し以外も使っている）。 */
  it('既存の social_posts_status_scheduled_idx が残っている', async () => {
    expect(await indexDefinitionOf(LEGACY_INDEX)).not.toBeNull();
  });

  /** #116。新しい列・テーブル・Permission は作らない。 */
  it('permissions の行数が適用前後で変わらない', async () => {
    expect(permissionsBefore).toBeGreaterThan(0);
    expect(await countPermissions()).toBe(permissionsBefore);
  });

  /** #116。索引だけなので列は増えない。 */
  it('social_posts の列の数が適用前後で変わらない', async () => {
    expect(columnsBefore).toBeGreaterThan(0);
    expect(await countColumns()).toBe(columnsBefore);
  });

  /** #116。既存行はそのまま。 */
  it('適用前から居る投稿がそのまま残る', async () => {
    const rows = await queryScratch<{ body: string; status: string }>(
      'SELECT body, status FROM social_posts WHERE id = $1',
      [LEGACY_POST_ID],
    );

    expect(rows[0]).toEqual({ body: '024 より前からある投稿', status: 'scheduled' });
  });

  /** 前進のみのランナーで、二度目の実行が何もしないこと（既存方針）。 */
  it('繰り返し適用しても壊れない', async () => {
    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
  });
});
