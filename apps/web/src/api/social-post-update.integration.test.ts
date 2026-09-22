import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as updateSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { isManualPending, type SocialPost } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `PATCH /api/v1/social/posts/{id}`（035-social-publishing 設計 §6.2）。
 *
 * 受け入れ条件 #22（更新側）、#34、#35、#36、#38。
 *
 * **ルートを直接叩く結合テスト**（実装プラン §2「テストの方法」）。
 * 偽の publisher はテストが `registerPublisher` で直接登録する。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
let writeToken: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `u${suffix}`,
        email: `u${suffix}@example.com`,
        display_name: 'social post update test',
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
    loginId: `u${suffix}`,
    displayName: 'social post update test',
    email: `u${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function publisherFor(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: 'x',
    label: 'X（テスト）',
    credentialFields: [],
    ...overrides,
  };
}

/** 手動投稿に対応した偽の publisher を登録する。 */
function registerManualPublisher(): void {
  registerPublisher(
    'test-plugin',
    publisherFor({ manual: () => ({ url: 'https://x.com/intent/post' }) }),
  );
}

async function callUpdate(id: string, body: unknown, token = writeToken): Promise<JsonResult> {
  const response = await updateSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** 手動投稿待ち（`manual` + `scheduled` + 予約時刻が過ぎている）の投稿を作る。 */
async function makeManualPendingPost(): Promise<SocialPost> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '手で投稿する',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'manual',
  });
  return post;
}

async function makeDraftPost(): Promise<SocialPost> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '下書き',
    scheduledAt: null,
    status: 'draft',
  });
  return post;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostupdate');
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
  const created = await createApiToken(admin, {
    name: 'update test',
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  writeToken = created.plaintext;
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

describe('#22 scheduled へ移す更新には予約日時が要る', () => {
  it('#22 scheduledAt を持たない投稿を scheduled にすると 422 scheduledAt', async () => {
    const post = await makeDraftPost();

    const result = await callUpdate(post.id, { status: 'scheduled' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('scheduledAt');
  });

  it('#22 scheduledAt を同時に送れば scheduled にできる', async () => {
    const post = await makeDraftPost();

    const result = await callUpdate(post.id, {
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(result.status).toBe(200);
  });
});

describe('#34 「投稿した」を記録する', () => {
  it('#34 published への更新が 200 で、状態が published になる', async () => {
    registerManualPublisher();
    const post = await makeManualPendingPost();

    const result = await callUpdate(post.id, {
      status: 'published',
      externalUrl: 'https://x.com/a/status/1',
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('published');
  });

  it('#34 published への更新で publishedAt が入る', async () => {
    registerManualPublisher();
    const post = await makeManualPendingPost();

    const result = await callUpdate(post.id, {
      status: 'published',
      externalUrl: 'https://x.com/a/status/1',
    });

    expect(dataOf(result)['publishedAt']).not.toBeNull();
  });

  it('#34 送った externalUrl が保存される', async () => {
    registerManualPublisher();
    const post = await makeManualPendingPost();

    const result = await callUpdate(post.id, {
      status: 'published',
      externalUrl: 'https://x.com/a/status/1',
    });

    expect(dataOf(result)['externalUrl']).toBe('https://x.com/a/status/1');
  });

  it('#34 externalUrl を省略しても 200 になる', async () => {
    // X の Web Intent は投稿の URL を返さないので、人が貼るとは限らない。
    registerManualPublisher();
    const post = await makeManualPendingPost();

    const result = await callUpdate(post.id, { status: 'published' });

    expect(result.status).toBe(200);
    expect(dataOf(result)['externalUrl']).toBeNull();
  });

  it('#34 published への更新で social.post.published が発火する', async () => {
    registerManualPublisher();
    const post = await makeManualPendingPost();
    const received: unknown[] = [];
    subscribe('social.post.published', (payload) => {
      received.push(payload);
    });

    await callUpdate(post.id, { status: 'published' });

    expect(received).toHaveLength(1);
  });
});

describe('#35 「取りやめ」で下書きへ戻す', () => {
  it('#35 draft への更新が 200 で、状態が draft になる', async () => {
    // 取りやめは失敗ではない。後で予約し直せる（設計 §6.2）。
    registerManualPublisher();
    const post = await makeManualPendingPost();

    const result = await callUpdate(post.id, { status: 'draft' });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('draft');
  });

  it('#35 取りやめた投稿は手動投稿待ちではなくなる', async () => {
    registerManualPublisher();
    const post = await makeManualPendingPost();
    expect(isManualPending(post, new Date())).toBe(true);

    const result = await callUpdate(post.id, { status: 'draft' });

    const updated = dataOf(result);
    expect(
      isManualPending(
        {
          deliveryMode: updated['deliveryMode'] as 'auto' | 'manual',
          status: updated['status'] as 'draft' | 'scheduled' | 'published' | 'failed',
          scheduledAt:
            updated['scheduledAt'] === null ? null : new Date(String(updated['scheduledAt'])),
        },
        new Date(),
      ),
    ).toBe(false);
  });
});

describe('#36 更新の 422', () => {
  it('#36 manual へ変える更新で provider が非対応なら 422 deliveryMode', async () => {
    // publisher を登録しない＝この provider は手動投稿に対応していない。
    const post = await makeDraftPost();

    const result = await callUpdate(post.id, { deliveryMode: 'manual' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('deliveryMode');
  });

  it('#36 manual の投稿に media を足すと 422 media', async () => {
    registerManualPublisher();
    const post = await makeManualPendingPost();

    const result = await callUpdate(post.id, {
      media: [{ url: 'https://cdn.example.com/a.png' }],
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });

  it('#36 externalUrl が http なら 422 externalUrl', async () => {
    const post = await makeDraftPost();

    const result = await callUpdate(post.id, { externalUrl: 'http://x.com/a/status/1' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('externalUrl');
  });

  it('#36 externalId が 201 文字なら 422 externalId', async () => {
    const post = await makeDraftPost();

    const result = await callUpdate(post.id, { externalId: 'e'.repeat(201) });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('externalId');
  });

  it('#36 externalId が 200 文字なら通る（境界）', async () => {
    const post = await makeDraftPost();

    const result = await callUpdate(post.id, { externalId: 'e'.repeat(200) });

    expect(result.status).toBe(200);
  });
});

describe('#38 failed への更新でイベントが発火する', () => {
  it('#38 status: failed で social.post.failed が発火する', async () => {
    // **現行は発火していない。** ジョブ以外の経路（Data API の markFailed を含む）でも
    // 購読側へ届く必要がある（設計 §9.6）。
    const post = await makeDraftPost();
    const received: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      received.push(payload);
    });

    await callUpdate(post.id, { status: 'failed', failureReason: '配信に失敗した' });

    expect(received).toHaveLength(1);
  });

  it('#38 payload は postId・accountId・status だけで failureReason を含まない', async () => {
    // 失敗理由は Plugin 由来の自由文で、資格情報を含みうる（設計 §9.6）。
    const post = await makeDraftPost();
    const received: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      received.push(payload);
    });

    await callUpdate(post.id, { status: 'failed', failureReason: '配信に失敗した' });

    expect(received[0]).toEqual({ postId: post.id, accountId: accountId, status: 'failed' });
  });
});

describe('認証と認可', () => {
  it('scope が social.read だけの Token では更新できない（403）', async () => {
    const post = await makeDraftPost();
    const readOnly = await createApiToken(admin, {
      name: 'read only',
      scopes: ['social.read'],
      expiresAt: null,
    });

    const result = await callUpdate(post.id, { body: 'y' }, readOnly.plaintext);

    expect(result.status).toBe(403);
  });

  it('存在しない ID は 404', async () => {
    const result = await callUpdate('01900000-0000-7000-8000-0000000000ff', { body: 'y' });

    expect(result.status).toBe(404);
  });
});
