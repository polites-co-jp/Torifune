import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  approveSocialPost,
  createSocialAccount,
  createSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { PermissionName } from '@/domain/permission';
import { SocialPostIneligibleError } from '@/domain/social/social';
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
 * * #51：Permission の無い文脈で一括の UseCase を呼ぶと `ForbiddenError` で、項目は 1 件も処理されない（G4 は承認の分、
 *   G5 は今すぐ送るの分）
 * * #28：`social.write` だけ（`social.approve` なし）の文脈で `publishSocialPostNow`：承認済みの予約は `approval_required`、
 *   承認を経ていない予約は成功（G5）
 * * #42：読んでから消すまでに着手された・状態が変わった行は `stale` で残る。`deletePostIf` を直接呼んでも 0 行（G6）
 * * #51 の取り消しの分（G6）
 * * #45：時間の予算（`budgetMs`）を過ぎてから始まるはずの項目は `timeout` で処理しない。始めた項目は最後まで処理する。
 *   承認の分に加え、今すぐ送る・取り消しにも同じ予算が掛かることを見る（設計 §8.6。G7）
 *
 * 一括の UseCase（`application/social/bulk-post-use-cases.ts`）と `publishSocialPostNow`（`social-use-cases.ts`）の
 * 未実装の口は、指定子を `string` の定数に置いた動的 import で読む（053 実装プラン §8 の 19）。入出力の型は設計 §8.1・
 * §8.2・§8.3 と実装プラン T11・T15・T16 から写す（`expectedUpdatedAt` は `Date`。ルートが文字列から直して渡す）。
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

interface BulkItemsInput {
  readonly items: readonly { readonly id: string; readonly expectedUpdatedAt: Date }[];
  readonly budgetMs?: number;
}

type BulkPublishNow = (context: AuthorizationContext, input: BulkItemsInput) => Promise<BulkOutput>;

async function bulkPublishSocialPostsNow(
  context: AuthorizationContext,
  input: BulkItemsInput,
): Promise<BulkOutput> {
  const module = (await import(/* @vite-ignore */ BULK_USE_CASES_MODULE)) as {
    readonly bulkPublishSocialPostsNow?: BulkPublishNow;
  };
  if (module.bulkPublishSocialPostsNow === undefined) {
    throw new Error(
      'application/social/bulk-post-use-cases.ts に bulkPublishSocialPostsNow が無い',
    );
  }
  return module.bulkPublishSocialPostsNow(context, input);
}

interface BulkDeleteInput {
  readonly ids: readonly string[];
  readonly budgetMs?: number;
}

type BulkDelete = (context: AuthorizationContext, input: BulkDeleteInput) => Promise<BulkOutput>;

async function bulkDeleteSocialPosts(
  context: AuthorizationContext,
  input: BulkDeleteInput,
): Promise<BulkOutput> {
  const module = (await import(/* @vite-ignore */ BULK_USE_CASES_MODULE)) as {
    readonly bulkDeleteSocialPosts?: BulkDelete;
  };
  if (module.bulkDeleteSocialPosts === undefined) {
    throw new Error('application/social/bulk-post-use-cases.ts に bulkDeleteSocialPosts が無い');
  }
  return module.bulkDeleteSocialPosts(context, input);
}

/** `publishSocialPostNow` の入出力（設計 §8.3・実装プラン T15）。 */
interface PublishNowInput {
  readonly id: string;
  readonly expectedUpdatedAt: Date;
  readonly bulkId?: string;
}

interface PublishNowOutput {
  readonly post: {
    readonly id: string;
    readonly scheduledAt: Date | null;
    readonly status: string;
  };
  readonly previousScheduledAt: Date | null;
  readonly approvalKept: boolean;
}

type PublishNow = (
  context: AuthorizationContext,
  input: PublishNowInput,
) => Promise<PublishNowOutput>;

const SOCIAL_USE_CASES_MODULE: string = '@/application/social/social-use-cases';

