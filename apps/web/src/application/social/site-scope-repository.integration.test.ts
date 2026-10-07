import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { deleteSite } from '@/application/site/site-use-cases';
import { scopeOf } from '@/application/social/access-scope';
import {
  createSocialPost,
  getSocialPost,
  listApprovalPendingPosts,
  listManualPendingPosts,
  listSocialPostHistory,
  listSocialPosts,
  listSocialPostsByIds,
  updateSocialAccount,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import type { Connection } from '@/database/provider';
import { NotFoundError } from '@/domain/repository';
import { ALL_SCOPE, postVisible, type AccessScope } from '@/domain/social/access-scope';
import type { SocialPost } from '@/domain/social/social';
import { apiTokenRepository } from '@/infrastructure/api-token-repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 投稿の区画の Repository と、API で届かない UseCase（053-site-scoped-social 設計 §5.2・§7.3・§7.4・§8.3）。
 *
 * 受け入れ条件 #41・#44・#45・#49 の前半（`SiteGoneError`）。
 *
 * * #41：p1〜p7 × 4 つの文脈で、Repository の `findPostById(id, scope)` と Domain の `postVisible` が一致する。
 *   `postVisible` の入力（アカウントの `site_id`・投稿の `origin_*`）は**DB から SQL で読む**（`SocialPost` に区画の列は無い）
 * * #45：画面専用の 4 つの UseCase も、トークンの文脈では区画の中だけ。セッションは全件
 * * #49 の前半：失効した・サイトの消えたトークンを登録元にした挿入は `SiteGoneError`（ルートでは 401）で、行は増えない
 *
 * 文脈は `buildApiTokenContext(平文, request)`（トークン）と `authorizationContextFor`（セッション）で作る
 * （実装プラン §2 のテストの方法）。
 *
 * **未実装の値は静的 import にしない。** Repository の第 3 引数 `scope` と `SiteGoneError` はまだ無いので、
 * 前者は型を広げて呼び、後者は指定子を定数に置いた動的 import で読む（実装プラン §8 の 19 と同じ）。
 */

const PASSWORD = 'site scope repository correct horse battery staple';
const PROVIDER = 'scope_none';
const REQUEST_INFO = { ipAddress: '203.0.113.56', userAgent: 'vitest' } as const;
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 未実装の値を型検査に掛けないため、指定子は定数に置く。 */
const SITE_MODULE: string = '@/domain/site/site';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let siteA: string;
let siteB: string;
let accA: string;
let accB: string;
let accC: string;

interface IssuedToken {
  readonly id: string;
  readonly plaintext: string;
}

async function createAdmin(): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `r${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'site scope repository test',
        password_hash: passwordHash,
      })
      .execute();
    const role = await roleRepository.findByName(connection, 'administrator');
    if (role === null) throw new Error('ロールが無い: administrator');
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId,
    displayName: 'site scope repository test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { ...context, request: REQUEST_INFO };
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

/** 管理者がトークンを発行する（G3 の UseCase）。 */
async function issueToken(siteId: string | null): Promise<IssuedToken> {
  const created = await createApiToken(admin, {
    name: `t-${uuidv7().slice(-8)}`,
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

/** UseCase で下書きの投稿を登録し、ID を返す。 */
async function createPostAs(context: AuthorizationContext, accountId: string): Promise<string> {
  const { post } = await createSocialPost(context, {
    socialAccountId: accountId,
    body: '区画の Repository のテストの投稿です。',
    scheduledAt: null,
  });
  return post.id;
}

async function countPosts(): Promise<number> {
  return withConnection(async (connection) => {
    const result = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM social_posts`.execute(connection.db);
    return Number(result.rows[0]?.count ?? '0');
  });
}

async function revokeTokenRow(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${id}`.execute(connection.db);
  });
}

/** サイトのトークンの `site_id` を NULL にする（サイトが消えた後の形。失効させない）。 */
async function detachTokenSite(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE api_tokens SET site_id = NULL WHERE id = ${id}`.execute(connection.db);
  });
}

/** 返した Promise が reject したときの例外。resolve したらテストを落とす。 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('reject されなかった');
}

/** `SiteGoneError`（未実装の段階では undefined）。 */
async function siteGoneError(): Promise<(new (...args: never[]) => Error) | undefined> {
  const module = (await import(/* @vite-ignore */ SITE_MODULE)) as {
    readonly SiteGoneError?: new (...args: never[]) => Error;
  };
  return module.SiteGoneError;
}

