import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POST as createApiTokenRoute } from '@/app/api/v1/api-tokens/route';
import { DELETE as deleteSiteRoute } from '@/app/api/v1/sites/[id]/route';
import { PATCH as updateSocialAccountRoute } from '@/app/api/v1/social/accounts/[id]/route';
import { GET as listSocialAccountsRoute } from '@/app/api/v1/social/accounts/route';
import { login } from '@/application/auth/login';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { siteRepository } from '@/infrastructure/site-repository';
import { createPluginDataApi } from '@/plugin/data-api';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * サイトの削除（053-site-scoped-social 設計 §8.6・§8.7・§8.9）。
 *
 * 受け入れ条件 #21・#46〜#48・#49 の後半（`SiteInUseError`）・#50。
 *
 * * 紐づいたアカウントがあれば 409 `CONFLICT`・`details.socialAccounts`。何も変えない（#46）
 * * 紐づいた失効していないトークンは削除と同時に失効させる。既に失効しているものの時刻は変えない（#21・#47）
 * * 監査 `deleted` の `detail` に `{ revokedApiTokens: n }`。409 では残らない（#48）
 * * Repository で外部キーに当たると `SiteInUseError`（500 にしない）（#49 の後半）
 * * Plugin の Data API の `sites.delete` も同じ UseCase を通るので reject される（#50）
 *
 * **ルートを直接叩く結合テスト**（`social-account-site.integration.test.ts` の叩き方を写す）。
 * トークンは `POST /api-tokens` で発行する（実装プラン §2 のテストの方法）。アカウントは SQL で入れる。
 * 削除する件があるので、サイトは件ごとに作る。
 *
 * **未実装の値は静的 import にしない。** `SiteInUseError` はまだ無いので、指定子を定数に置いた動的 import で読む。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-site-delete-scope';
const PASSWORD = 'site delete scope correct horse battery staple';
const PROVIDER = 'scope_none';
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 前もって失効させておくトークンの時刻（削除で書き換わらないことを見る）。 */
const EARLIER_REVOKED_AT = '2026-01-02T03:04:05.000Z';

/** 未実装の値を型検査に掛けないため、指定子は定数に置く。 */
const SITE_MODULE: string = '@/domain/site/site';

/** 設計 §8.6 の 2 の文言。 */
function inUseMessage(count: number): string {
  return `このサイトに紐づいた SNS アカウントが ${count} 件あります。アカウントのサイトを変えるか削除してから、サイトを削除してください。`;
}

