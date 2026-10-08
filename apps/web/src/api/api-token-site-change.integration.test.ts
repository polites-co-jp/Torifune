import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createApiTokenRoute } from '@/app/api/v1/api-tokens/route';
import { DELETE as deleteSiteRoute } from '@/app/api/v1/sites/[id]/route';
import { GET as getSocialAccountRoute } from '@/app/api/v1/social/accounts/[id]/route';
import {
  GET as listSocialAccountsRoute,
  POST as createSocialAccountRoute,
} from '@/app/api/v1/social/accounts/route';
import { GET as getSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { login } from '@/application/auth/login';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * トークンのサイトの変更 `PATCH /api-tokens/{id}`（053-site-scoped-social 設計 §8.5.6・§8.5.7・ユーザー裁定 7・10）。
 *
 * 受け入れ条件 #81〜#88・#90（#89 の同時実行は `api-token-site-change-concurrency.integration.test.ts`）。
 *
 * * セッションだけ・`token.manage`・自分のトークンだけ。他人のもの・存在しない・UUID の形でない ID は 404（#85）
 * * 変更の向きはすべて許す。共通 → サイトで SNS 以外の Scope があれば、同じ要求で狭めなければ 422 `scopes`（#83）
 * * 変更と同じトランザクションで、そのトークンが登録した投稿の `origin_*` を変更後の値に書き換える（裁定 10。#86・#88）
 * * 冪等キーはトークンの名前空間のまま。変更の後の再送は「200 で既存」「422 socialAccountId」「422 externalRef」（#87）
 * * 監査 `updated`・`api_token`・`{ siteId, previousSiteId, scopes, removedScopes, movedPosts }`（#90）
 *
 * **ルートを直接叩く結合テスト**（`social-account-site.integration.test.ts` の叩き方を写す）。
 * トークンは `POST /api-tokens` で発行し、アカウントは SQL で入れる（実装プラン §2 のテストの方法）。
 * `PATCH` はまだ無いので、呼ぶ直前に動的に読む（実装プラン §2。未実装の段階でファイル全体が読めなくならないため）。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-api-token-site-change';
const PASSWORD = 'api token site change correct horse battery staple';
const PROVIDER = 'scope_none';

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 設計 §8.5.6 の表の文言。 */
const MESSAGE_REVOKED = '失効したトークンは変えられません。';
const MESSAGE_WIDEN_PREFIX = '権限を広げることはできません: ';
const MESSAGE_SITE_NOT_FOUND = 'Webサイトが見つかりません。';
const MESSAGE_ARCHIVED = 'アーカイブしたサイトにはトークンを紐づけられません。';
const MESSAGE_SNS_ONLY_PREFIX =
  'サイトに紐づけるトークンには SNS の権限だけを指定できます。外す権限を scopes で指定し直してください: ';
/** 設計 §8.3.1 の文言。 */
const MESSAGE_ACCOUNT_NOT_FOUND = 'SNSアカウントが見つかりません。';
const MESSAGE_EXTERNAL_REF_USED =
  'この externalRef は既に使われています。別の externalRef で登録してください。';

let scratch: ScratchDatabase;
let adminSession: string;
let otherAdminSession: string;
let editorSession: string;
let siteA: string;
let siteB: string;
let archivedSite: string;
let tokA: IssuedToken;
let tokB: IssuedToken;
let tokCommon: IssuedToken;
let accA: string;
let accB: string;
let accC: string;
/** 要求ごとに変える送信元 IP の連番（`POST /api-tokens` の Rate Limit を避ける）。 */
let ipSequence = 0;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface IssuedToken {
  readonly id: string;
  readonly plaintext: string;
}

type Auth =
  | { readonly kind: 'session'; readonly session: string }
  | { readonly kind: 'token'; readonly token: string }
  | { readonly kind: 'none' };

type RouteHandler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

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
  return `10.58.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function headersFor(auth: Auth): Record<string, string> {
  if (auth.kind === 'token') {
    return { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` };
  }
  if (auth.kind === 'none') {
    return { 'content-type': 'application/json' };
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

function admin(): Auth {
  return { kind: 'session', session: adminSession };
}

function bearer(token: IssuedToken): Auth {
  return { kind: 'token', token: token.plaintext };
}

async function createUser(roleNames: readonly string[]): Promise<string> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `h${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'api token site change test',
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

async function insertSite(name: string, status: 'active' | 'archived' = 'active'): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO sites (id, name, url, status)
              VALUES (${id}, ${name}, 'https://example.com/', ${status})`.execute(connection.db);
  });
  return id;
}

