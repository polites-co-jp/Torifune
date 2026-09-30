import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * `023_social_publish_skip.sql` の結合テスト
 * （035-social-publishing 設計 §5.1.1、受け入れ条件 #85 の (B)。裁定 #9）。
 *
 * `social-publishing-migration.integration.test.ts` と同じ 2 段適用。
 * 001〜022 を一時ディレクトリへコピーして適用 → **既存行を 1 つ入れ**、`permissions` の件数を控える
 * → 023 を足して適用。`useScratchDatabase` は全部を一度に当てるので、
 * 「適用前に入っていた行が壊れない」と「Permission を作らない」はこうしないと確かめられない。
 *
 * **`022` は適用済みなので書き換えない。** そのことは静的検査
 * （`application/social/static-checks.test.ts` の #85）が固定する。
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
const TARGET_MIGRATION = '023_social_publish_skip.sql';

/** PostgreSQL の CHECK 制約違反。 */
const CHECK_VIOLATION = '23514';

/** 023 を当てる前から居る行。 */
const LEGACY_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000d1';
const LEGACY_POST_ID = '01900000-0000-7000-8000-0000000000d2';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** 023 を当てる前の `permissions` の件数。 */
let permissionsBefore: number;

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

async function countPermissions(): Promise<number> {
  const rows = await queryScratch<{ count: string }>(
    'SELECT count(*)::text AS count FROM permissions',
  );
  return Number(rows[0]?.count ?? '0');
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

/** 023 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['023']);
}

interface PostInput {
  readonly skipCount?: number;
  readonly skipReason?: string | null;
}

/** 妥当な既定値に差分を重ねて投稿を 1 行入れる。 */
async function insertPost(overrides: PostInput = {}): Promise<void> {
  const row = { skipCount: 0, skipReason: null as string | null, ...overrides };
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status, skip_count, skip_reason)
     VALUES (gen_random_uuid(), $1, '本文', 'draft', $2, $3)`,
    [LEGACY_ACCOUNT_ID, row.skipCount, row.skipReason],
  );
}

/** INSERT が CHECK 制約違反（23514）で落ちること。 */
async function expectCheckViolation(overrides: PostInput): Promise<void> {
  await expect(insertPost(overrides)).rejects.toMatchObject({ code: CHECK_VIOLATION });
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-sps-'));
  databaseName = `torifune_sps_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('022');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  // 023 より前から居る投稿。既存行の意味が変わらないことを #85 で確かめる。
  await queryScratch(
    `INSERT INTO social_accounts (id, provider, display_name, status)
     VALUES ($1, 'x', '公式', 'connected')`,
    [LEGACY_ACCOUNT_ID],
  );
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status)
     VALUES ($1, $2, '023 より前からある投稿', 'scheduled')`,
    [LEGACY_POST_ID, LEGACY_ACCOUNT_ID],
  );

  permissionsBefore = await countPermissions();

  await applyTarget();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await adminPool.end();
});

afterEach(async () => {
  await queryScratch('DELETE FROM social_posts WHERE id <> $1', [LEGACY_POST_ID]);
});

describe('#85 023_social_publish_skip', () => {
  /** #85 */
  it('social_posts に skip_count と skip_reason が足される', async () => {
    const rows = await queryScratch<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'social_posts' AND column_name IN ('skip_count', 'skip_reason')
        ORDER BY column_name`,
    );

    expect(rows.map((row) => row.column_name)).toEqual(['skip_count', 'skip_reason']);
  });

  /** #85。`attempt_count` と同じく数えるための列なので、NULL を許さず 0 から始める。 */
  it('skip_count は NOT NULL で既定が 0', async () => {
    const rows = await queryScratch<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'social_posts' AND column_name = 'skip_count'`,
    );

    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default ?? '').toContain('0');
  });

  /** #85。NULL なら「飛ばされていない」（設計 §5.1.1）。 */
  it('skip_reason は NULL を許す', async () => {
    const rows = await queryScratch<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_name = 'social_posts' AND column_name = 'skip_reason'`,
    );

    expect(rows[0]?.is_nullable).toBe('YES');
  });

  /** #85。既存行の意味は変わらない。 */
  it('既存行は skip_count = 0 / skip_reason = NULL になる', async () => {
    const rows = await queryScratch<{ skip_count: number; skip_reason: string | null }>(
      'SELECT skip_count, skip_reason FROM social_posts WHERE id = $1',
      [LEGACY_POST_ID],
    );

    expect(rows[0]).toEqual({ skip_count: 0, skip_reason: null });
  });

  /** #85 の前提。妥当な値は入る。 */
  it.each(['no_publisher', 'credential_missing', 'account_missing'])(
    'skip_reason = %s の行は入る',
    async (reason) => {
      await insertPost({ skipCount: 1, skipReason: reason });

      const rows = await queryScratch<{ count: string }>(
        'SELECT count(*)::text AS count FROM social_posts WHERE skip_reason = $1',
        [reason],
      );
      expect(rows[0]?.count).toBe('1');
    },
  );

  /** #85 */
  it('skip_count が負の数は制約違反', async () => {
    await expectCheckViolation({ skipCount: -1 });
  });

  /** #85。Domain の `SkipReason` に無い値を DB が受け付けると、列挙が食い違う。 */
  it('skip_reason に知らない値は制約違反', async () => {
    await expectCheckViolation({ skipReason: 'zzz' });
  });

  /** #85。新しい Permission もテーブルも作らない。 */
  it('permissions の行数が適用前後で変わらない', async () => {
    expect(permissionsBefore).toBeGreaterThan(0);
    expect(await countPermissions()).toBe(permissionsBefore);
  });

  /** 前進のみのランナーで、二度目の実行が何もしないこと（既存方針）。 */
  it('繰り返し適用しても壊れない', async () => {
    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
  });
});
