import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GET as listApiTokensRoute,
  POST as createApiTokenRoute,
} from '@/app/api/v1/api-tokens/route';
import { GET as listSitesRoute } from '@/app/api/v1/sites/route';
import { GET as listSocialAccountsRoute } from '@/app/api/v1/social/accounts/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { POST as publishSocialPostsRoute } from '@/app/api/v1/social/publish/route';
import { login } from '@/application/auth/login';
import { buildApiTokenContext } from '@/application/authorization/context';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import type { ApiToken } from '@/domain/api-token';
import { apiTokenRepository } from '@/infrastructure/api-token-repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * API トークンのサイト：発行・応答・監査・認証（053-site-scoped-social 設計 §7.2・§8.5.1〜§8.5.5・§10）。
 *
 * 受け入れ条件 #15〜#20・#22・#23・#51・#52・#54。検証の指摘の修正で、#101（文脈の `apiToken.siteScoped`）と、
 * #14・#20 を文脈の組み立ての段で固定する件（DB の CHECK に頼らない Scope の交差・使えないトークンの最終利用時刻）を足した。
 *
 * **ルートを直接叩く結合テスト**（`social-post-approve.integration.test.ts` の叩き方を写す）。
 * サイトのトークンは `POST /api-tokens` で発行する（実装プラン §2 のテストの方法：発行の経路も一緒に通す）。
 * `POST /api-tokens` は送信元 IP ごとに 1 分 10 回の Rate Limit があるので、要求ごとに
 * `x-forwarded-for` を変える。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-api-token-site';
const PASSWORD = 'api token site correct horse battery staple';

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 設計 §8.5.1 の文言。 */
const MESSAGE_SITE_NOT_FOUND = 'Webサイトが見つかりません。';
const MESSAGE_ARCHIVED = 'アーカイブしたサイトにはトークンを発行できません。';
const MESSAGE_SNS_ONLY =
  'サイトに紐づけるトークンには SNS の権限（social.read・social.write・social.delete・social.approve）だけを指定できます: site.read';

let scratch: ScratchDatabase;
let adminSession: string;
let editorSession: string;
let siteA: string;
let siteB: string;
let archivedSite: string;
/** 要求ごとに変える送信元 IP の連番（Rate Limit を避ける）。 */
let ipSequence = 0;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
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
  return `10.53.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
}

async function createUser(roleNames: readonly string[]): Promise<string> {
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
        display_name: 'api token site test',
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

/** 実際にログインして、有効なセッショントークンを得る。 */
async function issueSessionToken(loginId: string): Promise<string> {
  const outcome = await login({
    loginId,
    password: PASSWORD,
    request: { ipAddress: nextIp(), userAgent: 'vitest' },
  });
  if (!outcome.ok) throw new Error(`ログインに失敗した: ${outcome.reason}`);
  return outcome.sessionToken;
}

async function insertSite(name: string, status: 'active' | 'paused' | 'archived'): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO sites (id, name, url, status)
              VALUES (${id}, ${name}, 'https://example.com/', ${status})`.execute(connection.db);
  });
  return id;
}

async function setSiteStatus(id: string, status: 'active' | 'paused' | 'archived'): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE sites SET status = ${status} WHERE id = ${id}`.execute(connection.db);
  });
}

async function countTokens(): Promise<number> {
  return withConnection(async (connection) => {
    const result = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM api_tokens`.execute(connection.db);
    return Number(result.rows[0]?.count ?? '0');
  });
}

/** セッションで叩くときのヘッダ（Cookie と CSRF）。 */
function sessionHeaders(session: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-forwarded-host': '127.0.0.1:3000',
    'x-forwarded-for': nextIp(),
    origin: ORIGIN,
    cookie: `torifune_session=${session}; torifune_csrf=${CSRF}`,
    'x-csrf-token': CSRF,
  };
}

