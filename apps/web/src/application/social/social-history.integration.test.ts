import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import {
  createSocialAccount,
  createSocialPost,
  listSocialPostHistory,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * SNS の配信履歴（026-screen-completion 設計 §4）。
 *
 * **配信の試行履歴テーブルは作らない。** `published` / `failed` は終端で、
 * 1つの投稿が持つ配信結果は高々1つ。履歴とは「結果が確定した投稿の一覧」である。
 */

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
        login_id: `h${suffix}`,
        email: `h${suffix}@example.com`,
        display_name: 'social history test',
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
    loginId: `h${suffix}`,
    displayName: 'social history test',
    email: `h${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function makePost(body: string): Promise<string> {
  const post = await createSocialPost(admin, {
    socialAccountId: accountId,
    body,
    scheduledAt: null,
    status: 'draft',
  });
  return post.id;
}

function history(status: 'published' | 'failed' | null = null) {
  return listSocialPostHistory(admin, { page: 1, perPage: 20, status });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialhistory');
  admin = await contextFor(['administrator']);
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    status: 'connected',
  });
  accountId = account.id;
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

describe('失敗の記録', () => {
  /**
   * **これが「失敗した理由が見えない」の根本原因だった。**
   * `markFailed(id, reason)` は理由を受け取ると宣言しているのに、
   * `UpdatePostInput` に置き場所が無く捨てられていた。
   */
  it('失敗の理由が保存され、読み直せる', async () => {
    const id = await makePost('落ちる投稿');

    const failed = await updateSocialPost(admin, {
      id,
      status: 'failed',
      failureReason: 'API が 401 を返した',
    });

    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('API が 401 を返した');
  });

  /** 失敗した時刻。`updated_at` は「最後に触った時刻」で、失敗した時刻ではない。 */
  it('失敗した時刻が記録される', async () => {
    const id = await makePost('落ちる投稿');

    const failed = await updateSocialPost(admin, {
      id,
      status: 'failed',
      failureReason: 'timeout',
    });

    expect(failed.failedAt).toBeInstanceOf(Date);
  });

  it('配信に成功したら配信時刻が入り、失敗時刻は空のまま', async () => {
    const id = await makePost('通る投稿');

    const published = await updateSocialPost(admin, { id, status: 'published' });

    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(published.failedAt).toBeNull();
    expect(published.failureReason).toBeNull();
  });

  /** 起きた事実は書き換えない。理由だけ差し替えられると記録が信用できなくなる。 */
  it('failed から他の状態へは戻せない', async () => {
    const id = await makePost('落ちる投稿');
    await updateSocialPost(admin, { id, status: 'failed', failureReason: 'timeout' });

    await expect(updateSocialPost(admin, { id, status: 'draft' })).rejects.toThrow();
  });
});

describe('履歴', () => {
  it('結果が確定した投稿だけを返す', async () => {
    const done = await makePost('配信済み');
    const failed = await makePost('失敗');
    await makePost('下書きのまま');
    const scheduled = await makePost('予約しただけ');
    await updateSocialPost(admin, { id: scheduled, status: 'scheduled' });

    await updateSocialPost(admin, { id: done, status: 'published' });
    await updateSocialPost(admin, { id: failed, status: 'failed', failureReason: 'timeout' });

    const page = await history();

    expect(page.items.map((post) => post.id).sort()).toEqual([done, failed].sort());
    expect(page.total).toBe(2);
  });

  /** 結果の新しい順。作成順ではない。 */
  it('結果が確定した順の新しい順に並ぶ', async () => {
    const first = await makePost('先に作って先に配信');
    const second = await makePost('後から作って後で失敗');

    await updateSocialPost(admin, { id: first, status: 'published' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await updateSocialPost(admin, { id: second, status: 'failed', failureReason: 'timeout' });

    const page = await history();

    expect(page.items.map((post) => post.id)).toEqual([second, first]);
  });

  it('失敗だけに絞れる', async () => {
    const done = await makePost('配信済み');
    const failed = await makePost('失敗');
    await updateSocialPost(admin, { id: done, status: 'published' });
    await updateSocialPost(admin, { id: failed, status: 'failed', failureReason: '429' });

    const page = await history('failed');

    expect(page.items.map((post) => post.id)).toEqual([failed]);
    expect(page.items[0]?.failureReason).toBe('429');
  });

  it('配信済みだけに絞れる', async () => {
    const done = await makePost('配信済み');
    const failed = await makePost('失敗');
    await updateSocialPost(admin, { id: done, status: 'published' });
    await updateSocialPost(admin, { id: failed, status: 'failed', failureReason: '429' });

    const page = await history('published');

    expect(page.items.map((post) => post.id)).toEqual([done]);
  });

  it('結果がまだ無ければ空', async () => {
    await makePost('下書きのまま');
    expect((await history()).items).toEqual([]);
  });

  it('social.read が無ければ見られない', async () => {
    const id = uuidv7();
    const suffix = id.replaceAll('-', '').slice(-12);
    const identity: UserIdentity = {
      userId: id,
      loginId: `n${suffix}`,
      displayName: 'no roles',
      email: `n${suffix}@example.com`,
      providerId: 'local',
      externalUserId: null,
    };
    await withConnection(async (connection) => {
      await connection.db
        .insertInto('users')
        .values({
          id,
          login_id: identity.loginId,
          email: identity.email,
          display_name: identity.displayName,
        })
        .execute();
    });
    const stranger = await withConnection(async (connection) =>
      authorizationContextFor(connection, identity),
    );

    await expect(
      listSocialPostHistory(stranger, { page: 1, perPage: 20, status: null }),
    ).rejects.toThrow(ForbiddenError);
  });
});
