import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `025_social_post_approval.sql` の結合テスト（048-social-post-approval 設計 §5.1、受け入れ条件 #1〜#3）。
 *
 * `social-due-index-migration.integration.test.ts` と同じ 2 段適用（実装プラン T1）。
 * 001〜024 を一時ディレクトリへコピーして適用 → 4 つの状態の既存行と `permissions` の件数を控える
 * → 025 を足して適用。
 *
 * * #1：状態の CHECK が 5 値になり、既存の 4 状態の行は値が変わらず `approved_at` が NULL
 * * #2：`approved_at` は NULL 可の `timestamptz`。承認の記録を持てるのは `scheduled` / `published` / `failed` だけ
 * * #3：`social.approve` が 1 行増え、administrator と editor に割り当てられ、viewer には無い
 *
 * **`024` は適用済みなので書き換えない。** そのことは静的検査
 * （`application/social/approval-static-checks.test.ts`）が SHA-256 で固定する。
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
const TARGET_MIGRATION = '025_social_post_approval.sql';

/** PostgreSQL の CHECK 制約違反。 */
const CHECK_VIOLATION = '23514';

/** 025 を当てる前から居る行（4 つの状態を 1 行ずつ）。 */
const LEGACY_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000f1';
const LEGACY_POSTS = [
  { id: '01900000-0000-7000-8000-0000000000f2', status: 'draft' },
  { id: '01900000-0000-7000-8000-0000000000f3', status: 'scheduled' },
  { id: '01900000-0000-7000-8000-0000000000f4', status: 'published' },
  { id: '01900000-0000-7000-8000-0000000000f5', status: 'failed' },
] as const;

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** 025 を当てる前の `permissions` の件数。 */
let permissionsBefore: number;
/** 投稿の ID を作るための連番（テストごとに別の行を作る）。 */
let sequence = 0x100;

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

/** SQL を流し、失敗したらその SQLSTATE を返す（通れば null）。 */
async function sqlStateOf(text: string, values: readonly unknown[] = []): Promise<string | null> {
  try {
    await queryScratch(text, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

async function countPermissions(): Promise<number> {
  const rows = await queryScratch<{ count: string }>(
    'SELECT count(*)::text AS count FROM permissions',
  );
  return Number(rows[0]?.count ?? '0');
}

function nextPostId(): string {
  sequence += 1;
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/** 状態を指定して投稿を 1 行入れる（`approved_at` は NULL）。ID を返す。 */
async function insertPost(status: string): Promise<string> {
  const id = nextPostId();
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status, scheduled_at)
     VALUES ($1, $2, '025 の検査', $3, now() + interval '1 hour')`,
    [id, LEGACY_ACCOUNT_ID, status],
  );
  return id;
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

/** 025 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['025']);
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-spa-'));
  databaseName = `torifune_spa_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('024');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  // 025 より前から居る 4 つの状態の投稿。状態の CHECK を張り替えても値は変わらない。
  await queryScratch(
    `INSERT INTO social_accounts (id, provider, display_name, status)
     VALUES ($1, 'x', '公式', 'connected')`,
    [LEGACY_ACCOUNT_ID],
  );
  for (const post of LEGACY_POSTS) {
    await queryScratch(
      `INSERT INTO social_posts (id, social_account_id, body, status, scheduled_at)
       VALUES ($1, $2, '025 より前からある投稿', $3, now() - interval '1 minute')`,
      [post.id, LEGACY_ACCOUNT_ID, post.status],
    );
  }

  permissionsBefore = await countPermissions();

  await applyTarget();
});

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (adminPool !== undefined) {
    await adminPool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await adminPool.end();
  }
});

