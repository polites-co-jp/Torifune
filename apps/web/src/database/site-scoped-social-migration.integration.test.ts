import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `026_site_scoped_social.sql` の結合テスト（053-site-scoped-social 設計 §7.1、受け入れ条件 #1〜#5）。
 *
 * `social-post-approval-migration.integration.test.ts` と同じ 2 段適用（実装プラン T1）。
 * 001〜025 を一時ディレクトリへコピーして適用 → 既存行（サイト・アカウント・トークン・投稿を 1 行ずつ）を入れ、
 * `permissions` の件数を控える → 026 を足して適用。
 *
 * * #1：5 列の型・NULL 可・既定と、025 までに入れた行の値
 * * #2：`social_accounts.site_id` の外部キー（`RESTRICT`）
 * * #3：`api_tokens` の 2 つの CHECK と、サイトを消すと `site_scoped` が残る（`SET NULL`）
 * * #4：`social_posts` の CHECK と、サイトを消すと `origin_site_scoped` が残る（`SET NULL`）
 * * #5：部分索引 3 つ、`permissions` の件数が変わらない
 *
 * **`025` は適用済みなので書き換えない。** そのことは静的検査
 * （`application/social/site-scope-static-checks.test.ts`）が SHA-256 で固定する。
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
const TARGET_MIGRATION = '026_site_scoped_social.sql';

/** PostgreSQL の外部キー違反。 */
const FOREIGN_KEY_VIOLATION = '23503';
/** PostgreSQL の CHECK 制約違反。 */
const CHECK_VIOLATION = '23514';

/** サイトのトークンに付けられる Scope（設計 §7.2）。 */
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 026 を当てる前から居る行。 */
const LEGACY_USER_ID = '01900000-0000-7000-8000-0000000000e1';
const LEGACY_SITE_ID = '01900000-0000-7000-8000-0000000000e2';
const LEGACY_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000e3';
const LEGACY_TOKEN_ID = '01900000-0000-7000-8000-0000000000e4';
const LEGACY_POST_ID = '01900000-0000-7000-8000-0000000000e5';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** 026 を当てる前の `permissions` の件数。 */
let permissionsBefore: number;
/** ID を作るための連番（テストごとに別の行を作る）。 */
let sequence = 0x200;

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

