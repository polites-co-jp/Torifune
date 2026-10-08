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
 * * #61：`social-use-cases.ts` の 17 個（054 で 18 個。054-bulk-post-actions 設計 §13.10 #57）の handler が
 *   `scopeOf(context)` を呼び、`infrastructure/social-repository.ts` の区画の条件は `scopePredicate` の 1 か所にだけある（G5）
 * * #62：`application/social/publish.ts` が `access-scope` を import しない（G5。変えないことの固定）
 * * #60 の後半：`api_tokens` の `site_id` / `site_scoped` / `scopes` と `social_posts` の `origin_*` を
 *   `UPDATE` するのは `infrastructure/api-token-repository.ts` の `changeSite` だけ（G7）
 * * #100：Repository の区画の引数は必須（既定値・省略で `ALL_SCOPE` に倒れない。検証の指摘の修正）
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

/* -------------------------------------------------------------------------- */
/* #61 18 個の handler が scopeOf(context) を呼ぶ・述語は scopePredicate の 1 か所     */
/* -------------------------------------------------------------------------- */

const SOCIAL_USE_CASES_FILE = 'application/social/social-use-cases.ts';
const SOCIAL_REPOSITORY_FILE = 'infrastructure/social-repository.ts';

/**
 * 設計 §8.3.4 の 17 個と、054 で足した 1 個の計 18 個（`name` の値）。
 *
 * 054 の `listSocialPostSources`（`social.post.listSources`）も区画を掛ける（054-bulk-post-actions 設計 §8.8・§13.10 #57）。
 * 054 の G5 で `social.post.publishNow` を足して 19 個にする（054 実装プラン §8 の 14）。
 */
const SCOPED_USE_CASE_NAMES = [
  'social.account.list',
  'social.account.get',
  'social.account.create',
  'social.account.update',
  'social.account.delete',
  'social.account.readCredential',
  'social.post.list',
  'social.post.history',
  'social.post.listByIds',
  'social.post.get',
  'social.post.create',
  'social.post.update',
  'social.post.delete',
  'social.post.approve',
  'social.post.listApprovalPending',
  'social.post.listManualPending',
  'social.post.manualHandoff',
  'social.post.listSources',
];

interface UseCaseHandler {
  readonly name: string;
  /** `handler:` から `defineUseCase` の呼び出しの終わり（行頭の `});`）まで。 */
  readonly handler: string;
}

/**
 * `defineUseCase<…>({ … });` / `defineUseCase({ … });` を順に切り出し、`name` と `handler:` 以降の本文を返す。
 *
 * 呼び出しの終わりは行頭の `});`（`export const x = defineUseCase…` の閉じ）。コメントは先に落とす。
 */
function useCaseHandlers(source: string): UseCaseHandler[] {
  const code = withoutComments(source.replaceAll('\r\n', '\n'));
  const found: UseCaseHandler[] = [];
  for (const match of code.matchAll(/\bdefineUseCase\s*[<(]/g)) {
    const rest = code.slice(match.index);
    const end = rest.search(/^\}\);$/m);
    const chunk = end === -1 ? rest : rest.slice(0, end);
    const name = /\bname:\s*['"]([^'"]+)['"]/.exec(chunk)?.[1] ?? '';
    const at = chunk.indexOf('handler:');
    found.push({ name, handler: at === -1 ? '' : chunk.slice(at) });
  }
  return found;
}

/**
 * 区画の条件の語：`site_id` / `site_scoped` / `origin_site_id` / `origin_site_scoped` の比較。
 *
 * SQL の `site_id IS NULL`・`site_id = …`・`origin_site_scoped = false` と、Kysely の `eb('site_id', '=', …)`・
 * `.where('social_accounts.site_id', 'is', null)` を拾う。挿入の `values`（`site_id: …`）・JS の `===` は拾わない。
 */
