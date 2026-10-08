import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { PermissionName } from '@/domain/permission';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 一括の UseCase（054-bulk-post-actions 設計 §5.2・§8.1.1・§8.2・§10.1、実装プラン §2 のテストの方法）。
 *
 * **UseCase を直接呼ぶ結合テスト（B）。** ルートを通さずに見るもの：
 *
 * * #25：同じ承認待ちの投稿を含む 2 本の一括承認を同時に呼ぶと、ちょうど 1 本で成功する（G4）
 * * #46：2 件目の項目だけ Repository が例外を投げると、その項目だけ `internal_error`（例外の文言を含まない）（G4）
 * * #51：Permission の無い文脈で一括の UseCase を呼ぶと `ForbiddenError` で、項目は 1 件も処理されない（G4 は承認の分）
 *
 * 一括の UseCase（`application/social/bulk-post-use-cases.ts`）はまだ無いので、指定子を `string` の定数に置いた
 * 動的 import で読む（053 実装プラン §8 の 19）。入出力の型は設計 §8.1・§8.2 と実装プラン T11 から写す
 * （`expectedUpdatedAt` は `Date`。ルートが文字列から直して渡す）。
 */

const BOTH_PROVIDER = 'bulk_uc_both';
const REQUEST_INFO = { ipAddress: '203.0.113.57', userAgent: 'vitest' } as const;

interface BulkItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly effect?: string;
  readonly post?: unknown;
  readonly reason?: string;
  readonly message?: string;
  readonly field?: string | null;
}

interface BulkOutput {
  readonly bulkId: string;
  readonly results: readonly BulkItemResult[];
}

interface BulkApproveInput {
  readonly publishTiming: 'now' | 'scheduled';
  readonly items: readonly { readonly id: string; readonly expectedUpdatedAt: Date }[];
  readonly budgetMs?: number;
}

type BulkApprove = (context: AuthorizationContext, input: BulkApproveInput) => Promise<BulkOutput>;

const BULK_USE_CASES_MODULE: string = '@/application/social/bulk-post-use-cases';

async function bulkApproveSocialPosts(
  context: AuthorizationContext,
  input: BulkApproveInput,
): Promise<BulkOutput> {
  const module = (await import(/* @vite-ignore */ BULK_USE_CASES_MODULE)) as {
    readonly bulkApproveSocialPosts?: BulkApprove;
  };
  if (module.bulkApproveSocialPosts === undefined) {
    throw new Error('application/social/bulk-post-use-cases.ts に bulkApproveSocialPosts が無い');
  }
  return module.bulkApproveSocialPosts(context, input);
}

/** 想定外の失敗の項目の文言（設計 §8.1.1）。 */
const INTERNAL_ERROR_MESSAGE = '処理中にエラーが発生しました。';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
/** 外部アプリのトークンの文脈（`social.read` + `social.write`）。承認待ちの投稿の登録に使う。 */
let appContext: AuthorizationContext;

async function createAdmin(): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `u${suffix}`;

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'bulk use cases test',
      })
      .execute();
    const role = await roleRepository.findByName(connection, 'administrator');
    if (role === null) throw new Error('ロールが無い: administrator');
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId,
    displayName: 'bulk use cases test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { ...context, request: REQUEST_INFO };
}

function bothPublisher(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: () => ({ url: 'https://example.com/intent/post' }),
    ...overrides,
  };
}

interface Awaiting {
  readonly id: string;
  readonly expectedUpdatedAt: Date;
}

/** 外部アプリのトークンで承認待ちの投稿を登録する。 */
async function makeAwaiting(): Promise<Awaiting> {
  const { post } = await createSocialPost(appContext, {
    socialAccountId: accountId,
    body: '一括の UseCase のテストの投稿です。',
    scheduledAt: null,
    publishTiming: 'after_approval',
  });
  return { id: post.id, expectedUpdatedAt: post.updatedAt };
}

