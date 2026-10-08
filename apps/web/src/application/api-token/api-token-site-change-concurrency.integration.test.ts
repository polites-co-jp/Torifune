import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { Connection } from '@/database/provider';
import { apiTokenRepository } from '@/infrastructure/api-token-repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * トークンのサイトの変更と投稿の登録の同時実行（053-site-scoped-social 設計 §7.3・§8.5.6。受け入れ条件 #89）。
 *
 * 登録はトークンの行を `FOR SHARE` で読み、その値で `origin_*` を書く。変更はトークンの行を `UPDATE` してから
 * そのトークンが登録した投稿の `origin_*` を書き換える。どちらの順でも「トークンの区画」と投稿の `origin_*` が食い違わない。
 *
 * * 変更が先：`changeSite` のトランザクションを（トークンの行を書き換えた後で）開いたまま、同じトークンで登録すると、
 *   登録は変更のコミットまで待ち、登録した投稿の `origin_*` は変更後の値になる
 * * 登録が先：登録をコミットしてから変更すると、その投稿も変更で書き換わる（`movedPosts` に数えられる）
 *
 * **接続を 2 本使う**（実装プラン §2 のテストの方法）。待ち合わせは `Promise` の resolver で行い、フェイクタイマーは使わない
 * （DB の待ちを見るため）。文脈（`buildApiTokenContext`）は変更のトランザクションを開く**前に**作る
 * （文脈を作るときの最終利用時刻の更新が、変更の行ロックで待たないようにする）。
 *
 * **未実装の値は静的に参照しない。** `apiTokenRepository.changeSite` はまだ無いので、型を広げて取り出す。
 */

const LOGIN_PREFIX = 'race';
const PROVIDER = 'scope_none';
const REQUEST_INFO = { ipAddress: '203.0.113.89', userAgent: 'vitest' } as const;
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;

/** 登録が変更のコミットを待っていると判断するまでの時間。 */
const BLOCKED_FOR_MS = 300;

/** `apiTokenRepository.changeSite`（実装プラン T20 の形）。 */
type ChangeSite = (
  connection: Connection,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly siteId: string | null;
    readonly siteScoped: boolean;
    readonly scopes: readonly string[];
  },
) => Promise<{ readonly token: { readonly id: string }; readonly movedPosts: number } | null>;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let adminId: string;
let siteA: string;
let siteB: string;
let accC: string;

interface IssuedToken {
  readonly id: string;
  readonly plaintext: string;
}

function changeSiteOf(): ChangeSite {
  const changeSite = (apiTokenRepository as unknown as { readonly changeSite?: ChangeSite })
    .changeSite;
  if (changeSite === undefined) {
    throw new Error('infrastructure/api-token-repository.ts に changeSite が無い');
  }
  return changeSite.bind(apiTokenRepository);
}

async function createAdmin(): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `${LOGIN_PREFIX}${suffix}`;

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'api token site change race test',
      })
      .execute();
    const role = await roleRepository.findByName(connection, 'administrator');
    if (role === null) throw new Error('ロールが無い: administrator');
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  adminId = id;
  const identity: UserIdentity = {
    userId: id,
    loginId,
    displayName: 'api token site change race test',
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
  scratch = await useScratchDatabase('apitokensitechangerace');
  admin = await createAdmin();
  siteA = await insertSite('サイト A');
  siteB = await insertSite('サイト B');
});

afterAll(async () => {
  resetEventHandlers();
  await scratch.dispose();
});

beforeEach(async () => {
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
});

