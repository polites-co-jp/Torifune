import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createApiTokenRoute } from '@/app/api/v1/api-tokens/route';
import {
  DELETE as deleteSocialAccountRoute,
  GET as getSocialAccountRoute,
  PATCH as updateSocialAccountRoute,
} from '@/app/api/v1/social/accounts/[id]/route';
import {
  GET as listSocialAccountsRoute,
  POST as createSocialAccountRoute,
} from '@/app/api/v1/social/accounts/route';
import { login } from '@/application/auth/login';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * SNS アカウントの区画（053-site-scoped-social 設計 §5.2・§5.5・§5.6・§8.2・§8.7・§8.9）。
 *
 * 受け入れ条件 #24〜#33・#53。
 *
 * **ルートを直接叩く結合テスト**（`social-post-approve.integration.test.ts` の叩き方を写す）。
 * 共通の準備（設計 §13 の前書き）：サイト A・B（`active`）、アカウント `accA`（A 専用）・`accB`（B 専用）・
 * `accC`（共通）、トークン `tokA`（サイト A）・`tokB`（サイト B）・`tokCommon`（共通）。Scope はどれも SNS の 4 つで、
 * 所有者は管理者。トークンは `POST /api-tokens` で発行する（実装プラン §2 のテストの方法）。
 * アカウントの準備は**作成の API に頼らない**よう SQL で入れる（作成の振る舞いは #24〜#26 が見る）。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-social-account-site';
const PASSWORD = 'social account site correct horse battery staple';

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 設計 §8.2.3・§8.2.4 の文言。 */
const MESSAGE_SITE_NOT_FOUND = 'Webサイトが見つかりません。';
const MESSAGE_COMMON_TOKEN_CANNOT_LINK =
  'APIトークンではアカウントをサイトに紐づけられません。管理画面で紐づけてください。';
const MESSAGE_SITE_TOKEN_OTHER_SITE =
  'サイトに紐づいたトークンでは、そのサイト以外を指定できません。';
const MESSAGE_TOKEN_CANNOT_CHANGE_SITE =
  'APIトークンではアカウントのサイトを変えられません。管理画面で変えてください。';

