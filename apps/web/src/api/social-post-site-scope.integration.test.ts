import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createApiTokenRoute } from '@/app/api/v1/api-tokens/route';
import {
  GET as getSocialAccountRoute,
  PATCH as updateSocialAccountRoute,
} from '@/app/api/v1/social/accounts/[id]/route';
import { GET as listSocialAccountsRoute } from '@/app/api/v1/social/accounts/route';
import { POST as approveSocialPostRoute } from '@/app/api/v1/social/posts/[id]/approve/route';
import {
  DELETE as deleteSocialPostRoute,
  GET as getSocialPostRoute,
  PATCH as updateSocialPostRoute,
} from '@/app/api/v1/social/posts/[id]/route';
import {
  GET as listSocialPostsRoute,
  POST as createSocialPostRoute,
} from '@/app/api/v1/social/posts/route';
import { login } from '@/application/auth/login';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * SNS 投稿の区画（053-site-scoped-social 設計 §5.2・§7.3・§8.3・§8.7）。
 *
 * 受け入れ条件 #34〜#40・#42・#43・#55（#37 は DB の `origin_*` を SQL で読む B）。
 *
 * **ルートを直接叩く結合テスト**（`social-post-approve.integration.test.ts` の叩き方を写す）。
 * 共通の準備（設計 §13 の前書き）：サイト A・B（`active`）、アカウント `accA`（A 専用）・`accB`（B 専用）・
 * `accC`（共通）、トークン `tokA`（サイト A）・`tokB`（サイト B）・`tokCommon`（共通）。Scope はどれも SNS の 4 つで、
 * 所有者は管理者。トークンは `POST /api-tokens` で発行する（実装プラン §2 のテストの方法）。
 * アカウントは SQL で入れる（作成の振る舞いは G4 の `social-account-site.integration.test.ts` が見る）。
 *
 * provider は配信 Plugin が登録されない名前にする（`ensurePluginsStartedAnonymously` が同梱の Plugin を
 * 起こしても、その検査に掛からない。下書き・承認待ちは publisher が無くても登録できる）。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-post-site-scope';
const PASSWORD = 'social post site scope correct horse battery staple';
const PROVIDER = 'scope_none';

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 設計 §8.3.1 の文言。 */
const MESSAGE_ACCOUNT_NOT_FOUND = 'SNSアカウントが見つかりません。';
const MESSAGE_EXTERNAL_REF_USED =
  'この externalRef は既に使われています。別の externalRef で登録してください。';

let scratch: ScratchDatabase;
let adminSession: string;
let siteA: string;
let siteB: string;
let tokA: string;
let tokB: string;
let tokCommon: string;
let accA: string;
let accB: string;
let accC: string;
/** 要求ごとに変える送信元 IP の連番（`POST /api-tokens` の Rate Limit を避ける）。 */
let ipSequence = 0;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

type Auth = { readonly token: string } | { readonly session: string };

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
}

function errorOf(result: JsonResult): {
  readonly code?: string;
  readonly details?: Record<string, readonly string[]>;
} {
  return (result.body['error'] ?? {}) as {
    readonly code?: string;
    readonly details?: Record<string, readonly string[]>;
  };
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  return errorOf(result).details ?? {};
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function nextIp(): string {
  ipSequence += 1;
  return `10.55.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function headersFor(auth: Auth): Record<string, string> {
  if ('token' in auth) {
    return { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };
  }
  return {
    'content-type': 'application/json',
    'x-forwarded-host': '127.0.0.1:3000',
    'x-forwarded-for': nextIp(),
    origin: ORIGIN,
    cookie: `torifune_session=${auth.session}; torifune_csrf=${CSRF}`,
    'x-csrf-token': CSRF,
  };
}

async function createUser(roleNames: readonly string[]): Promise<string> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `q${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social post site scope test',
        password_hash: passwordHash,
      })
      .execute();

    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) throw new Error(`ロールが無い: ${roleName}`);
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: id, role_id: role.id })
        .execute();
    }
  });
  return loginId;
}

async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: nextIp(), userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