/** `POST /api-tokens` をセッションで叩く。 */
async function callIssue(
  body: Record<string, unknown>,
  session = adminSession,
): Promise<JsonResult> {
  const response = await createApiTokenRoute(
    new Request(`${API}/api-tokens`, {
      method: 'POST',
      headers: sessionHeaders(session),
      body: JSON.stringify(body),
    }),
  );
  return toResult(response);
}

/** `GET /api-tokens` をセッションで叩く。 */
async function callList(session = adminSession): Promise<JsonResult> {
  const response = await listApiTokensRoute(
    new Request(`${API}/api-tokens`, { headers: sessionHeaders(session) }),
  );
  return toResult(response);
}

interface IssuedToken {
  readonly id: string;
  readonly plaintext: string;
  readonly data: Record<string, unknown>;
}

/** トークンを発行して 201 を確かめる。`siteId` が undefined なら本文に入れない。 */
async function issue(
  siteId: string | null | undefined,
  scopes: readonly string[] = SNS_SCOPES,
): Promise<IssuedToken> {
  const result = await callIssue({
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    ...(siteId === undefined ? {} : { siteId }),
  });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  const data = dataOf(result);
  return { id: String(data['id']), plaintext: String(data['token']), data };
}

function bearer(token: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

async function bearerListAccounts(token: string): Promise<JsonResult> {
  const response = await listSocialAccountsRoute(
    new Request(`${API}/social/accounts`, { headers: bearer(token) }),
  );
  return toResult(response);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('apitokensite');
  const adminLogin = await createUser(['administrator']);
  const editorLogin = await createUser(['editor']);
  adminSession = await issueSessionToken(adminLogin);
  editorSession = await issueSessionToken(editorLogin);
  siteA = await insertSite('サイト A', 'active');
  siteB = await insertSite('サイト B', 'active');
  archivedSite = await insertSite('アーカイブしたサイト', 'archived');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
  await setSiteStatus(siteA, 'active');
  await setSiteStatus(siteB, 'active');
});

/* -------------------------------------------------------------------------- */
/* #15 発行の siteId と応答                                                       */
/* -------------------------------------------------------------------------- */

describe('#15 発行の siteId と応答の siteId / siteScoped', () => {
  it('#15 siteId: A・Scope social.read + social.write → 201、応答に siteId: A・siteScoped: true', async () => {
    const result = await callIssue({
      name: 'サイト A のアプリ',
      scopes: ['social.read', 'social.write'],
      siteId: siteA,
    });

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBe(siteA);
    expect(dataOf(result)['siteScoped']).toBe(true);
  });

  it('#15 siteId を送らない → 201、siteId: null・siteScoped: false', async () => {
    const result = await callIssue({ name: '共通のアプリ', scopes: ['social.read'] });

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBeNull();
    expect(dataOf(result)['siteScoped']).toBe(false);
  });

  it('#15 siteId: null → 201、siteId: null・siteScoped: false', async () => {
    const result = await callIssue({ name: '共通のアプリ', scopes: ['social.read'], siteId: null });

    expect(result.status).toBe(201);
    expect(dataOf(result)['siteId']).toBeNull();
    expect(dataOf(result)['siteScoped']).toBe(false);
  });

  it('#15 発行の応答のキーは今までのキーに siteId と siteScoped の 2 つが増えただけ', async () => {
    const result = await callIssue({ name: '共通のアプリ', scopes: ['social.read'] });

    expect(Object.keys(dataOf(result)).sort()).toEqual(
      [
        'id',
        'prefix',
        'name',
        'scopes',
        'expiresAt',
        'lastUsedAt',
        'revokedAt',
        'createdAt',
        'token',
        'siteId',
        'siteScoped',
      ].sort(),
    );
  });

  it('#15 DB の行に site_id と site_scoped = true が入る', async () => {
    const issued = await issue(siteA, ['social.read']);

    const rows = await withConnection(async (connection) => {
      const result = await sql<{
        site_id: string | null;
        site_scoped: boolean;
      }>`SELECT site_id, site_scoped FROM api_tokens WHERE id = ${issued.id}`.execute(
        connection.db,
      );
      return result.rows;
    });
    expect(rows).toEqual([{ site_id: siteA, site_scoped: true }]);
  });
});

