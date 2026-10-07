import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createApiTokenRoute } from '@/app/api/v1/api-tokens/route';
import {
  DELETE as deleteSocialAccountRoute,
  PATCH as updateSocialAccountRoute,
} from '@/app/api/v1/social/accounts/[id]/route';
import { login } from '@/application/auth/login';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { buildApiTokenContext } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { deleteSocialAccount, updateSocialAccount } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 別の区画の投稿が載った共通のアカウントを、トークンから削除・資格情報の変更をさせない
 * （053-site-scoped-social ユーザー裁定 11。設計 §5.5・§8.2.4・§8.2.5・§8.7。受け入れ条件 #94〜#99）。
 *
 * 共通のアカウントは共通のトークンから「変えられる」（§5.2）。ところが、そのアカウントにサイトのトークンが登録した投稿
 * （共通のトークンからは見えない）が載っていると、共通のトークンの削除は見えない投稿まで `CASCADE` で消し、
 * 資格情報の差し替えは見えない投稿の配信先を変える。**その場合だけ**、トークン（区画 `all` 以外）からの削除と資格情報の
 * 変更を 403 で断る。表示名・ハンドル・状態の変更は配信先を変えないので通す。画面（セッション）は今までどおり。
 * 別の区画の投稿が無ければ今までどおり（サイトを使っていない運用の既存のトークンは影響を受けない）。
 *
 * **ルートを直接叩く結合テスト**（`social-account-site.integration.test.ts` の叩き方を写す）。
 * 投稿は区画の列（`origin_*`）を明示して SQL で入れる（登録の振る舞いは #34〜#37 が見る）。
 * #99 は接続を 2 本使い、投稿を挿入したトランザクションを開いたまま削除・変更を呼ぶ（#89 と同じ流儀）。
 */

const API = 'http://127.0.0.1:3000/api/v1';
const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'csrf-token-for-shared-account-guard';
const PASSWORD = 'shared account guard correct horse battery staple';
const PROVIDER = 'scope_none';
const ORIGINAL_CREDENTIAL = 'v1.encrypted-original-credential';
const REQUEST_INFO = { ipAddress: '203.0.113.94', userAgent: 'vitest' } as const;

const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 挿入のトランザクションの相手が待っていると判断するまでの時間。 */
const BLOCKED_FOR_MS = 300;

let scratch: ScratchDatabase;
let adminSession: string;
let siteA: string;
let tokA: string;
let tokCommon: string;
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

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function nextIp(): string {
  ipSequence += 1;
  return `10.94.${Math.floor(ipSequence / 250)}.${(ipSequence % 250) + 1}`;
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

async function createAdmin(): Promise<string> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `g${suffix}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'shared account guard test',
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

/** 共通のアカウントを SQL で入れる（資格情報は暗号文の形（`v<版>.`）をした固定の文字列。復号はしない）。 */
async function insertSharedAccount(): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO social_accounts (id, provider, display_name, handle, credential, status)
              VALUES (${id}, ${PROVIDER}, '共通のアカウント', 'shared', ${ORIGINAL_CREDENTIAL},
                      'connected')`.execute(connection.db);
  });
  return id;
}

interface Origin {
  readonly originSiteId: string | null;
  readonly originSiteScoped: boolean;
}

/** 区画 site:A（A のトークンが登録した投稿）。 */
const SITE_A_ORIGIN = (): Origin => ({ originSiteId: siteA, originSiteScoped: true });
/** 共通の区画（共通のトークン・画面・Plugin が登録した投稿）。 */
const COMMON_ORIGIN: Origin = { originSiteId: null, originSiteScoped: false };
/** 登録したサイトが消えた投稿（どのトークンからも見えない。設計 §5.2 の 3）。 */
const GONE_SITE_ORIGIN: Origin = { originSiteId: null, originSiteScoped: true };

