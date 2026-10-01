import type { PluginDataApi } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createPluginDataApi } from './data-api';

/**
 * Data API の `socialPosts.markPublished` / `markFailed` は承認待ちの投稿を reject する
 * （048-social-post-approval 設計 §9.1・§9.2 の 2、受け入れ条件 #33）。
 *
 * 承認待ちは「まだ誰も出してよいと言っていない」状態で、そこから配信の結果を記録できない（設計 §6.3.1）。
 * reject は `ValidationError`（`field === 'status'`）で、**行は変わらない**。
 * 対照として、同じ呼び出しが予約（`scheduled`）の投稿では通ることも見る（判別力）。
 */

const PLUGIN_ID = 'approval-check-plugin';

/** publisher を登録していない provider（`auto` の下書き・承認待ちは登録できる）。 */
const PROVIDER = 'apr_dataapi';

interface ErrorShape {
  readonly name?: unknown;
  readonly field?: unknown;
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'data api approval test',
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
    loginId: `a${suffix}`,
    displayName: 'data api approval test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(): PluginDataApi {
  return createPluginDataApi({
    pluginId: PLUGIN_ID,
    declaredPermissions: new Set(['social.read', 'social.write']),
    context: admin,
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

async function makePost(status: 'awaiting_approval' | 'scheduled'): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '承認を待つ本文',
    scheduledAt: new Date(Date.now() + 60 * 60_000),
    status,
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly published_at: Date | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly external_id: string | null;
  readonly updated_at: Date;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select([
        'status',
        'published_at',
        'failed_at',
        'failure_reason',
        'external_id',
        'updated_at',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('dataapiapproval');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  accountId = (
    await createSocialAccount(admin, {
      provider: PROVIDER,
      displayName: '承認待ちの検査',
      handle: '@approval',
      credential: null,
      status: 'connected',
    })
  ).id;
});

afterEach(async () => {
  resetEventHandlers();
  resetPublisherRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#33 markPublished / markFailed は承認待ちの投稿を reject する', () => {
  it("#33 markPublished を承認待ちの投稿に呼ぶと ValidationError（field === 'status'）", async () => {
    const id = await makePost('awaiting_approval');

    const error = await rejectionOf(apiFor().socialPosts.markPublished(id, { externalId: 'e1' }));

    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('status');
  });

  it("#33 markFailed を承認待ちの投稿に呼ぶと ValidationError（field === 'status'）", async () => {
    const id = await makePost('awaiting_approval');

    const error = await rejectionOf(apiFor().socialPosts.markFailed(id, '送れませんでした'));

    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('status');
  });

  it('#33 markPublished の reject の後も行は変わらない', async () => {
    const id = await makePost('awaiting_approval');
    const before = await rowOf(id);

    await rejectionOf(apiFor().socialPosts.markPublished(id, { externalId: 'e1' }));

    expect(await rowOf(id)).toEqual(before);
  });

  it('#33 markFailed の reject の後も行は変わらない', async () => {
    const id = await makePost('awaiting_approval');
    const before = await rowOf(id);

    await rejectionOf(apiFor().socialPosts.markFailed(id, '送れませんでした'));

    expect(await rowOf(id)).toEqual(before);
  });

  it('#33 対照：予約（scheduled）の投稿には markPublished が通る', async () => {
    const id = await makePost('scheduled');

    const view = await apiFor().socialPosts.markPublished(id, { externalId: 'e1' });

    expect(view.status).toBe('published');
  });

  it('#33 承認待ちの投稿は socialPosts.get で status: awaiting_approval として読める', async () => {
    const id = await makePost('awaiting_approval');

    const view = await apiFor().socialPosts.get(id);

    expect(view?.status).toBe('awaiting_approval');
  });
});