describe('#89 (B) トークンのサイトの変更と投稿の登録の同時実行で origin_* が食い違わない', () => {
  it('#89 変更のトランザクションを開いたまま登録すると、登録は変更のコミットまで待ち、origin_* は変更後の値（B / true）', async () => {
    const changeSite = changeSiteOf();
    const tokA = await issueToken(siteA);
    const context = await tokenContext(tokA);

    const changed = gate();
    const commit = gate();
    const changing = withConnection((connection) =>
      connection.transaction(async (tx) => {
        const result = await changeSite(tx, {
          id: tokA.id,
          userId: adminId,
          siteId: siteB,
          siteScoped: true,
          scopes: SNS_SCOPES,
        });
        changed.open();
        await commit.promise;
        return result;
      }),
    );

    try {
      // 変更がトークンの行を書き換えるまで待つ（変更が失敗したらここで落ちる）。
      await Promise.race([changed.promise, changing]);

      let settled = false;
      const creating = createSocialPost(context, {
        socialAccountId: accC,
        body: '変更と同時に登録する投稿です。',
        scheduledAt: null,
      }).finally(() => {
        settled = true;
      });
      // 先に reject しても未処理の拒否にしない（結果は下で読む）。
      creating.catch(() => undefined);

      await sleep(BLOCKED_FOR_MS);
      expect(settled, '登録が変更のコミットを待たずに終わった（FOR SHARE で読んでいない）').toBe(
        false,
      );

      commit.open();
      const [changeResult, created] = await Promise.all([changing, creating]);

      expect(changeResult?.movedPosts).toBe(0);
      expect(await originOf(created.post.id)).toEqual({
        origin_site_id: siteB,
        origin_site_scoped: true,
      });
    } finally {
      commit.open();
      await changing.catch(() => undefined);
    }
  });

  it('#89 登録が先にコミットした場合は、その投稿も変更で書き換わる（movedPosts: 1・origin_* は B / true）', async () => {
    const changeSite = changeSiteOf();
    const tokA = await issueToken(siteA);
    const context = await tokenContext(tokA);
    const { post } = await createSocialPost(context, {
      socialAccountId: accC,
      body: '変更の前に登録した投稿です。',
      scheduledAt: null,
    });

    const result = await withConnection((connection) =>
      connection.transaction((tx) =>
        changeSite(tx, {
          id: tokA.id,
          userId: adminId,
          siteId: siteB,
          siteScoped: true,
          scopes: SNS_SCOPES,
        }),
      ),
    );

    expect(result?.movedPosts).toBe(1);
    expect(await originOf(post.id)).toEqual({ origin_site_id: siteB, origin_site_scoped: true });
  });

  it('#89 changeSite は失効したトークンには書かず null を返す（行も投稿も変わらない）', async () => {
    const changeSite = changeSiteOf();
    const tokA = await issueToken(siteA);
    const context = await tokenContext(tokA);
    const { post } = await createSocialPost(context, {
      socialAccountId: accC,
      body: '失効の前に登録した投稿です。',
      scheduledAt: null,
    });
    await withConnection(async (connection) => {
      await sql`UPDATE api_tokens SET revoked_at = now() WHERE id = ${tokA.id}`.execute(
        connection.db,
      );
    });

    const result = await withConnection((connection) =>
      connection.transaction((tx) =>
        changeSite(tx, {
          id: tokA.id,
          userId: adminId,
          siteId: siteB,
          siteScoped: true,
          scopes: SNS_SCOPES,
        }),
      ),
    );

    expect(result).toBeNull();
    expect(await originOf(post.id)).toEqual({ origin_site_id: siteA, origin_site_scoped: true });
  });

  it('#89 changeSite は他人のトークン（userId が違う）には書かず null を返す', async () => {
    const changeSite = changeSiteOf();
    const tokA = await issueToken(siteA);

    const result = await withConnection((connection) =>
      connection.transaction((tx) =>
        changeSite(tx, {
          id: tokA.id,
          userId: uuidv7(),
          siteId: siteB,
          siteScoped: true,
          scopes: SNS_SCOPES,
        }),
      ),
    );

    expect(result).toBeNull();
    const row = await withConnection(async (connection) => {
      const read = await sql<{ site_id: string | null }>`SELECT site_id FROM api_tokens
                                                           WHERE id = ${tokA.id}`.execute(
        connection.db,
      );
      return read.rows[0];
    });
    expect(row?.site_id).toBe(siteA);
  });
});