async function setSiteStatus(id: string, status: 'active' | 'archived'): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE sites SET status = ${status} WHERE id = ${id}`.execute(connection.db);
  });
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

/** `POST /api-tokens` をセッションで叩く。 */
async function issueToken(
  siteId: string | null,
  scopes: readonly string[] = SNS_SCOPES,
  session = adminSession,
): Promise<IssuedToken> {
  const result = await toResult(
    await createApiTokenRoute(
      new Request(`${API}/api-tokens`, {
        method: 'POST',
        headers: headersFor({ kind: 'session', session }),
        body: JSON.stringify({ name: `t-${uuidv7().slice(-8)}`, scopes, siteId }),
      }),
    ),
  );
  if (result.status !== 201) {
    throw new Error(`トークンを発行できない: ${JSON.stringify(result.body)}`);
  }
  return { id: String(dataOf(result)['id']), plaintext: String(dataOf(result)['token']) };
}

/** `PATCH /api-tokens/{id}`（動的に読む。冒頭の注記）。 */
async function callChange(id: string, body: unknown, auth: Auth = admin()): Promise<JsonResult> {
  const module = (await import('@/app/api/v1/api-tokens/[id]/route')) as unknown as {
    readonly PATCH?: RouteHandler;
  };
  if (module.PATCH === undefined) {
    throw new Error('app/api/v1/api-tokens/[id]/route.ts に PATCH が無い');
  }
  return toResult(
    await module.PATCH(
      new Request(`${API}/api-tokens/${id}`, {
        method: 'PATCH',
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

async function callCreateAccount(auth: Auth): Promise<JsonResult> {
  return toResult(
    await createSocialAccountRoute(
      new Request(`${API}/social/accounts`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify({ provider: PROVIDER, displayName: 'トークンが作ったアカウント' }),
      }),
    ),
  );
}

async function callCreatePost(
  auth: Auth,
  socialAccountId: string,
  externalRef: string,
): Promise<JsonResult> {
  return toResult(
    await createSocialPostRoute(
      new Request(`${API}/social/posts`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify({ socialAccountId, body: '変更のテストの投稿です。', externalRef }),
      }),
    ),
  );
}

async function createPost(
  token: IssuedToken,
  socialAccountId: string,
  externalRef: string,
): Promise<string> {
  const result = await callCreatePost(bearer(token), socialAccountId, externalRef);
  if (result.status !== 201) {
    throw new Error(`投稿を登録できない: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return String(dataOf(result)['id']);
}

async function getPostStatus(token: IssuedToken, id: string): Promise<number> {
  const response = await getSocialPostRoute(
    new Request(`${API}/social/posts/${id}`, { headers: headersFor(bearer(token)) }),
    { params: Promise.resolve({ id }) },
  );
  return response.status;
}

async function callDeleteSite(id: string): Promise<number> {
  const response = await deleteSiteRoute(
    new Request(`${API}/sites/${id}`, {
      method: 'DELETE',
      headers: headersFor(admin()),
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id }) },
  );
  return response.status;
}

function idsOf(result: JsonResult): string[] {
  return (result.body['data'] as Record<string, unknown>[])
    .map((item) => String(item['id']))
    .sort();
}

