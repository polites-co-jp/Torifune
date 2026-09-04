import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `021_job_runs.sql` の結合テスト（029-scheduled-jobs 設計 §5.1、受け入れ条件 #1、#2）。
 *
 * `analytics-breakdown-migration.integration.test.ts` と同じ 2 段適用。
 * 001〜020 を一時ディレクトリへコピーして適用 → `permissions` の件数を控える → 021 を足して適用。
 * 新しい Permission を作らない（#2）ことは、こうしないと確かめられない。
 *
 * DDL は 1 回だけ流し（`beforeAll`）、各テストは読むか、制約違反でロールバックされる INSERT を試みるだけ。
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
const TARGET_MIGRATION = '021_job_runs.sql';

/** PostgreSQL の CHECK 制約違反。 */
const CHECK_VIOLATION = '23514';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** 021 を当てる前の `permissions` の件数。 */
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

/** 021 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['021']);
}

interface JobRunInput {
  readonly jobName?: string;
  readonly triggeredBy?: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string | null;
  readonly error?: string | null;
}

/** 妥当な既定値に差分を重ねて 1 行入れる。 */
async function insertJobRun(overrides: JobRunInput = {}): Promise<void> {
  const row = {
    jobName: 'analytics.rollup',
    triggeredBy: 'scheduled',
    status: 'ok',
    startedAt: '2026-09-04T01:00:00Z',
    finishedAt: '2026-09-04T01:00:05Z',
    error: null,
    ...overrides,
  };
  await queryScratch(
    `INSERT INTO job_runs (id, job_name, triggered_by, status, started_at, finished_at, error, summary, runner)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, '{}'::jsonb, 'host:1')`,
    [row.jobName, row.triggeredBy, row.status, row.startedAt, row.finishedAt, row.error],
  );
}

/** INSERT が CHECK 制約違反（23514）で落ちること。 */
async function expectCheckViolation(overrides: JobRunInput): Promise<void> {
  await expect(insertJobRun(overrides)).rejects.toMatchObject({ code: CHECK_VIOLATION });
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-jrm-'));
  databaseName = `torifune_jrm_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('020');
  await applyMigrations({ databaseUrl, migrationsDir: dir });
  permissionsBefore = await countPermissions();

  await applyTarget();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await adminPool.end();
});

describe('021_job_runs', () => {
  /** #1 */
  it('job_runs が作られる', async () => {
    const rows = await queryScratch<{ column_name: string; is_nullable: string }>(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'job_runs' ORDER BY ordinal_position",
    );

    expect(rows.map((row) => row.column_name)).toEqual([
      'id',
      'job_name',
      'triggered_by',
      'status',
      'started_at',
      'finished_at',
      'error',
      'summary',
      'runner',
    ]);
    for (const required of ['id', 'job_name', 'triggered_by', 'status', 'started_at', 'summary']) {
      expect(rows.find((row) => row.column_name === required)?.is_nullable, required).toBe('NO');
    }
  });

  /** #1 */
  it('job_runs_job_started_idx が (job_name, started_at DESC) で作られる', async () => {
    const rows = await queryScratch<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'job_runs' AND indexname = 'job_runs_job_started_idx'",
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/\(job_name, started_at DESC\)/);
  });

  /** #1 の前提。妥当な行は入る。 */
  it('妥当な行は入り、既定値（started_at / summary）が埋まる', async () => {
    await queryScratch(
      `INSERT INTO job_runs (id, job_name, triggered_by, status)
       VALUES (gen_random_uuid(), 'webhook.deliver', 'manual', 'running')`,
    );

    const rows = await queryScratch<{
      started_at: Date;
      summary: unknown;
      finished_at: Date | null;
    }>("SELECT started_at, summary, finished_at FROM job_runs WHERE job_name = 'webhook.deliver'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.started_at).toBeInstanceOf(Date);
    expect(rows[0]?.summary).toEqual({});
    expect(rows[0]?.finished_at).toBeNull();
  });

  /** #1 */
  it("status = 'done' は制約違反", async () => {
    await expectCheckViolation({ status: 'done' });
  });

  /** #1 */
  it("triggered_by = 'cron' は制約違反", async () => {
    await expectCheckViolation({ triggeredBy: 'cron' });
  });

  /** #1 */
  it('finished_at < started_at は制約違反', async () => {
    await expectCheckViolation({
      startedAt: '2026-09-04T01:00:05Z',
      finishedAt: '2026-09-04T01:00:00Z',
    });
  });

  /** #1 */
  it('error が 2001 文字は制約違反（2000 文字は入る）', async () => {
    await expectCheckViolation({ status: 'error', error: 'x'.repeat(2001) });
    await insertJobRun({ status: 'error', error: 'y'.repeat(2000) });

    const rows = await queryScratch<{ length: number }>(
      "SELECT char_length(error) AS length FROM job_runs WHERE status = 'error'",
    );
    expect(rows.map((row) => row.length)).toEqual([2000]);
  });

  /** #1 */
  it("job_name = ' ' は制約違反", async () => {
    await expectCheckViolation({ jobName: ' ' });
  });

  /** #2 */
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