async function publishSocialPostNow(
  context: AuthorizationContext,
  input: PublishNowInput,
): Promise<PublishNowOutput> {
  const module = (await import(/* @vite-ignore */ SOCIAL_USE_CASES_MODULE)) as {
    readonly publishSocialPostNow?: PublishNow;
  };
  if (module.publishSocialPostNow === undefined) {
    throw new Error('application/social/social-use-cases.ts に publishSocialPostNow が無い');
  }
  return module.publishSocialPostNow(context, input);
}

/** 今すぐ送るの `approval_required` の文言（設計 §8.3 の 4）。 */
const APPROVAL_REQUIRED_MESSAGE = '承認済みの予約を今すぐ送るには、承認の権限が要ります。';

const HOUR = 60 * 60_000;

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
async function makeAwaiting(scheduledAt: Date | null = null): Promise<Awaiting> {
  const { post } = await createSocialPost(appContext, {
    socialAccountId: accountId,
    body: '一括の UseCase のテストの投稿です。',
    scheduledAt,
    publishTiming: 'after_approval',
  });
  return { id: post.id, expectedUpdatedAt: post.updatedAt };
}

/** 外部アプリのトークンで、承認を経ていない未来の予約を登録する。 */
async function makeScheduled(scheduledAt = new Date(Date.now() + HOUR)): Promise<Awaiting> {
  const { post } = await createSocialPost(appContext, {
    socialAccountId: accountId,
    body: '今すぐ送るのテストの投稿です。',
    scheduledAt,
    publishTiming: 'scheduled',
  });
  return { id: post.id, expectedUpdatedAt: post.updatedAt };
}

/** 承認済みの未来の予約（承認待ち → 管理者が `scheduled` の時機で承認）。 */
async function makeApprovedScheduled(): Promise<Awaiting> {
  const awaiting = await makeAwaiting(new Date(Date.now() + 2 * HOUR));
  const { post } = await approveSocialPost(admin, {
    id: awaiting.id,
    publishTiming: 'scheduled',
    expectedUpdatedAt: awaiting.expectedUpdatedAt,
  });
  return { id: post.id, expectedUpdatedAt: post.updatedAt };
}