interface TokenRow {
  readonly site_id: string | null;
  readonly site_scoped: boolean;
  readonly scopes: string[];
  readonly revoked_at: Date | null;
  readonly token_hash: string;
  readonly prefix: string;
}

async function tokenRow(id: string): Promise<TokenRow> {
  return withConnection(async (connection) => {
    const result = await sql<TokenRow>`SELECT site_id, site_scoped, scopes, revoked_at, token_hash,
                                              prefix
                                         FROM api_tokens WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`トークンが無い: ${id}`);
    return row;
  });
}

async function revokeTokenRow(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${id}`.execute(connection.db);
  });
}

interface OriginRow {
  readonly origin_site_id: string | null;
  readonly origin_site_scoped: boolean;
}

async function originOf(postId: string): Promise<OriginRow | undefined> {
  return withConnection(async (connection) => {
    const result = await sql<OriginRow>`SELECT origin_site_id, origin_site_scoped
                                          FROM social_posts WHERE id = ${postId}`.execute(
      connection.db,
    );
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

interface AuditRow {
  readonly resource_id: string | null;
  readonly detail: Record<string, unknown>;
}

async function tokenUpdatedAudits(): Promise<AuditRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<AuditRow>`SELECT resource_id, detail FROM audit_logs
                                        WHERE resource_type = 'api_token'
                                          AND action = 'updated'`.execute(connection.db);
    return result.rows;
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('apitokensitechange');
  adminSession = await issueSessionToken(await createUser(['administrator']));
  otherAdminSession = await issueSessionToken(await createUser(['administrator']));
  editorSession = await issueSessionToken(await createUser(['editor']));
  siteA = await insertSite('サイト A');
  siteB = await insertSite('サイト B');
  archivedSite = await insertSite('アーカイブしたサイト', 'archived');
});

afterAll(async () => {
  resetEventHandlers();
  await scratch.dispose();
});

beforeEach(async () => {
  tokA = await issueToken(siteA);
  tokB = await issueToken(siteB);
  tokCommon = await issueToken(null);
  accA = await insertAccount('A のアカウント', siteA);
  accB = await insertAccount('B のアカウント', siteB);
  accC = await insertAccount('共通のアカウント', null);
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
  await setSiteStatus(siteA, 'active');
});

/* -------------------------------------------------------------------------- */
/* #81 サイト A → サイト B                                                         */
/* -------------------------------------------------------------------------- */

describe('#81 管理者のセッションで PATCH /api-tokens/{tokA} に { siteId: B }', () => {
  it('#81 200、応答に siteId: B・siteScoped: true', async () => {
    const result = await callChange(tokA.id, { siteId: siteB });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBe(siteB);
    expect(dataOf(result)['siteScoped']).toBe(true);
  });

  it('#81 応答に token（平文）が無く、平文の値も現れない', async () => {
    const result = await callChange(tokA.id, { siteId: siteB });

    expect(Object.keys(dataOf(result))).not.toContain('token');
    expect(JSON.stringify(result.body)).not.toContain(tokA.plaintext);
  });

  it('#81 DB の行が site_id = B・site_scoped = true になる', async () => {
    await callChange(tokA.id, { siteId: siteB });

    const row = await tokenRow(tokA.id);
    expect(row.site_id).toBe(siteB);
    expect(row.site_scoped).toBe(true);
  });

  it('#81 続けて tokA で GET /social/accounts → accB・accC', async () => {
    await callChange(tokA.id, { siteId: siteB });

    const result = await callListAccounts(bearer(tokA));

    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual([accB, accC].sort());
  });

  it('#81 続けて tokA で GET /social/accounts/{accA} → 404', async () => {
    await callChange(tokA.id, { siteId: siteB });

    expect((await callGetAccount(bearer(tokA), accA)).status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* #82 サイト → 共通                                                              */
/* -------------------------------------------------------------------------- */

describe('#82 { siteId: null }（サイト → 共通）', () => {
  it('#82 200・siteId: null・siteScoped: false', async () => {
    const result = await callChange(tokA.id, { siteId: null });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBeNull();
    expect(dataOf(result)['siteScoped']).toBe(false);
    const row = await tokenRow(tokA.id);
    expect(row.site_id).toBeNull();
    expect(row.site_scoped).toBe(false);
  });

  it('#82 tokA で GET /social/accounts → accC だけ', async () => {
    await callChange(tokA.id, { siteId: null });

    expect(idsOf(await callListAccounts(bearer(tokA)))).toEqual([accC]);
  });

  it('#82 tokA が作って A に自動で紐づいたアカウントは siteId: A のまま（tokA から 404、セッションからは A）', async () => {
    const created = await callCreateAccount(bearer(tokA));
    expect(created.status).toBe(201);
    const madeByToken = String(dataOf(created)['id']);
    expect(dataOf(created)['siteId']).toBe(siteA);

    await callChange(tokA.id, { siteId: null });

    expect((await callGetAccount(bearer(tokA), madeByToken)).status).toBe(404);
    const fromSession = await callGetAccount(admin(), madeByToken);
    expect(fromSession.status).toBe(200);
    expect(dataOf(fromSession)['siteId']).toBe(siteA);
  });
});

/* -------------------------------------------------------------------------- */
/* #83 共通 → サイト                                                              */
/* -------------------------------------------------------------------------- */

describe('#83 共通 → サイト', () => {
  it('#83 Scope が SNS の 4 つの共通のトークン → 200・siteId: A・siteScoped: true', async () => {
    const result = await callChange(tokCommon.id, { siteId: siteA });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBe(siteA);
    expect(dataOf(result)['siteScoped']).toBe(true);
  });

  it('#83 Scope に site.read を含む共通のトークンで scopes 省略 → 422 scopes（文言に site.read。トークンは変わらない）', async () => {
    const wide = await issueToken(null, ['social.read', 'social.write', 'site.read']);

    const result = await callChange(wide.id, { siteId: siteA });

    expect(result.status).toBe(422);
    const [message] = detailsOf(result)['scopes'] ?? [];
    expect(message?.startsWith(MESSAGE_SNS_ONLY_PREFIX)).toBe(true);
    expect(message).toContain('site.read');
    const row = await tokenRow(wide.id);
    expect(row.site_id).toBeNull();
    expect(row.site_scoped).toBe(false);
    expect([...row.scopes].sort()).toEqual(['site.read', 'social.read', 'social.write']);
  });

  it("#83 同じトークンで scopes: ['social.read', 'social.write'] → 200・応答の scopes がその 2 つ", async () => {
    const wide = await issueToken(null, ['social.read', 'social.write', 'site.read']);

    const result = await callChange(wide.id, {
      siteId: siteA,
      scopes: ['social.read', 'social.write'],
    });

    expect(result.status).toBe(200);
    expect([...(dataOf(result)['scopes'] as string[])].sort()).toEqual([
      'social.read',
      'social.write',
    ]);
    const row = await tokenRow(wide.id);
    expect([...row.scopes].sort()).toEqual(['social.read', 'social.write']);
    expect(row.site_id).toBe(siteA);
  });

  it('#83 今の Scope に無い social.delete を scopes に入れる → 422 scopes「権限を広げることはできません: social.delete」', async () => {
    const narrow = await issueToken(null, ['social.read', 'social.write']);

    const result = await callChange(narrow.id, {
      siteId: siteA,
      scopes: ['social.read', 'social.delete'],
    });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['scopes']).toEqual([`${MESSAGE_WIDEN_PREFIX}social.delete`]);
    const row = await tokenRow(narrow.id);
    expect(row.site_id).toBeNull();
    expect([...row.scopes].sort()).toEqual(['social.read', 'social.write']);
  });
});

/* -------------------------------------------------------------------------- */
/* #84 422 siteId                                                                */
/* -------------------------------------------------------------------------- */

describe('#84 422 siteId（行は変わらない）', () => {
  it('#84 存在しない UUID → 422 siteId「Webサイトが見つかりません。」', async () => {
    const result = await callChange(tokA.id, { siteId: uuidv7() });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_SITE_NOT_FOUND]);
    expect((await tokenRow(tokA.id)).site_id).toBe(siteA);
  });

  it('#84 UUID の形でない値 → 422 siteId', async () => {
    const result = await callChange(tokA.id, { siteId: 'not-a-uuid' });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toBeDefined();
    expect((await tokenRow(tokA.id)).site_id).toBe(siteA);
  });

  it('#84 siteId を送らない → 422 siteId（必須）', async () => {
    const result = await callChange(tokA.id, {});

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toBeDefined();
  });

  it('#84 アーカイブしたサイト → 422 siteId「アーカイブしたサイトにはトークンを紐づけられません。」', async () => {
    const result = await callChange(tokA.id, { siteId: archivedSite });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_ARCHIVED]);
    expect((await tokenRow(tokA.id)).site_id).toBe(siteA);
  });

  it('#84 失効したトークン → 422 siteId「失効したトークンは変えられません。」', async () => {
    await revokeTokenRow(tokA.id);

    const result = await callChange(tokA.id, { siteId: siteB });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_REVOKED]);
    expect((await tokenRow(tokA.id)).site_id).toBe(siteA);
  });

  it('#84 サイトの削除で失効したトークン → 422 siteId「失効したトークンは変えられません。」', async () => {
    const goneSite = await insertSite('消すサイト');
    const tokGone = await issueToken(goneSite);
    expect(await callDeleteSite(goneSite)).toBe(204);

    const result = await callChange(tokGone.id, { siteId: siteB });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_REVOKED]);
    const row = await tokenRow(tokGone.id);
    expect(row.site_id).toBeNull();
    expect(row.site_scoped).toBe(true);
  });

  it('#84 サイト A をアーカイブして tokA が 401 になった後、tokA を B へ変えると 200 で、tokA が再び使える', async () => {
    await setSiteStatus(siteA, 'archived');
    expect((await callListAccounts(bearer(tokA))).status).toBe(401);

    const result = await callChange(tokA.id, { siteId: siteB });

    expect(result.status).toBe(200);
    const after = await callListAccounts(bearer(tokA));
    expect(after.status).toBe(200);
    expect(idsOf(after)).toEqual([accB, accC].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* #85 404・権限                                                                  */
/* -------------------------------------------------------------------------- */

describe('#85 404 と権限', () => {
  it('#85 他のユーザー（管理者）のトークン → 404（行は変わらない）', async () => {
    const others = await issueToken(siteA, SNS_SCOPES, otherAdminSession);

    const result = await callChange(others.id, { siteId: siteB });

    expect(result.status).toBe(404);
    expect((await tokenRow(others.id)).site_id).toBe(siteA);
  });

  it('#85 存在しない UUID → 404', async () => {
    expect((await callChange(uuidv7(), { siteId: siteB })).status).toBe(404);
  });

  it('#85 UUID の形でない ID → 404', async () => {
    expect((await callChange('not-a-uuid', { siteId: siteB })).status).toBe(404);
  });

  it('#85 他のユーザーのトークンの 404 の本文は存在しない UUID のときと同じ', async () => {
    const others = await issueToken(siteA, SNS_SCOPES, otherAdminSession);

    const outside = await callChange(others.id, { siteId: siteB });
    const missing = await callChange(uuidv7(), { siteId: siteB });

    expect(outside.body).toEqual(missing.body);
  });

  it('#85 編集者のセッション → 403', async () => {
    const result = await callChange(
      tokA.id,
      { siteId: siteB },
      { kind: 'session', session: editorSession },
    );

    expect(result.status).toBe(403);
    expect((await tokenRow(tokA.id)).site_id).toBe(siteA);
  });

  it('#85 トークン（Bearer）で叩く → 401（セッションだけ）', async () => {
    const owner = await issueToken(null, ['social.read', 'token.manage']);

    const result = await callChange(tokA.id, { siteId: siteB }, bearer(owner));

    expect(result.status).toBe(401);
    expect((await tokenRow(tokA.id)).site_id).toBe(siteA);
  });

  it('#85 Authorization もセッションも無い → 403 CSRF_FAILED', async () => {
    const result = await callChange(tokA.id, { siteId: siteB }, { kind: 'none' });

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
  });
});

/* -------------------------------------------------------------------------- */
/* #86 投稿がトークンと一緒に移る                                                   */
/* -------------------------------------------------------------------------- */

describe('#86 (B) 投稿がトークンと一緒に移る（裁定 10）', () => {
  let p1: string;
  let p3: string;
  let anotherA: IssuedToken;

  beforeEach(async () => {
    p1 = await createPost(tokA, accA, 'ref-p1');
    p3 = await createPost(tokA, accC, 'ref-p3');
    anotherA = await issueToken(siteA);
    const changed = await callChange(tokA.id, { siteId: siteB });
    expect(changed.status).toBe(200);
  });

  it('#86 p1・p3 の origin_site_id が B・origin_site_scoped が true', async () => {
    expect(await originOf(p1)).toEqual({ origin_site_id: siteB, origin_site_scoped: true });
    expect(await originOf(p3)).toEqual({ origin_site_id: siteB, origin_site_scoped: true });
  });

  it('#86 p3（共通のアカウント）は tokA・tokB から見え、サイト A の別のトークンからは 404', async () => {
    expect(await getPostStatus(tokA, p3)).toBe(200);
    expect(await getPostStatus(tokB, p3)).toBe(200);
    expect(await getPostStatus(anotherA, p3)).toBe(404);
  });

  it('#86 p1（A 専用のアカウント）はサイト A のトークンから見え、tokA からは 404', async () => {
    expect(await getPostStatus(anotherA, p1)).toBe(200);
    expect(await getPostStatus(tokA, p1)).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* #87 変更の後の再送                                                              */
/* -------------------------------------------------------------------------- */

describe('#87 変更の後の再送（冪等キーはトークンの名前空間のまま）', () => {
  let p1: string;
  let p3: string;

  beforeEach(async () => {
    p1 = await createPost(tokA, accA, 'ref-p1');
    p3 = await createPost(tokA, accC, 'ref-p3');
    const changed = await callChange(tokA.id, { siteId: siteB });
    expect(changed.status).toBe(200);
  });

  it('#87 p3 の externalRef で accC へ再送 → 200 で p3（行は増えない）', async () => {
    const result = await callCreatePost(bearer(tokA), accC, 'ref-p3');

    expect(result.status).toBe(200);
    expect(dataOf(result)['id']).toBe(p3);
    expect(await countPosts()).toBe(2);
  });

  it('#87 p1 の externalRef で accA へ再送 → 422 socialAccountId（行は増えない）', async () => {
    const result = await callCreatePost(bearer(tokA), accA, 'ref-p1');

    expect(result.status).toBe(422);
    expect(detailsOf(result)['socialAccountId']).toEqual([MESSAGE_ACCOUNT_NOT_FOUND]);
    expect(await countPosts()).toBe(2);
  });

  it('#87 p1 の externalRef で accB へ送る → 422 externalRef（行は増えない）', async () => {
    const result = await callCreatePost(bearer(tokA), accB, 'ref-p1');

    expect(result.status).toBe(422);
    expect(detailsOf(result)['externalRef']).toEqual([MESSAGE_EXTERNAL_REF_USED]);
    expect(await countPosts()).toBe(2);
  });

  it('#87 p1 は残っている（前提の確認）', async () => {
    expect(await originOf(p1)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #88 共通 → サイトで投稿が移る                                                   */
/* -------------------------------------------------------------------------- */

describe('#88 (B) 共通 → サイト：tokCommon が登録した p4 が A へ移る', () => {
  let p4: string;
  let anotherCommon: IssuedToken;

  beforeEach(async () => {
    p4 = await createPost(tokCommon, accC, 'ref-p4');
    anotherCommon = await issueToken(null);
    const changed = await callChange(tokCommon.id, { siteId: siteA });
    expect(changed.status).toBe(200);
  });

  it('#88 p4 の origin_site_id が A・origin_site_scoped が true', async () => {
    expect(await originOf(p4)).toEqual({ origin_site_id: siteA, origin_site_scoped: true });
  });

  it('#88 p4 は tokA と tokCommon から見える', async () => {
    expect(await getPostStatus(tokA, p4)).toBe(200);
    expect(await getPostStatus(tokCommon, p4)).toBe(200);
  });

  it('#88 p4 は他の共通のトークンからは 404', async () => {
    expect(await getPostStatus(anotherCommon, p4)).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* #90 監査                                                                      */
/* -------------------------------------------------------------------------- */

describe('#90 (B) 監査 updated・api_token（設計 §8.5.7）', () => {
  it('#90 #86 の変更（A → B・投稿 2 件）の detail が { siteId, previousSiteId, scopes, removedScopes, movedPosts: 2 }', async () => {
    await createPost(tokA, accA, 'ref-p1');
    await createPost(tokA, accC, 'ref-p3');

    expect((await callChange(tokA.id, { siteId: siteB })).status).toBe(200);

    const rows = await tokenUpdatedAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(tokA.id);
    const detail = rows[0]?.detail ?? {};
    expect(Object.keys(detail).sort()).toEqual(
      ['movedPosts', 'previousSiteId', 'removedScopes', 'scopes', 'siteId'].sort(),
    );
    expect(detail['siteId']).toBe(siteB);
    expect(detail['previousSiteId']).toBe(siteA);
    expect([...(detail['scopes'] as string[])].sort()).toEqual([...SNS_SCOPES].sort());
    expect(detail['removedScopes']).toEqual([]);
    expect(detail['movedPosts']).toBe(2);
  });

  it('#90 Scope を狭めた共通 → サイトの detail は removedScopes に外した権限、previousSiteId は null', async () => {
    const wide = await issueToken(null, ['social.read', 'social.write', 'site.read']);

    const result = await callChange(wide.id, {
      siteId: siteA,
      scopes: ['social.read', 'social.write'],
    });
    expect(result.status).toBe(200);

    const [row] = await tokenUpdatedAudits();
    expect(row?.detail['siteId']).toBe(siteA);
    expect(row?.detail['previousSiteId']).toBeNull();
    expect([...((row?.detail['scopes'] as string[] | undefined) ?? [])].sort()).toEqual([
      'social.read',
      'social.write',
    ]);
    expect(row?.detail['removedScopes']).toEqual(['site.read']);
    expect(row?.detail['movedPosts']).toBe(0);
  });

  it('#90 422 では監査が残らない', async () => {
    await callChange(tokA.id, { siteId: uuidv7() });
    await callChange(tokA.id, { siteId: archivedSite });

    expect(await tokenUpdatedAudits()).toEqual([]);
  });

  it('#90 404 では監査が残らない', async () => {
    await callChange(uuidv7(), { siteId: siteB });
    await callChange('not-a-uuid', { siteId: siteB });

    expect(await tokenUpdatedAudits()).toEqual([]);
  });

  it('#90 detail に平文・ハッシュ・prefix が無い', async () => {
    expect((await callChange(tokA.id, { siteId: siteB })).status).toBe(200);
    const row = await tokenRow(tokA.id);

    const [audit] = await tokenUpdatedAudits();
    const text = JSON.stringify(audit?.detail ?? {});
    expect(audit).toBeDefined();
    expect(text).not.toContain(tokA.plaintext);
    expect(text).not.toContain(row.token_hash);
    expect(text).not.toContain(row.prefix);
  });
});
