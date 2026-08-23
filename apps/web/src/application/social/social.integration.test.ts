import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { ForbiddenError } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import {
  createSocialAccount,
  createSocialPost,
  deleteSocialAccount,
  getSocialAccount,
  listSocialAccounts,
  listSocialPosts,
  readSocialCredential,
  updateSocialAccount,
  updateSocialPost,
} from './social-use-cases';

/** 失敗することを期待する呼び出しから Error を取り出す。 */
async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('失敗するはずの処理が成功した');
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

const CREDENTIAL = 'super-secret-access-token-value';

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `n${suffix}`,
        email: `n${suffix}@example.com`,
        display_name: 'social test',
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
    loginId: `n${suffix}`,
    displayName: 'social test',
    email: `n${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function createAccount(overrides: Partial<Parameters<typeof createSocialAccount>[1]> = {}) {
  return createSocialAccount(admin, {
    provider: 'x',
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: CREDENTIAL,
    status: 'connected',
    ...overrides,
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('social');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('アカウント', () => {
  it('作成できる', async () => {
    const account = await createAccount();

    expect(account.provider).toBe('x');
    expect(account.displayName).toBe('とりふね公式');
    expect(account.credentialConfigured).toBe(true);
  });

  it('Core が知らない provider でも作成できる', async () => {
    // Plugin が新しいSNSを足せる必要がある。
    const account = await createAccount({ provider: 'mastodon' });

    expect(account.provider).toBe('mastodon');
  });

  it('provider の形式が不正なら ValidationError', async () => {
    await expect(createAccount({ provider: 'X.com' })).rejects.toThrowError(ValidationError);
  });

  it('表示名が空なら ValidationError', async () => {
    await expect(createAccount({ displayName: '  ' })).rejects.toThrowError(ValidationError);
  });

  it('資格情報が DB 上で平文になっていない', async () => {
    const account = await createAccount();

    const row = await withConnection((connection) =>
      connection.db
        .selectFrom('social_accounts')
        .select('credential')
        .where('id', '=', account.id)
        .executeTakeFirst(),
    );

    expect(row?.credential).not.toBeNull();
    expect(row?.credential).not.toContain(CREDENTIAL);
    expect(row?.credential).toMatch(/^v1\./);
  });

  it('Entity に資格情報の平文が載らない', async () => {
    const account = await createAccount();

    expect(JSON.stringify(account)).not.toContain(CREDENTIAL);
    expect(Object.keys(account)).not.toContain('credential');
  });

  it('資格情報を設定しなければ credentialConfigured が false', async () => {
    const account = await createAccount({ credential: null });

    expect(account.credentialConfigured).toBe(false);
  });

  it('資格情報を復号して取り出せる', async () => {
    const account = await createAccount();

    const secret = await readSocialCredential(admin, { id: account.id });

    expect(secret?.expose()).toBe(CREDENTIAL);
  });

  it('資格情報の読み出しは social.write を要求する', async () => {
    // 読めれば外部サービスで何でもできるため、read では弱すぎる。
    const account = await createAccount();
    const viewer = await contextFor(['viewer']);

    await expect(readSocialCredential(viewer, { id: account.id })).rejects.toThrowError(
      ForbiddenError,
    );
  });

  it('資格情報を更新できる', async () => {
    const account = await createAccount();

    await updateSocialAccount(admin, { id: account.id, credential: 'new-token' });

    const secret = await readSocialCredential(admin, { id: account.id });
    expect(secret?.expose()).toBe('new-token');
  });

  it('資格情報を指定しない更新で、既存の資格情報が消えない', async () => {
    // 区別しないと、表示名だけ直したつもりで資格情報が消える。
    const account = await createAccount();

    await updateSocialAccount(admin, { id: account.id, displayName: '新しい名前' });

    const secret = await readSocialCredential(admin, { id: account.id });
    expect(secret?.expose()).toBe(CREDENTIAL);
  });

  it('空文字を指定すると資格情報を消せる', async () => {
    const account = await createAccount();

    await updateSocialAccount(admin, { id: account.id, credential: '' });

    const updated = await getSocialAccount(admin, { id: account.id });
    expect(updated.credentialConfigured).toBe(false);
  });

  it('provider で絞り込める', async () => {
    await createAccount({ provider: 'x' });
    await createAccount({ provider: 'facebook' });

    const page = await listSocialAccounts(admin, { page: 1, perPage: 20, provider: 'facebook' });

    expect(page.items.map((a) => a.provider)).toEqual(['facebook']);
    expect(page.total).toBe(1);
  });

  it('存在しない ID で NotFoundError', async () => {
    await expect(
      getSocialAccount(admin, { id: '01900000-0000-7000-8000-0000000000ff' }),
    ).rejects.toThrowError(NotFoundError);
  });

  it('social.read が無ければ ForbiddenError', async () => {
    const noRole = await contextFor([]);
    await expect(
      listSocialAccounts(noRole, { page: 1, perPage: 20, provider: null }),
    ).rejects.toThrowError(ForbiddenError);
  });

  it('social.write だけでは削除できない', async () => {
    const account = await createAccount();
    const editor = await contextFor(['editor']);

    await expect(deleteSocialAccount(editor, { id: account.id })).rejects.toThrowError(
      ForbiddenError,
    );
  });
});

describe('投稿', () => {
  it('作成できる', async () => {
    const account = await createAccount();

    const post = await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'こんにちは',
      scheduledAt: null,
      status: 'draft',
    });

    expect(post.body).toBe('こんにちは');
    expect(post.status).toBe('draft');
  });

  it('本文が空なら ValidationError', async () => {
    const account = await createAccount();

    await expect(
      createSocialPost(admin, {
        socialAccountId: account.id,
        body: '   ',
        scheduledAt: null,
        status: 'draft',
      }),
    ).rejects.toThrowError(ValidationError);
  });

  it('本文が長すぎれば ValidationError', async () => {
    const account = await createAccount();

    await expect(
      createSocialPost(admin, {
        socialAccountId: account.id,
        body: 'a'.repeat(10_001),
        scheduledAt: null,
        status: 'draft',
      }),
    ).rejects.toThrowError(ValidationError);
  });

  it('存在しないアカウントIDなら ValidationError（FK違反で500にしない）', async () => {
    await expect(
      createSocialPost(admin, {
        socialAccountId: '01900000-0000-7000-8000-0000000000ff',
        body: 'x',
        scheduledAt: null,
        status: 'draft',
      }),
    ).rejects.toThrowError(ValidationError);
  });

  it('アカウントで絞り込める', async () => {
    const a = await createAccount({ handle: '@a' });
    const b = await createAccount({ handle: '@b' });
    await createSocialPost(admin, {
      socialAccountId: a.id,
      body: 'A',
      scheduledAt: null,
      status: 'draft',
    });
    await createSocialPost(admin, {
      socialAccountId: b.id,
      body: 'B',
      scheduledAt: null,
      status: 'draft',
    });

    const page = await listSocialPosts(admin, {
      page: 1,
      perPage: 20,
      socialAccountId: a.id,
      status: null,
    });

    expect(page.items.map((p) => p.body)).toEqual(['A']);
  });

  it('状態で絞り込める', async () => {
    const account = await createAccount();
    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'draft',
      scheduledAt: null,
      status: 'draft',
    });
    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'scheduled',
      scheduledAt: new Date(),
      status: 'scheduled',
    });

    const page = await listSocialPosts(admin, {
      page: 1,
      perPage: 20,
      socialAccountId: null,
      status: 'scheduled',
    });

    expect(page.items.map((p) => p.body)).toEqual(['scheduled']);
  });

  it('draft から scheduled、published へ進められる', async () => {
    const account = await createAccount();
    const post = await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'draft',
    });

    const scheduled = await updateSocialPost(admin, { id: post.id, status: 'scheduled' });
    expect(scheduled.status).toBe('scheduled');

    const published = await updateSocialPost(admin, { id: post.id, status: 'published' });
    expect(published.status).toBe('published');
    expect(published.publishedAt).not.toBeNull();
  });

  it('published から draft へ戻せない', async () => {
    // 起きた事実は書き換えない。
    const account = await createAccount();
    const post = await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'published',
    });

    await expect(updateSocialPost(admin, { id: post.id, status: 'draft' })).rejects.toThrowError(
      ValidationError,
    );
  });

  it('failed から draft へ戻せない', async () => {
    const account = await createAccount();
    const post = await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'failed',
    });

    await expect(updateSocialPost(admin, { id: post.id, status: 'draft' })).rejects.toThrowError(
      ValidationError,
    );
  });

  it('状態を触らない更新は published でも通る', async () => {
    const account = await createAccount();
    const post = await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'published',
    });

    await expect(updateSocialPost(admin, { id: post.id, body: 'y' })).resolves.toMatchObject({
      body: 'y',
    });
  });

  it('アカウントを削除すると投稿も消える', async () => {
    const account = await createAccount();
    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'draft',
    });

    await deleteSocialAccount(admin, { id: account.id });

    const page = await listSocialPosts(admin, {
      page: 1,
      perPage: 20,
      socialAccountId: null,
      status: null,
    });
    expect(page.items).toHaveLength(0);
  });
});

describe('イベント', () => {
  it('アカウント作成で social.account.connected が発火する', async () => {
    const received: unknown[] = [];
    subscribe('social.account.connected', (payload) => {
      received.push(payload);
    });

    const account = await createAccount();

    expect(received).toEqual([
      { accountId: account.id, provider: 'x', displayName: 'とりふね公式' },
    ]);
  });

  it('イベントのペイロードに資格情報が含まれない', async () => {
    // Plugin へ渡ると、そこから漏れる。
    const received: unknown[] = [];
    subscribe('social.account.connected', (payload) => {
      received.push(payload);
    });

    await createAccount();

    expect(JSON.stringify(received)).not.toContain(CREDENTIAL);
  });

  it('投稿作成で social.post.created が発火する', async () => {
    const received: unknown[] = [];
    const account = await createAccount();
    subscribe('social.post.created', (payload) => {
      received.push(payload);
    });

    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'draft',
    });

    expect(received).toHaveLength(1);
  });

  it('published への更新で social.post.published が発火する', async () => {
    const received: unknown[] = [];
    const account = await createAccount();
    const post = await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'x',
      scheduledAt: null,
      status: 'draft',
    });
    subscribe('social.post.published', (payload) => {
      received.push(payload);
    });

    await updateSocialPost(admin, { id: post.id, status: 'published' });

    expect(received).toHaveLength(1);
  });
});

describe('Secret の漏洩', () => {
  it('エラーに資格情報の平文が出ない', async () => {
    const error = await errorFrom(createAccount({ provider: 'BAD', credential: CREDENTIAL }));

    expect(`${error.message}\n${error.stack ?? ''}`).not.toContain(CREDENTIAL);
  });

  it('一覧の結果に資格情報の平文が出ない', async () => {
    await createAccount();

    const page = await listSocialAccounts(admin, { page: 1, perPage: 20, provider: null });

    expect(JSON.stringify(page)).not.toContain(CREDENTIAL);
  });
});