function nextId(): string {
  sequence += 1;
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/** サイトを 1 行入れる。ID を返す。 */
async function insertSite(): Promise<string> {
  const id = nextId();
  await queryScratch(
    `INSERT INTO sites (id, name, url) VALUES ($1, '026 の検査', 'https://example.com/')`,
    [id],
  );
  return id;
}

async function siteExists(id: string): Promise<boolean> {
  const rows = await queryScratch<{ id: string }>('SELECT id FROM sites WHERE id = $1', [id]);
  return rows.length === 1;
}

/** アカウントを 1 行入れる SQL の SQLSTATE（通れば null）。 */
async function insertAccountState(id: string, siteId: string | null): Promise<string | null> {
  return sqlStateOf(
    `INSERT INTO social_accounts (id, provider, display_name, status, site_id)
     VALUES ($1, 'x', '026 の検査', 'connected', $2)`,
    [id, siteId],
  );
}

interface TokenRow {
  readonly siteId: string | null;
  readonly siteScoped: boolean;
  readonly scopes: readonly string[];
}

/** トークンを 1 行入れる SQL の SQLSTATE（通れば null）。 */
async function insertTokenState(id: string, row: TokenRow): Promise<string | null> {
  return sqlStateOf(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, site_id, site_scoped)
     VALUES ($1, $2, '026 の検査', $3, 'tfp_026check', $4::text[], $5, $6)`,
    [id, LEGACY_USER_ID, `hash-${id}`, [...row.scopes], row.siteId, row.siteScoped],
  );
}

interface PostOrigin {
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

/** 投稿を 1 行入れる SQL の SQLSTATE（通れば null）。 */
async function insertPostState(id: string, origin: PostOrigin): Promise<string | null> {
  return sqlStateOf(
    `INSERT INTO social_posts (id, social_account_id, body, status, origin_site_id, origin_site_scoped)
     VALUES ($1, $2, '026 の検査', 'draft', $3, $4)`,
    [id, LEGACY_ACCOUNT_ID, origin.originSiteId, origin.originSiteScoped],
  );
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

/** 026 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['026']);
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-sss-'));
  databaseName = `torifune_sss_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('025');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  // 026 より前から居る行。列が足されても意味は変わらない（設計 §5.3）。
  await queryScratch(
    `INSERT INTO users (id, login_id, email, display_name)
     VALUES ($1, 'legacy026', 'legacy026@example.com', '026 より前の利用者')`,
    [LEGACY_USER_ID],
  );
  await queryScratch(
    `INSERT INTO sites (id, name, url) VALUES ($1, '026 より前のサイト', 'https://example.com/')`,
    [LEGACY_SITE_ID],
  );
  await queryScratch(
    `INSERT INTO social_accounts (id, provider, display_name, status)
     VALUES ($1, 'x', '026 より前のアカウント', 'connected')`,
    [LEGACY_ACCOUNT_ID],
  );
  await queryScratch(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes)
     VALUES ($1, $2, '026 より前のトークン', 'legacy-026-hash', 'tfp_legacy26', ARRAY['social.read', 'site.read'])`,
    [LEGACY_TOKEN_ID, LEGACY_USER_ID],
  );
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status, created_by_token_id)
     VALUES ($1, $2, '026 より前の投稿', 'draft', $3)`,
    [LEGACY_POST_ID, LEGACY_ACCOUNT_ID, LEGACY_TOKEN_ID],
  );

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

/* -------------------------------------------------------------------------- */
/* #1 列と既存行                                                                  */
/* -------------------------------------------------------------------------- */

describe('#1 026 で足す 5 列と、025 までに入れた行の値', () => {
  interface ColumnInfo {
    readonly data_type: string;
    readonly is_nullable: string;
    readonly column_default: string | null;
  }

  async function columnOf(table: string, column: string): Promise<ColumnInfo | undefined> {
    const rows = await queryScratch<ColumnInfo>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column],
    );
    return rows[0];
  }

  it.each([
    ['social_accounts', 'site_id'],
    ['api_tokens', 'site_id'],
    ['social_posts', 'origin_site_id'],
  ])('#1 %s.%s は uuid で NULL 可・既定なし', async (table, column) => {
    expect(await columnOf(table, column)).toEqual({
      data_type: 'uuid',
      is_nullable: 'YES',
      column_default: null,
    });
  });

  it.each([
    ['api_tokens', 'site_scoped'],
    ['social_posts', 'origin_site_scoped'],
  ])('#1 %s.%s は boolean で NOT NULL・既定 false', async (table, column) => {
    expect(await columnOf(table, column)).toEqual({
      data_type: 'boolean',
      is_nullable: 'NO',
      column_default: 'false',
    });
  });

  it('#1 025 までに入れたアカウントの site_id は NULL（共通）', async () => {
    const rows = await queryScratch<{ site_id: string | null }>(
      'SELECT site_id FROM social_accounts WHERE id = $1',
      [LEGACY_ACCOUNT_ID],
    );

    expect(rows).toEqual([{ site_id: null }]);
  });

  it('#1 025 までに入れたトークンの site_id は NULL・site_scoped は false（共通）', async () => {
    const rows = await queryScratch<{
      site_id: string | null;
      site_scoped: boolean;
      scopes: string[];
    }>('SELECT site_id, site_scoped, scopes FROM api_tokens WHERE id = $1', [LEGACY_TOKEN_ID]);

    expect(rows).toEqual([
      { site_id: null, site_scoped: false, scopes: ['social.read', 'site.read'] },
    ]);
  });

  it('#1 025 までに入れた投稿の origin_site_id は NULL・origin_site_scoped は false（共通の区画）', async () => {
    const rows = await queryScratch<{
      origin_site_id: string | null;
      origin_site_scoped: boolean;
      created_by_token_id: string | null;
    }>(
      'SELECT origin_site_id, origin_site_scoped, created_by_token_id FROM social_posts WHERE id = $1',
      [LEGACY_POST_ID],
    );

    expect(rows).toEqual([
      { origin_site_id: null, origin_site_scoped: false, created_by_token_id: LEGACY_TOKEN_ID },
    ]);
  });

  it('#1 025 までに入れたサイトは残っている', async () => {
    expect(await siteExists(LEGACY_SITE_ID)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #2 social_accounts.site_id の外部キー                                         */
/* -------------------------------------------------------------------------- */

describe('#2 social_accounts.site_id の外部キー（RESTRICT）', () => {
  it('#2 存在しないサイトの ID を入れると外部キー違反（23503）', async () => {
    expect(await insertAccountState(nextId(), nextId())).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('#2 存在するサイトの ID は入る', async () => {
    const siteId = await insertSite();

    expect(await insertAccountState(nextId(), siteId)).toBeNull();
  });

  it('#2 アカウントが参照しているサイトを DELETE すると外部キー違反（23503）', async () => {
    const siteId = await insertSite();
    expect(await insertAccountState(nextId(), siteId)).toBeNull();

    expect(await sqlStateOf('DELETE FROM sites WHERE id = $1', [siteId])).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('#2 アカウントが参照しているサイトは DELETE に失敗しても行が残る', async () => {
    const siteId = await insertSite();
    const accountId = nextId();
    expect(await insertAccountState(accountId, siteId)).toBeNull();

    await sqlStateOf('DELETE FROM sites WHERE id = $1', [siteId]);

    expect(await siteExists(siteId)).toBe(true);
    const rows = await queryScratch<{ site_id: string | null }>(
      'SELECT site_id FROM social_accounts WHERE id = $1',
      [accountId],
    );
    expect(rows).toEqual([{ site_id: siteId }]);
  });

  it('#2 参照されていないサイトは消せる', async () => {
    const siteId = await insertSite();

    expect(await sqlStateOf('DELETE FROM sites WHERE id = $1', [siteId])).toBeNull();
    expect(await siteExists(siteId)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #3 api_tokens の CHECK と SET NULL                                            */
/* -------------------------------------------------------------------------- */

describe('#3 api_tokens の site_id / site_scoped / scopes', () => {
  it('#3 site_id あり・site_scoped = false の行は CHECK 違反（23514）', async () => {
    const siteId = await insertSite();

    expect(
      await insertTokenState(nextId(), { siteId, siteScoped: false, scopes: ['social.read'] }),
    ).toBe(CHECK_VIOLATION);
  });

  it('#3 site_scoped = true で scopes に site.read を含む行は CHECK 違反（23514）', async () => {
    const siteId = await insertSite();

    expect(
      await insertTokenState(nextId(), {
        siteId,
        siteScoped: true,
        scopes: ['social.read', 'site.read'],
      }),
    ).toBe(CHECK_VIOLATION);
  });

  it('#3 site_scoped = true で site_id が NULL でも scopes に SNS 以外を含む行は CHECK 違反（23514）', async () => {
    expect(
      await insertTokenState(nextId(), {
        siteId: null,
        siteScoped: true,
        scopes: ['system.manage'],
      }),
    ).toBe(CHECK_VIOLATION);
  });

  it.each([
    ['SNS の 4 つ全部', [...SNS_SCOPES]],
    ['social.read だけ', ['social.read']],
    ['social.read と social.write', ['social.read', 'social.write']],
    ['social.approve だけ', ['social.approve']],
    ['空', []],
  ] as const)('#3 site_scoped = true で scopes が %s なら入る', async (_label, scopes) => {
    const siteId = await insertSite();

    expect(await insertTokenState(nextId(), { siteId, siteScoped: true, scopes })).toBeNull();
  });

  it.each([
    ['site.read を含む', ['social.read', 'site.read']],
    ['system.manage だけ', ['system.manage']],
    ['token.manage を含む', ['token.manage', 'social.write']],
    ['空', []],
  ] as const)(
    '#3 site_scoped = false（共通）なら scopes が %s でも入る',
    async (_label, scopes) => {
      expect(
        await insertTokenState(nextId(), { siteId: null, siteScoped: false, scopes }),
      ).toBeNull();
    },
  );

  it('#3 参照しているサイトを消すと site_id が NULL になり site_scoped は true のまま', async () => {
    const siteId = await insertSite();
    const tokenId = nextId();
    expect(
      await insertTokenState(tokenId, { siteId, siteScoped: true, scopes: ['social.read'] }),
    ).toBeNull();

    expect(await sqlStateOf('DELETE FROM sites WHERE id = $1', [siteId])).toBeNull();

    const rows = await queryScratch<{ site_id: string | null; site_scoped: boolean }>(
      'SELECT site_id, site_scoped FROM api_tokens WHERE id = $1',
      [tokenId],
    );
    expect(rows).toEqual([{ site_id: null, site_scoped: true }]);
  });
});

/* -------------------------------------------------------------------------- */
/* #4 social_posts の CHECK と SET NULL                                          */
/* -------------------------------------------------------------------------- */

describe('#4 social_posts の origin_site_id / origin_site_scoped', () => {
  it('#4 origin_site_id あり・origin_site_scoped = false は CHECK 違反（23514）', async () => {
    const siteId = await insertSite();

    expect(await insertPostState(nextId(), { originSiteId: siteId, originSiteScoped: false })).toBe(
      CHECK_VIOLATION,
    );
  });

  it('#4 origin_site_id あり・origin_site_scoped = true は入る', async () => {
    const siteId = await insertSite();

    expect(
      await insertPostState(nextId(), { originSiteId: siteId, originSiteScoped: true }),
    ).toBeNull();
  });

  it('#4 origin_site_id に存在しないサイトの ID を入れると外部キー違反（23503）', async () => {
    expect(
      await insertPostState(nextId(), { originSiteId: nextId(), originSiteScoped: true }),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('#4 参照しているサイトを消すと origin_site_id が NULL、origin_site_scoped は true のまま', async () => {
    const siteId = await insertSite();
    const postId = nextId();
    expect(
      await insertPostState(postId, { originSiteId: siteId, originSiteScoped: true }),
    ).toBeNull();

    expect(await sqlStateOf('DELETE FROM sites WHERE id = $1', [siteId])).toBeNull();

    const rows = await queryScratch<{
      origin_site_id: string | null;
      origin_site_scoped: boolean;
    }>('SELECT origin_site_id, origin_site_scoped FROM social_posts WHERE id = $1', [postId]);
    expect(rows).toEqual([{ origin_site_id: null, origin_site_scoped: true }]);
  });
});

/* -------------------------------------------------------------------------- */
/* #5 部分索引と permissions                                                     */
/* -------------------------------------------------------------------------- */

describe('#5 部分索引と permissions の件数', () => {
  it.each([
    ['social_accounts_site_idx', 'social_accounts', 'site_id'],
    ['api_tokens_site_idx', 'api_tokens', 'site_id'],
    ['social_posts_origin_site_idx', 'social_posts', 'origin_site_id'],
  ])('#5 %s が %s にあり、%s の部分索引（WHERE … IS NOT NULL）', async (name, table, column) => {
    const rows = await queryScratch<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [name],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tablename).toBe(table);
    expect(rows[0]?.indexdef).toContain(`(${column})`);
    expect(rows[0]?.indexdef).toMatch(new RegExp(`WHERE \\(${column} IS NOT NULL\\)`));
  });

  it('#5 permissions の行数は適用の前後で変わらない（新しい Permission を作らない）', async () => {
    expect(permissionsBefore).toBeGreaterThan(0);
    expect(await countPermissions()).toBe(permissionsBefore);
  });
});

describe('026 の再適用', () => {
  /** 前進のみのランナーで、二度目の実行が何もしないこと（既存方針）。 */
  it('繰り返し適用しても壊れない', async () => {
    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
  });
});
