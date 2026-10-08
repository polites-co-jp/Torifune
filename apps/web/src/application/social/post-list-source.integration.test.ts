import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { createSocialPost, listSocialPosts } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import type { PermissionName } from '@/domain/permission';
import type { PostStatus } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 投稿一覧の登録元の絞り込みと、登録元の一覧（054-bulk-post-actions 設計 §5.6・§8.7・§8.8、受け入れ条件 #11〜#15）。
 *
 * **UseCase を直接呼ぶ結合テスト（B）。** 準備（設計 §13 の前書き・実装プラン T6）：
 *
 * * 共通のアカウント `acc`、サイト A・B 専用のアカウント `accA`・`accB`（SQL で入れる。provider は配信 Plugin の無い名前）
 * * トークン `tokBlog`「ブログ連携」で 2 件（下書き 1・承認待ち 1）、同じ名前の `tokBlog2` で 1 件、
 *   `tokShop`「ショップ連携」で 1 件（後で失効）、セッション（管理者）で 1 件、
 *   別の利用者が所有する `tokGone`「さよなら連携」で 1 件（後で所有者を消す＝トークンの行が消える）、
 *   サイト A の `tokA` で `accA` に 1 件、サイト B の `tokB` で `accB` に 1 件、投稿の無い `tokIdle`
 *
 * 一覧は 1 ページ 100 件で引き、どの投稿が返るかを ID の集合で見る。
 *
 * **未実装の値は静的に書かない。** `ListPostsInput.source` はまだ型に無いので、入力はオブジェクトリテラルを
 * 変数に置いてから渡す（余剰の項目の検査に掛けない）。`listSocialPostSources` は指定子を `string` の定数に置いた
 * 動的 import で読む（053 実装プラン §8 の 19）。型は設計 §7.3・§8.8 から写す。
 */

const PASSWORD = 'post list source correct horse battery staple';
const PROVIDER = 'src_none';
const REQUEST_INFO = { ipAddress: '203.0.113.54', userAgent: 'vitest' } as const;
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

type SourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

interface SocialPostSources {
  readonly tokens: readonly {
    readonly id: string;
    readonly name: string;
    readonly revoked: boolean;
    readonly createdAt: Date;
  }[];
  readonly hasScreenPosts: boolean;
  readonly hasDeletedTokenPosts: boolean;
}

type ListSources = (context: AuthorizationContext, input?: unknown) => Promise<SocialPostSources>;

const USE_CASES_MODULE: string = '@/application/social/social-use-cases';

async function listSocialPostSources(context: AuthorizationContext): Promise<SocialPostSources> {
  const module = (await import(/* @vite-ignore */ USE_CASES_MODULE)) as {
    readonly listSocialPostSources?: ListSources;
  };
  if (module.listSocialPostSources === undefined) {
    throw new Error('application/social/social-use-cases.ts に listSocialPostSources が無い');
  }
  return module.listSocialPostSources(context, undefined);
}

interface IssuedToken {
  readonly id: string;
  readonly plaintext: string;
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let acc: string;
let accA: string;
let accB: string;
let tokBlog: IssuedToken;
let tokBlog2: IssuedToken;
let tokShop: IssuedToken;
let tokGone: IssuedToken;
let tokIdle: IssuedToken;
let tokA: IssuedToken;
let tokB: IssuedToken;
/** 登録元ごとの投稿の ID。 */
const posts = {
  blogDraft: '',
  blogAwaiting: '',
  blog2: '',
  shop: '',
  screen: '',
  screenA: '',
  gone: '',
  siteA: '',
  siteB: '',
};

async function createUser(roleName: string): Promise<{
  readonly id: string;
  readonly context: AuthorizationContext;
}> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `s${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'post list source test',
        password_hash: passwordHash,
      })
      .execute();
    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId,
    displayName: 'post list source test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { id, context: { ...context, request: REQUEST_INFO } };
}

async function insertSite(name: string): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO sites (id, name, url)
              VALUES (${id}, ${name}, 'https://example.com/')`.execute(connection.db);
  });
  return id;
}