let scratch: ScratchDatabase;
let adminSession: string;
let adminContext: AuthorizationContext;
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

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function nextIp(): string {
  ipSequence += 1;
  return `10.57.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

function sessionHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-forwarded-host': '127.0.0.1:3000',
    'x-forwarded-for': nextIp(),
    origin: ORIGIN,
    cookie: `torifune_session=${adminSession}; torifune_csrf=${CSRF}`,
    'x-csrf-token': CSRF,
  };
}

async function createAdmin(): Promise<{
  readonly loginId: string;
  readonly context: AuthorizationContext;
}> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `d${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'site delete scope test',
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
    displayName: 'site delete scope test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { loginId, context };
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

/** 管理者のセッションで `POST /api-tokens` を叩く。 */
async function issueToken(siteId: string | null): Promise<IssuedToken> {
  const result = await toResult(
    await createApiTokenRoute(
      new Request(`${API}/api-tokens`, {
        method: 'POST',
        headers: sessionHeaders(),
        body: JSON.stringify({ name: `t-${uuidv7().slice(-8)}`, scopes: SNS_SCOPES, siteId }),
      }),
    ),
  );
  if (result.status !== 201) {
    throw new Error(`トークンを発行できない: ${JSON.stringify(result.body)}`);
  }
  return { id: String(dataOf(result)['id']), plaintext: String(dataOf(result)['token']) };
}

async function revokeAt(tokenId: string, at: string): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE api_tokens SET revoked_at = ${at}::timestamptz
               WHERE id = ${tokenId}`.execute(connection.db);
  });
}

async function callDeleteSite(id: string): Promise<JsonResult> {
  return toResult(
    await deleteSiteRoute(
      new Request(`${API}/sites/${id}`, {
        method: 'DELETE',
        headers: sessionHeaders(),
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function moveAccount(id: string, siteId: string | null): Promise<void> {
  const result = await toResult(
    await updateSocialAccountRoute(
      new Request(`${API}/social/accounts/${id}`, {
        method: 'PATCH',
        headers: sessionHeaders(),
        body: JSON.stringify({ siteId }),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
  if (result.status !== 200) {
    throw new Error(`アカウントを付け替えられない: ${JSON.stringify(result.body)}`);
  }
}

async function bearerListAccounts(token: string): Promise<number> {
  const response = await listSocialAccountsRoute(
    new Request(`${API}/social/accounts`, {
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    }),
  );
  return response.status;
}

interface TokenRow {
  readonly revoked_at: Date | null;
  readonly site_id: string | null;
  readonly site_scoped: boolean;
}

async function tokenRow(id: string): Promise<TokenRow> {
  return withConnection(async (connection) => {
    const result = await sql<TokenRow>`SELECT revoked_at, site_id, site_scoped
                                         FROM api_tokens WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`トークンが無い: ${id}`);
    return row;
  });
}

