import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_API_VERSION } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * SNS アカウントと API トークンをサイトに紐づける件の静的検査（053-site-scoped-social 設計 §13.9）。
 *
 * `approval-static-checks.test.ts` と同じ流儀で、ソース・マイグレーション・定数の形を固定する。
 *
 * * `025` の SHA-256 の固定（G1。受け入れ条件の番号は無い。実装プラン §8 の 2）
 * * #63：公開 Plugin API の `SocialAccountView` / `SocialPostView` のキー、`PLUGIN_API_VERSION`、Core の Permission の数（G1）
 *
 * **未実装の値は静的 import にしない**（`approval-static-checks.test.ts` と同じ）。
 * 未実装の段階でこのファイル全体が読めなくなると、他の件まで一緒に落ちて何が壊れたのか読めなくなる。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
/** apps/web/src → リポジトリルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const PLUGIN_API_DATA = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'data.ts');

/** リポジトリのマイグレーションを読む（改行コードの違いを吸収する）。 */
function migrationSource(name: string): string {
  const path = join(MIGRATIONS_DIR, name);
  expect(existsSync(path), `migrations/${name} が無い`).toBe(true);
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/* -------------------------------------------------------------------------- */
/* 025 は適用済み（SHA-256 の固定）                                               */
/* -------------------------------------------------------------------------- */

/**
 * `025_social_post_approval.sql` の内容（改行を LF にそろえたもの）の SHA-256。
 *
 * 後継のマイグレーション（`026`）を足すので、`022`〜`024` と同じ形で固定する（実装プラン §8 の 2）。
 * **適用済みなので書き換えない。** 足りないものは `026` 以降で足す。`026` は次のマイグレーションで固定する。
 */
const SHA256_OF_025 = 'bddd2e1138dde09dc8760235ee32d36f3ae86d5fb9d6997bdd69b4d1420228ec';

describe('025 のマイグレーションは適用済み', () => {
  it('025_social_post_approval.sql のファイル内容が変わっていない', () => {
    const digest = createHash('sha256')
      .update(migrationSource('025_social_post_approval.sql'), 'utf8')
      .digest('hex');

    expect(
      digest,
      '025 は適用済み。サイトの紐づけの変更は 026_site_scoped_social.sql で足す（053 設計 §7.1）',
    ).toBe(SHA256_OF_025);
  });
});

/* -------------------------------------------------------------------------- */
/* #63 公開 Plugin API と Permission は変えない                                    */
/* -------------------------------------------------------------------------- */

/**
 * `export interface <name> {` の本文から、直下のメンバー名（`  readonly <key>:`）を宣言の順に取り出す。
 *
 * TSDoc の行（`   * …`）は字下げが違うので拾わない。interface が無ければ null。
 */
function interfaceKeys(source: string, name: string): string[] | null {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.search(new RegExp(`^export interface ${name} \\{$`, 'm'));
  if (start === -1) return null;
  const rest = normalized.slice(start);
  const end = rest.search(/^\}$/m);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/^ {2}readonly ([A-Za-z0-9_]+)\??:/gm)].map((match) => match[1] ?? '');
}

/** 053 の時点の `SocialAccountView` のキー（設計 §11.1：`siteId` を足さない）。 */
const SOCIAL_ACCOUNT_VIEW_KEYS = [
  'id',
  'provider',
  'displayName',
  'handle',
  'status',
  'credentialConfigured',
];

/** 053 の時点の `SocialPostView` のキー（設計 §11.1）。 */
const SOCIAL_POST_VIEW_KEYS = [
  'id',
  'socialAccountId',
  'body',
  'scheduledAt',
  'status',
  'publishedAt',
  'failureReason',
  'deliveryMode',
  'media',
  'link',
  'providerOptions',
  'externalRef',
  'externalId',
  'externalUrl',
  'failedAt',
];

/** 053 の時点の Core の Permission（設計 §10.2：新しい Permission を作らない）。 */
const CORE_PERMISSION_NAMES_053 = [
  'analytics.read',
  'campaign.delete',
  'campaign.read',
  'campaign.write',
  'plugin.manage',
  'site.delete',
  'site.read',
  'site.write',
  'social.approve',
  'social.delete',
  'social.read',
  'social.write',
  'system.manage',
  'token.manage',
  'user.manage',
];

describe('#63 公開 Plugin API の型と版、Core の Permission を変えない', () => {
  const dataSource = (): string => readFileSync(PLUGIN_API_DATA, 'utf8');

  it('#63 SocialAccountView のキーが変わらない（siteId を足さない）', () => {
    expect(interfaceKeys(dataSource(), 'SocialAccountView')).toEqual(SOCIAL_ACCOUNT_VIEW_KEYS);
  });

  it('#63 SocialPostView のキーが変わらない', () => {
    expect(interfaceKeys(dataSource(), 'SocialPostView')).toEqual(SOCIAL_POST_VIEW_KEYS);
  });

  it('#63 PLUGIN_API_VERSION は 1 のまま', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it('#63 CORE_PERMISSIONS は 15 種のまま', () => {
    expect(CORE_PERMISSIONS).toHaveLength(15);
  });

  it('#63 CORE_PERMISSIONS の名前の集合が 053 の前と同じ（サイトの紐づけ用の Permission を足さない）', () => {
    expect([...(CORE_PERMISSIONS as readonly string[])].sort()).toEqual(CORE_PERMISSION_NAMES_053);
  });

  it('#63 判別力：SocialAccountView に siteId を足した写しではキーが一致しない', () => {
    const tampered = `export interface SocialAccountView {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  readonly status: string;
  /**
   * 資格情報が設定されているか。
   *   readonly fake: string;
   */
  readonly credentialConfigured: boolean;
  readonly siteId: string | null;
}
`;

    expect(interfaceKeys(tampered, 'SocialAccountView')).toEqual([
      ...SOCIAL_ACCOUNT_VIEW_KEYS,
      'siteId',
    ]);
    expect(interfaceKeys(tampered, 'SocialAccountView')).not.toEqual(SOCIAL_ACCOUNT_VIEW_KEYS);
  });

  it('#63 判別力：interface が無ければ null', () => {
    expect(
      interfaceKeys('export interface Other {\n  readonly id: string;\n}\n', 'SocialPostView'),
    ).toBeNull();
  });
});
