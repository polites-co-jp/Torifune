import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `027_social_post_token_name.sql` の結合テスト（054-bulk-post-actions 設計 §7.1、受け入れ条件 #1〜#3）。
 *
 * `site-scoped-social-migration.integration.test.ts` と同じ 2 段適用（実装プラン T1）。
 * 001〜026 を一時ディレクトリへコピーして適用 → 既存行（利用者 1・トークン 1「ブログ連携」・
 * トークンで登録した投稿 1・トークンを経ない投稿 1）を入れる → 027 を足して適用。
 *
 * * #1：列の型・NULL 可と、026 までに入れた行の埋め戻し
 * * #2：CHECK（トークンありで名前 NULL・空白だけの名前は違反、トークン NULL で名前ありは可）
 * * #3：トークンの所有者を消すとトークン ID は NULL、名前は残る
 *
 * **`026` は適用済みなので書き換えない。** そのことは静的検査
 * （`application/social/bulk-post-static-checks.test.ts` の #4）が SHA-256 で固定する。
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
const TARGET_MIGRATION = '027_social_post_token_name.sql';

/** PostgreSQL の CHECK 制約違反。 */
const CHECK_VIOLATION = '23514';

/** 027 を当てる前から居る行。 */
const LEGACY_USER_ID = '01900000-0000-7000-8000-0000000000f1';
const LEGACY_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000f2';
const LEGACY_TOKEN_ID = '01900000-0000-7000-8000-0000000000f3';
const LEGACY_TOKEN_POST_ID = '01900000-0000-7000-8000-0000000000f4';
const LEGACY_SCREEN_POST_ID = '01900000-0000-7000-8000-0000000000f5';
const LEGACY_TOKEN_NAME = 'ブログ連携';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** ID を作るための連番（テストごとに別の行を作る）。 */
let sequence = 0x300;

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

function nextId(): string {
  sequence += 1;
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, '0')}`;
}

/** 利用者を 1 行入れる。ID を返す。 */
async function insertUser(): Promise<string> {
  const id = nextId();
  const loginId = `u027${sequence.toString(16)}`;
  await queryScratch(
    `INSERT INTO users (id, login_id, email, display_name) VALUES ($1, $2, $3, '027 の検査')`,
    [id, loginId, `${loginId}@example.com`],
  );
  return id;
}

/** トークンを 1 行入れる。ID を返す。 */
async function insertToken(userId: string, name: string): Promise<string> {
  const id = nextId();
  await queryScratch(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes)
     VALUES ($1, $2, $3, $4, 'tfp_027check', ARRAY['social.read', 'social.write'])`,
    [id, userId, name, `hash-${id}`],
  );
  return id;
}

/** 投稿を 1 行入れる SQL の SQLSTATE（通れば null）。 */
async function insertPostState(
  id: string,
  tokenId: string | null,
  tokenName: string | null,
): Promise<string | null> {
  return sqlStateOf(
    `INSERT INTO social_posts (id, social_account_id, body, status, created_by_token_id, created_by_token_name)
     VALUES ($1, $2, '027 の検査', 'draft', $3, $4)`,
    [id, LEGACY_ACCOUNT_ID, tokenId, tokenName],
  );
}

interface TokenColumns {
  readonly created_by_token_id: string | null;
  readonly created_by_token_name: string | null;
}