async function insertAccount(displayName: string, siteId: string | null): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO social_accounts (id, provider, display_name, status, site_id)
              VALUES (${id}, ${PROVIDER}, ${displayName}, 'connected', ${siteId})`.execute(
      connection.db,
    );
  });
  return id;
}

async function issueToken(
  owner: AuthorizationContext,
  name: string,
  siteId: string | null = null,
): Promise<IssuedToken> {
  const created = await createApiToken(owner, {
    name,
    scopes: SNS_SCOPES,
    expiresAt: null,
    siteId,
  });
  return { id: created.token.id, plaintext: created.plaintext };
}

async function tokenContext(token: IssuedToken): Promise<AuthorizationContext> {
  const context = await buildApiTokenContext(token.plaintext, REQUEST_INFO);
  if (context.identity === null) throw new Error('トークンの文脈を作れない');
  return context;
}

async function createPostAs(
  context: AuthorizationContext,
  accountId: string,
  publishTiming?: 'after_approval',
): Promise<string> {
  const { post } = await createSocialPost(context, {
    socialAccountId: accountId,
    body: '登録元の絞り込みのテストの投稿です。',
    scheduledAt: null,
    ...(publishTiming === undefined ? {} : { publishTiming }),
  });
  return post.id;
}

interface ListOptions {
  readonly source?: SourceFilter | null;
  readonly status?: PostStatus | null;
  readonly socialAccountId?: string | null;
}

/** 1 ページ 100 件で一覧を引き、ID の集合（昇順）と total を返す。 */
async function list(
  context: AuthorizationContext,
  options: ListOptions = {},
): Promise<{ readonly ids: string[]; readonly total: number }> {
  // `source` はまだ `ListPostsInput` の型に無い。変数に置いてから渡す（冒頭の注記）。
  const input = { page: 1, perPage: 100, socialAccountId: null, status: null, ...options };
  const page = await listSocialPosts(context, input);
  return { ids: page.items.map((post) => post.id).sort(), total: page.total };
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

interface CreatedByRow {
  readonly id: string;
  readonly created_by_token_id: string | null;
  readonly created_by_token_name: string | null;
}

/** 投稿の登録元の 2 列を生の SQL で読む（`created_by_token_name` はまだ Kysely の型に無い）。 */
async function createdByOf(ids: readonly string[]): Promise<CreatedByRow[]> {
  if (ids.length === 0) return [];
  return withConnection(async (connection) => {
    const result = await sql<CreatedByRow>`
      SELECT id, created_by_token_id, created_by_token_name
        FROM social_posts WHERE id IN (${sql.join([...ids])})`.execute(connection.db);
    return result.rows;
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('postlistsource');

  admin = (await createUser('administrator')).context;
  const siteA = await insertSite('サイト A');
  const siteB = await insertSite('サイト B');
  acc = await insertAccount('共通のアカウント', null);
  accA = await insertAccount('サイト A のアカウント', siteA);
  accB = await insertAccount('サイト B のアカウント', siteB);

  tokBlog = await issueToken(admin, 'ブログ連携');
  tokBlog2 = await issueToken(admin, 'ブログ連携');
  tokShop = await issueToken(admin, 'ショップ連携');
  tokIdle = await issueToken(admin, '投稿の無い連携');
  tokA = await issueToken(admin, 'サイト A 連携', siteA);
  tokB = await issueToken(admin, 'サイト B 連携', siteB);
  const goneOwner = await createUser('administrator');
  tokGone = await issueToken(goneOwner.context, 'さよなら連携');

  const blogContext = await tokenContext(tokBlog);
  posts.blogDraft = await createPostAs(blogContext, acc);
  posts.blogAwaiting = await createPostAs(blogContext, acc, 'after_approval');
  posts.blog2 = await createPostAs(await tokenContext(tokBlog2), acc);
  // 承認待ちを tokBlog 以外にも置く（#12 の AND が登録元で絞れているかを見分ける）。
  posts.shop = await createPostAs(await tokenContext(tokShop), acc, 'after_approval');
  posts.screen = await createPostAs(admin, acc);
  // サイト A のアカウントにも tokA 以外の投稿を置く（#12・#14 を見分ける）。
  posts.screenA = await createPostAs(admin, accA);
  posts.gone = await createPostAs(await tokenContext(tokGone), acc);
  posts.siteA = await createPostAs(await tokenContext(tokA), accA);
  posts.siteB = await createPostAs(await tokenContext(tokB), accB);

  await withConnection(async (connection) => {
    // 失効（行は残る）。
    await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${tokShop.id}`.execute(
      connection.db,
    );
    // 所有者を消す（トークンの行は CASCADE で消え、投稿の created_by_token_id は NULL になる）。
    await sql`DELETE FROM users WHERE id = ${goneOwner.id}`.execute(connection.db);
  });
});

afterAll(async () => {
  await scratch.dispose();
});

function allPostIds(): string[] {
  return sorted(Object.values(posts));
}