const SCOPE_CONDITION =
  /\b(?:origin_)?site_(?:id|scoped)\b\s*(?:=(?!=)|<>|!=(?!=)|\bIS\b)|['"](?:[a-z_]+\.)?(?:origin_)?site_(?:id|scoped)['"]\s*,\s*['"](?:=|<>|!=|is|is not)['"]/gi;

function scopeConditionCount(source: string): number {
  return [...withoutComments(source).matchAll(SCOPE_CONDITION)].length;
}

describe('#61 SNS の UseCase は scopeOf(context) を呼び、区画の述語は scopePredicate の 1 か所にだけある', () => {
  const handlers = (): UseCaseHandler[] =>
    useCaseHandlers(readFileSync(join(SRC_DIR, SOCIAL_USE_CASES_FILE), 'utf8'));

  it('#61 social-use-cases.ts の defineUseCase は設計 §8.3.4 の 17 個と 054 の 1 個の計 18 個', () => {
    // 並びは問わない（定義の順を変えても落とさない）。数と名前の集合を見る。
    expect(
      handlers()
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...SCOPED_USE_CASE_NAMES].sort());
  });

  it.each(SCOPED_USE_CASE_NAMES)('#61 %s の handler が scopeOf(context) を呼ぶ', (name) => {
    const entry = handlers().find((candidate) => candidate.name === name);

    expect(entry, `${name} の defineUseCase が無い`).toBeDefined();
    expect(entry?.handler, `${name} に handler が無い`).not.toBe('');
    expect(entry?.handler).toContain('scopeOf(context)');
  });

  it('#61 infrastructure/social-repository.ts の区画の条件はすべて scopePredicate の本文にある', () => {
    const source = readFileSync(join(SRC_DIR, SOCIAL_REPOSITORY_FILE), 'utf8');
    const body = exportedFunctionBody(source, 'scopePredicate');

    expect(body, 'scopePredicate の定義が無い').not.toBe('');
    expect(scopeConditionCount(body)).toBeGreaterThan(0);
    expect(scopeConditionCount(source)).toBe(scopeConditionCount(body));
  });

  it('#61 scopePredicate は投稿の述語も持つ（origin_site_scoped・origin_site_id が本文にある）', () => {
    const body = withoutComments(
      exportedFunctionBody(
        readFileSync(join(SRC_DIR, SOCIAL_REPOSITORY_FILE), 'utf8'),
        'scopePredicate',
      ),
    );

    expect(body).toMatch(/origin_site_scoped/);
    expect(body).toMatch(/origin_site_id/);
  });

  it('#61 判別力：scopeOf を呼ばない handler を見分ける（コメントの中の scopeOf は数えない）', () => {
    const tampered = [
      'export const getThing = defineUseCase<{ id: string }, Thing>({',
      "  name: 'social.post.get',",
      "  permission: 'social.read',",
      '  handler: async (context, input) => {',
      '    // scopeOf(context) はコメントなので数えない',
      '    return repository.findPostById(context.connection, input.id);',
      '  },',
      '});',
      '',
      'export const listThings = defineUseCase<Input, Page>({',
      "  name: 'social.post.list',",
      "  permission: 'social.read',",
      '  handler: async (context, input) =>',
      '    repository.listPosts(context.connection, input, scopeOf(context)),',
      '});',
      '',
    ].join('\n');
    const found = useCaseHandlers(tampered);

    expect(found.map((entry) => entry.name)).toEqual(['social.post.get', 'social.post.list']);
    expect(found[0]?.handler).not.toContain('scopeOf(context)');
    expect(found[1]?.handler).toContain('scopeOf(context)');
  });

  it('#61 判別力：scopePredicate の外にある区画の条件（SQL・Kysely）を数える。values と === は数えない', () => {
    const tampered = [
      'function scopePredicate(scope) {',
      '  return sql`social_accounts.site_id IS NULL AND social_posts.origin_site_scoped = false`;',
      '}',
      '',
      'export const repo = {',
      '  async listPosts(connection) {',
      "    return connection.db.selectFrom('social_posts').where('social_accounts.site_id', '=', siteId);",
      '  },',
      '  async insertPost(connection, post) {',
      '    if (row.site_scoped && row.site_id === null) throw new SiteGoneError();',
      "    return connection.db.insertInto('social_posts').values({ origin_site_id: siteId, origin_site_scoped: true });",
      '  },',
      '  async listOther(connection) {',
      '    return sql`SELECT * FROM social_posts WHERE origin_site_id = ${siteId}`;',
      '  },',
      '};',
      '',
    ].join('\n');

    expect(scopeConditionCount(exportedFunctionBody(tampered, 'scopePredicate'))).toBe(2);
    expect(scopeConditionCount(tampered)).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/* #62 配信ジョブは区画で絞らない                                                   */
/* -------------------------------------------------------------------------- */

const PUBLISH_FILE = 'application/social/publish.ts';

/** `access-scope` のモジュール（`application/social/access-scope` / `domain/social/access-scope`）を読むか。 */
function importsAccessScope(source: string): boolean {
  const code = withoutComments(source);
  return (
    /\bfrom\s*['"][^'"]*access-scope['"]/.test(code) ||
    /\bimport\s*\(\s*['"][^'"]*access-scope['"]\s*\)/.test(code) ||
    /\bimport\s*['"][^'"]*access-scope['"]/.test(code)
  );
}

describe('#62 application/social/publish.ts は access-scope を import しない（配信ジョブは区画で絞らない）', () => {
  it('#62 publish.ts が access-scope を import しない', () => {
    const path = join(SRC_DIR, PUBLISH_FILE);
    expect(existsSync(path), `${PUBLISH_FILE} が無い`).toBe(true);

    expect(importsAccessScope(readFileSync(path, 'utf8'))).toBe(false);
  });

  it('#62 publish.ts が scopeOf を呼ばない', () => {
    const source = withoutComments(readFileSync(join(SRC_DIR, PUBLISH_FILE), 'utf8'));

    expect(source).not.toMatch(/\bscopeOf\s*\(/);
  });

  it('#62 判別力：import を足した写しを見分ける（静的・型だけ・動的。コメントは数えない）', () => {
    expect(importsAccessScope("import { scopeOf } from '@/application/social/access-scope';")).toBe(
      true,
    );
    expect(
      importsAccessScope("import type { AccessScope } from '../../domain/social/access-scope';"),
    ).toBe(true);
    expect(importsAccessScope("const m = await import('./access-scope');")).toBe(true);
    expect(importsAccessScope("// import { scopeOf } from './access-scope';\nconst x = 1;")).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #60 の後半 site_id / site_scoped / scopes / origin_* を書き換えるのは changeSite だけ */
/* -------------------------------------------------------------------------- */

const API_TOKEN_REPOSITORY_FILE = 'infrastructure/api-token-repository.ts';

/** `UPDATE` の対象の表ごとに、`SET` に現れてはいけない列（`changeSite` を除く）。 */
const GUARDED_COLUMNS: Readonly<Record<string, RegExp>> = {
  api_tokens: /\b(?:site_id|site_scoped|scopes)\b/,
  social_posts: /\b(?:origin_site_id|origin_site_scoped)\b/,
};

interface UpdateSet {
  readonly table: string;
  /** `.set( … )` の中身、または生の SQL の `SET … WHERE` の間。 */
  readonly set: string;
  /** コメントを落としたソースの中での位置。 */
  readonly index: number;
}

/** `open` の位置の `(` に対応する `)` までの中身。対応が取れなければ末尾まで。 */
function balancedContent(code: string, open: number): string {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, index);
    }
  }
  return code.slice(open + 1);
}

/**
 * コメントを落としたソースから、`api_tokens` / `social_posts` への `UPDATE` の `SET` を集める。
 *
 * * Kysely：`updateTable('api_tokens')` の後の最初の `.set( … )` の中身（`where` の条件は含めない）
 * * 生の SQL：`UPDATE api_tokens SET … WHERE`（`RETURNING` かテンプレートの終わりまで）
 */
function updateSets(code: string): UpdateSet[] {
  const found: UpdateSet[] = [];
  for (const match of code.matchAll(/updateTable\(\s*['"](api_tokens|social_posts)['"]\s*\)/g)) {
    const from = match.index + match[0].length;
    const setAt = code.slice(from).search(/\.set\s*\(/);
    if (setAt === -1) continue;
    const open = code.indexOf('(', from + setAt);
    found.push({ table: match[1] ?? '', set: balancedContent(code, open), index: match.index });
  }
  for (const match of code.matchAll(
    /\bUPDATE\s+(api_tokens|social_posts)\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|`|$)/gi,
  )) {
    found.push({
      table: (match[1] ?? '').toLowerCase(),
      set: match[2] ?? '',
      index: match.index,
    });
  }
  return found;
}

/** オブジェクトリテラルのメソッド `  async <name>(` から、次の行頭 `  },` まで（位置つき）。無ければ null。 */
function methodRange(code: string, name: string): { start: number; end: number } | null {
  const start = code.search(new RegExp(`^ {2}async ${name}\\(`, 'm'));
  if (start === -1) return null;
  const end = code.slice(start).search(/^ {2}\},?$/m);
  return { start, end: end === -1 ? code.length : start + end };
}

/** 禁止の列を `SET` に書いている箇所（`api-token-repository.ts` の `changeSite` の中は除く）。 */
function guardedWrites(files: readonly { path: string; text: string }[]): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    const code = withoutComments(text.replaceAll('\r\n', '\n'));
    const allowed = path === API_TOKEN_REPOSITORY_FILE ? methodRange(code, 'changeSite') : null;
    for (const update of updateSets(code)) {
      const guard = GUARDED_COLUMNS[update.table];
      if (guard === undefined || !guard.test(update.set)) continue;
      if (allowed !== null && update.index >= allowed.start && update.index < allowed.end) continue;
      offenders.push(`${path}（${update.table}）`);
    }
  }
  return offenders;
}

function sourceFiles(): { path: string; text: string }[] {
  return sourceFilesUnder(SRC_DIR).map((path) => ({
    path,
    text: readFileSync(join(SRC_DIR, path), 'utf8'),
  }));
}

describe('#60 api_tokens の site_id / site_scoped / scopes と social_posts の origin_* を書き換えるのは changeSite だけ', () => {
  it('#60 apps/web/src（テストを除く）で、changeSite の外に禁止の列を SET する UPDATE が無い', () => {
    expect(guardedWrites(sourceFiles())).toEqual([]);
  });

  it('#60 infrastructure/api-token-repository.ts に changeSite があり、api_tokens の site_id と social_posts の origin_site_id を書き換える', () => {
    const code = withoutComments(
      readFileSync(join(SRC_DIR, API_TOKEN_REPOSITORY_FILE), 'utf8').replaceAll('\r\n', '\n'),
    );
    const range = methodRange(code, 'changeSite');

    expect(range, 'apiTokenRepository に changeSite が無い').not.toBeNull();
    const inChangeSite = updateSets(code).filter(
      (update) => range !== null && update.index >= range.start && update.index < range.end,
    );
    expect(
      inChangeSite.some(
        (update) => update.table === 'api_tokens' && /\bsite_id\b/.test(update.set),
      ),
      'changeSite が api_tokens の site_id を書き換えていない',
    ).toBe(true);
    expect(
      inChangeSite.some(
        (update) => update.table === 'social_posts' && /\borigin_site_id\b/.test(update.set),
      ),
      'changeSite が social_posts の origin_site_id を書き換えていない',
    ).toBe(true);
  });

  it('#60 判別力：changeSite の外の Kysely・生の SQL の UPDATE を見分け、where の条件と changeSite の中は数えない', () => {
    const tampered = [
      'export const apiTokenRepository = {',
      '  async revokeBySite(connection, siteId, now) {',
      "    await connection.db.updateTable('api_tokens').set({ revoked_at: now }).where('site_id', '=', siteId).execute();",
      '  },',
      '',
      '  async detach(connection, id) {',
      "    await connection.db.updateTable('api_tokens').set({ site_id: null }).where('id', '=', id).execute();",
      '  },',
      '',
      '  async changeSite(connection, input) {',
      "    await connection.db.updateTable('api_tokens').set({ site_id: input.siteId, site_scoped: input.siteScoped, scopes: input.scopes }).execute();",
      '    await sql`UPDATE social_posts SET origin_site_id = ${input.siteId}, origin_site_scoped = ${input.siteScoped} WHERE created_by_token_id = ${input.id}`.execute(connection.db);',
      '  },',
      '};',
      '',
    ].join('\n');
    const otherFile = [
      'export async function reset(connection) {',
      '  await sql`UPDATE social_posts SET origin_site_scoped = false WHERE id = ${id}`.execute(connection.db);',
      '}',
      '',
    ].join('\n');

    expect(
      guardedWrites([
        { path: API_TOKEN_REPOSITORY_FILE, text: tampered },
        { path: 'infrastructure/social-repository.ts', text: otherFile },
      ]),
    ).toEqual([
      `${API_TOKEN_REPOSITORY_FILE}（api_tokens）`,
      'infrastructure/social-repository.ts（social_posts）',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #100 Repository の区画の引数は必須                                             */
/* -------------------------------------------------------------------------- */

const SOCIAL_REPOSITORY_DECLARATION_FILE = 'domain/social/social-repository.ts';

/** 区画を取る読み出し（053 設計 §7.4・実装プラン §8 の 4）。 */
const SCOPED_REPOSITORY_METHODS = [
  'listAccounts',
  'listPosts',
  'findPostById',
  'findPostsByIds',
  'listManualPending',
  'listApprovalPending',
] as const;

/**
 * 区画の引数が省略できる・既定値を持つ宣言（`scope?: AccessScope`・`scope: AccessScope = …`）の数。
 *
 * 省略や既定値があると、区画を渡し忘れた呼び出しが黙って `ALL_SCOPE`（絞らない）に倒れる。区画は失敗したときに
 * 広がらない（閉じる）向きに作る。
 */
const OPTIONAL_SCOPE = /\bscope\s*(?:\?\s*:\s*AccessScope\b|:\s*AccessScope\s*=)/g;

function optionalScopeCount(source: string): number {
  return [...withoutComments(source).matchAll(OPTIONAL_SCOPE)].length;
}

/** `<name>(` の宣言の引数の並び（括弧の対応で切る）。無ければ null。 */
function declarationParameters(source: string, name: string): string | null {
  const code = withoutComments(source);
  const match = new RegExp(`^\\s*(?:async\\s+)?${name}\\(`, 'm').exec(code);
  if (match === null) return null;
  return balancedContent(code, match.index + match[0].length - 1);
}

describe('#100 Repository の区画の引数は必須（省略・既定値で ALL_SCOPE に倒れない）', () => {
  it.each([SOCIAL_REPOSITORY_FILE, SOCIAL_REPOSITORY_DECLARATION_FILE])(
    '#100 %s に省略できる・既定値を持つ scope の宣言が無い',
    (file) => {
      expect(optionalScopeCount(readFileSync(join(SRC_DIR, file), 'utf8'))).toBe(0);
    },
  );

  it.each(SCOPED_REPOSITORY_METHODS)(
    '#100 Domain の宣言の %s が scope: AccessScope を必須で取る',
    (name) => {
      const parameters = declarationParameters(
        readFileSync(join(SRC_DIR, SOCIAL_REPOSITORY_DECLARATION_FILE), 'utf8'),
        name,
      );

      expect(parameters, `${name} の宣言が無い`).not.toBeNull();
      expect(parameters).toMatch(/\bscope\s*:\s*AccessScope\b/);
    },
  );

  it('#100 判別力：省略できる宣言と既定値を持つ宣言を数え、必須の宣言は数えない', () => {
    const sample = [
      '  listPosts(connection: Connection, query: Q, scope?: AccessScope): Promise<P>;',
      '  async findPostById(connection: Connection, id: string, scope: AccessScope = ALL_SCOPE) {',
      '  listAccounts(connection: Connection, query: Q, scope: AccessScope): Promise<P>;',
      '  // scope?: AccessScope はコメントなので数えない',
    ].join('\n');

    expect(optionalScopeCount(sample)).toBe(2);
  });
});
