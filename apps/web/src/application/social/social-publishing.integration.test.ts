import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import {
  authorizationContextFor,
  buildApiTokenContext,
  buildAuthorizationContext,
} from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { createPluginDataApi } from '@/plugin/data-api';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 投稿の登録まわりのうち、HTTP を通さずに見るもの（035-social-publishing 設計 §6.1 / §6.2）。
 *
 * 受け入れ条件 #29（セッションからは `externalRef` を指定できない）、
 * #31（`created_by_token_id` と `AuthorizationContext.apiToken`）、
 * #32（同時 10 本で 1 行）、#37（配信中のガード）。
 *
 * #29 は「`context.apiToken` が無いこと」が本体なので、ルートではなく
 * UseCase を直接呼ぶ（実装プラン §2「テストの方法」）。
 */

const REQUEST = { ipAddress: '203.0.113.30', userAgent: 'vitest' } as const;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;

/** 失敗することを期待する呼び出しから Error を取り出す。 */
async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('失敗するはずの処理が成功した');
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `p${suffix}`,
        email: `p${suffix}@example.com`,
        display_name: 'social publishing test',
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

  const identity: UserIdentity = {
    userId: id,
    loginId: `p${suffix}`,
    displayName: 'social publishing test',
    email: `p${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** Token を発行して、その Token の認可文脈を組み立てる。 */
async function tokenContext(
  name = 'external app',
): Promise<{ readonly tokenId: string; readonly context: AuthorizationContext }> {
  const created = await createApiToken(admin, {
    name,
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  return {
    tokenId: created.token.id,
    context: await buildApiTokenContext(created.plaintext, REQUEST),
  };
}

/** 配信が進行中の行を直接作る（着手印はジョブしか立てないため）。 */
async function markPublishStarted(id: string, at: Date | null): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ publish_started_at: at })
      .where('id', '=', id)
      .execute();
  });
}

async function createdByTokenIdOf(id: string): Promise<string | null> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select('created_by_token_id')
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  return row?.created_by_token_id ?? null;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishing');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: 'account-credential',
    status: 'connected',
  });
  accountId = account.id;
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#29 セッション認証では externalRef を指定できない', () => {
  it('#29 セッションの文脈で externalRef を送ると ValidationError', async () => {
    // Token が無いと一意の名前空間が無く、PostgreSQL の一意索引は NULL を
    // 区別しないので「冪等のつもりで二重登録」が黙って起きる（設計 §6.1.3）。
    const error = await errorFrom(
      createSocialPost(admin, {
        socialAccountId: accountId,
        body: 'こんにちは',
        scheduledAt: null,
        status: 'draft',
        externalRef: 'r1',
      }),
    );

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('#29 例外のフィールドが externalRef', async () => {
    const error = await errorFrom(
      createSocialPost(admin, {
        socialAccountId: accountId,
        body: 'こんにちは',
        scheduledAt: null,
        status: 'draft',
        externalRef: 'r1',
      }),
    );

    expect((error as ValidationError).field).toBe('externalRef');
  });

  it('#29 externalRef を省略すればセッションからでも作成できる', async () => {
    const { post, created } = await createSocialPost(admin, {
      socialAccountId: accountId,
      body: 'こんにちは',
      scheduledAt: null,
      status: 'draft',
    });

    expect(created).toBe(true);
    expect(post.externalRef).toBeNull();
  });
});

describe('#31 登録した Token が残る', () => {
  it('#31 buildApiTokenContext の文脈は apiToken に id と name を持つ', async () => {
    // **リクエストの値ではなくサーバー側で引いた行から積む**（04 §28）。
    const created = await createApiToken(admin, {
      name: 'CI',
      scopes: ['social.write'],
      expiresAt: null,
    });

    const context = await buildApiTokenContext(created.plaintext, REQUEST);

    expect(context.apiToken).toEqual({ id: created.token.id, name: 'CI' });
  });

  it('#31 buildAuthorizationContext の文脈は apiToken を持たない', async () => {
    const context = await buildAuthorizationContext(undefined, REQUEST);

    expect(context.apiToken).toBeUndefined();
  });

  it('#31 authorizationContextFor の文脈も apiToken を持たない', async () => {
    expect(admin.apiToken).toBeUndefined();
  });

  it('#31 Bearer で作った投稿の created_by_token_id がその Token の ID', async () => {
    const { tokenId, context } = await tokenContext();

    const { post } = await createSocialPost(context, {
      socialAccountId: accountId,
      body: 'Token から',
      scheduledAt: null,
      status: 'draft',
    });

    expect(await createdByTokenIdOf(post.id)).toBe(tokenId);
  });

  it('#31 セッションで作った投稿の created_by_token_id は NULL', async () => {
    const { post } = await createSocialPost(admin, {
      socialAccountId: accountId,
      body: 'セッションから',
      scheduledAt: null,
      status: 'draft',
    });

    expect(await createdByTokenIdOf(post.id)).toBeNull();
  });
});

describe('#32 同時の再送でも行は 1 つ', () => {
  it('#32 同じ Token・同じ externalRef の 10 本同時が 1 行にまとまる', async () => {
    const { context } = await tokenContext();

    await Promise.all(
      Array.from({ length: 10 }, () =>
        createSocialPost(context, {
          socialAccountId: accountId,
          body: '同時の再送',
          scheduledAt: null,
          status: 'draft',
          externalRef: 'same-ref',
        }),
      ),
    );

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('social_posts').select('id').execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it('#32 10 本すべてが同じ id を返す', async () => {
    const { context } = await tokenContext();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        createSocialPost(context, {
          socialAccountId: accountId,
          body: '同時の再送',
          scheduledAt: null,
          status: 'draft',
          externalRef: 'same-ref',
        }),
      ),
    );

    expect(new Set(results.map((result) => result.post.id)).size).toBe(1);
  });

  it('#32 created が true になるのは 1 本だけ', async () => {
    const { context } = await tokenContext();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        createSocialPost(context, {
          socialAccountId: accountId,
          body: '同時の再送',
          scheduledAt: null,
          status: 'draft',
          externalRef: 'same-ref',
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it('#32 Token が違えば同じ externalRef でも別の行になる', async () => {
    const a = await tokenContext('app A');
    const b = await tokenContext('app B');

    const fromA = await createSocialPost(a.context, {
      socialAccountId: accountId,
      body: 'A',
      scheduledAt: null,
      status: 'draft',
      externalRef: 'same-ref',
    });
    const fromB = await createSocialPost(b.context, {
      socialAccountId: accountId,
      body: 'B',
      scheduledAt: null,
      status: 'draft',
      externalRef: 'same-ref',
    });

    expect(fromB.post.id).not.toBe(fromA.post.id);
    expect(fromB.created).toBe(true);
  });
});

describe('#37 配信中のガード', () => {
  async function scheduledAutoPost(): Promise<string> {
    const { post } = await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '配信待ち',
      scheduledAt: new Date(Date.now() - 60_000),
      status: 'scheduled',
      deliveryMode: 'auto',
    });
    await markPublishStarted(post.id, new Date());
    return post.id;
  }

  it('#37 配信中の投稿は本文を変えられない', async () => {
    // ジョブは着手時に読んだ内容を送る。その間の編集は
    // 「送った内容と保存内容が食い違う」を生む（設計 §6.2）。
    const id = await scheduledAutoPost();

    await expect(updateSocialPost(admin, { id, body: 'あとから直した' })).rejects.toThrowError(
      ValidationError,
    );
  });

  it('#37 配信中のガードのフィールドは status', async () => {
    const id = await scheduledAutoPost();

    const error = await errorFrom(updateSocialPost(admin, { id, body: 'あとから直した' }));

    expect((error as ValidationError).field).toBe('status');
  });

  it('#37 配信中の投稿は取りやめられない', async () => {
    const id = await scheduledAutoPost();

    await expect(updateSocialPost(admin, { id, status: 'draft' })).rejects.toThrowError(
      ValidationError,
    );
  });

  it('#37 配信中の投稿を published にできない', async () => {
    const id = await scheduledAutoPost();

    await expect(updateSocialPost(admin, { id, status: 'published' })).rejects.toThrowError(
      ValidationError,
    );
  });

  it('#37 着手印を NULL に戻せば更新できる', async () => {
    // 窓は最長でも PUBLISH_TIMEOUT_MS ＋次のジョブまで。
    const id = await scheduledAutoPost();

    await markPublishStarted(id, null);

    await expect(updateSocialPost(admin, { id, body: 'あとから直した' })).resolves.toMatchObject({
      body: 'あとから直した',
    });
  });

  it('#37 Data API の markFailed も同じ例外で止まる', async () => {
    const id = await scheduledAutoPost();
    const data = createPluginDataApi({
      pluginId: 'test-plugin',
      declaredPermissions: new Set(['social.read', 'social.write']),
      context: admin,
    });

    await expect(data.socialPosts.markFailed(id, 'どこかで失敗した')).rejects.toThrowError(
      ValidationError,
    );
  });

  it('#37 着手印の無い投稿は Data API から markFailed できる', async () => {
    const { post } = await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '着手していない',
      scheduledAt: null,
      status: 'draft',
    });
    const data = createPluginDataApi({
      pluginId: 'test-plugin',
      declaredPermissions: new Set(['social.read', 'social.write']),
      context: admin,
    });

    await expect(data.socialPosts.markFailed(post.id, 'どこかで失敗した')).resolves.toMatchObject({
      status: 'failed',
    });
  });
});