// ---------------------------------------------------------------------------
// #11 登録元の 3 種
// ---------------------------------------------------------------------------

describe('#11 listSocialPosts の source で絞る', () => {
  it("#11 { kind: 'token', tokenId: tokBlog } → tokBlog で登録した投稿だけ", async () => {
    const result = await list(admin, { source: { kind: 'token', tokenId: tokBlog.id } });

    expect(result.ids).toEqual(sorted([posts.blogDraft, posts.blogAwaiting]));
  });

  it("#11 { kind: 'token', tokenId: tokBlog } の total も絞った件数（2）", async () => {
    const result = await list(admin, { source: { kind: 'token', tokenId: tokBlog.id } });

    expect(result.total).toBe(2);
  });

  it('#11 失効したトークン（tokShop）でも絞れる', async () => {
    const result = await list(admin, { source: { kind: 'token', tokenId: tokShop.id } });

    expect(result).toEqual({ ids: [posts.shop], total: 1 });
  });

  it("#11 { kind: 'screen' } → セッションで登録した投稿だけ（total も 2）", async () => {
    const result = await list(admin, { source: { kind: 'screen' } });

    expect(result).toEqual({ ids: sorted([posts.screen, posts.screenA]), total: 2 });
  });

  it("#11 { kind: 'deleted_token' } → 所有者を削除したトークンの投稿だけ（total も 1）", async () => {
    const result = await list(admin, { source: { kind: 'deleted_token' } });

    expect(result).toEqual({ ids: [posts.gone], total: 1 });
  });

  it("#11 所有者を削除したトークンの投稿は { kind: 'screen' } に混ざらない", async () => {
    const result = await list(admin, { source: { kind: 'screen' } });

    expect(result.ids).not.toContain(posts.gone);
  });
});

// ---------------------------------------------------------------------------
// #12 他の絞り込みと AND
// ---------------------------------------------------------------------------

describe('#12 source と status・socialAccountId は AND で掛かる', () => {
  it('#12 tokBlog × awaiting_approval → tokBlog の承認待ちだけ', async () => {
    const result = await list(admin, {
      source: { kind: 'token', tokenId: tokBlog.id },
      status: 'awaiting_approval',
    });

    expect(result).toEqual({ ids: [posts.blogAwaiting], total: 1 });
  });

  it('#12 tokBlog × draft → tokBlog の下書きだけ', async () => {
    const result = await list(admin, {
      source: { kind: 'token', tokenId: tokBlog.id },
      status: 'draft',
    });

    expect(result).toEqual({ ids: [posts.blogDraft], total: 1 });
  });

  it('#12 tokA × サイト B のアカウント → 0 件', async () => {
    const result = await list(admin, {
      source: { kind: 'token', tokenId: tokA.id },
      socialAccountId: accB,
    });

    expect(result).toEqual({ ids: [], total: 0 });
  });

  it('#12 tokA × サイト A のアカウント → tokA の投稿だけ', async () => {
    const result = await list(admin, {
      source: { kind: 'token', tokenId: tokA.id },
      socialAccountId: accA,
    });

    expect(result).toEqual({ ids: [posts.siteA], total: 1 });
  });
});

// ---------------------------------------------------------------------------
// #13 省略と形の誤り
// ---------------------------------------------------------------------------