describe('#1 状態の CHECK に awaiting_approval が足される', () => {
  it('#1 status = awaiting_approval の行を入れられる', async () => {
    expect(
      await sqlStateOf(
        `INSERT INTO social_posts (id, social_account_id, body, status)
       VALUES ($1, $2, '承認待ち', 'awaiting_approval')`,
        [nextPostId(), LEGACY_ACCOUNT_ID],
      ),
    ).toBeNull();
  });

  it('#1 status = pending の行は制約違反（23514）', async () => {
    expect(
      await sqlStateOf(
        `INSERT INTO social_posts (id, social_account_id, body, status)
       VALUES ($1, $2, '知らない状態', 'pending')`,
        [nextPostId(), LEGACY_ACCOUNT_ID],
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('#1 024 までに入れた 4 つの状態の行は値が変わらない', async () => {
    const rows = await queryScratch<{ id: string; status: string; body: string }>(
      'SELECT id, status, body FROM social_posts WHERE id = ANY($1::uuid[]) ORDER BY id',
      [LEGACY_POSTS.map((post) => post.id)],
    );

    expect(rows).toEqual(
      LEGACY_POSTS.map((post) => ({
        id: post.id,
        status: post.status,
        body: '025 より前からある投稿',
      })),
    );
  });

  it('#1 024 までに入れた行の approved_at は NULL', async () => {
    const rows = await queryScratch<{ approved_at: Date | null }>(
      'SELECT approved_at FROM social_posts WHERE id = ANY($1::uuid[])',
      [LEGACY_POSTS.map((post) => post.id)],
    );

    expect(rows).toHaveLength(LEGACY_POSTS.length);
    expect(rows.every((row) => row.approved_at === null)).toBe(true);
  });
});

describe('#2 approved_at の列と CHECK', () => {
  it('#2 approved_at は timestamp with time zone で NULL 可', async () => {
    const rows = await queryScratch<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'social_posts' AND column_name = 'approved_at'`,
    );

    expect(rows).toEqual([{ data_type: 'timestamp with time zone', is_nullable: 'YES' }]);
  });

  it.each(['scheduled', 'published', 'failed'])(
    '#2 status = %s の行には approved_at を入れられる',
    async (status) => {
      const id = await insertPost(status);

      expect(
        await sqlStateOf('UPDATE social_posts SET approved_at = now() WHERE id = $1', [id]),
      ).toBeNull();
    },
  );

  it.each(['draft', 'awaiting_approval'])(
    '#2 status = %s の行に approved_at を入れると制約違反（23514）',
    async (status) => {
      const id = await insertPost(status);

      expect(
        await sqlStateOf('UPDATE social_posts SET approved_at = now() WHERE id = $1', [id]),
      ).toBe(CHECK_VIOLATION);
    },
  );

  it('#2 承認済みの予約を approved_at を残したまま承認待ちへ戻すと制約違反（23514）', async () => {
    // 承認を外すときに Application が NULL に戻し忘れると、ここで落ちる（設計 §5.1）。
    const id = await insertPost('scheduled');
    await queryScratch('UPDATE social_posts SET approved_at = now() WHERE id = $1', [id]);

    expect(
      await sqlStateOf(`UPDATE social_posts SET status = 'awaiting_approval' WHERE id = $1`, [id]),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('#3 Permission social.approve', () => {
  it('#3 permissions の行数が適用前 + 1', async () => {
    expect(permissionsBefore).toBeGreaterThan(0);
    expect(await countPermissions()).toBe(permissionsBefore + 1);
  });

  it('#3 permissions に social.approve がある', async () => {
    const rows = await queryScratch<{ name: string }>(
      `SELECT name FROM permissions WHERE name = 'social.approve'`,
    );

    expect(rows).toEqual([{ name: 'social.approve' }]);
  });

  it('#3 social.approve を持つロールは administrator と editor だけ（viewer に無い）', async () => {
    const rows = await queryScratch<{ name: string }>(
      `SELECT r.name
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_name = 'social.approve'
        ORDER BY r.name`,
    );

    expect(rows.map((row) => row.name)).toEqual(['administrator', 'editor']);
  });

  it('#3 viewer ロールは social.approve を持たない', async () => {
    const rows = await queryScratch<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_name = 'social.approve' AND r.name = 'viewer'`,
    );

    expect(rows[0]?.count).toBe('0');
  });
});

describe('025 の再適用', () => {
  /** 前進のみのランナーで、二度目の実行が何もしないこと（既存方針）。 */
  it('繰り返し適用しても壊れない', async () => {
    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
  });
});
