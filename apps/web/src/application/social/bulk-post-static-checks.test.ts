import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_EVENTS, PLUGIN_API_VERSION } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@/domain/audit';
import { CORE_PERMISSIONS } from '@/domain/permission';

/**
 * SNS 投稿の一括操作の静的検査（054-bulk-post-actions 設計 §13.10・§13.1）。
 *
 * `site-scope-static-checks.test.ts` と同じ流儀で、ソース・マイグレーション・定数の形を固定する。
 *
 * * #4：`026_site_scoped_social.sql` の SHA-256 の固定（G1）
 * * #59：公開 Plugin API の `SocialPostView` のキー、`PLUGIN_API_VERSION`、`CORE_EVENTS`、`CORE_PERMISSIONS`、
 *   `AUDIT_ACTIONS` が 054 の前（`4597907`）と同じ（G1）
 * * #61：`application/social/publish.ts` の SHA-256 の固定（G1）
 * * #58 の一部：`listPostSourceTokens` は `scopedPosts` で区画を掛け、区画の条件を直に書かない。Domain の宣言は
 *   `scope: AccessScope` を必須で取る（G3）
 * * #56：`application/social/bulk-post-use-cases.ts` があり、`socialRepository` も `infrastructure/` も import しない（G4）
 *
 * **未実装の値は静的 import にしない**（`site-scope-static-checks.test.ts` と同じ）。
 * 未実装の段階でこのファイル全体が読めなくなると、他の件まで一緒に落ちて何が壊れたのか読めなくなる。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
/** apps/web/src → リポジトリルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');
const PLUGIN_API_DATA = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'data.ts');

/** 改行を LF にそろえた内容の SHA-256。 */
function sha256OfLf(source: string): string {
  return createHash('sha256').update(source.replaceAll('\r\n', '\n'), 'utf8').digest('hex');
}

/** ファイルを読む（無ければ落とす）。 */
function readSource(path: string, label: string): string {
  expect(existsSync(path), `${label} が無い`).toBe(true);
  return readFileSync(path, 'utf8');
}

/* -------------------------------------------------------------------------- */
/* #4 026 は適用済み（SHA-256 の固定）                                             */
/* -------------------------------------------------------------------------- */

/**
 * `026_site_scoped_social.sql` の内容（改行を LF にそろえたもの）の SHA-256（`4597907` で計算）。
 *
 * 後継のマイグレーション（`027`）を足すので、`025` と同じ形で固定する（053 の約束。設計 §13.1 #4）。
 * **適用済みなので書き換えない。** 足りないものは `027` 以降で足す。`027` は次のマイグレーションで固定する。
 */
const SHA256_OF_026 = '5c9d436a73621438c7983ea91ea31d807596d1be5d4d88317e2651cd5910ec19';

describe('#4 026 のマイグレーションは適用済み', () => {
  it('#4 026_site_scoped_social.sql のファイル内容が変わっていない', () => {
    const source = readSource(
      join(MIGRATIONS_DIR, '026_site_scoped_social.sql'),
      'migrations/026_site_scoped_social.sql',
    );

    expect(
      sha256OfLf(source),
      '026 は適用済み。登録元の名前の写しは 027_social_post_token_name.sql で足す（054 設計 §7.1）',
    ).toBe(SHA256_OF_026);
  });

  it('#4 判別力：1 文字変えた写しは SHA-256 が一致しない', () => {
    const source = readSource(
      join(MIGRATIONS_DIR, '026_site_scoped_social.sql'),
      'migrations/026_site_scoped_social.sql',
    );

    expect(sha256OfLf(`${source} `)).not.toBe(SHA256_OF_026);
  });

  it('#4 判別力：改行が CRLF の写しも同じ SHA-256（改行コードの違いでは落ちない）', () => {
    const source = readSource(
      join(MIGRATIONS_DIR, '026_site_scoped_social.sql'),
      'migrations/026_site_scoped_social.sql',
    ).replaceAll('\r\n', '\n');

    expect(sha256OfLf(source.replaceAll('\n', '\r\n'))).toBe(SHA256_OF_026);
  });
});

/* -------------------------------------------------------------------------- */
/* #59 公開 Plugin API・イベント・Permission・監査の action は変えない                 */
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