/** 投稿を区画の列を明示して SQL で入れる。 */
async function insertPost(accountId: string, origin: Origin): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await sql`INSERT INTO social_posts (id, social_account_id, body, origin_site_id, origin_site_scoped)
              VALUES (${id}, ${accountId}, '区画の列を明示した投稿', ${origin.originSiteId},
                      ${origin.originSiteScoped})`.execute(connection.db);
  });
  return id;
}

interface AccountRow {
  readonly display_name: string;
  readonly handle: string;
  readonly credential: string | null;
  readonly status: string;
}

async function accountRow(id: string): Promise<AccountRow | undefined> {
  return withConnection(async (connection) => {
    const result = await sql<AccountRow>`SELECT display_name, handle, credential, status
                                           FROM social_accounts WHERE id = ${id}`.execute(
      connection.db,
    );
    return result.rows[0];
  });
}

async function postExists(id: string): Promise<boolean> {
  return withConnection(async (connection) => {
    const result = await sql<{ id: string }>`SELECT id FROM social_posts WHERE id = ${id}`.execute(
      connection.db,
    );
    return result.rows.length === 1;
  });
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

async function tokenContext(plaintext: string): Promise<AuthorizationContext> {
  const context = await buildApiTokenContext(plaintext, REQUEST_INFO);
  if (context.identity === null) throw new Error('トークンの文脈を作れない');
  return context;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 外から解決できる Promise。 */
function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('sharedaccountguard');
  adminSession = await issueSessionToken(await createAdmin());
  siteA = await insertSite('サイト A');
  tokA = await issueToken(siteA);
  tokCommon = await issueToken(null);
});

afterAll(async () => {
  resetEventHandlers();
  await scratch.dispose();
});