/* -------------------------------------------------------------------------- */
/* #16 422 siteId                                                                */
/* -------------------------------------------------------------------------- */

describe('#16 422 siteId（存在しない・UUID の形でない・アーカイブ）。トークンは作られない', () => {
  it('#16 存在しない UUID → 422 siteId「Webサイトが見つかりません。」', async () => {
    const result = await callIssue({ name: 'x', scopes: ['social.read'], siteId: uuidv7() });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_SITE_NOT_FOUND]);
  });

  it('#16 UUID の形でない値 → 422 siteId', async () => {
    const result = await callIssue({ name: 'x', scopes: ['social.read'], siteId: 'not-a-uuid' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('siteId');
  });

  it('#16 アーカイブしたサイト → 422 siteId「アーカイブしたサイトにはトークンを発行できません。」', async () => {
    const result = await callIssue({ name: 'x', scopes: ['social.read'], siteId: archivedSite });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['siteId']).toEqual([MESSAGE_ARCHIVED]);
  });

  it.each([
    ['存在しない UUID', () => uuidv7()],
    ['UUID の形でない値', () => 'not-a-uuid'],
    ['アーカイブしたサイト', () => archivedSite],
  ])('#16 %s では api_tokens の件数が変わらない', async (_label, siteIdOf) => {
    const before = await countTokens();

    const result = await callIssue({ name: 'x', scopes: ['social.read'], siteId: siteIdOf() });

    expect(result.status).toBe(422);
    expect(await countTokens()).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #17 サイトのトークンの Scope                                                    */
/* -------------------------------------------------------------------------- */

describe('#17 サイトのトークンの Scope は SNS の 4 つに限る（裁定 6）', () => {
  it('#17 siteId: A ＋ Scope に site.read → 422 scopes（文言に site.read）', async () => {
    const result = await callIssue({
      name: 'x',
      scopes: ['social.read', 'site.read'],
      siteId: siteA,
    });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['scopes']).toEqual([MESSAGE_SNS_ONLY]);
  });

  it('#17 siteId: A ＋ Scope に site.read → トークンは作られない', async () => {
    const before = await countTokens();

    await callIssue({ name: 'x', scopes: ['social.read', 'site.read'], siteId: siteA });

    expect(await countTokens()).toBe(before);
  });

  it('#17 siteId: A ＋ SNS の 4 つ全部 → 201・応答の scopes が 4 つ', async () => {
    const result = await callIssue({ name: 'x', scopes: [...SNS_SCOPES], siteId: siteA });

    expect(result.status).toBe(201);
    expect([...(dataOf(result)['scopes'] as string[])].sort()).toEqual([...SNS_SCOPES].sort());
  });

  it('#17 siteId を送らない（共通）なら site.read を含めても 201（今までどおり）', async () => {
    const result = await callIssue({ name: 'x', scopes: ['social.read', 'site.read'] });

    expect(result.status).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* #18 一覧の siteId / siteScoped                                                 */
/* -------------------------------------------------------------------------- */

describe('#18 GET /api-tokens の各要素に siteId / siteScoped', () => {
  it('#18 サイトのトークンと共通のトークンの両方に siteId / siteScoped がある', async () => {
    const site = await issue(siteA, ['social.read']);
    const common = await issue(null, ['social.read']);

    const result = await callList();

    expect(result.status).toBe(200);
    const items = result.body['data'] as Record<string, unknown>[];
    const byId = new Map(items.map((item) => [String(item['id']), item]));
    expect(byId.get(site.id)?.['siteId']).toBe(siteA);
    expect(byId.get(site.id)?.['siteScoped']).toBe(true);
    expect(byId.get(common.id)?.['siteId']).toBeNull();
    expect(byId.get(common.id)?.['siteScoped']).toBe(false);
  });

  it('#18 一覧の要素はすべて siteId と siteScoped のキーを持ち、平文（token）を持たない', async () => {
    await issue(siteA, ['social.read']);
    await issue(null, ['social.read']);

    const items = (await callList()).body['data'] as Record<string, unknown>[];

    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(Object.keys(item)).toContain('siteId');
      expect(Object.keys(item)).toContain('siteScoped');
      expect(Object.keys(item)).not.toContain('token');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #19 発行の監査                                                                 */
/* -------------------------------------------------------------------------- */

describe('#19 発行の監査 created（新たに残す。設計 §8.5.5）', () => {
  interface AuditRow {
    readonly action: string;
    readonly resource_type: string;
    readonly resource_id: string | null;
    readonly detail: Record<string, unknown>;
  }

  async function tokenAudits(): Promise<AuditRow[]> {
    return withConnection(async (connection) => {
      const result = await sql<AuditRow>`SELECT action, resource_type, resource_id, detail
                                           FROM audit_logs
                                          WHERE resource_type = 'api_token'`.execute(connection.db);
      return result.rows;
    });
  }

  it('#19 発行で action: created・resourceType: api_token・resourceId がトークンの ID の行が 1 つ残る', async () => {
    const issued = await issue(siteA, ['social.read', 'social.write']);

    const rows = await tokenAudits();

    expect(
      rows.map(({ action, resource_type, resource_id }) => ({
        action,
        resource_type,
        resource_id,
      })),
    ).toEqual([{ action: 'created', resource_type: 'api_token', resource_id: issued.id }]);
  });

  it('#19 detail が { siteId, scopes, expiresAt: null }', async () => {
    await issue(siteA, ['social.read', 'social.write']);

    const [row] = await tokenAudits();

    expect(row?.detail).toEqual({
      siteId: siteA,
      scopes: ['social.read', 'social.write'],
      expiresAt: null,
    });
  });

  it('#19 有効期限つきなら detail.expiresAt が ISO8601、共通のトークンなら siteId: null', async () => {
    const expiresAt = '2099-01-01T00:00:00.000Z';
    const result = await callIssue({ name: 'x', scopes: ['social.read'], expiresAt });
    expect(result.status).toBe(201);

    const [row] = await tokenAudits();

    expect(row?.detail).toEqual({ siteId: null, scopes: ['social.read'], expiresAt });
  });

  it('#19 detail に平文・ハッシュ・prefix が無い', async () => {
    const issued = await issue(siteA, ['social.read']);
    const stored = await withConnection(async (connection) => {
      const result = await sql<{
        token_hash: string;
        prefix: string;
      }>`SELECT token_hash, prefix FROM api_tokens WHERE id = ${issued.id}`.execute(connection.db);
      return result.rows[0];
    });

    const [row] = await tokenAudits();
    const serialized = JSON.stringify(row?.detail ?? {});

    expect(row).toBeDefined();
    expect(serialized).not.toContain(issued.plaintext);
    expect(serialized).not.toContain(stored?.token_hash ?? '<hash>');
    expect(serialized).not.toContain(stored?.prefix ?? '<prefix>');
  });
});

/* -------------------------------------------------------------------------- */
/* #20 アーカイブしたサイトのトークン                                               */
/* -------------------------------------------------------------------------- */

describe('#20 サイトの状態とサイトのトークンの認証（裁定 8）', () => {
  it('#20 tokA で GET /social/accounts → 200', async () => {
    const tokA = await issue(siteA);

    expect((await bearerListAccounts(tokA.plaintext)).status).toBe(200);
  });

  it('#20 サイト A を archived にすると tokA は 401', async () => {
    const tokA = await issue(siteA);
    await setSiteStatus(siteA, 'archived');

    const result = await bearerListAccounts(tokA.plaintext);

    expect(result.status).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it('#20 サイト A を paused にしても tokA は 200（paused は影響しない）', async () => {
    const tokA = await issue(siteA);
    await setSiteStatus(siteA, 'paused');

    expect((await bearerListAccounts(tokA.plaintext)).status).toBe(200);
  });

  it('#20 archived から active に戻すと tokA は再び 200', async () => {
    const tokA = await issue(siteA);
    await setSiteStatus(siteA, 'archived');
    expect((await bearerListAccounts(tokA.plaintext)).status).toBe(401);

    await setSiteStatus(siteA, 'active');

    expect((await bearerListAccounts(tokA.plaintext)).status).toBe(200);
  });

  it('#20 サイト B をアーカイブしても tokA（サイト A）は 200、共通のトークンも 200', async () => {
    const tokA = await issue(siteA);
    const tokCommon = await issue(null);
    await setSiteStatus(siteB, 'archived');

    expect((await bearerListAccounts(tokA.plaintext)).status).toBe(200);
    expect((await bearerListAccounts(tokCommon.plaintext)).status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* #22・#23 buildApiTokenContext                                                 */
/* -------------------------------------------------------------------------- */

const REQUEST_INFO = { ipAddress: '203.0.113.53', userAgent: 'vitest' } as const;

/** `apiToken.siteId` を読む（053 の前の型には無いので、形だけを見る）。 */
function apiTokenSiteIdOf(context: { readonly apiToken?: unknown }): unknown {
  const apiToken = context.apiToken as { readonly siteId?: unknown } | undefined;
  return apiToken === undefined ? 'no apiToken' : apiToken.siteId;
}

describe('#22 サイトの消えたサイトのトークンは未認証の文脈（設計 §8.5.3 の 1）', () => {
  it('#22 発行直後のサイトのトークンは認証される（前提）', async () => {
    const tokA = await issue(siteA);

    const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(context.identity).not.toBeNull();
  });

  it('#22 行の site_id を DB で直接 NULL にする（失効させない）と identity: null', async () => {
    const tokA = await issue(siteA);
    await withConnection(async (connection) => {
      await sql`UPDATE api_tokens SET site_id = NULL WHERE id = ${tokA.id}`.execute(connection.db);
    });

    const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(context.identity).toBeNull();
    expect([...context.permissions]).toEqual([]);
  });

  it('#22 site_id を NULL にしても revoked_at は入らない（失効ではなく、使えないだけ）', async () => {
    const tokA = await issue(siteA);
    await withConnection(async (connection) => {
      await sql`UPDATE api_tokens SET site_id = NULL WHERE id = ${tokA.id}`.execute(connection.db);
    });
    await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    const rows = await withConnection(async (connection) => {
      const result = await sql<{
        revoked_at: Date | null;
        site_scoped: boolean;
      }>`SELECT revoked_at, site_scoped FROM api_tokens WHERE id = ${tokA.id}`.execute(
        connection.db,
      );
      return result.rows;
    });
    expect(rows).toEqual([{ revoked_at: null, site_scoped: true }]);
  });
});

describe('#23 buildApiTokenContext の apiToken.siteId はトークン行から積む', () => {
  it('#23 tokA では apiToken.siteId が A', async () => {
    const tokA = await issue(siteA);

    const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(apiTokenSiteIdOf(context)).toBe(siteA);
  });

  it('#23 tokCommon では apiToken.siteId が null', async () => {
    const tokCommon = await issue(null);

    const context = await buildApiTokenContext(tokCommon.plaintext, REQUEST_INFO);

    expect(apiTokenSiteIdOf(context)).toBeNull();
  });

  it('#23 apiToken の id はトークンの ID のまま', async () => {
    const tokA = await issue(siteA);

    const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(context.apiToken?.id).toBe(tokA.id);
  });
});

/* -------------------------------------------------------------------------- */
/* #51 権限・未認証                                                               */
/* -------------------------------------------------------------------------- */

const POST_BODY = { socialAccountId: '01900000-0000-7000-8000-000000000053', body: '本文' };

async function callCreatePost(headers: Record<string, string>): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(`${API}/social/posts`, {
      method: 'POST',
      headers,
      body: JSON.stringify(POST_BODY),
    }),
  );
  return toResult(response);
}

describe('#51 サイトのトークンの権限と未認証', () => {
  it('#51 サイトのトークン（Scope social.read だけ）で POST /social/posts → 403', async () => {
    const readOnly = await issue(siteA, ['social.read']);
    expect(readOnly.data['siteScoped']).toBe(true);

    const result = await callCreatePost(bearer(readOnly.plaintext));

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it('#51 形の合った無効なトークン → 401', async () => {
    const result = await callCreatePost(
      bearer(`tfp_${'0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'.slice(0, 43)}`),
    );

    expect(result.status).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it('#51 Authorization もセッションも無い POST → 403 CSRF_FAILED', async () => {
    const result = await callCreatePost({ 'content-type': 'application/json' });

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('CSRF_FAILED');
  });
});

/* -------------------------------------------------------------------------- */
/* #52 サイトのトークンは SNS 以外に届かない                                         */
/* -------------------------------------------------------------------------- */

describe('#52 tokA は SNS 以外の API に届かない', () => {
  it('#52 tokA で GET /sites → 403', async () => {
    const tokA = await issue(siteA);

    const result = await toResult(
      await listSitesRoute(new Request(`${API}/sites`, { headers: bearer(tokA.plaintext) })),
    );

    expect(result.status).toBe(403);
  });

  it('#52 tokA で POST /social/publish → 403', async () => {
    const tokA = await issue(siteA);

    const result = await toResult(
      await publishSocialPostsRoute(
        new Request(`${API}/social/publish`, {
          method: 'POST',
          headers: bearer(tokA.plaintext),
          body: JSON.stringify({}),
        }),
      ),
    );

    expect(result.status).toBe(403);
  });

  it('#52 tokA で GET /api-tokens → 403', async () => {
    const tokA = await issue(siteA);

    const result = await toResult(
      await listApiTokensRoute(
        new Request(`${API}/api-tokens`, { headers: bearer(tokA.plaintext) }),
      ),
    );

    expect(result.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* #54 発行の権限                                                                 */
/* -------------------------------------------------------------------------- */

describe('#54 発行の権限（token.manage・セッションだけ）', () => {
  it('#54 編集者のセッションで POST /api-tokens（siteId あり）→ 403', async () => {
    const result = await callIssue(
      { name: 'x', scopes: ['social.read'], siteId: siteA },
      editorSession,
    );

    expect(result.status).toBe(403);
  });

  it('#54 編集者のセッションの 403 ではトークンが作られない', async () => {
    const before = await countTokens();

    await callIssue({ name: 'x', scopes: ['social.read'], siteId: siteA }, editorSession);

    expect(await countTokens()).toBe(before);
  });

  it('#54 トークンで POST /api-tokens → 401（sessionOnly）', async () => {
    const tokCommon = await issue(null);

    const result = await toResult(
      await createApiTokenRoute(
        new Request(`${API}/api-tokens`, {
          method: 'POST',
          headers: { ...bearer(tokCommon.plaintext), 'x-forwarded-for': nextIp() },
          body: JSON.stringify({ name: 'x', scopes: ['social.read'], siteId: siteA }),
        }),
      ),
    );

    expect(result.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* 検証の指摘の修正：文脈の組み立ての段で固定する                                     */
/* -------------------------------------------------------------------------- */

/** `apiToken.siteScoped` を読む（検証の指摘の修正の前の型には無いので、形だけを見る）。 */
function apiTokenSiteScopedOf(context: { readonly apiToken?: unknown }): unknown {
  const apiToken = context.apiToken as { readonly siteScoped?: unknown } | undefined;
  return apiToken === undefined ? 'no apiToken' : apiToken.siteScoped;
}

describe('#101 buildApiTokenContext の apiToken.siteScoped はトークン行から積む', () => {
  it('#101 tokA では apiToken.siteScoped が true', async () => {
    const tokA = await issue(siteA);

    const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(apiTokenSiteScopedOf(context)).toBe(true);
  });

  it('#101 tokCommon では apiToken.siteScoped が false', async () => {
    const tokCommon = await issue(null);

    const context = await buildApiTokenContext(tokCommon.plaintext, REQUEST_INFO);

    expect(apiTokenSiteScopedOf(context)).toBe(false);
  });
});

/**
 * 引いたトークンの行の Scope に `site.read` を足して返す（DB の `api_tokens_site_scopes_check` をすり抜けた行の代わり）。
 * 行そのものは本物（発行したトークン）で、差し替えるのは Scope だけ。
 */
function stubScopesWithSiteRead(): { readonly restore: () => void } {
  const original = apiTokenRepository.findByHash.bind(apiTokenRepository);
  const spy = vi
    .spyOn(apiTokenRepository, 'findByHash')
    .mockImplementation(async (connection, hash) => {
      const token = await original(connection, hash);
      if (token === null) return null;
      const widened: ApiToken = { ...token, scopes: [...token.scopes, 'site.read'] };
      return widened;
    });
  return { restore: () => spy.mockRestore() };
}

describe('#14（文脈）サイトのトークンの実効 Permission は、DB の CHECK に頼らず SITE_TOKEN_SCOPES と交差する（設計 §8.5.3）', () => {
  it('#14 行の Scope に site.read があっても、サイトのトークンの文脈の Permission に site.read は入らない', async () => {
    const tokA = await issue(siteA);
    const stub = stubScopesWithSiteRead();
    try {
      const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

      expect(context.identity).not.toBeNull();
      expect(context.permissions.has('site.read')).toBe(false);
      expect([...context.permissions].sort()).toEqual([...SNS_SCOPES].sort());
    } finally {
      stub.restore();
    }
  });

  it('#14 対照：共通のトークンでは、同じく足した site.read が文脈の Permission に入る（交差はサイトのトークンだけ）', async () => {
    const tokCommon = await issue(null);
    const stub = stubScopesWithSiteRead();
    try {
      const context = await buildApiTokenContext(tokCommon.plaintext, REQUEST_INFO);

      expect(context.permissions.has('site.read')).toBe(true);
    } finally {
      stub.restore();
    }
  });
});

async function lastUsedAtOf(tokenId: string): Promise<Date | null | undefined> {
  return withConnection(async (connection) => {
    const result = await sql<{
      last_used_at: Date | null;
    }>`SELECT last_used_at FROM api_tokens WHERE id = ${tokenId}`.execute(connection.db);
    return result.rows[0]?.last_used_at;
  });
}

describe('#20（最終利用時刻）使えないサイトのトークンは last_used_at を進めない（サイトの検査は touch の前。実装プラン §8 の 9）', () => {
  it('#20 サイト A を archived にした tokA で文脈を作っても last_used_at は null のまま', async () => {
    const tokA = await issue(siteA);
    await setSiteStatus(siteA, 'archived');

    const context = await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(context.identity).toBeNull();
    expect(await lastUsedAtOf(tokA.id)).toBeNull();
  });

  it('#20 サイトの消えた tokA（site_id を NULL にした行）でも last_used_at は null のまま', async () => {
    const tokA = await issue(siteA);
    await withConnection(async (connection) => {
      await sql`UPDATE api_tokens SET site_id = NULL WHERE id = ${tokA.id}`.execute(connection.db);
    });

    await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(await lastUsedAtOf(tokA.id)).toBeNull();
  });

  it('#20 対照：使えるサイトのトークンでは last_used_at が入る', async () => {
    const tokA = await issue(siteA);

    await buildApiTokenContext(tokA.plaintext, REQUEST_INFO);

    expect(await lastUsedAtOf(tokA.id)).toBeInstanceOf(Date);
  });
});