interface PostRow {
  readonly status: string;
  readonly approved_at: Date | null;
  readonly scheduled_at: Date | null;
  readonly updated_at: Date;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, approved_at, scheduled_at, updated_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
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

// ---------------------------------------------------------------------------
// #28 social.write だけの文脈の今すぐ送る（G5）
// ---------------------------------------------------------------------------

describe('#28 social.write だけ（social.approve なし）の文脈で publishSocialPostNow', () => {
  /** 管理者の文脈を広げ、`permissions` だけ差し替える（既定のロールに social.write だけのものは無い。実装プラン §2）。 */
  function writeOnly(): AuthorizationContext {
    return { ...admin, permissions: new Set<PermissionName>(['social.read', 'social.write']) };
  }

  it('#28 承認済みの予約 → SocialPostIneligibleError（reason: approval_required）', async () => {
    const post = await makeApprovedScheduled();

    const error = await rejectionOf(publishSocialPostNow(writeOnly(), post));

    expect(error).toBeInstanceOf(SocialPostIneligibleError);
    expect((error as SocialPostIneligibleError).reason).toBe('approval_required');
  });

  it('#28 approval_required の行は変わらない', async () => {
    const post = await makeApprovedScheduled();
    const before = await rowOf(post.id);

    await rejectionOf(publishSocialPostNow(writeOnly(), post));

    expect(await rowOf(post.id)).toEqual(before);
  });

  it('#28 承認を経ていない予約 → 成功（scheduledAt がいま、approvalKept: false、previousScheduledAt は元の日時）', async () => {
    const desired = new Date(Date.now() + 3 * HOUR);
    const post = await makeScheduled(desired);

    const before = Date.now();
    const output = await publishSocialPostNow(writeOnly(), post);
    const after = Date.now();

    expect(output.post.id).toBe(post.id);
    expect(output.post.status).toBe('scheduled');
    expect(output.post.scheduledAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(output.post.scheduledAt?.getTime()).toBeLessThanOrEqual(after);
    expect(output.approvalKept).toBe(false);
    expect(output.previousScheduledAt?.getTime()).toBe(desired.getTime());
  });

  it('#28 判別力：social.approve を持つ管理者なら承認済みの予約も成功し、approvalKept: true', async () => {
    const post = await makeApprovedScheduled();

    const output = await publishSocialPostNow(admin, post);

    expect(output.approvalKept).toBe(true);
    expect((await rowOf(post.id)).approved_at).not.toBeNull();
  });

  it('#28 一括で呼ぶと承認済みの予約の項目だけ approval_required（field: null・設計の文言）、他は queued', async () => {
    const approved = await makeApprovedScheduled();
    const unapproved = await makeScheduled();

    const output = await bulkPublishSocialPostsNow(writeOnly(), { items: [approved, unapproved] });

    expect(output.results[0]).toEqual({
      id: approved.id,
      ok: false,
      reason: 'approval_required',
      field: null,
      message: APPROVAL_REQUIRED_MESSAGE,
    });
    expect(output.results[1]).toMatchObject({ id: unapproved.id, ok: true, effect: 'queued' });
  });
});

// ---------------------------------------------------------------------------
// #51 Permission の無い文脈（今すぐ送るの分。G5）
// ---------------------------------------------------------------------------

describe('#51 bulkPublishSocialPostsNow を social.write の無い文脈で呼ぶ', () => {
  function withoutWrite(): AuthorizationContext {
    return {
      ...admin,
      permissions: new Set<PermissionName>(['social.read', 'social.approve', 'social.delete']),
    };
  }

  it('#51 ForbiddenError', async () => {
    const post = await makeScheduled();

    const error = await rejectionOf(bulkPublishSocialPostsNow(withoutWrite(), { items: [post] }));

    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('#51 項目は 1 件も処理されない（投稿を読まず、行は変わらず、監査 updated も残らない）', async () => {
    const post = await makeScheduled();
    const before = await rowOf(post.id);
    const find = vi.spyOn(socialRepository, 'findPostById');

    await rejectionOf(bulkPublishSocialPostsNow(withoutWrite(), { items: [post] }));

    expect(find).not.toHaveBeenCalled();
    expect(await rowOf(post.id)).toEqual(before);
    expect(await auditCount('updated')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #42 読んでから消すまでの変化（G6）
// ---------------------------------------------------------------------------

/**
 * 項目の UseCase が投稿を読んだ**後に** `interrupt` を差し込み、読んだ時点の投稿を返す（読んでから消すまでの間。
 * 実装プラン §2 のテストの方法）。0 行のときの読み直しでは差し込まない（1 回目だけ）。
 */
function interruptAfterPostRead(interrupt: () => Promise<void>): void {
  const original = socialRepository.findPostById.bind(socialRepository);
  let calls = 0;
  vi.spyOn(socialRepository, 'findPostById').mockImplementation(async (...args) => {
    calls += 1;
    const post = await original(...args);
    if (calls === 1) {
      await interrupt();
    }
    return post;
  });
}

async function execute(statement: ReturnType<typeof sql>): Promise<void> {
  await withConnection(async (connection) => {
    await statement.execute(connection.db);
  });
}

/** 行が残っているか（状態と着手印）。無ければ null。 */
async function remaining(
  id: string,
): Promise<{ readonly status: string; readonly publish_started_at: Date | null } | null> {
  return withConnection(async (connection) => {
    const result = await sql<{ status: string; publish_started_at: Date | null }>`
      SELECT status, publish_started_at FROM social_posts WHERE id = ${id}`.execute(connection.db);
    return result.rows[0] ?? null;
  });
}

type DeletePostIf = (
  connection: unknown,
  id: string,
  condition: { readonly status: string },
) => Promise<boolean>;

/** Repository の `deletePostIf` を直接呼ぶ（まだ無いので型を写して読む。設計 §8.4 の 3）。 */
async function deletePostIf(id: string, status: string): Promise<boolean> {
  const method = (socialRepository as unknown as { readonly deletePostIf?: DeletePostIf })
    .deletePostIf;
  if (method === undefined) {
    throw new Error('infrastructure/social-repository.ts に deletePostIf が無い');
  }
  return withConnection((connection) =>
    connection.transaction((tx) => method.call(socialRepository, tx, id, { status })),
  );
}

/** 状態が変わった項目の `stale` の文言（1 件の操作の 409 の文言。実装プラン §8 の 7）。 */
const POST_STATE_CHANGED_MESSAGE = '投稿の状態が変わっています。読み直してからやり直してください。';

describe('#42 (B) 読んでから消すまでに着手された・状態が変わった行は stale で、行は残る', () => {
  it('#42 予約を読んだ後に配信ジョブが着手する → stale（field: null・409 の文言）、行と着手印は残る', async () => {
    const post = await makeScheduled();
    interruptAfterPostRead(() =>
      execute(sql`UPDATE social_posts SET publish_started_at = now() WHERE id = ${post.id}`),
    );

    const output = await bulkDeleteSocialPosts(admin, { ids: [post.id] });

    expect(output.results[0]).toEqual({
      id: post.id,
      ok: false,
      reason: 'stale',
      field: null,
      message: POST_STATE_CHANGED_MESSAGE,
    });
    const row = await remaining(post.id);
    expect(row?.status).toBe('scheduled');
    expect(row?.publish_started_at).not.toBeNull();
  });

  it('#42 下書きを読んだ後に状態が変わる（承認待ち）→ stale、行は変わった状態のまま残る', async () => {
    const { post } = await createSocialPost(appContext, {
      socialAccountId: accountId,
      body: '下書きの投稿です。',
      scheduledAt: null,
    });
    interruptAfterPostRead(() =>
      execute(
        sql`UPDATE social_posts SET status = 'awaiting_approval', updated_at = now() WHERE id = ${post.id}`,
      ),
    );

    const output = await bulkDeleteSocialPosts(admin, { ids: [post.id] });

    expect(output.results[0]).toMatchObject({ id: post.id, ok: false, reason: 'stale' });
    expect((await remaining(post.id))?.status).toBe('awaiting_approval');
  });

  it('#42 stale の項目は監査 deleted を残さない', async () => {
    const post = await makeScheduled();
    interruptAfterPostRead(() =>
      execute(sql`UPDATE social_posts SET publish_started_at = now() WHERE id = ${post.id}`),
    );

    await bulkDeleteSocialPosts(admin, { ids: [post.id] });

    expect(await auditCount('deleted')).toBe(0);
  });

  it('#42 deletePostIf を直接呼んでも、読んだのと違う状態なら 0 行（false）で行は残る', async () => {
    const post = await makeScheduled();

    const deleted = await deletePostIf(post.id, 'draft');

    expect(deleted).toBe(false);
    expect(await remaining(post.id)).not.toBeNull();
  });

  it('#42 deletePostIf を直接呼んでも、着手印があれば 0 行（false）で行は残る', async () => {
    const post = await makeScheduled();
    await execute(sql`UPDATE social_posts SET publish_started_at = now() WHERE id = ${post.id}`);

    const deleted = await deletePostIf(post.id, 'scheduled');

    expect(deleted).toBe(false);
    expect(await remaining(post.id)).not.toBeNull();
  });

  it('#42 deletePostIf は UUID の形でない ID で false（例外を投げない）', async () => {
    expect(await deletePostIf('abc', 'draft')).toBe(false);
  });

  it('#42 判別力：状態が同じで着手印が無ければ deletePostIf は true で行が消える', async () => {
    const post = await makeScheduled();

    const deleted = await deletePostIf(post.id, 'scheduled');

    expect(deleted).toBe(true);
    expect(await remaining(post.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #51 Permission の無い文脈（取り消しの分。G6）
// ---------------------------------------------------------------------------

describe('#51 bulkDeleteSocialPosts を social.delete の無い文脈で呼ぶ', () => {
  function withoutDelete(): AuthorizationContext {
    return {
      ...admin,
      permissions: new Set<PermissionName>(['social.read', 'social.write', 'social.approve']),
    };
  }

  it('#51 ForbiddenError', async () => {
    const post = await makeScheduled();

    const error = await rejectionOf(bulkDeleteSocialPosts(withoutDelete(), { ids: [post.id] }));

    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('#51 項目は 1 件も処理されない（投稿を読まず、行は残り、監査 deleted も残らない）', async () => {
    const post = await makeScheduled();
    const find = vi.spyOn(socialRepository, 'findPostById');

    await rejectionOf(bulkDeleteSocialPosts(withoutDelete(), { ids: [post.id] }));

    expect(find).not.toHaveBeenCalled();
    expect(await remaining(post.id)).not.toBeNull();
    expect(await auditCount('deleted')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #45 時間の予算（G7）
// ---------------------------------------------------------------------------

/** 時間の予算を過ぎて処理しなかった項目の文言（設計 §8.6）。 */
const TIMEOUT_MESSAGE = '時間内に処理できませんでした。もう一度操作してください。';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `validate()` が待つ publisher に差し替える（実装プラン §2 のテストの方法）。投稿を登録した**後に**呼ぶ
 * （登録の `validate()` は待たせない）。`delayFor` は何回目の呼び出しかを受けて待つミリ秒を返す。
 */
function useSlowValidate(delayFor: (call: number) => number): void {
  let calls = 0;
  resetPublisherRegistry();
  registerPublisher(
    'test-plugin',
    bothPublisher({
      validate: async () => {
        calls += 1;
        await sleep(delayFor(calls));
        return [];
      },
    }),
  );
}

/** 予算を過ぎて処理しなかった項目の結果（設計 §8.6、実装プラン §8 の 8：`field` は `null`）。 */
function timedOut(id: string | undefined): BulkItemResult {
  return { id: id ?? '', ok: false, reason: 'timeout', field: null, message: TIMEOUT_MESSAGE };
}

describe('#45 (B) 一括承認の時間の予算（budgetMs: 50、validate() が 40ms かかる publisher で承認待ち 5 件）', () => {
  async function fiveAwaiting(): Promise<Awaiting[]> {
    const posts: Awaiting[] = [];
    for (let index = 0; index < 5; index += 1) {
      posts.push(await makeAwaiting());
    }
    return posts;
  }

  it('#45 results は 5 件で、要求の並びと同じ順', async () => {
    const posts = await fiveAwaiting();
    useSlowValidate(() => 40);

    const output = await bulkApproveSocialPosts(admin, {
      publishTiming: 'now',
      items: posts,
      budgetMs: 50,
    });

    expect(output.results.map((entry) => entry.id)).toEqual(posts.map((post) => post.id));
  });

  it('#45 先頭から処理した項目は成功し（1 件以上）、その後ろはすべて timeout', async () => {
    const posts = await fiveAwaiting();
    useSlowValidate(() => 40);

    const output = await bulkApproveSocialPosts(admin, {
      publishTiming: 'now',
      items: posts,
      budgetMs: 50,
    });

    const outcomes = output.results.map((entry) => entry.effect ?? entry.reason);
    const firstNotApproved = outcomes.findIndex((outcome) => outcome !== 'approved_now');
    // 1 件目は予算の前に始まる。成功の並びの後ろに、成功が混ざらない（予算を過ぎたら残りはすべて処理しない）
    expect(firstNotApproved).toBeGreaterThanOrEqual(1);
    expect(outcomes.slice(firstNotApproved).every((outcome) => outcome === 'timeout')).toBe(true);
  });

  it('#45 予算を過ぎてから始まるはずの 3〜5 件目は timeout（field: null・設計の文言）', async () => {
    const posts = await fiveAwaiting();
    useSlowValidate(() => 40);

    const output = await bulkApproveSocialPosts(admin, {
      publishTiming: 'now',
      items: posts,
      budgetMs: 50,
    });

    // 3 件目を始める時点で少なくとも 40ms × 2 = 80ms が経っている（> 50ms）
    expect(output.results.slice(2)).toEqual(posts.slice(2).map((post) => timedOut(post.id)));
  });

  it('#45 timeout の行は承認待ちのまま変わらず、監査 approved は成功した項目の分だけ', async () => {
    const posts = await fiveAwaiting();
    const before = await Promise.all(posts.map((post) => rowOf(post.id)));
    useSlowValidate(() => 40);

    const output = await bulkApproveSocialPosts(admin, {
      publishTiming: 'now',
      items: posts,
      budgetMs: 50,
    });

    const timeouts = output.results
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.reason === 'timeout');
    expect(timeouts.length).toBeGreaterThanOrEqual(3);
    for (const { entry, index } of timeouts) {
      const row = await rowOf(entry.id);
      expect(row.status).toBe('awaiting_approval');
      expect(row).toEqual(before[index]);
      expect(await auditCount('approved', entry.id)).toBe(0);
    }
    const successes = output.results.filter((entry) => entry.ok).length;
    expect(await auditCount('approved')).toBe(successes);
  });

  it('#45 予算を過ぎた時点で処理中だった項目は最後まで処理され、成功する（予算の検査は各項目を始める前だけ）', async () => {
    const posts = await fiveAwaiting();
    // 1 件目の validate() だけ予算（50ms）を大きく超えて待つ。始めた後に予算を過ぎる
    useSlowValidate((call) => (call === 1 ? 120 : 0));

    const output = await bulkApproveSocialPosts(admin, {
      publishTiming: 'now',
      items: posts,
      budgetMs: 50,
    });

    expect(output.results[0]).toMatchObject({ id: posts[0]?.id, ok: true, effect: 'approved_now' });
    const first = await rowOf(posts[0]?.id ?? '');
    expect(first.status).toBe('scheduled');
    expect(first.approved_at).not.toBeNull();
    expect(output.results.slice(1)).toEqual(posts.slice(1).map((post) => timedOut(post.id)));
  });

  it('#45 判別力：budgetMs を渡さなければ（既定 BULK_BUDGET_MS）同じ 5 件はすべて成功する', async () => {
    const posts = await fiveAwaiting();
    useSlowValidate(() => 40);

    const output = await bulkApproveSocialPosts(admin, { publishTiming: 'now', items: posts });

    expect(output.results.map((entry) => entry.effect ?? entry.reason)).toEqual(
      posts.map(() => 'approved_now'),
    );
  });
});

describe('#45 (B) 今すぐ送る・一括取り消しにも同じ時間の予算が掛かる（設計 §8.6「一括の UseCase」）', () => {
  it('#45 今すぐ送る：処理中だった 1 件目は queued、2・3 件目は timeout で予約日時は変わらない', async () => {
    const posts = [await makeScheduled(), await makeScheduled(), await makeScheduled()];
    const before = await Promise.all(posts.map((post) => rowOf(post.id)));
    useSlowValidate((call) => (call === 1 ? 120 : 0));

    const output = await bulkPublishSocialPostsNow(admin, { items: posts, budgetMs: 50 });

    expect(output.results[0]).toMatchObject({ id: posts[0]?.id, ok: true, effect: 'queued' });
    expect(output.results.slice(1)).toEqual(posts.slice(1).map((post) => timedOut(post.id)));
    expect(await rowOf(posts[1]?.id ?? '')).toEqual(before[1]);
    expect(await rowOf(posts[2]?.id ?? '')).toEqual(before[2]);
  });

  it('#45 一括取り消し：処理中だった 1 件目は deleted、2・3 件目は timeout で行は残る', async () => {
    const posts = [await makeScheduled(), await makeScheduled(), await makeScheduled()];
    // 取り消しは validate() を呼ばない。1 件目の投稿の読み出しを予算より長く待たせる
    interruptAfterPostRead(() => sleep(120));

    const output = await bulkDeleteSocialPosts(admin, {
      ids: posts.map((post) => post.id),
      budgetMs: 50,
    });

    expect(output.results[0]).toMatchObject({ id: posts[0]?.id, ok: true, effect: 'deleted' });
    expect(await remaining(posts[0]?.id ?? '')).toBeNull();
    expect(output.results.slice(1)).toEqual(posts.slice(1).map((post) => timedOut(post.id)));
    expect(await remaining(posts[1]?.id ?? '')).not.toBeNull();
    expect(await remaining(posts[2]?.id ?? '')).not.toBeNull();
  });
});