/** 054 の前（`4597907`）の `SocialPostView` のキー（設計 §11：登録元を足さない）。 */
const SOCIAL_POST_VIEW_KEYS_054 = [
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

/** 054 の前（`4597907`）の `CORE_EVENTS`（設計 §8.11：一括のイベントを足さない）。 */
const CORE_EVENTS_054 = [
  'site.created',
  'site.updated',
  'site.deleted',
  'social.account.connected',
  'social.account.disconnected',
  'social.post.created',
  'social.post.approved',
  'social.post.published',
  'social.post.failed',
  'campaign.created',
  'campaign.updated',
  'campaign.deleted',
  'analytics.rolledUp',
  'analytics.purged',
];

/** 054 の前（`4597907`）の Core の Permission（設計 §10.2：新しい Permission を作らない）。 */
const CORE_PERMISSION_NAMES_054 = [
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

/** 054 の前（`4597907`）の `AUDIT_ACTIONS`（設計 §8.10：新しい action を足さない）。 */
const AUDIT_ACTIONS_054 = [
  'created',
  'updated',
  'deleted',
  'enabled',
  'disabled',
  'installed',
  'uninstalled',
  'credential_read',
  'approved',
];

describe('#59 公開 Plugin API・イベント・Permission・監査の action を変えない', () => {
  const dataSource = (): string => readSource(PLUGIN_API_DATA, 'packages/plugin-api/src/data.ts');

  it('#59 SocialPostView のキーが 054 の前と同じ（登録元を足さない）', () => {
    expect(interfaceKeys(dataSource(), 'SocialPostView')).toEqual(SOCIAL_POST_VIEW_KEYS_054);
  });

  it('#59 PLUGIN_API_VERSION は 1 のまま', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it('#59 CORE_EVENTS が 054 の前と順まで同じ（一括のイベントを足さない）', () => {
    expect([...(CORE_EVENTS as readonly string[])]).toEqual(CORE_EVENTS_054);
  });

  it('#59 CORE_PERMISSIONS は 15 種で、名前の集合が 054 の前と同じ', () => {
    expect(CORE_PERMISSIONS).toHaveLength(15);
    expect([...(CORE_PERMISSIONS as readonly string[])].sort()).toEqual(CORE_PERMISSION_NAMES_054);
  });

  it('#59 AUDIT_ACTIONS が 054 の前と順まで同じ（新しい action を足さない）', () => {
    expect([...(AUDIT_ACTIONS as readonly string[])]).toEqual(AUDIT_ACTIONS_054);
  });

  it('#59 判別力：SocialPostView に createdByTokenName を足した写しではキーが一致しない', () => {
    const tampered = `export interface SocialPostView {
${SOCIAL_POST_VIEW_KEYS_054.map((key) => `  readonly ${key}: unknown;`).join('\n')}
  /**
   *   readonly fake: string;
   */
  readonly createdByTokenName: string | null;
}
`;

    expect(interfaceKeys(tampered, 'SocialPostView')).toEqual([
      ...SOCIAL_POST_VIEW_KEYS_054,
      'createdByTokenName',
    ]);
    expect(interfaceKeys(tampered, 'SocialPostView')).not.toEqual(SOCIAL_POST_VIEW_KEYS_054);
  });

  it('#59 判別力：一覧に 1 つ足した写し（bulk_approved）は AUDIT_ACTIONS の固定と一致しない', () => {
    expect([...AUDIT_ACTIONS_054, 'bulk_approved']).not.toEqual(AUDIT_ACTIONS_054);
  });
});

/* -------------------------------------------------------------------------- */
/* #61 publish.ts は変えない（SHA-256 の固定）                                     */
/* -------------------------------------------------------------------------- */

const PUBLISH_FILE = 'application/social/publish.ts';

/**
 * `application/social/publish.ts` の内容（改行を LF にそろえたもの）の SHA-256（`4597907` で計算）。
 *
 * 054 は配信ジョブの取り出し・着手・記録の条件に手を入れない（設計 §5.4・§13.10 #61）。「今すぐ送る」は予約日時を
 * いまにするだけで、送るのは次の定期実行が既存の条件で取り出したとき。
 *
 * **後の機能で `publish.ts` を変えるときは、この値を更新してよい。** そのときは 054 の約束（今すぐ送るが取り出し・
 * 着手・記録の条件に依らないこと）が崩れていないかを見直す（実装プラン §8 の 15）。
 */
const SHA256_OF_PUBLISH = '10c7cc376f73db501b42e19c44ed65ae894d5dc474dc183b66e80fe62b4f9198';

describe('#61 application/social/publish.ts は変えない', () => {
  it('#61 publish.ts のファイル内容が 054 の前と同じ', () => {
    const source = readSource(join(SRC_DIR, PUBLISH_FILE), PUBLISH_FILE);

    expect(
      sha256OfLf(source),
      'publish.ts は 054 で変えない（取り出し・着手・記録の条件に手を入れない。054 設計 §5.4）',
    ).toBe(SHA256_OF_PUBLISH);
  });

  it('#61 判別力：1 行足した写しは SHA-256 が一致しない', () => {
    const source = readSource(join(SRC_DIR, PUBLISH_FILE), PUBLISH_FILE);

    expect(sha256OfLf(`${source}\n// publish now\n`)).not.toBe(SHA256_OF_PUBLISH);
  });
});

/* -------------------------------------------------------------------------- */
/* #58 区画の条件は scopePredicate だけ（listPostSourceTokens は scopedPosts を使う）     */
/* -------------------------------------------------------------------------- */

const SOCIAL_REPOSITORY_FILE = 'infrastructure/social-repository.ts';
const SOCIAL_REPOSITORY_DECLARATION_FILE = 'domain/social/social-repository.ts';

/** コメント（ブロックコメントと行コメント）を落とす。 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/**
 * オブジェクトリテラルのメソッド `  async <name>(` から、次のメソッドかオブジェクトの終わりまで
 * （`approval-static-checks.test.ts` の `methodBody` を写す）。無ければ null。
 */
function methodBody(source: string, name: string): string | null {
  const normalized = source.replaceAll('\r\n', '\n');
  const start = normalized.search(new RegExp(`^ {2}async ${name}\\(`, 'm'));
  if (start === -1) return null;
  const rest = normalized.slice(start + 1);
  const end = rest.search(/^ {2}async [A-Za-z]+\(|^\};?$/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * 区画の条件の語：`site_id` / `site_scoped` / `origin_site_id` / `origin_site_scoped` の比較
 * （`site-scope-static-checks.test.ts` の #61 の `SCOPE_CONDITION` を写す）。
 */
const SCOPE_CONDITION =
  /\b(?:origin_)?site_(?:id|scoped)\b\s*(?:=(?!=)|<>|!=(?!=)|\bIS\b)|['"](?:[a-z_]+\.)?(?:origin_)?site_(?:id|scoped)['"]\s*,\s*['"](?:=|<>|!=|is|is not)['"]/gi;

function scopeConditionCount(source: string): number {
  return [...withoutComments(source).matchAll(SCOPE_CONDITION)].length;
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

/** `<name>(` の宣言の引数の並び（括弧の対応で切る）。無ければ null。 */
function declarationParameters(source: string, name: string): string | null {
  const code = withoutComments(source);
  const match = new RegExp(`^\\s*(?:async\\s+)?${name}\\(`, 'm').exec(code);
  if (match === null) return null;
  return balancedContent(code, match.index + match[0].length - 1);
}

describe('#58 listPostSourceTokens は scopedPosts で区画を掛け、区画の条件を直に書かない', () => {
  const repository = (): string =>
    readSource(join(SRC_DIR, SOCIAL_REPOSITORY_FILE), SOCIAL_REPOSITORY_FILE);

  it('#58 infrastructure/social-repository.ts に listPostSourceTokens があり、本文が scopedPosts( を呼ぶ', () => {
    const body = methodBody(repository(), 'listPostSourceTokens');

    expect(body, 'socialRepository に listPostSourceTokens が無い').not.toBeNull();
    expect(withoutComments(body ?? '')).toMatch(/\bscopedPosts\s*\(/);
  });

  it('#58 listPostSourceTokens の本文に区画の条件の語（site_id・origin_site_* の比較）を直に書かない', () => {
    const body = methodBody(repository(), 'listPostSourceTokens');

    expect(body, 'socialRepository に listPostSourceTokens が無い').not.toBeNull();
    expect(scopeConditionCount(body ?? '')).toBe(0);
  });

  it('#58 Domain の宣言の listPostSourceTokens が scope: AccessScope を必須で取る', () => {
    const parameters = declarationParameters(
      readSource(
        join(SRC_DIR, SOCIAL_REPOSITORY_DECLARATION_FILE),
        SOCIAL_REPOSITORY_DECLARATION_FILE,
      ),
      'listPostSourceTokens',
    );

    expect(parameters, 'listPostSourceTokens の宣言が無い').not.toBeNull();
    expect(parameters).toMatch(/\bscope\s*:\s*AccessScope\b/);
    expect(parameters).not.toMatch(/\bscope\s*\?\s*:/);
  });

  it('#58 判別力：区画の条件を直に書いた本文と scopedPosts を呼ばない本文を見分ける（コメントは数えない）', () => {
    const tampered = [
      'export const socialRepository = {',
      '  async listPostSourceTokens(connection, scope) {',
      '    // scopedPosts( はコメントなので数えない',
      "    return connection.db.selectFrom('social_posts').where('social_accounts.site_id', '=', siteId);",
      '  },',
      '',
      '  async other(connection) {',
      "    return scopedPosts(connection.db.selectFrom('social_posts'), scope);",
      '  },',
      '};',
      '',
    ].join('\n');
    const body = methodBody(tampered, 'listPostSourceTokens') ?? '';

    expect(withoutComments(body)).not.toMatch(/\bscopedPosts\s*\(/);
    expect(scopeConditionCount(body)).toBe(1);
  });

  it('#58 判別力：省略できる scope の宣言は必須の形に合わない', () => {
    const parameters = declarationParameters(
      '  listPostSourceTokens(connection: Connection, scope?: AccessScope): Promise<S>;',
      'listPostSourceTokens',
    );

    expect(parameters).toMatch(/\bscope\s*\?\s*:/);
  });
});

/* -------------------------------------------------------------------------- */
/* #56 一括の UseCase は Repository を直接触らない                                   */
/* -------------------------------------------------------------------------- */

const BULK_USE_CASES_FILE = 'application/social/bulk-post-use-cases.ts';

/**
 * `socialRepository` か `infrastructure/` を読む箇所の数（静的・型だけ・動的・副作用だけの import。コメントは数えない）。
 *
 * * `import { socialRepository } from …` / `import type { … } from '@/infrastructure/…'` / `export … from '…'`
 * * `await import('../../infrastructure/…')` / `import '@/infrastructure/…'`
 * * `socialRepository` という名前を本文で使う（別名の再 export を経由した呼び出しも拾う）
 */
function repositoryReferenceCount(source: string): number {
  const code = withoutComments(source);
  const infrastructure =
    /['"](?:@\/infrastructure|(?:\.\.?\/)+(?:[\w-]+\/)*infrastructure)(?:\/[^'"]*)?['"]/;
  let count = 0;
  for (const match of code.matchAll(
    /\b(?:import|export)\b[^;]*?\bfrom\s*(['"][^'"]+['"])|\bimport\s*\(\s*(['"][^'"]+['"])\s*\)|\bimport\s*(['"][^'"]+['"])/g,
  )) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? '';
    if (infrastructure.test(specifier)) count += 1;
  }
  count += [...code.matchAll(/\bsocialRepository\b/g)].length;
  return count;
}

describe('#56 application/social/bulk-post-use-cases.ts は socialRepository も infrastructure/ も import しない', () => {
  it('#56 application/social/bulk-post-use-cases.ts がある', () => {
    expect(existsSync(join(SRC_DIR, BULK_USE_CASES_FILE)), `${BULK_USE_CASES_FILE} が無い`).toBe(
      true,
    );
  });

  it('#56 socialRepository と infrastructure/ を参照しない（静的・型だけ・動的のどれでも）', () => {
    const source = readSource(join(SRC_DIR, BULK_USE_CASES_FILE), BULK_USE_CASES_FILE);

    expect(repositoryReferenceCount(source)).toBe(0);
  });

  it('#56 判別力：静的・型だけ・動的・副作用だけの import と名前の参照を数え、コメントと他の層は数えない', () => {
    expect(
      repositoryReferenceCount(
        "import { socialRepository } from '@/infrastructure/social-repository';",
      ),
    ).toBe(2);
    expect(
      repositoryReferenceCount(
        "import type { Row } from '../../infrastructure/social-repository';",
      ),
    ).toBe(1);
    expect(
      repositoryReferenceCount("const m = await import('@/infrastructure/logging');\nm.log;"),
    ).toBe(1);
    expect(repositoryReferenceCount("import '../../infrastructure/side-effect';")).toBe(1);
    expect(repositoryReferenceCount("export { log } from '@/infrastructure/logging';")).toBe(1);
    expect(
      repositoryReferenceCount(
        [
          "// import { socialRepository } from '@/infrastructure/social-repository';",
          "import { approveSocialPost } from './social-use-cases';",
          "import { BULK_MAX_ITEMS } from '@/domain/social/bulk';",
          '',
        ].join('\n'),
      ),
    ).toBe(0);
  });
});