async function insertSite(name: string): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO sites (id, name, url)
              VALUES (${id}, ${name}, 'https://example.com/')`.execute(connection.db);
  });
  return id;
}

/** 管理者のセッションで `POST /api-tokens` を叩き、平文を返す。 */
async function issueToken(siteId: string | null): Promise<string> {
  const response = await createApiTokenRoute(
    new Request(`${API}/api-tokens`, {
      method: 'POST',
      headers: headersFor({ session: adminSession }),
      body: JSON.stringify({ name: `t-${uuidv7().slice(-8)}`, scopes: SNS_SCOPES, siteId }),
    }),
  );
  const result = await toResult(response);
  if (result.status !== 201) {
    throw new Error(`トークンを発行できない: ${JSON.stringify(result.body)}`);
  }
  return String(dataOf(result)['token']);
}

/** アカウントを SQL で入れる（準備。作成の API に頼らない）。 */
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

interface PostRow {
  readonly body: string;
  readonly status: string;
  readonly origin_site_id: string | null;
  readonly origin_site_scoped: boolean;
}

async function postRow(id: string): Promise<PostRow | undefined> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`SELECT body, status, origin_site_id, origin_site_scoped
                                        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    return result.rows[0];
  });
}

async function countPosts(): Promise<number> {
  return withConnection(async (connection) => {
    const result = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM social_posts`.execute(connection.db);
    return Number(result.rows[0]?.count ?? '0');
  });
}

/* ------------------------------- ルートの呼び出し ------------------------------- */

async function callCreatePost(auth: Auth, body: Record<string, unknown>): Promise<JsonResult> {
  return toResult(
    await createSocialPostRoute(
      new Request(`${API}/social/posts`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify({ body: '区画のテストの投稿です。', ...body }),
      }),
    ),
  );
}

async function callListPosts(auth: Auth, query = ''): Promise<JsonResult> {
  return toResult(
    await listSocialPostsRoute(
      new Request(`${API}/social/posts${query}`, { headers: headersFor(auth) }),
    ),
  );
}

async function callGetPost(auth: Auth, id: string): Promise<JsonResult> {
  return toResult(
    await getSocialPostRoute(
      new Request(`${API}/social/posts/${id}`, { headers: headersFor(auth) }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callUpdatePost(
  auth: Auth,
  id: string,
  body: Record<string, unknown>,
): Promise<JsonResult> {
  return toResult(
    await updateSocialPostRoute(
      new Request(`${API}/social/posts/${id}`, {
        method: 'PATCH',
        headers: headersFor(auth),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callDeletePost(auth: Auth, id: string): Promise<JsonResult> {
  return toResult(
    await deleteSocialPostRoute(
      new Request(`${API}/social/posts/${id}`, {
        method: 'DELETE',
        headers: headersFor(auth),
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callApprove(
  auth: Auth,
  id: string,
  body: Record<string, unknown>,
): Promise<JsonResult> {
  return toResult(
    await approveSocialPostRoute(
      new Request(`${API}/social/posts/${id}/approve`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callListAccounts(auth: Auth): Promise<JsonResult> {
  return toResult(
    await listSocialAccountsRoute(
      new Request(`${API}/social/accounts`, { headers: headersFor(auth) }),
    ),
  );
}

async function callGetAccount(auth: Auth, id: string): Promise<JsonResult> {
  return toResult(
    await getSocialAccountRoute(
      new Request(`${API}/social/accounts/${id}`, { headers: headersFor(auth) }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

/** セッション（画面）でアカウントのサイトを付け替える。 */
async function moveAccount(id: string, siteId: string | null): Promise<void> {
  const result = await toResult(
    await updateSocialAccountRoute(
      new Request(`${API}/social/accounts/${id}`, {
        method: 'PATCH',
        headers: headersFor({ session: adminSession }),
        body: JSON.stringify({ siteId }),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
  if (result.status !== 200) {
    throw new Error(`アカウントを付け替えられない: ${JSON.stringify(result.body)}`);
  }
}

/** 投稿を登録して 201 を確かめ、ID を返す。 */
async function createPost(
  auth: Auth,
  socialAccountId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await callCreatePost(auth, { socialAccountId, ...extra });
  if (result.status !== 201) {
    throw new Error(`投稿を登録できない: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return String(dataOf(result)['id']);
}

function idsOf(result: JsonResult): string[] {
  return (result.body['data'] as Record<string, unknown>[])
    .map((item) => String(item['id']))
    .sort();
}

function totalOf(result: JsonResult): unknown {
  return (result.body['meta'] as Record<string, unknown> | undefined)?.['total'];
}

/* ------------------------------- p1〜p7 の準備 ------------------------------- */

type PostName = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7';
type Posts = Readonly<Record<PostName, string>>;

const POST_NAMES: readonly PostName[] = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];

/** 設計 §13 の #36 の 7 件。 */
async function makeSevenPosts(): Promise<Posts> {
  const session = { session: adminSession };
  return {
    p1: await createPost({ token: tokA }, accA),
    p2: await createPost(session, accA),
    p3: await createPost({ token: tokA }, accC),
    p4: await createPost({ token: tokCommon }, accC),
    p5: await createPost(session, accC),
    p6: await createPost({ token: tokB }, accB),
    p7: await createPost({ token: tokB }, accC),
  };
}

type ContextName = 'session' | 'tokA' | 'tokB' | 'tokCommon';

/** 設計 §5.2 の投稿の表を p1〜p7 に当てたもの（#36）。 */
const VISIBLE: Readonly<Record<ContextName, readonly PostName[]>> = {
  session: POST_NAMES,
  tokA: ['p1', 'p2', 'p3'],
  tokB: ['p6', 'p7'],
  tokCommon: ['p4', 'p5'],
};

function authOf(name: ContextName): Auth {
  switch (name) {
    case 'session':
      return { session: adminSession };
    case 'tokA':
      return { token: tokA };
    case 'tokB':
      return { token: tokB };
    case 'tokCommon':
      return { token: tokCommon };
  }
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostsitescope');
  adminSession = await issueSessionToken(await createUser(['administrator']));
  siteA = await insertSite('サイト A');
  siteB = await insertSite('サイト B');
  tokA = await issueToken(siteA);
  tokB = await issueToken(siteB);
  tokCommon = await issueToken(null);
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  accA = await insertAccount('A のアカウント', siteA);
  accB = await insertAccount('B のアカウント', siteB);
  accC = await insertAccount('共通のアカウント', null);
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #34 サイトのトークンの登録                                                       */
/* -------------------------------------------------------------------------- */

describe('#34 tokA の POST /social/posts', () => {
  it('#34 accA（A 専用）→ 201', async () => {
    const result = await callCreatePost({ token: tokA }, { socialAccountId: accA });

    expect(result.status).toBe(201);
  });

  it('#34 accC（共通）→ 201', async () => {
    const result = await callCreatePost({ token: tokA }, { socialAccountId: accC });

    expect(result.status).toBe(201);
  });

  it('#34 accB（B 専用）→ 422 socialAccountId「SNSアカウントが見つかりません。」（行は増えない）', async () => {
    const result = await callCreatePost({ token: tokA }, { socialAccountId: accB });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['socialAccountId']).toEqual([MESSAGE_ACCOUNT_NOT_FOUND]);
    expect(await countPosts()).toBe(0);
  });

  it('#34 accB の 422 の details は存在しない UUID のときと同じ', async () => {
    const outside = await callCreatePost({ token: tokA }, { socialAccountId: accB });
    const missing = await callCreatePost({ token: tokA }, { socialAccountId: uuidv7() });

    expect(missing.status).toBe(422);
    expect(detailsOf(outside)).toEqual(detailsOf(missing));
  });
});

/* -------------------------------------------------------------------------- */
/* #35 共通のトークン・セッションの登録                                               */
/* -------------------------------------------------------------------------- */

describe('#35 tokCommon とセッションの POST /social/posts', () => {
  it('#35 tokCommon で accA（サイト専用）→ 422 socialAccountId（裁定 4。行は増えない）', async () => {
    const result = await callCreatePost({ token: tokCommon }, { socialAccountId: accA });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['socialAccountId']).toEqual([MESSAGE_ACCOUNT_NOT_FOUND]);
    expect(await countPosts()).toBe(0);
  });

  it('#35 tokCommon で accA の 422 の details は存在しない UUID のときと同じ', async () => {
    const outside = await callCreatePost({ token: tokCommon }, { socialAccountId: accA });
    const missing = await callCreatePost({ token: tokCommon }, { socialAccountId: uuidv7() });

    expect(detailsOf(outside)).toEqual(detailsOf(missing));
  });

  it('#35 tokCommon で accC（共通）→ 201', async () => {
    const result = await callCreatePost({ token: tokCommon }, { socialAccountId: accC });

    expect(result.status).toBe(201);
  });

  it.each(['accA', 'accB', 'accC'] as const)(
    '#35 セッションで %s → 201（画面は区画で絞らない）',
    async (name) => {
      const id = { accA, accB, accC }[name];

      const result = await callCreatePost({ session: adminSession }, { socialAccountId: id });

      expect(result.status).toBe(201);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #36 p1〜p7 の一覧・取得                                                        */
/* -------------------------------------------------------------------------- */

describe('#36 区画の表（設計 §5.2）を投稿で固定する', () => {
  let posts: Posts;

  beforeEach(async () => {
    posts = await makeSevenPosts();
  });

  it.each(['session', 'tokA', 'tokB', 'tokCommon'] as const)(
    '#36 %s の GET /social/posts は見える投稿だけ（meta.total も同じ）',
    async (name) => {
      const result = await callListPosts(authOf(name), '?perPage=100');
      const expected = VISIBLE[name].map((post) => posts[post]).sort();

      expect(result.status).toBe(200);
      expect(idsOf(result)).toEqual(expected);
      expect(totalOf(result)).toBe(expected.length);
    },
  );

  it.each(['session', 'tokA', 'tokB', 'tokCommon'] as const)(
    '#36 %s の GET /social/posts/{id} は見えないものがすべて 404、見えるものは 200',
    async (name) => {
      const statuses: Record<string, number> = {};
      for (const post of POST_NAMES) {
        statuses[post] = (await callGetPost(authOf(name), posts[post])).status;
      }

      const expected = Object.fromEntries(
        POST_NAMES.map((post) => [post, VISIBLE[name].includes(post) ? 200 : 404]),
      );
      expect(statuses).toEqual(expected);
    },
  );

  it('#36 区画の外の 404 の本文は存在しない UUID のときと同じ（tokA で p4）', async () => {
    const outside = await callGetPost({ token: tokA }, posts.p4);
    const missing = await callGetPost({ token: tokA }, uuidv7());

    expect(missing.status).toBe(404);
    expect(outside.body).toEqual(missing.body);
  });

  it('#36 区画の外の 404 の本文は存在しない UUID のときと同じ（tokCommon で p1）', async () => {
    const outside = await callGetPost({ token: tokCommon }, posts.p1);
    const missing = await callGetPost({ token: tokCommon }, uuidv7());

    expect(outside.body).toEqual(missing.body);
  });
});

/* -------------------------------------------------------------------------- */
/* #37 登録した投稿の origin_*                                                     */
/* -------------------------------------------------------------------------- */

describe('#37 (B) 登録した投稿の origin_site_id / origin_site_scoped（設計 §7.3）', () => {
  it('#37 tokA が登録 → origin_site_id = A・origin_site_scoped = true', async () => {
    const id = await createPost({ token: tokA }, accC);

    const row = await postRow(id);

    expect(row?.origin_site_id).toBe(siteA);
    expect(row?.origin_site_scoped).toBe(true);
  });

  it('#37 tokA がサイト専用のアカウントへ登録しても origin_* はトークンの区画（A / true）', async () => {
    const id = await createPost({ token: tokA }, accA);

    const row = await postRow(id);

    expect(row?.origin_site_id).toBe(siteA);
    expect(row?.origin_site_scoped).toBe(true);
  });

  it('#37 tokCommon が登録 → origin_site_id = NULL・origin_site_scoped = false', async () => {
    const id = await createPost({ token: tokCommon }, accC);

    const row = await postRow(id);

    expect(row?.origin_site_id).toBeNull();
    expect(row?.origin_site_scoped).toBe(false);
  });

  it('#37 セッションが登録 → origin_site_id = NULL・origin_site_scoped = false', async () => {
    const id = await createPost({ session: adminSession }, accC);

    const row = await postRow(id);

    expect(row?.origin_site_id).toBeNull();
    expect(row?.origin_site_scoped).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #38 更新                                                                      */
/* -------------------------------------------------------------------------- */

describe('#38 PATCH /social/posts/{id}（body）', () => {
  let posts: Posts;

  beforeEach(async () => {
    posts = await makeSevenPosts();
  });

  it.each(['p4', 'p6'] as const)(
    '#38 tokA で区画の外の %s → 404（行は変わらない）',
    async (name) => {
      const result = await callUpdatePost({ token: tokA }, posts[name], { body: '書き換えた' });

      expect(result.status).toBe(404);
      expect((await postRow(posts[name]))?.body).toBe('区画のテストの投稿です。');
    },
  );

  it('#38 tokA で区画の中の p2（A 専用・セッションが登録）→ 200', async () => {
    const result = await callUpdatePost({ token: tokA }, posts.p2, { body: '書き換えた' });

    expect(result.status).toBe(200);
    expect((await postRow(posts.p2))?.body).toBe('書き換えた');
  });
});

/* -------------------------------------------------------------------------- */
/* #39 削除・承認                                                                 */
/* -------------------------------------------------------------------------- */

describe('#39 DELETE /social/posts/{id}', () => {
  let posts: Posts;

  beforeEach(async () => {
    posts = await makeSevenPosts();
  });

  it('#39 tokA で区画の外の p4 → 404（行は残る）', async () => {
    const result = await callDeletePost({ token: tokA }, posts.p4);

    expect(result.status).toBe(404);
    expect(await postRow(posts.p4)).toBeDefined();
  });

  it('#39 tokCommon で区画の外の p1 → 404（行は残る）', async () => {
    const result = await callDeletePost({ token: tokCommon }, posts.p1);

    expect(result.status).toBe(404);
    expect(await postRow(posts.p1)).toBeDefined();
  });

  it('#39 tokA で区画の中の p3 → 204（行が消える）', async () => {
    const result = await callDeletePost({ token: tokA }, posts.p3);

    expect(result.status).toBe(204);
    expect(await postRow(posts.p3)).toBeUndefined();
  });
});

describe('#39 POST /social/posts/{id}/approve（承認待ちの投稿）', () => {
  /** セッションで承認待ちの投稿を作り、`updatedAt` を添えて返す。 */
  async function makeAwaiting(accountId: string): Promise<{ id: string; updatedAt: string }> {
    const id = await createPost({ session: adminSession }, accountId, {
      publishTiming: 'after_approval',
    });
    const read = await callGetPost({ session: adminSession }, id);
    return { id, updatedAt: String(dataOf(read)['updatedAt']) };
  }

  it('#39 tokA で区画の外（accB の承認待ち）→ 404（承認待ちのまま）', async () => {
    const outside = await makeAwaiting(accB);

    const result = await callApprove({ token: tokA }, outside.id, {
      publishTiming: 'now',
      expectedUpdatedAt: outside.updatedAt,
    });

    expect(result.status).toBe(404);
    expect((await postRow(outside.id))?.status).toBe('awaiting_approval');
  });

  it('#39 tokA で区画の中（accA の承認待ち）→ 200', async () => {
    const inside = await makeAwaiting(accA);

    const result = await callApprove({ token: tokA }, inside.id, {
      publishTiming: 'now',
      expectedUpdatedAt: inside.updatedAt,
    });

    expect(result.status).toBe(200);
    expect((await postRow(inside.id))?.status).toBe('scheduled');
  });
});

/* -------------------------------------------------------------------------- */
/* #40 一覧の絞り込みは区画の中                                                     */
/* -------------------------------------------------------------------------- */

describe('#40 GET /social/posts の絞り込みは区画の中で掛かる', () => {
  let posts: Posts;

  beforeEach(async () => {
    posts = await makeSevenPosts();
  });

  it('#40 tokA で ?accountId=<accC> → p3 だけ（p4・p5・p7 は区画の外）', async () => {
    const result = await callListPosts({ token: tokA }, `?accountId=${accC}`);

    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual([posts.p3]);
    expect(totalOf(result)).toBe(1);
  });

  it('#40 tokA で ?accountId=<accB>（区画の外のアカウント）→ 200・空・meta.total: 0', async () => {
    const result = await callListPosts({ token: tokA }, `?accountId=${accB}`);

    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual([]);
    expect(totalOf(result)).toBe(0);
  });

  it('#40 tokA で ?status=awaiting_approval も区画の中だけ', async () => {
    const inside = await createPost({ session: adminSession }, accA, {
      publishTiming: 'after_approval',
    });
    await createPost({ session: adminSession }, accB, { publishTiming: 'after_approval' });

    const result = await callListPosts({ token: tokA }, '?status=awaiting_approval');

    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual([inside]);
    expect(totalOf(result)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #42 付け替えの後の冪等の再送                                                     */
/* -------------------------------------------------------------------------- */

describe('#42 冪等の再送で区画の外の既存を見せない（設計 §8.3.1）', () => {
  it('#42 accC を B へ付け替えた後の同じ要求の再送 → 422 socialAccountId（行は増えない）', async () => {
    const first = await callCreatePost(
      { token: tokA },
      { socialAccountId: accC, externalRef: 'r-42' },
    );
    expect(first.status).toBe(201);
    await moveAccount(accC, siteB);

    const replay = await callCreatePost(
      { token: tokA },
      { socialAccountId: accC, externalRef: 'r-42' },
    );

    expect(replay.status).toBe(422);
    expect(detailsOf(replay)['socialAccountId']).toEqual([MESSAGE_ACCOUNT_NOT_FOUND]);
    expect(await countPosts()).toBe(1);
  });

  it('#42 accA へ同じ externalRef で送る → 422 externalRef「この externalRef は既に使われています。…」（行は増えない）', async () => {
    const first = await callCreatePost(
      { token: tokA },
      { socialAccountId: accC, externalRef: 'r-42' },
    );
    expect(first.status).toBe(201);
    await moveAccount(accC, siteB);

    const other = await callCreatePost(
      { token: tokA },
      { socialAccountId: accA, externalRef: 'r-42' },
    );

    expect(other.status).toBe(422);
    expect(detailsOf(other)['externalRef']).toEqual([MESSAGE_EXTERNAL_REF_USED]);
    expect(await countPosts()).toBe(1);
  });

  it('#42 付け替えていなければ再送は今までどおり 200 で既存を返す（前提の確認）', async () => {
    const first = await callCreatePost(
      { token: tokA },
      { socialAccountId: accC, externalRef: 'r-42' },
    );

    const replay = await callCreatePost(
      { token: tokA },
      { socialAccountId: accC, externalRef: 'r-42' },
    );

    expect(replay.status).toBe(200);
    expect(dataOf(replay)['id']).toBe(dataOf(first)['id']);
  });
});

/* -------------------------------------------------------------------------- */
/* #43 付け替えで投稿が移る                                                        */
/* -------------------------------------------------------------------------- */

describe('#43 アカウントの付け替えで投稿が付け替え先の区画へ移る（設計 §7.3）', () => {
  it('#43 accC の p4（tokCommon が登録）は accC を A に付け替えた後、tokA から見える', async () => {
    const p4 = await createPost({ token: tokCommon }, accC);
    await moveAccount(accC, siteA);

    expect((await callGetPost({ token: tokA }, p4)).status).toBe(200);
  });

  it('#43 付け替えた後の p4 は tokCommon から 404', async () => {
    const p4 = await createPost({ token: tokCommon }, accC);
    await moveAccount(accC, siteA);

    expect((await callGetPost({ token: tokCommon }, p4)).status).toBe(404);
  });

  it('#43 付け替える前の p4 は tokA から 404（前提の確認）', async () => {
    const p4 = await createPost({ token: tokCommon }, accC);

    expect((await callGetPost({ token: tokA }, p4)).status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* #55 共通のトークンの既存の操作                                                   */
/* -------------------------------------------------------------------------- */

describe('#55 共通のトークンの裁定前からの操作は今までどおり（裁定 4）', () => {
  let posts: Posts;

  beforeEach(async () => {
    posts = await makeSevenPosts();
  });

  it('#55 tokCommon で accC への登録 → 201', async () => {
    const result = await callCreatePost({ token: tokCommon }, { socialAccountId: accC });

    expect(result.status).toBe(201);
  });

  it('#55 tokCommon で p4 の取得 → 200', async () => {
    expect((await callGetPost({ token: tokCommon }, posts.p4)).status).toBe(200);
  });

  it('#55 tokCommon で p4 の更新 → 200', async () => {
    const result = await callUpdatePost({ token: tokCommon }, posts.p4, { body: '書き換えた' });

    expect(result.status).toBe(200);
    expect((await postRow(posts.p4))?.body).toBe('書き換えた');
  });

  it('#55 tokCommon で GET /social/accounts → 200（accC を含む）', async () => {
    const result = await callListAccounts({ token: tokCommon });

    expect(result.status).toBe(200);
    expect(idsOf(result)).toContain(accC);
  });

  it('#55 tokCommon で共通のアカウントの取得 → 200', async () => {
    expect((await callGetAccount({ token: tokCommon }, accC)).status).toBe(200);
  });

  it('#55 判別力：同じ tokCommon でもサイトの区画の p1（A のトークンが A 専用へ登録）は 404', async () => {
    expect((await callGetPost({ token: tokCommon }, posts.p1)).status).toBe(404);
  });
});
