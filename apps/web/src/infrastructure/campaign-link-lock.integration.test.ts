import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { Connection } from '@/database/provider';
import { campaignRepository } from '@/infrastructure/campaign-repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 紐づけ先の存在の確かめと共有ロック（045-campaign-input-500 設計 §4・§6.4、受け入れ条件 #24・#25）。
 *
 * `CampaignRepository.lockExistingLinks(connection, { siteIds, socialPostIds })` は、
 * 引数の ID のうち存在するものを返し、その行を `FOR KEY SHARE` で押さえる。
 * 押さえている間（トランザクションが終わるまで）、別の接続からその行を `DELETE` できない。
 *
 * 「別の接続」は同じ DB へ別に張った `pg.Client`（`job-lock.integration.test.ts` の形）。
 * 待ちの時間ではなく、`lock_timeout` の**時間切れで失敗する**（`55P03`）ことを見る（設計 §13 の 4。`sleep` に頼らない）。
 * **トランザクションのコールバックの中で**別の接続の要求を待つ（抜けるとコミットされ、ロックを確かめられない）。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** 実在するサイト S1 と SNS 投稿 P1。 */
let s1: string;
let p1: string;
/** テスト中に開いた別の接続。後始末で必ず閉じる。 */
const outsiders: pg.Client[] = [];

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `k${suffix}`,
        email: `k${suffix}@example.com`,
        display_name: 'campaign link lock test',
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
    loginId: `k${suffix}`,
    displayName: 'campaign link lock test',
    email: `k${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** 同じ DB へ別に張った接続。ロック待ちは 200ms で時間切れにする。 */
async function outsider(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  outsiders.push(client);
  await client.query("SET lock_timeout = '200ms'");
  return client;
}

/** 別の接続から行を消す。消えた行数を返す（失敗すれば reject）。 */
async function deleteFrom(
  client: pg.Client,
  table: 'sites' | 'social_posts',
  id: string,
): Promise<number> {
  const result = await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  return result.rowCount ?? 0;
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

/** トランザクションを張って `fn` を中で動かす。`fn` が終わるまでコミットされない。 */
function inTransaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T> {
  return withConnection((connection) => connection.transaction(fn));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('campaignlinklock');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  s1 = (
    await createSite(admin, {
      name: 'S1',
      url: 'https://s1.example.com',
      description: '',
      status: 'active',
    })
  ).id;
  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'アカウント',
    handle: '@lock',
    credential: null,
    status: 'connected',
  });
  p1 = (
    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'P1',
      scheduledAt: null,
      status: 'draft',
    })
  ).post.id;
});

afterEach(async () => {
  for (const client of outsiders.splice(0)) {
    await client.end();
  }
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #24 押さえている間は消せない                                                       */
/* -------------------------------------------------------------------------- */

describe('#24 lockExistingLinks で押さえた行は、トランザクションが終わるまで別の接続から消せない', () => {
  it('#24 トランザクションの中で { siteIds: [S1], socialPostIds: [P1] } → 両方がそのまま返る', async () => {
    const locked = await inTransaction((tx) =>
      campaignRepository.lockExistingLinks(tx, { siteIds: [s1], socialPostIds: [p1] }),
    );

    expect(locked).toEqual({ siteIds: [s1], socialPostIds: [p1] });
  });

  it('#24 押さえている間、別の接続の DELETE FROM sites（S1）がロック待ちの時間切れ（55P03）で失敗する', async () => {
    const other = await outsider();

    const error = await inTransaction(async (tx) => {
      await campaignRepository.lockExistingLinks(tx, { siteIds: [s1], socialPostIds: [p1] });
      return rejectionOf(deleteFrom(other, 'sites', s1));
    });

    expect((error as { code?: unknown }).code).toBe('55P03');
  });

  it('#24 押さえている間、別の接続の DELETE FROM social_posts（P1）がロック待ちの時間切れ（55P03）で失敗する', async () => {
    const other = await outsider();

    const error = await inTransaction(async (tx) => {
      await campaignRepository.lockExistingLinks(tx, { siteIds: [s1], socialPostIds: [p1] });
      return rejectionOf(deleteFrom(other, 'social_posts', p1));
    });

    expect((error as { code?: unknown }).code).toBe('55P03');
  });

  it('#24 トランザクションを終えた後は、別の接続から S1 を消せる（1 行）', async () => {
    const other = await outsider();
    await inTransaction((tx) =>
      campaignRepository.lockExistingLinks(tx, { siteIds: [s1], socialPostIds: [p1] }),
    );

    expect(await deleteFrom(other, 'sites', s1)).toBe(1);
  });

  it('#24 トランザクションを終えた後は、別の接続から P1 を消せる（1 行）', async () => {
    const other = await outsider();
    await inTransaction((tx) =>
      campaignRepository.lockExistingLinks(tx, { siteIds: [s1], socialPostIds: [p1] }),
    );

    expect(await deleteFrom(other, 'social_posts', p1)).toBe(1);
  });

  it('#24 押さえている間も、サイトの通常の更新（名前）は妨げない', async () => {
    const other = await outsider();

    const updated = await inTransaction(async (tx) => {
      await campaignRepository.lockExistingLinks(tx, { siteIds: [s1], socialPostIds: [] });
      const result = await other.query('UPDATE sites SET name = $1 WHERE id = $2', ['改名', s1]);
      return result.rowCount;
    });

    expect(updated).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #25 存在しない ID・空の配列                                                        */
/* -------------------------------------------------------------------------- */

describe('#25 lockExistingLinks は存在する ID だけを返し、空なら問い合わせない', () => {
  it('#25 { siteIds: [S1, 存在しない ID] } → siteIds が [S1]', async () => {
    const locked = await inTransaction((tx) =>
      campaignRepository.lockExistingLinks(tx, { siteIds: [s1, uuidv7()], socialPostIds: [] }),
    );

    expect(locked.siteIds).toEqual([s1]);
  });

  it('#25 { socialPostIds: [P1, 存在しない ID] } → socialPostIds が [P1]', async () => {
    const locked = await inTransaction((tx) =>
      campaignRepository.lockExistingLinks(tx, { siteIds: [], socialPostIds: [p1, uuidv7()] }),
    );

    expect(locked.socialPostIds).toEqual([p1]);
  });

  it('#25 種類の取り違え（siteIds に P1、socialPostIds に S1）→ どちらも返らない', async () => {
    const locked = await inTransaction((tx) =>
      campaignRepository.lockExistingLinks(tx, { siteIds: [p1], socialPostIds: [s1] }),
    );

    expect(locked).toEqual({ siteIds: [], socialPostIds: [] });
  });

  it('#25 両方が空の配列 → 空を返し、DB へ問い合わせない', async () => {
    // DB 境界の偽物：db のメソッドを 1 つでも呼べば記録して投げる。
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get(_target, property) {
          return () => {
            touched.push(String(property));
            throw new Error(`DB へ問い合わせた: ${String(property)}`);
          };
        },
      },
    );
    const connection = {
      db,
      transaction: () => {
        touched.push('transaction');
        throw new Error('トランザクションを張った');
      },
    } as unknown as Connection;

    const locked = await campaignRepository.lockExistingLinks(connection, {
      siteIds: [],
      socialPostIds: [],
    });

    expect(locked).toEqual({ siteIds: [], socialPostIds: [] });
    expect(touched).toEqual([]);
  });
});