let scratch: ScratchDatabase;
let adminSession: string;
let editorSession: string;
let viewerSession: string;
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
  return `10.54.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
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
  const loginId = `c${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'social account site test',
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
              VALUES (${id}, 'x', ${displayName}, 'connected', ${siteId})`.execute(connection.db);
  });
  return id;
}

interface AccountRow {
  readonly display_name: string;
  readonly site_id: string | null;
}

async function accountRow(id: string): Promise<AccountRow | undefined> {
  return withConnection(async (connection) => {
    const result = await sql<AccountRow>`SELECT display_name, site_id
                                           FROM social_accounts WHERE id = ${id}`.execute(
      connection.db,
    );
    return result.rows[0];
  });
}

async function callCreate(auth: Auth, body: Record<string, unknown>): Promise<JsonResult> {
  return toResult(
    await createSocialAccountRoute(
      new Request(`${API}/social/accounts`, {
        method: 'POST',
        headers: headersFor(auth),
        body: JSON.stringify({ provider: 'x', displayName: '作成したアカウント', ...body }),
      }),
    ),
  );
}

async function callList(auth: Auth, query = ''): Promise<JsonResult> {
  return toResult(
    await listSocialAccountsRoute(
      new Request(`${API}/social/accounts${query}`, { headers: headersFor(auth) }),
    ),
  );
}

async function callGet(auth: Auth, id: string): Promise<JsonResult> {
  return toResult(
    await getSocialAccountRoute(
      new Request(`${API}/social/accounts/${id}`, { headers: headersFor(auth) }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callUpdate(
  auth: Auth,
  id: string,
  body: Record<string, unknown>,
): Promise<JsonResult> {
  return toResult(
    await updateSocialAccountRoute(
      new Request(`${API}/social/accounts/${id}`, {
        method: 'PATCH',
        headers: headersFor(auth),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callDelete(auth: Auth, id: string): Promise<JsonResult> {
  return toResult(
    await deleteSocialAccountRoute(
      new Request(`${API}/social/accounts/${id}`, {
        method: 'DELETE',
        headers: headersFor(auth),
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

function idsOf(result: JsonResult): string[] {
  return (result.body['data'] as Record<string, unknown>[])
    .map((item) => String(item['id']))
    .sort();
}

function totalOf(result: JsonResult): unknown {
  return (result.body['meta'] as Record<string, unknown> | undefined)?.['total'];
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialaccountsite');
  adminSession = await issueSessionToken(await createUser(['administrator']));
  editorSession = await issueSessionToken(await createUser(['editor']));
  viewerSession = await issueSessionToken(await createUser(['viewer']));
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
/* #24 セッションでの作成                                                          */
/* -------------------------------------------------------------------------- */

describe('#24 管理者のセッションで作成する siteId', () => {
  it('#24 siteId: A → 201・siteId: A', async () => {
    const result = await callCreate({ session: adminSession }, { siteId: siteA });

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBe(siteA);
  });

  it('#24 siteId を送らない → 201・siteId: null', async () => {
    const result = await callCreate({ session: adminSession }, {});

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBeNull();
  });

  it('#24 存在しない UUID → 422 siteId「Webサイトが見つかりません。」', async () => {
    const result = await callCreate({ session: adminSession }, { siteId: uuidv7() });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_SITE_NOT_FOUND]);
  });

  it('#24 応答のキーが 9 個（既存の 8 ＋ siteId）', async () => {
    const result = await callCreate({ session: adminSession }, { siteId: siteA });

    expect(Object.keys(dataOf(result)).sort()).toEqual(
      [
        'id',
        'provider',
        'displayName',
        'handle',
        'status',
        'credentialConfigured',
        'createdAt',
        'updatedAt',
        'siteId',
      ].sort(),
    );
  });

  it('#24 作成した行の site_id が A', async () => {
    const result = await callCreate({ session: adminSession }, { siteId: siteA });

    expect((await accountRow(String(dataOf(result)['id'])))?.site_id).toBe(siteA);
  });
});

/* -------------------------------------------------------------------------- */
/* #25 サイトのトークンでの作成                                                     */
/* -------------------------------------------------------------------------- */

describe('#25 tokA で作成する（サイトのトークンが作るアカウントはそのサイトに紐づく）', () => {
  it('#25 siteId 省略 → 201・siteId: A（自動で紐づく）', async () => {
    const result = await callCreate({ token: tokA }, {});

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBe(siteA);
  });

  it('#25 siteId: A → 201・siteId: A', async () => {
    const result = await callCreate({ token: tokA }, { siteId: siteA });

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBe(siteA);
  });

  it('#25 siteId: B → 422 siteId', async () => {
    const result = await callCreate({ token: tokA }, { siteId: siteB });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_SITE_TOKEN_OTHER_SITE]);
  });

  it('#25 siteId: null → 422 siteId', async () => {
    const result = await callCreate({ token: tokA }, { siteId: null });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_SITE_TOKEN_OTHER_SITE]);
  });

  it('#25 siteId: B と null の 422 は同じ文言（サイトの存在を教えない）', async () => {
    const withOther = await callCreate({ token: tokA }, { siteId: siteB });
    const withNull = await callCreate({ token: tokA }, { siteId: null });
    const withMissing = await callCreate({ token: tokA }, { siteId: uuidv7() });

    expect(detailsOf(withOther)).toEqual(detailsOf(withNull));
    expect(detailsOf(withMissing)).toEqual(detailsOf(withNull));
    expect(detailsOf(withNull)['siteId']).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #26 共通のトークンでの作成                                                       */
/* -------------------------------------------------------------------------- */

describe('#26 tokCommon で作成する', () => {
  it('#26 siteId 省略 → 201・siteId: null', async () => {
    const result = await callCreate({ token: tokCommon }, {});

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBeNull();
  });

  it('#26 siteId: null → 201・siteId: null', async () => {
    const result = await callCreate({ token: tokCommon }, { siteId: null });

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBeNull();
  });

  it('#26 siteId: A → 422 siteId', async () => {
    const result = await callCreate({ token: tokCommon }, { siteId: siteA });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_COMMON_TOKEN_CANNOT_LINK]);
  });
});

/* -------------------------------------------------------------------------- */
/* #27 一覧の区画                                                                 */
/* -------------------------------------------------------------------------- */

describe('#27 GET /social/accounts は区画で絞る', () => {
  it('#27 セッションは accA・accB・accC（meta.total: 3）', async () => {
    const result = await callList({ session: adminSession });

    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual([accA, accB, accC].sort());
    expect(totalOf(result)).toBe(3);
  });

  it('#27 tokA は accA・accC（meta.total: 2）', async () => {
    const result = await callList({ token: tokA });

    expect(result.status).toBe(200);
    expect(idsOf(result)).toEqual([accA, accC].sort());
    expect(totalOf(result)).toBe(2);
  });

  it('#27 tokB は accB・accC（meta.total: 2）', async () => {
    const result = await callList({ token: tokB });

    expect(idsOf(result)).toEqual([accB, accC].sort());
    expect(totalOf(result)).toBe(2);
  });

  it('#27 tokCommon は accC だけ（meta.total: 1）', async () => {
    const result = await callList({ token: tokCommon });

    expect(idsOf(result)).toEqual([accC]);
    expect(totalOf(result)).toBe(1);
  });

  it('#27 provider の絞り込みも区画の中で掛かる（tokA の provider=x は accA・accC）', async () => {
    const result = await callList({ token: tokA }, '?provider=x');

    expect(idsOf(result)).toEqual([accA, accC].sort());
    expect(totalOf(result)).toBe(2);
  });

  it('#27 provider の絞り込みも区画の中で掛かる（tokCommon の provider=x は accC だけ）', async () => {
    const result = await callList({ token: tokCommon }, '?provider=x');

    expect(idsOf(result)).toEqual([accC]);
    expect(totalOf(result)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #28・#29 取得の区画                                                             */
/* -------------------------------------------------------------------------- */

describe('#28 tokA の GET /social/accounts/{id}', () => {
  it('#28 accA → 200', async () => {
    expect((await callGet({ token: tokA }, accA)).status).toBe(200);
  });

  it('#28 accC（共通）→ 200', async () => {
    expect((await callGet({ token: tokA }, accC)).status).toBe(200);
  });

  it('#28 accB → 404', async () => {
    expect((await callGet({ token: tokA }, accB)).status).toBe(404);
  });

  it('#28 accB の 404 の本文は存在しない UUID のときと同じ', async () => {
    const outside = await callGet({ token: tokA }, accB);
    const missing = await callGet({ token: tokA }, uuidv7());

    expect(missing.status).toBe(404);
    expect(outside.body).toEqual(missing.body);
  });
});

describe('#29 tokCommon の GET /social/accounts/{id}', () => {
  it('#29 accA（サイト専用）→ 404', async () => {
    expect((await callGet({ token: tokCommon }, accA)).status).toBe(404);
  });

  it('#29 accA の 404 の本文は存在しない UUID のときと同じ', async () => {
    const outside = await callGet({ token: tokCommon }, accA);
    const missing = await callGet({ token: tokCommon }, uuidv7());

    expect(outside.body).toEqual(missing.body);
  });

  it('#29 accC（共通）→ 200', async () => {
    expect((await callGet({ token: tokCommon }, accC)).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* #30 更新の区画                                                                 */
/* -------------------------------------------------------------------------- */

describe('#30 PATCH /social/accounts/{id}（displayName）', () => {
  const rename = { displayName: '名前を変えた' };

  it('#30 tokA で accA → 200', async () => {
    const result = await callUpdate({ token: tokA }, accA, rename);

    expect(result.status).toBe(200);
    expect(dataOf(result)['displayName']).toBe('名前を変えた');
  });

  it('#30 tokA で accC（共通）→ 403 FORBIDDEN', async () => {
    const result = await callUpdate({ token: tokA }, accC, rename);

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it('#30 tokA で accC の 403 では行が変わらない', async () => {
    await callUpdate({ token: tokA }, accC, rename);

    expect((await accountRow(accC))?.display_name).toBe('共通のアカウント');
  });

  it('#30 tokA で accB → 404（行は変わらない）', async () => {
    const result = await callUpdate({ token: tokA }, accB, rename);

    expect(result.status).toBe(404);
    expect((await accountRow(accB))?.display_name).toBe('B のアカウント');
  });

  it('#30 tokCommon で accC → 200', async () => {
    const result = await callUpdate({ token: tokCommon }, accC, rename);

    expect(result.status).toBe(200);
    expect((await accountRow(accC))?.display_name).toBe('名前を変えた');
  });

  it('#30 tokCommon で accA → 404（行は変わらない）', async () => {
    const result = await callUpdate({ token: tokCommon }, accA, rename);

    expect(result.status).toBe(404);
    expect((await accountRow(accA))?.display_name).toBe('A のアカウント');
  });
});

/* -------------------------------------------------------------------------- */
/* #31 siteId の付け替え                                                          */
/* -------------------------------------------------------------------------- */

describe('#31 siteId の付け替えはセッションだけ（設計 §5.6）', () => {
  it('#31 セッションで accA を B → 200・siteId: B', async () => {
    const result = await callUpdate({ session: adminSession }, accA, { siteId: siteB });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBe(siteB);
    expect((await accountRow(accA))?.site_id).toBe(siteB);
  });

  it('#31 セッションで accA を共通（null）→ 200・siteId: null', async () => {
    const result = await callUpdate({ session: adminSession }, accA, { siteId: null });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBeNull();
    expect((await accountRow(accA))?.site_id).toBeNull();
  });

  it('#31 セッションで共通の accC を A → 200・siteId: A', async () => {
    const result = await callUpdate({ session: adminSession }, accC, { siteId: siteA });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBe(siteA);
  });

  it('#31 セッションで存在しないサイト → 422 siteId「Webサイトが見つかりません。」（行は変わらない）', async () => {
    const result = await callUpdate({ session: adminSession }, accA, { siteId: uuidv7() });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_SITE_NOT_FOUND]);
    expect((await accountRow(accA))?.site_id).toBe(siteA);
  });

  it('#31 tokA で accA に siteId: A → 200（変わらない）', async () => {
    const result = await callUpdate({ token: tokA }, accA, { siteId: siteA });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBe(siteA);
    expect((await accountRow(accA))?.site_id).toBe(siteA);
  });

  it('#31 tokA で accA に siteId: null → 422 siteId（行は変わらない）', async () => {
    const result = await callUpdate({ token: tokA }, accA, { siteId: null });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_TOKEN_CANNOT_CHANGE_SITE]);
    expect((await accountRow(accA))?.site_id).toBe(siteA);
  });

  it('#31 tokA で accA に siteId: B → 422 siteId（行は変わらない）', async () => {
    const result = await callUpdate({ token: tokA }, accA, { siteId: siteB });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_TOKEN_CANNOT_CHANGE_SITE]);
    expect((await accountRow(accA))?.site_id).toBe(siteA);
  });

  it('#31 tokCommon で accC に siteId: A → 422 siteId（行は変わらない）', async () => {
    const result = await callUpdate({ token: tokCommon }, accC, { siteId: siteA });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_TOKEN_CANNOT_CHANGE_SITE]);
    expect((await accountRow(accC))?.site_id).toBeNull();
  });

  it('#31 tokCommon で accC に siteId: null → 200（変わらない）', async () => {
    const result = await callUpdate({ token: tokCommon }, accC, { siteId: null });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* #32 削除の区画                                                                 */
/* -------------------------------------------------------------------------- */

describe('#32 DELETE /social/accounts/{id}', () => {
  it('#32 tokA で accA → 204（行が消える）', async () => {
    const result = await callDelete({ token: tokA }, accA);

    expect(result.status).toBe(204);
    expect(await accountRow(accA)).toBeUndefined();
  });

  it('#32 tokA で accC（共通）→ 403 FORBIDDEN（行は残る）', async () => {
    const result = await callDelete({ token: tokA }, accC);

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
    expect(await accountRow(accC)).toBeDefined();
  });

  it('#32 tokA で accB → 404（行は残る）', async () => {
    const result = await callDelete({ token: tokA }, accB);

    expect(result.status).toBe(404);
    expect(await accountRow(accB)).toBeDefined();
  });

  it('#32 tokCommon で accA → 404（行は残る）', async () => {
    const result = await callDelete({ token: tokCommon }, accA);

    expect(result.status).toBe(404);
    expect(await accountRow(accA)).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #33 監査                                                                      */
/* -------------------------------------------------------------------------- */

describe('#33 アカウントの作成・付け替えの監査（設計 §8.9）', () => {
  interface AuditRow {
    readonly action: string;
    readonly resource_id: string | null;
    readonly detail: Record<string, unknown>;
  }

  async function accountAudits(action: string): Promise<AuditRow[]> {
    return withConnection(async (connection) => {
      const result = await sql<AuditRow>`SELECT action, resource_id, detail FROM audit_logs
                                          WHERE resource_type = 'social_account'
                                            AND action = ${action}`.execute(connection.db);
      return result.rows;
    });
  }

  it('#33 作成の created の detail が { provider, siteId }', async () => {
    const created = await callCreate({ session: adminSession }, { siteId: siteA });
    expect(created.status).toBe(201);

    const rows = await accountAudits('created');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(String(dataOf(created)['id']));
    expect(rows[0]?.detail).toEqual({ provider: 'x', siteId: siteA });
  });

  it('#33 共通で作成した created の detail の siteId は null', async () => {
    await callCreate({ session: adminSession }, {});

    const [row] = await accountAudits('created');

    expect(row?.detail).toEqual({ provider: 'x', siteId: null });
  });

  it('#33 付け替えの updated の detail.changed が siteId を含み、detail.siteId が更新後の値', async () => {
    const result = await callUpdate({ session: adminSession }, accA, { siteId: siteB });
    expect(result.status).toBe(200);

    const rows = await accountAudits('updated');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(accA);
    expect(rows[0]?.detail['changed']).toContain('siteId');
    expect(rows[0]?.detail['siteId']).toBe(siteB);
  });

  it('#33 共通への付け替えの updated の detail.siteId は null', async () => {
    await callUpdate({ session: adminSession }, accA, { siteId: null });

    const [row] = await accountAudits('updated');

    expect(row?.detail['changed']).toContain('siteId');
    expect(Object.keys(row?.detail ?? {})).toContain('siteId');
    expect(row?.detail['siteId']).toBeNull();
  });

  it('#33 displayName だけの更新の detail に siteId が無い', async () => {
    const result = await callUpdate({ session: adminSession }, accA, { displayName: '名前だけ' });
    expect(result.status).toBe(200);

    const [row] = await accountAudits('updated');

    expect(row?.detail['changed']).toEqual(['displayName']);
    expect(Object.keys(row?.detail ?? {})).not.toContain('siteId');
  });

  it('#33 区画の外で断られた操作（403 / 404 / 422）は監査に残らない', async () => {
    await callUpdate({ token: tokA }, accC, { displayName: 'x' });
    await callUpdate({ token: tokA }, accB, { displayName: 'x' });
    await callUpdate({ token: tokA }, accA, { siteId: siteB });

    expect(await accountAudits('updated')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #53 付け替えの権限                                                              */
/* -------------------------------------------------------------------------- */

describe('#53 siteId の付け替えの権限（social.write）', () => {
  it('#53 閲覧者のセッションで PATCH に siteId → 403（行は変わらない）', async () => {
    const result = await callUpdate({ session: viewerSession }, accA, { siteId: siteB });

    expect(result.status).toBe(403);
    expect((await accountRow(accA))?.site_id).toBe(siteA);
  });

  it('#53 編集者のセッションで PATCH に siteId → 200', async () => {
    const result = await callUpdate({ session: editorSession }, accA, { siteId: siteB });

    expect(result.status).toBe(200);
    expect(dataOf(result)['siteId']).toBe(siteB);
  });
});
