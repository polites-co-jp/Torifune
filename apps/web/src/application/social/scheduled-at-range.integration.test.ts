import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
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
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * SNS 投稿の `scheduledAt` の範囲を UseCase で確かめる（046-input-500-nul-and-ranges 設計 §6.5、受け入れ条件 #42）。
 *
 * `createSocialPost` / `updateSocialPost` を直接呼び、`scheduledAt` に `new Date(-62135596800001)`（`0001-01-01T00:00:00.000Z` の 1 ミリ秒前）を渡すと
 * `ValidationError`（`field === 'scheduledAt'`）で、何も書かれない。HTTP の Zod だけでは UseCase を直接呼ぶ経路が漏れるので、検査は UseCase にある。
 *
 * 範囲の境目ちょうど（`-62135596800000`・`253402300799999`）と `null` は従来どおり通る（対照）。
 */

const RANGE_TEXT =
  '0001-01-01T00:00:00Z から 9999-12-31T23:59:59.999Z までの日時を指定してください。';

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
        login_id: `sa${suffix}`,
        email: `sa${suffix}@example.com`,
        display_name: 'scheduled at range test',
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
    loginId: `sa${suffix}`,
    displayName: 'scheduled at range test',
    email: `sa${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
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

async function postRows(): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM social_posts`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
  });
}

async function makeDraft(): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '本文',
    scheduledAt: null,
    status: 'draft',
  });
  return post.id;
}

const OUT_OF_RANGE: readonly (readonly [string, number])[] = [
  ['-62135596800001（0001-01-01T00:00:00.000Z の 1 ミリ秒前）', -62135596800001],
  ['253402300800000（9999-12-31T23:59:59.999Z の 1 ミリ秒後）', 253402300800000],
  ['-8.64e15（JavaScript の Date の下限）', -8.64e15],
  ['8.64e15（JavaScript の Date の上限）', 8.64e15],
];

beforeAll(async () => {
  scratch = await useScratchDatabase('scheduledatrange');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  accountId = (
    await createSocialAccount(admin, {
      provider: 'x',
      displayName: 'とりふね公式',
      handle: '@torifune',
      credential: null,
      status: 'connected',
    })
  ).id;
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#42 createSocialPost の scheduledAt の範囲外は ValidationError', () => {
  it.each(OUT_OF_RANGE)(
    "#42 scheduledAt: new Date(%s) → ValidationError（field === 'scheduledAt'）",
    async (_label, ms) => {
      const error = await rejectionOf(
        createSocialPost(admin, {
          socialAccountId: accountId,
          body: '本文',
          scheduledAt: new Date(ms),
          status: 'scheduled',
        }),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('scheduledAt');
      expect((error as ValidationError).detail).toBe(RANGE_TEXT);
    },
  );

  it.each(OUT_OF_RANGE)('#42 scheduledAt: new Date(%s) → 何も書かれない', async (_label, ms) => {
    const before = await postRows();

    await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '本文',
      scheduledAt: new Date(ms),
      status: 'scheduled',
    }).catch(() => undefined);

    expect(await postRows()).toEqual(before);
  });

  it.each([
    ['-62135596800000（下の境目ちょうど）', -62135596800000],
    ['253402300799999（上の境目ちょうど）', 253402300799999],
  ] as const)('#42 対照：scheduledAt: new Date(%s) → 成功', async (_label, ms) => {
    const { post } = await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '本文',
      scheduledAt: new Date(ms),
      status: 'draft',
    });

    // 年が 0001 の値の読み戻しはサーバの Node のタイムゾーン（地方平均時のオフセット）に左右されうるので、
    // ここでは「作成できた」ことだけを見る（範囲の判定は #40 の単体テストが境目ちょうどで見ている）。
    expect(post.scheduledAt).toBeInstanceOf(Date);
  });

  it('#42 対照：scheduledAt: null → 成功', async () => {
    const { post } = await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '本文',
      scheduledAt: null,
      status: 'draft',
    });

    expect(post.scheduledAt).toBeNull();
  });
});

describe('#42 updateSocialPost の scheduledAt の範囲外は ValidationError', () => {
  it.each(OUT_OF_RANGE)(
    "#42 scheduledAt: new Date(%s) → ValidationError（field === 'scheduledAt'）",
    async (_label, ms) => {
      const id = await makeDraft();

      const error = await rejectionOf(updateSocialPost(admin, { id, scheduledAt: new Date(ms) }));

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('scheduledAt');
      expect((error as ValidationError).detail).toBe(RANGE_TEXT);
    },
  );

  it.each(OUT_OF_RANGE)('#42 scheduledAt: new Date(%s) → 行が変わらない', async (_label, ms) => {
    const id = await makeDraft();
    const before = await postRows();

    await updateSocialPost(admin, { id, scheduledAt: new Date(ms) }).catch(() => undefined);

    expect(await postRows()).toEqual(before);
  });

  it('#42 対照：scheduledAt に範囲内（2030-01-01T00:00:00Z）→ 成功', async () => {
    const id = await makeDraft();
    const at = new Date('2030-01-01T00:00:00Z');

    const post = await updateSocialPost(admin, { id, scheduledAt: at });

    expect(post.scheduledAt?.getTime()).toBe(at.getTime());
  });

  it('#42 対照：scheduledAt: null → 成功', async () => {
    const id = await makeDraft();

    const post = await updateSocialPost(admin, { id, scheduledAt: null });

    expect(post.scheduledAt).toBeNull();
  });
});
