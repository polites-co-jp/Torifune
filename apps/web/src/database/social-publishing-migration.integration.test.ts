import { applyMigrations } from '@torifune/cli/migrate/runner';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * `022_social_publishing.sql` の結合テスト（035-social-publishing 設計 §5.1、受け入れ条件 #1〜#4）。
 *
 * `job-runs-migration.integration.test.ts` と同じ 2 段適用。
 * 001〜021 を一時ディレクトリへコピーして適用 → **既存行を 1 つ入れ**、`permissions` の件数を控える
 * → 022 を足して適用。`useScratchDatabase` は 001〜022 を一度に当てるので、
 * 「適用前に入っていた行が壊れない」（#1）と「Permission を作らない」（#4）はこうしないと確かめられない。
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
const TARGET_MIGRATION = '022_social_publishing.sql';

/** PostgreSQL の CHECK 制約違反。 */
const CHECK_VIOLATION = '23514';
/** PostgreSQL の一意制約違反。 */
const UNIQUE_VIOLATION = '23505';

/** 022 を当てる前から居る行。 */
const LEGACY_ACCOUNT_ID = '01900000-0000-7000-8000-0000000000c1';
const LEGACY_POST_ID = '01900000-0000-7000-8000-0000000000c2';
const USER_ID = '01900000-0000-7000-8000-0000000000c3';

let adminPool: pg.Pool;
let dir: string;
let databaseName: string;
let databaseUrl: string;
/** 022 を当てる前の `permissions` の件数。 */
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

/** 022 を一時ディレクトリへ足して適用する。 */
async function applyTarget(): Promise<void> {
  const source = join(REPO_MIGRATIONS, TARGET_MIGRATION);
  if (!existsSync(source)) {
    throw new Error(`マイグレーションが無い: migrations/${TARGET_MIGRATION}`);
  }
  copyFileSync(source, join(dir, TARGET_MIGRATION));
  const result = await applyMigrations({ databaseUrl, migrationsDir: dir });
  expect(result.applied.map((m) => m.version)).toEqual(['022']);
}

interface PostInput {
  readonly id?: string;
  readonly body?: string;
  readonly status?: string;
  readonly deliveryMode?: string;
  /** jsonb のリテラル。 */
  readonly media?: string;
  /** jsonb のリテラル。 */
  readonly providerOptions?: string;
  readonly link?: string | null;
  readonly externalRef?: string | null;
  readonly createdByTokenId?: string | null;
  readonly attemptCount?: number;
}

/** 妥当な既定値に差分を重ねて投稿を 1 行入れる。 */
async function insertPost(overrides: PostInput = {}): Promise<void> {
  const row = {
    id: null as string | null,
    body: '本文',
    status: 'draft',
    deliveryMode: 'auto',
    media: '[]',
    providerOptions: '{}',
    link: null as string | null,
    externalRef: null as string | null,
    createdByTokenId: null as string | null,
    attemptCount: 0,
    ...overrides,
  };
  await queryScratch(
    `INSERT INTO social_posts
       (id, social_account_id, body, status, delivery_mode, media, provider_options,
        link, external_ref, created_by_token_id, attempt_count)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::jsonb, $7::jsonb,
             $8, $9, $10::uuid, $11)`,
    [
      row.id,
      LEGACY_ACCOUNT_ID,
      row.body,
      row.status,
      row.deliveryMode,
      row.media,
      row.providerOptions,
      row.link,
      row.externalRef,
      row.createdByTokenId,
      row.attemptCount,
    ],
  );
}

/** INSERT が CHECK 制約違反（23514）で落ちること。 */
async function expectCheckViolation(overrides: PostInput): Promise<void> {
  await expect(insertPost(overrides)).rejects.toMatchObject({ code: CHECK_VIOLATION });
}

