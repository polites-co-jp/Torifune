import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `020_analytics_breakdown.sql` の結合テスト（028-analytics-dashboard-redesign 設計 §5.1、受け入れ条件 #1〜#6）。
 *
 * **既存の行がある状態で適用する。** `useScratchDatabase` は毎回 001〜020 を一度に当てるので、
 * 「適用前に入っていた行が壊れない」（#2、#3）は確かめられない。
 * ここでは 001〜019 を一時ディレクトリへコピーして適用 → 行を入れる → 020 を足して適用、の 2 段で行う
 * （`packages/cli/src/migrate/runner.integration.test.ts` の使い捨て DB の作り方に合わせる）。
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
const TARGET_MIGRATION = '020_analytics_breakdown.sql';

const SITE_ID = '01900000-0000-7000-8000-0000000000a1';
const METRIC_DATE = '2026-06-10';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;

async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `torifune_abm_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

async function dropScratchDatabase(name: string): Promise<void> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

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

/** 020 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['020']);
}

async function insertAnalyticsRow(metric: string, value: number, key?: string): Promise<void> {
  if (key === undefined) {
    await queryScratch(
      'INSERT INTO analytics (site_id, metric_date, source, metric, value) VALUES ($1, $2, $3, $4, $5)',
      [SITE_ID, METRIC_DATE, 'core', metric, value],
    );
    return;
  }
  await queryScratch(
    'INSERT INTO analytics (site_id, metric_date, source, metric, key, value) VALUES ($1, $2, $3, $4, $5, $6)',
    [SITE_ID, METRIC_DATE, 'core', metric, key, value],
  );
}

beforeAll(() => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 4 });
});

afterAll(async () => {
  await adminPool.end();
});

/**
 * 毎回、019 まで適用した DB にサイト 1 件・集計 2 行・生ログ 1 行を入れた状態から始める。
 * DDL を伴うため、テストごとに使い捨てのデータベースを作る。
 */
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'torifune-abm-'));
  const scratch = await createScratchDatabase();
  databaseName = scratch.name;
  databaseUrl = scratch.url;

  copyMigrationsUpTo('019');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  await queryScratch('INSERT INTO sites (id, name, url) VALUES ($1, $2, $3)', [
    SITE_ID,
    'before-020',
    'https://example.com',
  ]);
  await insertAnalyticsRow('pageviews', 10);
  await insertAnalyticsRow('visitors', 4);
  await queryScratch(
    "INSERT INTO access_logs (id, site_id, path, visitor_hash, device) VALUES ($1, $2, '/', 'h1', 'desktop')",
    ['01900000-0000-7000-8000-0000000000b1', SITE_ID],
  );
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await dropScratchDatabase(databaseName);
});

describe('020_analytics_breakdown', () => {
  /** #1 */
  it("analytics に key 列が NOT NULL DEFAULT '' で足される", async () => {
    await applyTarget();

    const columns = await queryScratch<{
      is_nullable: string;
      column_default: string | null;
      data_type: string;
    }>(
      "SELECT is_nullable, column_default, data_type FROM information_schema.columns WHERE table_name = 'analytics' AND column_name = 'key'",
    );

    expect(columns).toHaveLength(1);
    expect(columns[0]?.is_nullable).toBe('NO');
    expect(columns[0]?.data_type).toBe('text');
    expect(columns[0]?.column_default).toBe("''::text");
  });

  /** #1 */
  it('analytics の主キーが (site_id, metric_date, source, metric, key) になる', async () => {
    await applyTarget();

    const rows = await queryScratch<{ column_name: string }>(`
      SELECT a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'analytics'::regclass AND c.contype = 'p'
      ORDER BY array_position(c.conkey, a.attnum)
    `);

    expect(rows.map((r) => r.column_name)).toEqual([
      'site_id',
      'metric_date',
      'source',
      'metric',
      'key',
    ]);
  });

  /** #2 */
  it("適用前に入っていた行が key = '' のまま残り、件数が変わらない", async () => {
    await applyTarget();

    const rows = await queryScratch<{ metric: string; key: string; value: string }>(
      'SELECT metric, key, value::text AS value FROM analytics ORDER BY metric',
    );

    expect(rows).toEqual([
      { metric: 'pageviews', key: '', value: '10' },
      { metric: 'visitors', key: '', value: '4' },
    ]);
  });

  /** #3 */
  it('sites.analytics_last_seen_at が NULL 許容の timestamptz で足される', async () => {
    await applyTarget();

    const columns = await queryScratch<{ is_nullable: string; data_type: string }>(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'sites' AND column_name = 'analytics_last_seen_at'",
    );

    expect(columns).toHaveLength(1);
    expect(columns[0]?.is_nullable).toBe('YES');
    expect(columns[0]?.data_type).toBe('timestamp with time zone');
  });

  /** #3 */
  it('既存のサイトの analytics_last_seen_at は NULL', async () => {
    await applyTarget();

    const rows = await queryScratch<{ analytics_last_seen_at: Date | null }>(
      'SELECT analytics_last_seen_at FROM sites WHERE id = $1',
      [SITE_ID],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.analytics_last_seen_at).toBeNull();
  });

  /** #4 */
  it('analytics_site_metric_idx と access_logs_visitor_idx が作られる', async () => {
    await applyTarget();

    const rows = await queryScratch<{ indexname: string; tablename: string }>(
      "SELECT indexname, tablename FROM pg_indexes WHERE indexname IN ('analytics_site_metric_idx', 'access_logs_visitor_idx') ORDER BY indexname",
    );

    expect(rows).toEqual([
      { indexname: 'access_logs_visitor_idx', tablename: 'access_logs' },
      { indexname: 'analytics_site_metric_idx', tablename: 'analytics' },
    ]);
  });

  /** #4。生ログをパスで引く読み手が無くなるので落とす。 */
  it('access_logs_path_idx が落とされる', async () => {
    // 適用前には存在する（014 で作った）ことを先に確かめ、「元から無い」と区別する。
    const before = await queryScratch<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'access_logs_path_idx'",
    );
    expect(before).toHaveLength(1);

    await applyTarget();

    const after = await queryScratch<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname = 'access_logs_path_idx'",
    );
    expect(after).toHaveLength(0);
  });

  /** #5 */
  it('同じ (site_id, metric_date, source, metric) で key だけ違う 2 行を入れられる', async () => {
    await applyTarget();

    await insertAnalyticsRow('path_pageviews', 3, '/a');
    await insertAnalyticsRow('path_pageviews', 2, '/b');

    const rows = await queryScratch<{ key: string; value: string }>(
      "SELECT key, value::text AS value FROM analytics WHERE metric = 'path_pageviews' ORDER BY key",
    );
    expect(rows).toEqual([
      { key: '/a', value: '3' },
      { key: '/b', value: '2' },
    ]);
  });

  /** #5 の裏。key まで同じなら従来どおり重複を拒む。 */
  it('key まで同じ行は入れられない', async () => {
    await applyTarget();

    await insertAnalyticsRow('path_pageviews', 3, '/a');

    await expect(insertAnalyticsRow('path_pageviews', 5, '/a')).rejects.toThrowError();
  });

  /** #6。500 は PATH_MAX_LENGTH と同じ。 */
  it('key が 500 文字の行は入れられる', async () => {
    await applyTarget();

    await insertAnalyticsRow('path_pageviews', 1, `/${'a'.repeat(499)}`);

    const rows = await queryScratch<{ length: number }>(
      "SELECT char_length(key) AS length FROM analytics WHERE metric = 'path_pageviews'",
    );
    expect(rows[0]?.length).toBe(500);
  });

  /** #6 */
  it('key が 501 文字の行は制約違反になる', async () => {
    await applyTarget();

    await expect(
      insertAnalyticsRow('path_pageviews', 1, `/${'a'.repeat(500)}`),
    ).rejects.toThrowError();
  });

  /** 既存の制約は残す（設計 §5.1）。 */
  it('metric が空白の行と負の値は引き続き拒まれる', async () => {
    await applyTarget();

    await expect(insertAnalyticsRow('   ', 1, '/a')).rejects.toThrowError();
    await expect(insertAnalyticsRow('path_pageviews', -1, '/a')).rejects.toThrowError();
  });

  /** 前進のみのランナーで、二度目の実行が何もしないこと（既存方針）。 */
  it('繰り返し適用しても壊れない', async () => {
    await applyTarget();

    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
  });
});
