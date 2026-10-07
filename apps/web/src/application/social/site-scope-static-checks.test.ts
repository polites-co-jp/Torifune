import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
 * * #60 の前半：`026` の `api_tokens_site_scopes_check` の配列と Domain の `SITE_TOKEN_SCOPES`（G2）
 * * #64：`AccessScope` を組み立てるのは `application/social/access-scope.ts` の `scopeOf` だけ（G4）
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

/* -------------------------------------------------------------------------- */
/* #60 の前半 026 の api_tokens_site_scopes_check と SITE_TOKEN_SCOPES             */
/* -------------------------------------------------------------------------- */

const MIGRATION_026 = '026_site_scoped_social.sql';

/** SQL のコメント（`-- …` の行末まで）を落とす。戻す手順のコメントに書いた SQL を拾わない。 */
function withoutSqlComments(source: string): string {
  return source.replace(/--.*$/gm, '');
}

/**
 * `ADD CONSTRAINT api_tokens_site_scopes_check CHECK ( … ARRAY[…] … )` の配列の値を、書いた順に取り出す。
 *
 * 戻す手順のコメント（`DROP CONSTRAINT api_tokens_site_scopes_check`）を拾わないよう、コメントを先に落とす。
 * `DROP CONSTRAINT …` の直後は `CHECK` ではないので、コメントの外にあっても拾わない。無ければ null。
 */
function siteScopesCheckValues(sql: string): string[] | null {
  const match = withoutSqlComments(sql).match(
    /api_tokens_site_scopes_check\s+CHECK\s*\(([\s\S]*?)ARRAY\s*\[([^\]]*)\]/i,
  );
  if (match === null) return null;
  return [...(match[2] ?? '').matchAll(/'([^']*)'/g)].map((value) => value[1] ?? '');
}

/** 未実装の値を型検査に掛けないため、指定子は定数に置く。 */
const API_TOKEN_MODULE: string = '@/domain/api-token';

async function siteTokenScopes(): Promise<readonly string[] | undefined> {
  const domain = (await import(/* @vite-ignore */ API_TOKEN_MODULE)) as {
    readonly SITE_TOKEN_SCOPES?: readonly string[];
  };
  return domain.SITE_TOKEN_SCOPES;
}

