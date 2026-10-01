import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/domain/audit';
import {
  CORE_PERMISSIONS,
  HIGH_PRIVILEGE_PERMISSIONS,
  PERMISSION_DESCRIPTIONS,
} from '@/domain/permission';

/**
 * SNS 投稿の承認待ちの静的検査（048-social-post-approval 設計 §10.9、受け入れ条件 #60〜#64）。
 *
 * `application/social/static-checks.test.ts` と同じ流儀で、ソース・マイグレーション・定数の形を固定する。
 *
 * * #61：Core の Permission と監査の定数（G1）
 * * #63：`025` で入れる Permission 名が `CORE_PERMISSIONS` に含まれる（G1。実装プラン §8 の 2：既存の検査が無いので新設）
 * * `024` の SHA-256 の固定（G1。受け入れ条件の番号は無い。実装プラン §8 の 3。`022`・`023` と同じ流儀）
 * * #62：`025` の状態の CHECK と Domain の `POST_STATUSES`（G2）
 * * #60・#64：公開 Plugin API のイベントと版、配信ジョブが承認待ちに触れないこと（G5）
 *
 * **未実装の値は静的 import にしない**（`static-checks.test.ts` #85 と同じ）。
 * 未実装の段階でこのファイル全体が読めなくなると、他の件まで一緒に落ちて何が壊れたのか読めなくなる。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
/** apps/web/src → リポジトリルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

const MIGRATION_025 = '025_social_post_approval.sql';

/** リポジトリのマイグレーションを読む（改行コードの違いを吸収する）。 */
function migrationSource(name: string): string {
  const path = join(MIGRATIONS_DIR, name);
  expect(existsSync(path), `migrations/${name} が無い`).toBe(true);
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/** SQL のコメント（`-- …` の行末まで）を落とす。戻す手順のコメントに書いた SQL を拾わない。 */
function withoutSqlComments(source: string): string {
  return source.replace(/--.*$/gm, '');
}

/**
 * `INSERT INTO permissions (…) VALUES (…), (…);` の各行の先頭の値（Permission 名）と、
 * `INSERT INTO role_permissions (…) VALUES (…), (…);` の各行の 2 番目の値（Permission 名）。
 */
function permissionNamesInserted(sql: string): { permissions: string[]; grants: string[] } {
  const body = withoutSqlComments(sql);
  const valuesOf = (table: string): string[][] => {
    const statements = [
      ...body.matchAll(
        new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\([^)]*\\)\\s*VALUES([\\s\\S]*?);`, 'gi'),
      ),
    ];
    return statements.flatMap((statement) =>
      [...(statement[1] ?? '').matchAll(/\(([^)]*)\)/g)].map((tuple) =>
        [...(tuple[1] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1] ?? ''),
      ),
    );
  };
  return {
    permissions: valuesOf('permissions').map((values) => values[0] ?? ''),
    grants: valuesOf('role_permissions').map((values) => values[1] ?? ''),
  };
}

/* -------------------------------------------------------------------------- */
/* #61 Core の Permission と監査の定数                                            */
/* -------------------------------------------------------------------------- */

describe('#61 Core の Permission と監査の定数', () => {
  it('#61 CORE_PERMISSIONS に social.approve がある', () => {
    expect(CORE_PERMISSIONS as readonly string[]).toContain('social.approve');
  });

  it('#61 CORE_PERMISSIONS は 15 種', () => {
    expect(CORE_PERMISSIONS).toHaveLength(15);
  });

  it('#61 PERMISSION_DESCRIPTIONS に social.approve の説明がある（外部アプリのトークンに付けない旨を含む）', () => {
    // 設計 §8.2：トークンの Scope を選ぶ画面にこの説明が出る。
    expect((PERMISSION_DESCRIPTIONS as Readonly<Record<string, string>>)['social.approve']).toBe(
      '承認待ちのSNS投稿を承認して配信に回す（投稿を登録する外部アプリのトークンには付けない）',
    );
  });

  it('#61 social.approve は HIGH_PRIVILEGE_PERMISSIONS に無い', () => {
    // Torifune 全体を掌握する権限ではない（設計 §8.2）。
    expect(HIGH_PRIVILEGE_PERMISSIONS as readonly string[]).not.toContain('social.approve');
  });

  it("#61 AUDIT_ACTIONS に 'approved' がある", () => {
    expect(AUDIT_ACTIONS as readonly string[]).toContain('approved');
  });
});

/* -------------------------------------------------------------------------- */
/* #63 025 で入れる Permission 名                                                */
/* -------------------------------------------------------------------------- */

describe('#63 025 で入れる Permission 名が CORE_PERMISSIONS に含まれる', () => {
  it('#63 025 の INSERT INTO permissions の名前が social.approve の 1 つ', () => {
    const { permissions } = permissionNamesInserted(migrationSource(MIGRATION_025));

    expect(permissions).toEqual(['social.approve']);
  });

  it('#63 025 の INSERT INTO role_permissions の Permission 名が 2 行とも social.approve', () => {
    // administrator と editor の 2 行（設計 §5.1）。
    const { grants } = permissionNamesInserted(migrationSource(MIGRATION_025));

    expect(grants).toEqual(['social.approve', 'social.approve']);
  });

  it('#63 025 で入れる Permission 名はすべて CORE_PERMISSIONS に含まれる', () => {
    const { permissions, grants } = permissionNamesInserted(migrationSource(MIGRATION_025));
    const core = new Set<string>(CORE_PERMISSIONS);

    expect(permissions.length + grants.length).toBeGreaterThan(0);
    expect([...permissions, ...grants].filter((name) => !core.has(name))).toEqual([]);
  });

  it('#63 判別力：名前を 1 文字変えた写しの SQL では CORE_PERMISSIONS に無い名前が見つかる', () => {
    const tampered = `INSERT INTO permissions (name, display_name, description, is_system) VALUES
    ('social.approvx', 'x', 'x', true);
INSERT INTO role_permissions (role_id, permission_name) VALUES
    ('01900000-0000-7000-8000-000000000001', 'social.approvx');`;
    const { permissions, grants } = permissionNamesInserted(tampered);
    const core = new Set<string>(CORE_PERMISSIONS);

    expect([...permissions, ...grants].filter((name) => !core.has(name))).toEqual([
      'social.approvx',
      'social.approvx',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 024 は適用済み（SHA-256 の固定）                                               */
/* -------------------------------------------------------------------------- */

/**
 * `024_social_posts_due_index.sql` の内容（改行を LF にそろえたもの）の SHA-256。
 *
 * 後継のマイグレーション（`025`）を足すので、`022`・`023` と同じ形で固定する（実装プラン §8 の 3）。
 * **適用済みなので書き換えない。** 足りないものは `025` 以降で足す。`025` は次のマイグレーションで固定する。
 */
const SHA256_OF_024 = 'f3ed75399754d25da6bb6d4e22bb0fcf45403de0c708b248633e1abd328896f9';

describe('024 のマイグレーションは適用済み', () => {
  it('024_social_posts_due_index.sql のファイル内容が変わっていない', () => {
    const digest = createHash('sha256')
      .update(migrationSource('024_social_posts_due_index.sql'), 'utf8')
      .digest('hex');

    expect(
      digest,
      '024 は適用済み。承認待ちの変更は 025_social_post_approval.sql で足す（048 設計 §5.1）',
    ).toBe(SHA256_OF_024);
  });
});

/* -------------------------------------------------------------------------- */
/* #62 025 の状態の CHECK と Domain の POST_STATUSES                              */
/* -------------------------------------------------------------------------- */

/**
 * `ADD CONSTRAINT social_posts_status_check CHECK (status IN (…))` の値の集合。
 *
 * `025` には `status IN (…)` が 2 つある（`social_posts_approved_at_check` にもある）ので、
 * **`social_posts_status_check` の直後の `CHECK (status IN (…))` を読む**（実装プラン §2 のテストの方法）。
 * `DROP CONSTRAINT social_posts_status_check,` の直後は `CHECK` ではないので拾わない。
 * 戻す手順のコメントにある 4 値の CHECK を拾わないよう、コメントを先に落とす。
 */
function statusCheckValues(sql: string): string[] | null {
  const match = withoutSqlComments(sql).match(
    /social_posts_status_check\s+CHECK\s*\(\s*status\s+IN\s*\(([^)]*)\)\s*\)/i,
  );
  if (match === null) return null;
  return [...(match[1] ?? '').matchAll(/'([^']*)'/g)].map((value) => value[1] ?? '').sort();
}

describe('#62 025 の social_posts_status_check と POST_STATUSES', () => {
  it('#62 025 の social_posts_status_check の値の集合が POST_STATUSES と一致する', async () => {
    const inSql = statusCheckValues(migrationSource(MIGRATION_025));
    // 未実装の段階でこのファイル全体が読めなくならないよう、動的に読む。
    const domain = (await import('@/domain/social/social')) as {
      readonly POST_STATUSES?: readonly string[];
    };

    expect(
      inSql,
      '025 に social_posts_status_check の CHECK (status IN (…)) が無い',
    ).not.toBeNull();
    expect([...(domain.POST_STATUSES ?? [])].sort()).toEqual(inSql);
  });

  it('#62 025 の social_posts_status_check は 5 値で awaiting_approval を含む', () => {
    expect(statusCheckValues(migrationSource(MIGRATION_025))).toEqual(
      ['awaiting_approval', 'draft', 'failed', 'published', 'scheduled'].sort(),
    );
  });

  it('#62 判別力：値を 1 つ落とした写しでは POST_STATUSES と一致しない', async () => {
    const tampered = `ALTER TABLE social_posts
    DROP CONSTRAINT social_posts_status_check,
    ADD CONSTRAINT social_posts_status_check
        CHECK (status IN ('draft', 'scheduled', 'published', 'failed')),
    ADD CONSTRAINT social_posts_approved_at_check
        CHECK (approved_at IS NULL OR status IN ('scheduled', 'published', 'failed'));`;
    const domain = (await import('@/domain/social/social')) as {
      readonly POST_STATUSES?: readonly string[];
    };

    expect(statusCheckValues(tampered)).toEqual(['draft', 'failed', 'published', 'scheduled']);
    expect([...(domain.POST_STATUSES ?? [])].sort()).not.toEqual(statusCheckValues(tampered));
  });

  it('#62 判別力：approved_at の CHECK の IN を状態の CHECK と取り違えない', () => {
    // approved_at の CHECK だけを持つ写しでは、状態の CHECK は見つからない。
    const onlyApprovedAt = `ALTER TABLE social_posts
    ADD CONSTRAINT social_posts_approved_at_check
        CHECK (approved_at IS NULL OR status IN ('scheduled', 'published', 'failed'));`;

    expect(statusCheckValues(onlyApprovedAt)).toBeNull();
  });
});