async function siteExists(id: string): Promise<boolean> {
  return withConnection(async (connection) => {
    const result = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM sites WHERE id = ${id}`.execute(connection.db);
    return Number(result.rows[0]?.count ?? '0') === 1;
  });
}

async function accountSiteOf(id: string): Promise<string | null | undefined> {
  return withConnection(async (connection) => {
    const result = await sql<{ site_id: string | null }>`SELECT site_id FROM social_accounts
                                                           WHERE id = ${id}`.execute(connection.db);
    return result.rows[0]?.site_id;
  });
}

interface AuditRow {
  readonly resource_id: string | null;
  readonly detail: Record<string, unknown> | null;
}

async function siteDeletedAudits(siteId: string): Promise<AuditRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<AuditRow>`SELECT resource_id, detail FROM audit_logs
                                        WHERE resource_type = 'site' AND action = 'deleted'
                                          AND resource_id = ${siteId}`.execute(connection.db);
    return result.rows;
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

/** `SiteInUseError`（未実装の段階では undefined）。 */
async function siteInUseError(): Promise<(new (...args: never[]) => Error) | undefined> {
  const module = (await import(/* @vite-ignore */ SITE_MODULE)) as {
    readonly SiteInUseError?: new (...args: never[]) => Error;
  };
  return module.SiteInUseError;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('sitedeletescope');
  const admin = await createAdmin();
  adminContext = admin.context;
  adminSession = await issueSessionToken(admin.loginId);
});

afterAll(async () => {
  resetEventHandlers();
  await scratch.dispose();
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('sites').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #21 削除で紐づいたトークンが失効する                                              */
/* -------------------------------------------------------------------------- */

describe('#21 (B) アカウントが紐づいていないサイトを削除すると、紐づいたトークンが失効する', () => {
  it('#21 削除は 204。tokA の revoked_at が入り、site_id は NULL・site_scoped は true のまま', async () => {
    const siteA = await insertSite('サイト A');
    const tokA = await issueToken(siteA);

    const result = await callDeleteSite(siteA);

    expect(result.status).toBe(204);
    const row = await tokenRow(tokA.id);
    expect(row.revoked_at).not.toBeNull();
    expect(row.site_id).toBeNull();
    expect(row.site_scoped).toBe(true);
  });

  it('#21 削除の後、tokA で叩くと 401', async () => {
    const siteA = await insertSite('サイト A');
    const tokA = await issueToken(siteA);
    expect(await bearerListAccounts(tokA.plaintext)).toBe(200);

    await callDeleteSite(siteA);

    expect(await bearerListAccounts(tokA.plaintext)).toBe(401);
  });

  it('#21 削除の前に失効させていたトークンの revoked_at は変わらない', async () => {
    const siteA = await insertSite('サイト A');
    await issueToken(siteA);
    const earlier = await issueToken(siteA);
    await revokeAt(earlier.id, EARLIER_REVOKED_AT);

    await callDeleteSite(siteA);

    expect((await tokenRow(earlier.id)).revoked_at?.toISOString()).toBe(EARLIER_REVOKED_AT);
  });

  it('#21 別のサイトのトークンと共通のトークンは失効しない', async () => {
    const siteA = await insertSite('サイト A');
    const siteB = await insertSite('サイト B');
    await issueToken(siteA);
    const tokB = await issueToken(siteB);
    const tokCommon = await issueToken(null);

    await callDeleteSite(siteA);

    expect((await tokenRow(tokB.id)).revoked_at).toBeNull();
    expect((await tokenRow(tokCommon.id)).revoked_at).toBeNull();
    expect(await bearerListAccounts(tokB.plaintext)).toBe(200);
    expect(await bearerListAccounts(tokCommon.plaintext)).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* #46 紐づいたアカウントがあれば 409                                               */
/* -------------------------------------------------------------------------- */

describe('#46 accA が紐づいたサイト A の DELETE /sites/{id}', () => {
  it('#46 409 CONFLICT・details.socialAccounts に「1 件」を含む文言', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);

    const result = await callDeleteSite(siteA);

    expect(result.status).toBe(409);
    expect(errorOf(result).code).toBe('CONFLICT');
    expect(errorOf(result).details?.['socialAccounts']).toEqual([inUseMessage(1)]);
  });

  it('#46 紐づいたアカウントが 2 件なら文言は「2 件」', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント 1', siteA);
    await insertAccount('A のアカウント 2', siteA);

    const result = await callDeleteSite(siteA);

    expect(result.status).toBe(409);
    expect(errorOf(result).details?.['socialAccounts']).toEqual([inUseMessage(2)]);
  });

  it('#46 409 ではサイトが残り、アカウントの紐づけも変わらない', async () => {
    const siteA = await insertSite('サイト A');
    const accA = await insertAccount('A のアカウント', siteA);

    await callDeleteSite(siteA);

    expect(await siteExists(siteA)).toBe(true);
    expect(await accountSiteOf(accA)).toBe(siteA);
  });

  it('#46 409 では tokA は失効していない（まだ使える）', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);
    const tokA = await issueToken(siteA);

    await callDeleteSite(siteA);

    const row = await tokenRow(tokA.id);
    expect(row.revoked_at).toBeNull();
    expect(row.site_id).toBe(siteA);
    expect(await bearerListAccounts(tokA.plaintext)).toBe(200);
  });

  it('#46 別のサイトに紐づいたアカウントは数えない（そのサイトのアカウントが無ければ 204）', async () => {
    const siteA = await insertSite('サイト A');
    const siteB = await insertSite('サイト B');
    await insertAccount('B のアカウント', siteB);
    await insertAccount('共通のアカウント', null);

    expect((await callDeleteSite(siteA)).status).toBe(204);
  });
});

/* -------------------------------------------------------------------------- */
/* #47 紐づけを外すと消せる                                                         */
/* -------------------------------------------------------------------------- */

describe('#47 accA を共通へ付け替えた後の DELETE /sites/{id}', () => {
  it('#47 204 で、tokA が失効している', async () => {
    const siteA = await insertSite('サイト A');
    const accA = await insertAccount('A のアカウント', siteA);
    const tokA = await issueToken(siteA);
    expect((await callDeleteSite(siteA)).status).toBe(409);

    await moveAccount(accA, null);
    const result = await callDeleteSite(siteA);

    expect(result.status).toBe(204);
    expect(await siteExists(siteA)).toBe(false);
    expect((await tokenRow(tokA.id)).revoked_at).not.toBeNull();
    expect(await bearerListAccounts(tokA.plaintext)).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* #48 監査                                                                      */
/* -------------------------------------------------------------------------- */

describe('#48 (B) サイトの削除の監査（設計 §8.9）', () => {
  it('#48 deleted（site）の detail が { revokedApiTokens: 1 }（既に失効していたものは数えない）', async () => {
    const siteA = await insertSite('サイト A');
    await issueToken(siteA);
    const earlier = await issueToken(siteA);
    await revokeAt(earlier.id, EARLIER_REVOKED_AT);

    expect((await callDeleteSite(siteA)).status).toBe(204);

    const rows = await siteDeletedAudits(siteA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toEqual({ revokedApiTokens: 1 });
  });

  it('#48 紐づいたトークンが無ければ detail は { revokedApiTokens: 0 }', async () => {
    const siteA = await insertSite('サイト A');

    expect((await callDeleteSite(siteA)).status).toBe(204);

    const [row] = await siteDeletedAudits(siteA);
    expect(row?.detail).toEqual({ revokedApiTokens: 0 });
  });

  it('#48 409 のときは監査が残らない', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);
    await issueToken(siteA);

    expect((await callDeleteSite(siteA)).status).toBe(409);

    expect(await siteDeletedAudits(siteA)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #49 の後半 Repository の外部キー違反                                             */
/* -------------------------------------------------------------------------- */

describe('#49 (B) Repository でサイトを直接消して social_accounts の外部キーに当たると SiteInUseError', () => {
  it('#49 siteRepository.delete が SiteInUseError で reject する（500 の素の例外にしない）', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);
    const SiteInUseError = await siteInUseError();

    const error = await rejectionOf(
      withConnection((connection) =>
        connection.transaction((tx) => siteRepository.delete(tx, siteA)),
      ),
    );

    expect(SiteInUseError, 'domain/site/site.ts に SiteInUseError が無い').toBeDefined();
    if (SiteInUseError === undefined) return;
    expect(error).toBeInstanceOf(SiteInUseError);
  });

  it('#49 reject の後もサイトは残る', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);

    await withConnection((connection) =>
      connection.transaction((tx) => siteRepository.delete(tx, siteA)),
    ).catch(() => undefined);

    expect(await siteExists(siteA)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #50 Plugin の Data API の sites.delete                                         */
/* -------------------------------------------------------------------------- */

describe('#50 (B) Plugin の Data API の sites.delete も同じ条件で reject される', () => {
  function dataApi() {
    return createPluginDataApi({
      pluginId: 'site-scope-plugin',
      declaredPermissions: new Set(['site.read', 'site.delete']),
      context: adminContext,
    });
  }

  it('#50 アカウントが紐づいたサイトの sites.delete は reject され、サイトは残る', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);

    const error = await rejectionOf(dataApi().sites.delete(siteA));

    expect(error).toBeInstanceOf(Error);
    expect(await siteExists(siteA)).toBe(true);
  });

  it('#50 reject の理由は SiteInUseError（同じ UseCase を通る）', async () => {
    const siteA = await insertSite('サイト A');
    await insertAccount('A のアカウント', siteA);
    const SiteInUseError = await siteInUseError();

    const error = await rejectionOf(dataApi().sites.delete(siteA));

    expect(SiteInUseError, 'domain/site/site.ts に SiteInUseError が無い').toBeDefined();
    if (SiteInUseError === undefined) return;
    expect(error).toBeInstanceOf(SiteInUseError);
  });

  it('#50 アカウントが紐づいていなければ sites.delete で消せる（前提の確認）', async () => {
    const siteA = await insertSite('サイト A');

    await dataApi().sites.delete(siteA);

    expect(await siteExists(siteA)).toBe(false);
  });
});