describe('#60 026 の api_tokens_site_scopes_check と SITE_TOKEN_SCOPES', () => {
  it('#60 026 の api_tokens_site_scopes_check の配列が SITE_TOKEN_SCOPES と順まで一致する', async () => {
    const inSql = siteScopesCheckValues(migrationSource(MIGRATION_026));
    const inDomain = await siteTokenScopes();

    expect(
      inSql,
      '026 に api_tokens_site_scopes_check の CHECK ( … ARRAY[…] ) が無い',
    ).not.toBeNull();
    expect(inDomain, 'domain/api-token.ts に SITE_TOKEN_SCOPES が無い').toBeDefined();
    expect([...(inDomain ?? [])]).toEqual(inSql);
  });

  it('#60 026 の api_tokens_site_scopes_check の配列は SNS の 4 つ', () => {
    expect(siteScopesCheckValues(migrationSource(MIGRATION_026))).toEqual([
      'social.read',
      'social.write',
      'social.delete',
      'social.approve',
    ]);
  });

  it('#60 判別力：配列に site.read を足した写しでは SNS の 4 つと一致しない', () => {
    const tampered = `ALTER TABLE api_tokens
    ADD CONSTRAINT api_tokens_site_scopes_check CHECK (
        NOT site_scoped
        OR scopes <@ ARRAY['social.read', 'social.write', 'social.delete', 'social.approve', 'site.read']::text[]
    );`;

    expect(siteScopesCheckValues(tampered)).toEqual([
      'social.read',
      'social.write',
      'social.delete',
      'social.approve',
      'site.read',
    ]);
  });

  it('#60 判別力：戻す手順のコメントにある DROP CONSTRAINT は拾わない', () => {
    const onlyComment = `-- ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_site_scopes_check CHECK (ARRAY['x']);
ALTER TABLE api_tokens DROP CONSTRAINT api_tokens_site_scopes_check;`;

    expect(siteScopesCheckValues(onlyComment)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* #64 AccessScope を組み立てるのは scopeOf だけ                                  */
/* -------------------------------------------------------------------------- */

const SCOPE_OF_FILE = 'application/social/access-scope.ts';

/** コメント（ブロックコメントと行コメント）を落とす。 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** ディレクトリ以下のすべての `.ts` / `.tsx`（テストを除く）。`apps/web/src` からの相対パス（`/` 区切り）で返す。 */
function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test-support') continue;
      found.push(...sourceFilesUnder(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(relative(SRC_DIR, path).split(sep).join('/'));
    }
  }
  return found;
}

/**
 * `kind: 'site'` を**値として組み立てる**箇所の数（実装プラン §8 の 5）。
 *
 * 型の宣言は数えない：前に `readonly` があるもの、後ろが `;`（型リテラルのメンバー）のもの、
 * 後ろが `}>`（`Extract<AccessScope, { kind: 'site' }>` のような型引数）のもの。
 * オブジェクトリテラルは後ろが `,` か `}` になる。
 */
function siteScopeLiteralCount(source: string): number {
  const code = withoutComments(source);
  let count = 0;
  for (const match of code.matchAll(/(readonly\s+)?\bkind\s*:\s*['"]site['"](\s*[;,}]\s*>?)?/g)) {
    if (match[1] !== undefined) continue;
    const tail = (match[2] ?? '').replace(/\s/g, '');
    if (tail.startsWith(';') || tail === '}>') continue;
    count += 1;
  }
  return count;
}

/** モジュールの関数 `export function <name>(`（`export` は任意）から、最初の行頭の `}` まで。無ければ ''。 */
function exportedFunctionBody(source: string, name: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.search(new RegExp(`^(export\\s+)?function ${name}\\(`, 'm'));
  if (start === -1) return '';
  const rest = normalized.slice(start);
  const end = rest.search(/^\}$/m);
  return end === -1 ? rest : rest.slice(0, end + 1);
}

describe('#64 AccessScope の site を組み立てるのは scopeOf だけ', () => {
  it("#64 apps/web/src（テストを除く）で kind: 'site' を値として書くファイルは application/social/access-scope.ts だけ", () => {
    const files = sourceFilesUnder(SRC_DIR).filter(
      (file) => siteScopeLiteralCount(readFileSync(join(SRC_DIR, file), 'utf8')) > 0,
    );

    expect(files).toEqual([SCOPE_OF_FILE]);
  });

  it("#64 application/social/access-scope.ts の kind: 'site' はすべて scopeOf の本文にある", () => {
    const path = join(SRC_DIR, SCOPE_OF_FILE);
    expect(existsSync(path), `${SCOPE_OF_FILE} が無い`).toBe(true);
    const source = readFileSync(path, 'utf8');
    const body = exportedFunctionBody(source, 'scopeOf');

    expect(body, 'scopeOf の定義が無い').not.toBe('');
    expect(siteScopeLiteralCount(body)).toBeGreaterThan(0);
    expect(siteScopeLiteralCount(body)).toBe(siteScopeLiteralCount(source));
  });

  it("#64 判別力：domain に { kind: 'site', siteId } を返す関数を足した写しを数える", () => {
    const tampered = `export type AccessScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'site'; readonly siteId: string };

export function siteScope(siteId: string): AccessScope {
  return { kind: 'site', siteId };
}
`;

    expect(siteScopeLiteralCount(tampered)).toBe(1);
  });

  it('#64 判別力：型の宣言（readonly・型リテラル・型引数）とコメントは数えない', () => {
    const declarations = `export type AccessScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'site'; readonly siteId: string };
type SiteScope = { kind: 'site'; siteId: string };
type Narrowed = Extract<AccessScope, { kind: 'site' }>;
// const commented = { kind: 'site', siteId };
`;

    expect(siteScopeLiteralCount(declarations)).toBe(0);
  });

  it('#64 判別力：scopeOf の外にある組み立ては本文の数と合わない', () => {
    const tampered = `export function scopeOf(context) {
  if (context.apiToken === undefined) return ALL_SCOPE;
  return context.apiToken.siteId === null
    ? { kind: 'common' }
    : { kind: 'site', siteId: context.apiToken.siteId };
}

export function fromQuery(siteId) {
  return { kind: 'site', siteId };
}
`;

    expect(siteScopeLiteralCount(exportedFunctionBody(tampered, 'scopeOf'))).toBe(1);
    expect(siteScopeLiteralCount(tampered)).toBe(2);
  });
});