interface PostRow {
  readonly status: string;
  readonly approved_at: Date | null;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, approved_at FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

async function auditCount(action: string, resourceId?: string): Promise<number> {
  return withConnection(async (connection) => {
    let query = connection.db
      .selectFrom('audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('resource_type', '=', 'social_post')
      .where('action', '=', action as never);
    if (resourceId !== undefined) {
      query = query.where('resource_id', '=', resourceId);
    }
    const row = await query.executeTakeFirst();
    return Number(row?.count ?? '0');
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

beforeAll(async () => {
  scratch = await useScratchDatabase('bulkpostusecases');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await createAdmin();
  registerPublisher('test-plugin', bothPublisher());
  accountId = (
    await createSocialAccount(admin, {
      provider: BOTH_PROVIDER,
      displayName: '両方',
      handle: '@bulk',
      credential: null,
      credentials: { token: 'secret-token' },
      status: 'connected',
    })
  ).id;
  const token = await createApiToken(admin, {
    name: 'ブログ連携',
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  appContext = await buildApiTokenContext(token.plaintext, REQUEST_INFO);
});

afterEach(async () => {
  vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// #25 同時の 2 本
// ---------------------------------------------------------------------------

describe('#25 同じ承認待ちの投稿を含む 2 本の一括承認を同時に呼ぶ', () => {
  it('#25 その投稿はちょうど 1 本で成功し、もう 1 本では not_applicable か stale', async () => {
    const post = await makeAwaiting();

    const [first, second] = await Promise.all([
      bulkApproveSocialPosts(admin, { publishTiming: 'now', items: [post] }),
      bulkApproveSocialPosts(admin, { publishTiming: 'now', items: [post] }),
    ]);

    const outcomes = [first.results[0], second.results[0]];
    expect(outcomes.filter((entry) => entry?.ok === true)).toHaveLength(1);
    const failed = outcomes.find((entry) => entry?.ok === false);
    expect(['not_applicable', 'stale']).toContain(failed?.reason);
  });

  it('#25 approved_at は 1 回だけ入る（監査 approved がその投稿に 1 行）', async () => {
    const post = await makeAwaiting();

    await Promise.all([
      bulkApproveSocialPosts(admin, { publishTiming: 'now', items: [post] }),
      bulkApproveSocialPosts(admin, { publishTiming: 'now', items: [post] }),
    ]);

    expect((await rowOf(post.id)).approved_at).not.toBeNull();
    expect(await auditCount('approved', post.id)).toBe(1);
  });

  it('#25 2 本の bulkId は別の値', async () => {
    const post = await makeAwaiting();

    const [first, second] = await Promise.all([
      bulkApproveSocialPosts(admin, { publishTiming: 'now', items: [post] }),
      bulkApproveSocialPosts(admin, { publishTiming: 'now', items: [post] }),
    ]);

    expect(first.bulkId).not.toBe(second.bulkId);
  });
});

// ---------------------------------------------------------------------------
// #46 想定外の失敗
// ---------------------------------------------------------------------------

describe('#46 想定外の例外はその項目だけ internal_error', () => {
  /** 2 回目の `findPostById` だけ reject させる（外部境界の失敗の見立て）。 */
  function failSecondFind(): void {
    const original = socialRepository.findPostById.bind(socialRepository);
    let calls = 0;
    vi.spyOn(socialRepository, 'findPostById').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('db down 1234');
      }
      return original(...args);
    });
  }

  it('#46 2 件目は internal_error、1・3 件目は成功する', async () => {
    const posts = [await makeAwaiting(), await makeAwaiting(), await makeAwaiting()];
    failSecondFind();

    const output = await bulkApproveSocialPosts(admin, { publishTiming: 'now', items: posts });

    expect(
      output.results.map((entry) => [entry.id, entry.ok, entry.effect ?? entry.reason]),
    ).toEqual([
      [posts[0]?.id, true, 'approved_now'],
      [posts[1]?.id, false, 'internal_error'],
      [posts[2]?.id, true, 'approved_now'],
    ]);
  });

  it('#46 internal_error の message は「処理中にエラーが発生しました。」で、例外の文言を含まない', async () => {
    const posts = [await makeAwaiting(), await makeAwaiting(), await makeAwaiting()];
    failSecondFind();

    const output = await bulkApproveSocialPosts(admin, { publishTiming: 'now', items: posts });

    expect(output.results[1]?.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(output.results[1])).not.toContain('db down');
    expect(output.results[1]?.field).toBeNull();
  });

  it('#46 internal_error の項目の行は承認待ちのまま', async () => {
    const posts = [await makeAwaiting(), await makeAwaiting(), await makeAwaiting()];
    failSecondFind();

    await bulkApproveSocialPosts(admin, { publishTiming: 'now', items: posts });

    expect((await rowOf(posts[1]?.id ?? '')).status).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #51 Permission の無い文脈（承認の分）
// ---------------------------------------------------------------------------

describe('#51 bulkApproveSocialPosts を social.approve の無い文脈で呼ぶ', () => {
  function withoutApprove(): AuthorizationContext {
    return {
      ...admin,
      permissions: new Set<PermissionName>(['social.read', 'social.write', 'social.delete']),
    };
  }

  it('#51 ForbiddenError', async () => {
    const post = await makeAwaiting();

    const error = await rejectionOf(
      bulkApproveSocialPosts(withoutApprove(), { publishTiming: 'now', items: [post] }),
    );

    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('#51 項目は 1 件も処理されない（投稿を読まず、承認待ちのまま、監査も残らない）', async () => {
    const post = await makeAwaiting();
    const find = vi.spyOn(socialRepository, 'findPostById');

    await rejectionOf(
      bulkApproveSocialPosts(withoutApprove(), { publishTiming: 'now', items: [post] }),
    );

    expect(find).not.toHaveBeenCalled();
    expect((await rowOf(post.id)).status).toBe('awaiting_approval');
    expect(await auditCount('approved')).toBe(0);
  });
});