async function expectSiteGone(error: unknown): Promise<void> {
  const SiteGoneError = await siteGoneError();
  expect(SiteGoneError, 'domain/site/site.ts に SiteGoneError が無い').toBeDefined();
  if (SiteGoneError === undefined) return;
  expect(error).toBeInstanceOf(SiteGoneError);
}

/** `findPostById` の第 3 引数 `scope`（053 で足す。実装プラン §8 の 4）。 */
type ScopedFindPostById = (
  connection: Connection,
  id: string,
  scope?: AccessScope,
) => Promise<SocialPost | null>;

async function findPostByIdIn(id: string, scope: AccessScope): Promise<SocialPost | null> {
  const find = socialRepository.findPostById as unknown as ScopedFindPostById;
  return withConnection((connection) => find.call(socialRepository, connection, id, scope));
}

interface ScopeFactsRow {
  readonly account_site_id: string | null;
  readonly origin_site_id: string | null;
  readonly origin_site_scoped: boolean;
}

/** `postVisible` の入力を DB から読む（#41）。 */
async function scopeFactsOf(id: string): Promise<ScopeFactsRow> {
  return withConnection(async (connection) => {
    const result = await sql<ScopeFactsRow>`
      SELECT a.site_id AS account_site_id, p.origin_site_id, p.origin_site_scoped
        FROM social_posts p JOIN social_accounts a ON a.id = p.social_account_id
       WHERE p.id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('sitescoperepository');
  admin = await createAdmin();
  siteA = await insertSite('サイト A');
  siteB = await insertSite('サイト B');
});

afterAll(async () => {
  resetEventHandlers();
  await scratch.dispose();
});

beforeEach(async () => {
  accA = await insertAccount('A のアカウント', siteA);
  accB = await insertAccount('B のアカウント', siteB);
  accC = await insertAccount('共通のアカウント', null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #41 区画の述語と純関数の一致                                                    */
/* -------------------------------------------------------------------------- */

describe('#41 (B) findPostById(id, scope) と postVisible が一致する（7 件 × 4 つの文脈）', () => {
  type ContextName = 'session' | 'tokA' | 'tokB' | 'tokCommon';
  const contexts: Partial<Record<ContextName, AuthorizationContext>> = {};
  let posts: Record<string, string>;

  beforeEach(async () => {
    const tokA = await tokenContext(await issueToken(siteA));
    const tokB = await tokenContext(await issueToken(siteB));
    const tokCommon = await tokenContext(await issueToken(null));
    contexts.session = admin;
    contexts.tokA = tokA;
    contexts.tokB = tokB;
    contexts.tokCommon = tokCommon;
    posts = {
      p1: await createPostAs(tokA, accA),
      p2: await createPostAs(admin, accA),
      p3: await createPostAs(tokA, accC),
      p4: await createPostAs(tokCommon, accC),
      p5: await createPostAs(admin, accC),
      p6: await createPostAs(tokB, accB),
      p7: await createPostAs(tokB, accC),
    };
  });

  it.each(['session', 'tokA', 'tokB', 'tokCommon'] as const)(
    '#41 %s の文脈で、7 件それぞれについて Repository の結果と postVisible が一致する',
    async (name) => {
      const context = contexts[name];
      if (context === undefined) throw new Error(`文脈が無い: ${name}`);
      const scope = scopeOf(context);

      const fromRepository: Record<string, boolean> = {};
      const fromDomain: Record<string, boolean> = {};
      for (const [label, id] of Object.entries(posts)) {
        fromRepository[label] = (await findPostByIdIn(id, scope)) !== null;
        const facts = await scopeFactsOf(id);
        fromDomain[label] = postVisible(scope, {
          accountSiteId: facts.account_site_id,
          originSiteId: facts.origin_site_id,
          originSiteScoped: facts.origin_site_scoped,
        });
      }

      expect(fromRepository).toEqual(fromDomain);
    },
  );

  it('#41 判別力：tokA の文脈では見えない投稿がある（突き合わせが全件真で空回りしていない）', async () => {
    const context = contexts.tokA;
    if (context === undefined) throw new Error('文脈が無い: tokA');
    const scope = scopeOf(context);

    const visible: string[] = [];
    for (const [label, id] of Object.entries(posts)) {
      if ((await findPostByIdIn(id, scope)) !== null) visible.push(label);
    }

    expect(visible.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  // 053 の検証の指摘の修正で区画の引数は必須になった（既定値で all に倒さない。受け入れ条件 #100）。
  it('#41 区画 all（ALL_SCOPE）を渡すと 7 件とも見える', async () => {
    for (const id of Object.values(posts)) {
      expect(
        await withConnection((connection) =>
          socialRepository.findPostById(connection, id, ALL_SCOPE),
        ),
      ).not.toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #44 登録したサイトが消えた投稿                                                   */
/* -------------------------------------------------------------------------- */

describe('#44 (B) 登録したサイトが消えた投稿はどのトークンからも見えない（設計 §5.2 の 3）', () => {
  /** p7 に当たる投稿（共通のアカウントへ、この件のために作ったサイトのトークンが登録）。 */
  let p7: string;
  let goneSite: string;

  beforeEach(async () => {
    goneSite = await insertSite('消すサイト B');
    const goneAccount = await insertAccount('消すサイトのアカウント', goneSite);
    const tokGone = await tokenContext(await issueToken(goneSite));
    p7 = await createPostAs(tokGone, accC);
    // サイトのアカウントを共通へ付け替えてから、サイトを消す（設計 §13 の #44）。
    await updateSocialAccount(admin, { id: goneAccount, siteId: null });
    await deleteSite(admin, { id: goneSite });
  });

  it('#44 サイトを消した後の p7 の origin_site_id は NULL、origin_site_scoped は true のまま', async () => {
    const facts = await scopeFactsOf(p7);

    expect(facts.origin_site_id).toBeNull();
    expect(facts.origin_site_scoped).toBe(true);
  });

  it('#44 tokCommon の文脈で getSocialPost → NotFoundError', async () => {
    const tokCommon = await tokenContext(await issueToken(null));

    await expect(getSocialPost(tokCommon, { id: p7 })).rejects.toThrowError(NotFoundError);
  });

  it('#44 tokA の文脈で getSocialPost → NotFoundError', async () => {
    const tokA = await tokenContext(await issueToken(siteA));

    await expect(getSocialPost(tokA, { id: p7 })).rejects.toThrowError(NotFoundError);
  });

  it('#44 セッションの一覧には p7 が出る', async () => {
    const page = await listSocialPosts(admin, {
      page: 1,
      perPage: 100,
      socialAccountId: null,
      status: null,
    });

    expect(page.items.map((post) => post.id)).toContain(p7);
  });
});

/* -------------------------------------------------------------------------- */
/* #45 画面専用の UseCase も区画で絞る                                              */
/* -------------------------------------------------------------------------- */

interface RowSpec {
  readonly accountId: string;
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

/** 投稿を SQL で入れる（区画の列を直接決める。#45 は UseCase の絞り込みを見る）。 */
async function insertPostRow(
  spec: RowSpec,
  shape: {
    readonly status: string;
    readonly deliveryMode?: 'auto' | 'manual';
    readonly scheduledAt?: Date | null;
    readonly publishedAt?: Date | null;
  },
): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO social_posts
                (id, social_account_id, body, status, delivery_mode, scheduled_at, published_at,
                 origin_site_id, origin_site_scoped)
              VALUES (${id}, ${spec.accountId}, '画面専用の一覧のテスト', ${shape.status},
                      ${shape.deliveryMode ?? 'auto'}, ${shape.scheduledAt ?? null},
                      ${shape.publishedAt ?? null}, ${spec.originSiteId},
                      ${spec.originSiteScoped})`.execute(connection.db);
  });
  return id;
}