async function tokenColumnsOf(postId: string): Promise<TokenColumns[]> {
  return queryScratch<TokenColumns>(
    'SELECT created_by_token_id, created_by_token_name FROM social_posts WHERE id = $1',
    [postId],
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

/** 027 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['027']);
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-sptn-'));
  databaseName = `torifune_sptn_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('026');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  // 027 より前から居る行。
  await queryScratch(
    `INSERT INTO users (id, login_id, email, display_name)
     VALUES ($1, 'legacy027', 'legacy027@example.com', '027 より前の利用者')`,
    [LEGACY_USER_ID],
  );
  await queryScratch(
    `INSERT INTO social_accounts (id, provider, display_name, status)
     VALUES ($1, 'x', '027 より前のアカウント', 'connected')`,
    [LEGACY_ACCOUNT_ID],
  );
  await queryScratch(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes)
     VALUES ($1, $2, $3, 'legacy-027-hash', 'tfp_legacy27', ARRAY['social.read', 'social.write'])`,
    [LEGACY_TOKEN_ID, LEGACY_USER_ID, LEGACY_TOKEN_NAME],
  );
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status, created_by_token_id)
     VALUES ($1, $2, '027 より前のトークンの投稿', 'draft', $3)`,
    [LEGACY_TOKEN_POST_ID, LEGACY_ACCOUNT_ID, LEGACY_TOKEN_ID],
  );
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status)
     VALUES ($1, $2, '027 より前の画面の投稿', 'draft')`,
    [LEGACY_SCREEN_POST_ID, LEGACY_ACCOUNT_ID],
  );

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
/* #1 列と既存行の埋め戻し                                                         */
/* -------------------------------------------------------------------------- */

describe('#1 027 で足す created_by_token_name と、026 までに入れた行の値', () => {
  it('#1 social_posts.created_by_token_name は text で NULL 可・既定なし', async () => {
    const rows = await queryScratch<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'social_posts'
          AND column_name = 'created_by_token_name'`,
    );

    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);
  });

  it('#1 026 までにトークンで登録した投稿は、そのトークンの名前で埋まる', async () => {
    expect(await tokenColumnsOf(LEGACY_TOKEN_POST_ID)).toEqual([
      { created_by_token_id: LEGACY_TOKEN_ID, created_by_token_name: LEGACY_TOKEN_NAME },
    ]);
  });

  it('#1 026 までにトークンを経ずに登録した投稿は NULL のまま', async () => {
    expect(await tokenColumnsOf(LEGACY_SCREEN_POST_ID)).toEqual([
      { created_by_token_id: null, created_by_token_name: null },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #2 CHECK                                                                     */
/* -------------------------------------------------------------------------- */

describe('#2 social_posts_created_by_token_name_check', () => {
  it('#2 created_by_token_id があり created_by_token_name が NULL の行は CHECK 違反（23514）', async () => {
    expect(await insertPostState(nextId(), LEGACY_TOKEN_ID, null)).toBe(CHECK_VIOLATION);
  });

  it("#2 created_by_token_name = '  '（空白だけ）は CHECK 違反（23514。トークンあり）", async () => {
    expect(await insertPostState(nextId(), LEGACY_TOKEN_ID, '  ')).toBe(CHECK_VIOLATION);
  });

  it("#2 created_by_token_name = '  '（空白だけ）は CHECK 違反（23514。トークン NULL）", async () => {
    expect(await insertPostState(nextId(), null, '  ')).toBe(CHECK_VIOLATION);
  });

  it('#2 created_by_token_id が NULL で名前がある行は入る', async () => {
    const id = nextId();

    expect(await insertPostState(id, null, 'ショップ連携')).toBeNull();
    expect(await tokenColumnsOf(id)).toEqual([
      { created_by_token_id: null, created_by_token_name: 'ショップ連携' },
    ]);
  });

  it('#2 created_by_token_id と名前の両方がある行は入る', async () => {
    expect(await insertPostState(nextId(), LEGACY_TOKEN_ID, LEGACY_TOKEN_NAME)).toBeNull();
  });

  it('#2 両方 NULL の行は入る（画面の登録）', async () => {
    expect(await insertPostState(nextId(), null, null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* #3 所有者の削除                                                               */
/* -------------------------------------------------------------------------- */

describe('#3 トークンの所有者を削除しても名前は残る', () => {
  it('#3 所有者を DELETE すると投稿の created_by_token_id は NULL、created_by_token_name は残る', async () => {
    const userId = await insertUser();
    const tokenId = await insertToken(userId, '消える連携');
    const postId = nextId();
    expect(await insertPostState(postId, tokenId, '消える連携')).toBeNull();

    expect(await sqlStateOf('DELETE FROM users WHERE id = $1', [userId])).toBeNull();

    const tokens = await queryScratch<{ id: string }>('SELECT id FROM api_tokens WHERE id = $1', [
      tokenId,
    ]);
    expect(tokens).toEqual([]);
    expect(await tokenColumnsOf(postId)).toEqual([
      { created_by_token_id: null, created_by_token_name: '消える連携' },
    ]);
  });
});

describe('027 の再適用', () => {
  /** 前進のみのランナーで、二度目の実行が何もしないこと（既存方針）。 */
  it('繰り返し適用しても壊れない', async () => {
    const second = await applyMigrations({ databaseUrl, migrationsDir: dir });

    expect(second.applied).toEqual([]);
  });
});