describe('#13 source を省略した呼び出しは 054 の前と同じ', () => {
  it('#13 source 省略 → すべての投稿と total', async () => {
    const result = await list(admin);

    expect(result).toEqual({ ids: allPostIds(), total: allPostIds().length });
  });

  it('#13 source: null も省略と同じ', async () => {
    expect(await list(admin, { source: null })).toEqual(await list(admin));
  });

  it("#13 { kind: 'token', tokenId: 'abc' }（UUID の形でない）→ 0 件", async () => {
    const result = await list(admin, { source: { kind: 'token', tokenId: 'abc' } });

    expect(result).toEqual({ ids: [], total: 0 });
  });

  it('#13 存在しないトークンの UUID → 0 件', async () => {
    const result = await list(admin, { source: { kind: 'token', tokenId: uuidv7() } });

    expect(result).toEqual({ ids: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// #14 区画の中で絞る
// ---------------------------------------------------------------------------

describe('#14 サイトのトークンの文脈では区画の中で絞る', () => {
  it('#14 tokA の文脈で source に tokB（別の区画の投稿を登録したトークン）→ 0 件', async () => {
    const context = await tokenContext(tokA);

    const result = await list(context, { source: { kind: 'token', tokenId: tokB.id } });

    expect(result).toEqual({ ids: [], total: 0 });
  });

  it('#14 tokA の文脈で source に tokA → 区画の中の tokA の投稿', async () => {
    const context = await tokenContext(tokA);

    const result = await list(context, { source: { kind: 'token', tokenId: tokA.id } });

    expect(result).toEqual({ ids: [posts.siteA], total: 1 });
  });

  it('#14 tokA の文脈で絞った結果は、絞らない一覧（区画の中）の部分集合', async () => {
    const context = await tokenContext(tokA);
    const visible = (await list(context)).ids;

    for (const source of [
      { kind: 'screen' },
      { kind: 'deleted_token' },
      { kind: 'token', tokenId: tokBlog.id },
    ] as const) {
      const result = await list(context, { source });
      expect(result.ids.every((id) => visible.includes(id))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// #15 listSocialPostSources
// ---------------------------------------------------------------------------

describe('#15 listSocialPostSources', () => {
  it('#15 投稿を登録したトークン（失効を含む）を、名前 → 発行日時 → ID の順で返す', async () => {
    const sources = await listSocialPostSources(admin);

    const expected = [tokA, tokB, tokShop, tokBlog, tokBlog2].map((token) => token.id);
    // 名前の並び：「サイト A 連携」「サイト B 連携」「ショップ連携」「ブログ連携」×2（同じ名前は発行の順）。
    expect(sources.tokens.map((token) => token.id)).toEqual(expected);
  });

  it('#15 トークンの名前と失効の有無', async () => {
    const sources = await listSocialPostSources(admin);
    const byId = new Map(sources.tokens.map((token) => [token.id, token]));

    expect(byId.get(tokBlog.id)).toMatchObject({ name: 'ブログ連携', revoked: false });
    expect(byId.get(tokShop.id)).toMatchObject({ name: 'ショップ連携', revoked: true });
  });

  it('#15 発行日時（createdAt）は Date', async () => {
    const sources = await listSocialPostSources(admin);

    expect(sources.tokens.every((token) => token.createdAt instanceof Date)).toBe(true);
  });

  it('#15 投稿の無いトークンは含まない', async () => {
    const sources = await listSocialPostSources(admin);

    expect(sources.tokens.map((token) => token.id)).not.toContain(tokIdle.id);
  });

  it('#15 行の消えたトークンは含まない', async () => {
    const sources = await listSocialPostSources(admin);

    expect(sources.tokens.map((token) => token.id)).not.toContain(tokGone.id);
  });

  it('#15 セッションの投稿があれば hasScreenPosts: true', async () => {
    expect((await listSocialPostSources(admin)).hasScreenPosts).toBe(true);
  });

  it('#15 トークンの行が消えた投稿があれば hasDeletedTokenPosts: true', async () => {
    expect((await listSocialPostSources(admin)).hasDeletedTokenPosts).toBe(true);
  });

  it('#15 区画 site の文脈では、その区画から見える投稿のトークンだけ（別の区画の tokB を含まない）', async () => {
    const context = await tokenContext(tokA);

    const sources = await listSocialPostSources(context);

    expect(sources.tokens.map((token) => token.id)).toContain(tokA.id);
    expect(sources.tokens.map((token) => token.id)).not.toContain(tokB.id);
  });

  it('#15 区画 site の文脈のトークンと 2 つの真偽は、区画の中で見える投稿の登録元とちょうど一致する', async () => {
    const context = await tokenContext(tokA);
    const visible = await createdByOf((await list(context)).ids);

    const sources = await listSocialPostSources(context);

    const expectedTokens = [
      ...new Set(
        visible.flatMap((row) =>
          row.created_by_token_id === null ? [] : [row.created_by_token_id],
        ),
      ),
    ].sort();
    expect(sources.tokens.map((token) => token.id).sort()).toEqual(expectedTokens);
    expect(sources.hasScreenPosts).toBe(
      visible.some((row) => row.created_by_token_id === null && row.created_by_token_name === null),
    );
    expect(sources.hasDeletedTokenPosts).toBe(
      visible.some((row) => row.created_by_token_id === null && row.created_by_token_name !== null),
    );
  });

  it('#15 social.read の無い文脈では ForbiddenError', async () => {
    const withoutRead: AuthorizationContext = {
      ...admin,
      permissions: new Set<PermissionName>(['social.write', 'social.approve', 'social.delete']),
    };

    await expect(listSocialPostSources(withoutRead)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