/** API Token を 1 本作って ID を返す。 */
async function insertToken(name: string): Promise<string> {
  const rows = await queryScratch<{ id: string }>(
    `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix)
     VALUES (gen_random_uuid(), $1, $2, $3, 'tfp_')
     RETURNING id::text AS id`,
    [USER_ID, name, `hash-${name}`],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('api_tokens の INSERT が行を返さなかった');
  return id;
}

beforeAll(async () => {
  adminPool = new pg.Pool({ connectionString: adminUrl, max: 2 });

  dir = mkdtempSync(join(tmpdir(), 'torifune-spm-'));
  databaseName = `torifune_spm_${Math.random().toString(36).slice(2, 10)}`;
  await adminPool.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();

  copyMigrationsUpTo('021');
  await applyMigrations({ databaseUrl, migrationsDir: dir });

  // 022 より前から居る投稿。既存行の意味が変わらないことを #1 で確かめる。
  await queryScratch(
    `INSERT INTO social_accounts (id, provider, display_name, status)
     VALUES ($1, 'x', '公式', 'connected')`,
    [LEGACY_ACCOUNT_ID],
  );
  await queryScratch(
    `INSERT INTO social_posts (id, social_account_id, body, status)
     VALUES ($1, $2, '022 より前からある投稿', 'scheduled')`,
    [LEGACY_POST_ID, LEGACY_ACCOUNT_ID],
  );
  await queryScratch(
    `INSERT INTO users (id, login_id, email, display_name)
     VALUES ($1, 'tokenowner', 'tokenowner@example.com', 'Token 所有者')`,
    [USER_ID],
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
  await queryScratch('DELETE FROM api_tokens');
});

describe('022_social_publishing', () => {
  /** #1 */
  it('social_posts に 11 列が足される', async () => {
    const rows = await queryScratch<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'social_posts'",
    );

    const columns = rows.map((row) => row.column_name);
    expect(columns).toEqual(
      expect.arrayContaining([
        'delivery_mode',
        'media',
        'link',
        'provider_options',
        'external_ref',
        'created_by_token_id',
        'external_id',
        'external_url',
        'publish_started_at',
        'attempt_count',
        'next_attempt_at',
      ]),
    );
  });

  /** #1 */
  it('既存行は自動配信・媒体なし・追加項目なしになる', async () => {
    const rows = await queryScratch<{
      delivery_mode: string;
      media: unknown;
      provider_options: unknown;
      attempt_count: number;
    }>(
      `SELECT delivery_mode, media, provider_options, attempt_count
         FROM social_posts WHERE id = $1`,
      [LEGACY_POST_ID],
    );

    expect(rows[0]).toEqual({
      delivery_mode: 'auto',
      media: [],
      provider_options: {},
      attempt_count: 0,
    });
  });

  /** #1 */
  it('既存行の残りの追加列は NULL のままになる', async () => {
    const rows = await queryScratch<{ nulls: boolean }>(
      `SELECT (link IS NULL AND external_ref IS NULL AND created_by_token_id IS NULL
               AND external_id IS NULL AND external_url IS NULL
               AND publish_started_at IS NULL AND next_attempt_at IS NULL) AS nulls
         FROM social_posts WHERE id = $1`,
      [LEGACY_POST_ID],
    );

    expect(rows[0]?.nulls).toBe(true);
  });

  /** #1 の前提。妥当な行は入る。 */
  it('追加列を埋めた行は入る', async () => {
    await insertPost({
      deliveryMode: 'manual',
      media: '[{"url":"https://example.com/a.png","alt":null}]',
      providerOptions: '{"replyTo":"1"}',
      link: 'https://example.com/',
      externalRef: 'r1',
      attemptCount: 3,
    });

    const rows = await queryScratch<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE delivery_mode = 'manual'",
    );
    expect(rows[0]?.count).toBe('1');
  });

  /** #1 */
  it("delivery_mode = 'x' は制約違反", async () => {
    await expectCheckViolation({ deliveryMode: 'x' });
  });

  /** #1。媒体は配列で持つ（`[{ url, alt }]`）。 */
  it('media がオブジェクトは制約違反', async () => {
    await expectCheckViolation({ media: '{}' });
  });

  /** #1。provider 固有の追加項目はオブジェクトで持つ。 */
  it('provider_options が配列は制約違反', async () => {
    await expectCheckViolation({ providerOptions: '[]' });
  });

  /** #1 */
  it('attempt_count が負の数は制約違反', async () => {
    await expectCheckViolation({ attemptCount: -1 });
  });

  /** #1。空白だけの冪等キーを許すと「指定したつもり」が黙って通る。 */
  it('external_ref が空白だけは制約違反', async () => {
    await expectCheckViolation({ externalRef: ' ' });
  });

  /** #1 */
  it('external_ref が 201 文字は制約違反（200 文字は入る）', async () => {
    await expectCheckViolation({ externalRef: 'r'.repeat(201) });
    await insertPost({ externalRef: 'r'.repeat(200) });
  });

  /** #1 */
  it('link が 2049 文字は制約違反（2048 文字は入る）', async () => {
    const base = 'https://example.com/';
    await expectCheckViolation({ link: base + 'a'.repeat(2049 - base.length) });
    await insertPost({ link: base + 'a'.repeat(2048 - base.length) });
  });

  /** #2。同じ外部アプリ（Token）からの同じ external_ref は 1 行だけ。 */
  it('同じ Token の同じ external_ref は 2 行目を拒否する', async () => {
    const tokenId = await insertToken('app-a');
    await insertPost({ createdByTokenId: tokenId, externalRef: 'r1' });

    await expect(
      insertPost({ createdByTokenId: tokenId, externalRef: 'r1' }),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
  });

  /** #2。Token = 外部アプリ 1 つ（裁定 #4）。別のアプリの ID 空間は別。 */
  it('Token が違えば同じ external_ref を入れられる', async () => {
    const tokenA = await insertToken('app-a');
    const tokenB = await insertToken('app-b');

    await insertPost({ createdByTokenId: tokenA, externalRef: 'r1' });
    await insertPost({ createdByTokenId: tokenB, externalRef: 'r1' });

    const rows = await queryScratch<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE external_ref = 'r1'",
    );
    expect(rows[0]?.count).toBe('2');
  });

  /** #2。Token の無い登録（画面から）は索引の対象外。冪等の名前空間が無い。 */
  it('Token が無ければ同じ external_ref を何行でも入れられる', async () => {
    await insertPost({ createdByTokenId: null, externalRef: 'r1' });
    await insertPost({ createdByTokenId: null, externalRef: 'r1' });

    const rows = await queryScratch<{ count: string }>(
      "SELECT count(*)::text AS count FROM social_posts WHERE external_ref = 'r1'",
    );
    expect(rows[0]?.count).toBe('2');
  });

  /** #3。起きた事実は消さない。投稿は残して「誰が登録したか」だけを失う。 */
  it('Token を削除すると投稿は残り created_by_token_id が NULL になる', async () => {
    const tokenId = await insertToken('app-a');
    await insertPost({ createdByTokenId: tokenId, externalRef: 'r1' });

    await queryScratch('DELETE FROM api_tokens WHERE id = $1', [tokenId]);

    const rows = await queryScratch<{ created_by_token_id: string | null }>(
      "SELECT created_by_token_id FROM social_posts WHERE external_ref = 'r1'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_by_token_id).toBeNull();
  });

  /** #3。失効は行を消さない（監査が追えなくなる）ので、投稿の参照も変わらない。 */
  it('Token を失効させても created_by_token_id は変わらない', async () => {
    const tokenId = await insertToken('app-a');
    await insertPost({ createdByTokenId: tokenId, externalRef: 'r1' });

    await queryScratch('UPDATE api_tokens SET revoked_at = now() WHERE id = $1', [tokenId]);

    const rows = await queryScratch<{ created_by_token_id: string | null }>(
      "SELECT created_by_token_id FROM social_posts WHERE external_ref = 'r1'",
    );
    expect(rows[0]?.created_by_token_id).toBe(tokenId);
  });

  /** #4。新しい Permission もテーブルも作らない。 */
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