describe('#45 (B) 画面専用の 4 つの UseCase も、トークンの文脈では区画の中だけ', () => {
  let tokA: AuthorizationContext;

  /** q1・q2 は tokA の区画の中、q3〜q5 は外（設計 §5.2 の投稿の表）。 */
  function specs(): Record<'q1' | 'q2' | 'q3' | 'q4' | 'q5', RowSpec> {
    return {
      q1: { accountId: accA, originSiteId: null, originSiteScoped: false },
      q2: { accountId: accC, originSiteId: siteA, originSiteScoped: true },
      q3: { accountId: accC, originSiteId: null, originSiteScoped: false },
      q4: { accountId: accB, originSiteId: siteB, originSiteScoped: true },
      q5: { accountId: accC, originSiteId: siteB, originSiteScoped: true },
    };
  }

  async function insertAll(shape: Parameters<typeof insertPostRow>[1]): Promise<{
    readonly inside: string[];
    readonly all: string[];
  }> {
    const ids: Record<string, string> = {};
    for (const [label, spec] of Object.entries(specs())) {
      ids[label] = await insertPostRow(spec, shape);
    }
    return {
      inside: [ids['q1'] ?? '', ids['q2'] ?? ''].sort(),
      all: Object.values(ids).sort(),
    };
  }

  function idsOf(items: readonly SocialPost[]): string[] {
    return items.map((post) => post.id).sort();
  }

  beforeEach(async () => {
    tokA = await tokenContext(await issueToken(siteA));
  });

  describe('listSocialPostHistory（配信結果の確定した投稿）', () => {
    let rows: { readonly inside: string[]; readonly all: string[] };

    beforeEach(async () => {
      rows = await insertAll({ status: 'published', publishedAt: new Date() });
    });

    it('#45 tokA の文脈では区画の中だけ（total も）', async () => {
      const page = await listSocialPostHistory(tokA, { page: 1, perPage: 100, status: null });

      expect(idsOf(page.items)).toEqual(rows.inside);
      expect(page.total).toBe(2);
    });

    it('#45 セッションの文脈では全件（total も）', async () => {
      const page = await listSocialPostHistory(admin, { page: 1, perPage: 100, status: null });

      expect(idsOf(page.items)).toEqual(rows.all);
      expect(page.total).toBe(5);
    });
  });

  describe('listSocialPostsByIds（ID でまとめて引く）', () => {
    let rows: { readonly inside: string[]; readonly all: string[] };

    beforeEach(async () => {
      rows = await insertAll({ status: 'draft' });
    });

    it('#45 tokA の文脈では区画の中だけ', async () => {
      const found = await listSocialPostsByIds(tokA, { ids: rows.all });

      expect(idsOf(found)).toEqual(rows.inside);
    });

    it('#45 セッションの文脈では全件', async () => {
      const found = await listSocialPostsByIds(admin, { ids: rows.all });

      expect(idsOf(found)).toEqual(rows.all);
    });
  });

  describe('listApprovalPendingPosts（承認待ち）', () => {
    let rows: { readonly inside: string[]; readonly all: string[] };

    beforeEach(async () => {
      rows = await insertAll({ status: 'awaiting_approval' });
    });

    it('#45 tokA の文脈では区画の中だけ（total も）', async () => {
      const page = await listApprovalPendingPosts(tokA, { limit: 50 });

      expect(idsOf(page.items)).toEqual(rows.inside);
      expect(page.total).toBe(2);
    });

    it('#45 セッションの文脈では全件（total も）', async () => {
      const page = await listApprovalPendingPosts(admin, { limit: 50 });

      expect(idsOf(page.items)).toEqual(rows.all);
      expect(page.total).toBe(5);
    });
  });

  describe('listManualPendingPosts（手動投稿待ち）', () => {
    let rows: { readonly inside: string[]; readonly all: string[] };

    beforeEach(async () => {
      rows = await insertAll({
        status: 'scheduled',
        deliveryMode: 'manual',
        scheduledAt: new Date(Date.now() - 60 * 60_000),
      });
    });

    it('#45 tokA の文脈では区画の中だけ（total も）', async () => {
      const page = await listManualPendingPosts(tokA, { limit: 50 });

      expect(idsOf(page.items)).toEqual(rows.inside);
      expect(page.total).toBe(2);
    });

    it('#45 セッションの文脈では全件（total も）', async () => {
      const page = await listManualPendingPosts(admin, { limit: 50 });

      expect(idsOf(page.items)).toEqual(rows.all);
      expect(page.total).toBe(5);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #49 の前半 SiteGoneError                                                       */
/* -------------------------------------------------------------------------- */

describe('#49 (B) 失効した・サイトの消えたトークンを登録元にした挿入は SiteGoneError（設計 §8.3.1）', () => {
  function newPost(createdByTokenId: string): Parameters<typeof socialRepository.insertPost>[1] {
    return {
      id: uuidv7(),
      socialAccountId: accC,
      body: '登録の直前にトークンが使えなくなった投稿',
      scheduledAt: null,
      status: 'draft',
      createdByTokenId,
    };
  }

  it('#49 失効したサイトのトークンで insertPostIdempotent → SiteGoneError（行は増えない）', async () => {
    const token = await issueToken(siteA);
    await revokeTokenRow(token.id);

    const error = await rejectionOf(
      withConnection((connection) =>
        connection.transaction((tx) =>
          socialRepository.insertPostIdempotent(tx, newPost(token.id)),
        ),
      ),
    );

    await expectSiteGone(error);
    expect(await countPosts()).toBe(0);
  });

  it('#49 失効した共通のトークンで insertPostIdempotent → SiteGoneError（行は増えない）', async () => {
    const token = await issueToken(null);
    await revokeTokenRow(token.id);

    const error = await rejectionOf(
      withConnection((connection) =>
        connection.transaction((tx) =>
          socialRepository.insertPostIdempotent(tx, newPost(token.id)),
        ),
      ),
    );

    await expectSiteGone(error);
    expect(await countPosts()).toBe(0);
  });

  it('#49 サイトの消えたサイトのトークン（site_scoped で site_id が NULL）で insertPostIdempotent → SiteGoneError（行は増えない）', async () => {
    const token = await issueToken(siteA);
    await detachTokenSite(token.id);

    const error = await rejectionOf(
      withConnection((connection) =>
        connection.transaction((tx) =>
          socialRepository.insertPostIdempotent(tx, newPost(token.id)),
        ),
      ),
    );

    await expectSiteGone(error);
    expect(await countPosts()).toBe(0);
  });

  it('#49 失効したトークンで insertPost → SiteGoneError（行は増えない）', async () => {
    const token = await issueToken(siteA);
    await revokeTokenRow(token.id);

    const error = await rejectionOf(
      withConnection((connection) =>
        connection.transaction((tx) => socialRepository.insertPost(tx, newPost(token.id))),
      ),
    );

    await expectSiteGone(error);
    expect(await countPosts()).toBe(0);
  });

  it('#49 使えるサイトのトークンなら挿入でき、origin_* はトークンの行の値（A / true）', async () => {
    const token = await issueToken(siteA);

    const { post } = await withConnection((connection) =>
      connection.transaction((tx) => socialRepository.insertPostIdempotent(tx, newPost(token.id))),
    );

    const facts = await scopeFactsOf(post.id);
    expect(facts.origin_site_id).toBe(siteA);
    expect(facts.origin_site_scoped).toBe(true);
  });

  it('#49 文脈を作った後にトークンを失効させると、createSocialPost は SiteGoneError（行は増えない）', async () => {
    const token = await issueToken(siteA);
    const context = await tokenContext(token);
    await revokeTokenRow(token.id);

    const error = await rejectionOf(createPostAs(context, accC));

    await expectSiteGone(error);
    expect(await countPosts()).toBe(0);
  });

  it('#49 文脈を作った後にサイトが消えた形になると、createSocialPost は SiteGoneError（行は増えない）', async () => {
    const token = await issueToken(siteA);
    const context = await tokenContext(token);
    await detachTokenSite(token.id);

    const error = await rejectionOf(createPostAs(context, accC));

    await expectSiteGone(error);
    expect(await countPosts()).toBe(0);
  });

  it('#49 ルートでは 401 UNAUTHENTICATED（文脈を作った直後にトークンを失効させる。行は増えない）', async () => {
    const token = await issueToken(siteA);
    // 文脈を作る最後の書き込み（最終利用時刻）の後で失効させ、登録と失効が同時に進んだ窓を作る。
    const originalTouch = apiTokenRepository.touch.bind(apiTokenRepository);
    vi.spyOn(apiTokenRepository, 'touch').mockImplementation(async (...args) => {
      await originalTouch(...args);
      await revokeTokenRow(token.id);
    });

    const response = await createSocialPostRoute(
      new Request('http://127.0.0.1:3000/api/v1/social/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token.plaintext}` },
        body: JSON.stringify({ socialAccountId: accC, body: '窓を通る投稿です。' }),
      }),
    );
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe('UNAUTHENTICATED');
    expect(await countPosts()).toBe(0);
  });
});