beforeEach(async () => {
  accC = await insertSharedAccount();
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #94 削除                                                                       */
/* -------------------------------------------------------------------------- */

describe('#94 別の区画の投稿が載った共通のアカウントは、共通のトークンから削除できない（裁定 11）', () => {
  it('#94 tokA の区画の投稿がある accC を tokCommon で DELETE → 403 FORBIDDEN', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callDelete({ token: tokCommon }, accC);

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it('#94 403 ではアカウントも投稿も残る（CASCADE で消えない）', async () => {
    const hidden = await insertPost(accC, SITE_A_ORIGIN());
    const visible = await insertPost(accC, COMMON_ORIGIN);

    await callDelete({ token: tokCommon }, accC);

    expect(await accountRow(accC)).toBeDefined();
    expect(await postExists(hidden)).toBe(true);
    expect(await postExists(visible)).toBe(true);
  });

  it('#94 403 の本文は、サイトのトークンが共通のアカウントを消そうとしたときの 403 と同じ（件数も理由も含まない）', async () => {
    await insertPost(accC, SITE_A_ORIGIN());
    await insertPost(accC, SITE_A_ORIGIN());

    const guarded = await callDelete({ token: tokCommon }, accC);
    const siteToken = await callDelete({ token: tokA }, accC);

    expect(siteToken.status).toBe(403);
    expect(guarded.body).toEqual(siteToken.body);
    expect(errorOf(guarded).details).toBeUndefined();
  });

  it('#94 403 は監査に残らない（失敗は記録しない）', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    await callDelete({ token: tokCommon }, accC);

    const rows = await withConnection(async (connection) => {
      const result = await sql<{
        action: string;
      }>`SELECT action FROM audit_logs WHERE resource_id = ${accC}`.execute(connection.db);
      return result.rows;
    });
    expect(rows).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #95 資格情報の変更                                                             */
/* -------------------------------------------------------------------------- */

describe('#95 別の区画の投稿が載った共通のアカウントの資格情報は、共通のトークンから変えられない（裁定 11）', () => {
  it.each([
    { label: 'credential を差し替える', body: { credential: 'new-secret' } },
    { label: "credential: '' で消す", body: { credential: '' } },
    { label: 'credentials: {} で消す', body: { credentials: {} } },
  ])('#95 $label → 403 FORBIDDEN（資格情報は変わらない）', async ({ body }) => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callUpdate({ token: tokCommon }, accC, body);

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
    expect((await accountRow(accC))?.credential).toBe(ORIGINAL_CREDENTIAL);
  });

  it('#95 credential と displayName を一緒に送ると 403 で、表示名も変わらない', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callUpdate({ token: tokCommon }, accC, {
      credential: 'new-secret',
      displayName: '変えた表示名',
    });

    expect(result.status).toBe(403);
    expect(await accountRow(accC)).toMatchObject({
      display_name: '共通のアカウント',
      credential: ORIGINAL_CREDENTIAL,
    });
  });

  it('#95 403 の本文に件数も理由も含まない（サイトのトークンの 403 と同じ）', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const guarded = await callUpdate({ token: tokCommon }, accC, { credential: 'new-secret' });
    const siteToken = await callUpdate({ token: tokA }, accC, { credential: 'new-secret' });

    expect(siteToken.status).toBe(403);
    expect(guarded.body).toEqual(siteToken.body);
  });
});

/* -------------------------------------------------------------------------- */
/* #96 配信先を変えない更新                                                        */
/* -------------------------------------------------------------------------- */

describe('#96 配信先を変えない更新は、別の区画の投稿があっても共通のトークンから通る（裁定 11）', () => {
  it('#96 displayName → 200（行が変わる）', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callUpdate({ token: tokCommon }, accC, { displayName: '変えた表示名' });

    expect(result.status).toBe(200);
    expect((await accountRow(accC))?.display_name).toBe('変えた表示名');
  });

  it('#96 handle → 200（行が変わる）', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callUpdate({ token: tokCommon }, accC, { handle: 'changed' });

    expect(result.status).toBe(200);
    expect((await accountRow(accC))?.handle).toBe('changed');
  });

  it('#96 status → 200（行が変わる。資格情報は変わらない）', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callUpdate({ token: tokCommon }, accC, { status: 'disconnected' });

    expect(result.status).toBe(200);
    expect(await accountRow(accC)).toMatchObject({
      status: 'disconnected',
      credential: ORIGINAL_CREDENTIAL,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* #97 別の区画の投稿が無ければ今までどおり                                         */
/* -------------------------------------------------------------------------- */

describe('#97 別の区画の投稿が無ければ、共通のトークンの削除・資格情報の変更は今までどおり（裁定 4・11）', () => {
  it('#97 投稿が無い accC を tokCommon で DELETE → 204', async () => {
    const result = await callDelete({ token: tokCommon }, accC);

    expect(result.status).toBe(204);
    expect(await accountRow(accC)).toBeUndefined();
  });

  it('#97 共通の区画の投稿だけの accC を tokCommon で DELETE → 204（投稿も CASCADE で消える）', async () => {
    const post = await insertPost(accC, COMMON_ORIGIN);

    const result = await callDelete({ token: tokCommon }, accC);

    expect(result.status).toBe(204);
    expect(await postExists(post)).toBe(false);
  });

  it('#97 共通の区画の投稿だけの accC の credential を tokCommon で変える → 200', async () => {
    await insertPost(accC, COMMON_ORIGIN);

    const result = await callUpdate({ token: tokCommon }, accC, { credential: 'new-secret' });

    expect(result.status).toBe(200);
    expect((await accountRow(accC))?.credential).not.toBe(ORIGINAL_CREDENTIAL);
  });

  it('#97 登録したサイトが消えた投稿（どのトークンからも見えない）が載っていれば DELETE → 403', async () => {
    await insertPost(accC, GONE_SITE_ORIGIN);

    const result = await callDelete({ token: tokCommon }, accC);

    expect(result.status).toBe(403);
    expect(await accountRow(accC)).toBeDefined();
  });

  it('#97 登録したサイトが消えた投稿が載っていれば credential の変更 → 403', async () => {
    await insertPost(accC, GONE_SITE_ORIGIN);

    const result = await callUpdate({ token: tokCommon }, accC, { credential: 'new-secret' });

    expect(result.status).toBe(403);
    expect((await accountRow(accC))?.credential).toBe(ORIGINAL_CREDENTIAL);
  });
});

/* -------------------------------------------------------------------------- */
/* #98 画面（セッション）は区画で絞らない                                          */
/* -------------------------------------------------------------------------- */

describe('#98 セッションは、別の区画の投稿が載った共通のアカウントも削除・資格情報の変更ができる（設計 §5.4）', () => {
  it('#98 管理者のセッションで DELETE → 204（投稿も消える）', async () => {
    const hidden = await insertPost(accC, SITE_A_ORIGIN());

    const result = await callDelete({ session: adminSession }, accC);

    expect(result.status).toBe(204);
    expect(await postExists(hidden)).toBe(false);
  });

  it('#98 管理者のセッションで credential を変える → 200', async () => {
    await insertPost(accC, SITE_A_ORIGIN());

    const result = await callUpdate({ session: adminSession }, accC, { credential: 'new-secret' });

    expect(result.status).toBe(200);
    expect((await accountRow(accC))?.credential).not.toBe(ORIGINAL_CREDENTIAL);
  });
});

/* -------------------------------------------------------------------------- */
/* #99 登録と同時に進んだ削除・資格情報の変更                                        */
/* -------------------------------------------------------------------------- */

/**
 * 区画 site:A の投稿を挿入したトランザクションを開いたまま `run` を呼び、挿入のコミットまで `run` が終わらないこと、
 * コミットの後に `run` が `ForbiddenError` で断られることを確かめる。
 */
async function expectWaitsForInsertThenForbidden(
  run: () => Promise<unknown>,
): Promise<{ readonly insertedPostId: string }> {
  const insertedPostId = uuidv7();
  const inserted = gate();
  const commit = gate();
  const inserting = withConnection((connection) =>
    connection.transaction(async (tx) => {
      await sql`INSERT INTO social_posts (id, social_account_id, body, origin_site_id, origin_site_scoped)
                VALUES (${insertedPostId}, ${accC}, '同時に登録した投稿', ${siteA}, true)`.execute(
        tx.db,
      );
      inserted.open();
      await commit.promise;
    }),
  );

  try {
    await Promise.race([inserted.promise, inserting]);

    let settled = false;
    const running = run().finally(() => {
      settled = true;
    });
    running.catch(() => undefined);

    await sleep(BLOCKED_FOR_MS);
    expect(settled, '挿入のコミットを待たずに終わった（アカウントの行をロックしていない）').toBe(
      false,
    );

    commit.open();
    await inserting;

    await expect(running).rejects.toBeInstanceOf(ForbiddenError);
    return { insertedPostId };
  } finally {
    commit.open();
    await inserting.catch(() => undefined);
  }
}

describe('#99 (B) 別の区画の投稿の登録と同時に進んだ削除・資格情報の変更も断る（裁定 11）', () => {
  it('#99 挿入のトランザクションを開いたまま tokCommon で削除すると、コミットまで待ってから 403（アカウントと投稿は残る）', async () => {
    const context = await tokenContext(tokCommon);

    const { insertedPostId } = await expectWaitsForInsertThenForbidden(() =>
      deleteSocialAccount(context, { id: accC }),
    );

    expect(await accountRow(accC)).toBeDefined();
    expect(await postExists(insertedPostId)).toBe(true);
  });

  it('#99 挿入のトランザクションを開いたまま tokCommon で credential を変えると、コミットまで待ってから 403（資格情報は残る）', async () => {
    const context = await tokenContext(tokCommon);

    await expectWaitsForInsertThenForbidden(() =>
      updateSocialAccount(context, { id: accC, credential: 'new-secret' }),
    );

    expect((await accountRow(accC))?.credential).toBe(ORIGINAL_CREDENTIAL);
  });
});
