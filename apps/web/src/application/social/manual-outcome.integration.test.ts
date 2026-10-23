import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { Connection } from '@/database/provider';
import { NotFoundError } from '@/domain/repository';
import { SocialPostStateChangedError, type SocialPost } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 手動投稿の結果の記録の競合・配信ジョブ・区画（055-social-pending-tab 設計 §5.6・§8.2・§8.6、受け入れ条件 #26・#27・#32）。
 *
 * **UseCase と Repository を直接呼ぶ結合テスト（B）。**
 *
 * * #26：読んだ後に配信方法を `auto` に変えた・`draft` にした行は、Repository の `recordManualOutcome`（条件付き更新の
 *   1 文）が `null` を返し、何も書かない。UseCase は `findPostById` で読んだ**後に**行を書き換えられると 409
 *   （`SocialPostStateChangedError`）。割り込みは `vi.spyOn(socialRepository, 'findPostById')` で元を呼んだ後に SQL で
 *   書き換え、読んだ時点の投稿を返す（実装プラン §2「テストの方法」）
 * * #27：配信ジョブは手動の予約を取り出さない（今のまま。前半は今も緑）。`posted` の後に回しても `published_at` は同じ
 * * #32：サイトに紐づいたトークンの文脈で区画の外の投稿に呼ぶ → `NotFoundError`
 *
 * `recordManualOutcome`（UseCase・Repository）はまだ無いので、UseCase は指定子を `string` の定数に置いた動的 import で、
 * Repository はメソッドの有無を確かめてから呼ぶ（054 実装プラン §8 の 43）。口の形は設計 §8.6 から写す。
 */

type ManualOutcome = 'posted' | 'not_posted';

interface RecordManualOutcomeInput {
  readonly id: string;
  readonly outcome: ManualOutcome;
  readonly expectedUpdatedAt: Date;
  readonly externalUrl?: string | null;
}

type RecordManualOutcome = (
  context: AuthorizationContext,
  input: RecordManualOutcomeInput,
) => Promise<{ readonly post: SocialPost }>;

interface RepositoryRecordInput {
  readonly id: string;
  readonly outcome: ManualOutcome;
  readonly externalUrl: string | null;
  readonly now: Date;
  readonly expectedUpdatedAt: Date;
}

type RepositoryRecord = (
  connection: Connection,
  input: RepositoryRecordInput,
) => Promise<SocialPost | null>;

const USE_CASES_MODULE: string = '@/application/social/social-use-cases';

async function recordManualOutcome(
  context: AuthorizationContext,
  input: RecordManualOutcomeInput,
): Promise<{ readonly post: SocialPost }> {
  const module = (await import(/* @vite-ignore */ USE_CASES_MODULE)) as {
    readonly recordManualOutcome?: RecordManualOutcome;
  };
  if (module.recordManualOutcome === undefined) {
    throw new Error('application/social/social-use-cases.ts に recordManualOutcome が無い');
  }
  return module.recordManualOutcome(context, input);
}

async function repositoryRecord(input: RepositoryRecordInput): Promise<SocialPost | null> {
  const method = (socialRepository as unknown as { recordManualOutcome?: RepositoryRecord })
    .recordManualOutcome;
  if (method === undefined) {
    throw new Error('infrastructure/social-repository.ts に recordManualOutcome が無い');
  }
  return withConnection((connection) =>
    connection.transaction((tx) => method.call(socialRepository, tx, input)),
  );
}

const BOTH_PROVIDER = 'mouc_both';
const REQUEST_INFO = { ipAddress: '203.0.113.56', userAgent: 'vitest' } as const;
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;
const HOUR = 60 * 60_000;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let acc: string;
let publishCalls = 0;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `mo${suffix}`,
        email: `mo${suffix}@example.com`,
        display_name: 'manual outcome test',
      })
      .execute();
    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });
  const identity: UserIdentity = {
    userId: id,
    loginId: `mo${suffix}`,
    displayName: 'manual outcome test',
    email: `mo${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { ...context, request: REQUEST_INFO };
}

function bothPublisher(): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [],
    publish: async () => {
      publishCalls += 1;
      return { ok: true, externalId: 'e1' };
    },
    manual: () => ({ url: 'https://example.com/intent/post' }),
  };
}

/** 手動・予約時刻を 1 時間過ぎた予約（手動投稿待ち）。 */
async function makeManualPending(accountId: string = acc): Promise<SocialPost> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '手動で投稿する本文です。',
    scheduledAt: new Date(Date.now() - HOUR),
    status: 'scheduled',
    deliveryMode: 'manual',
  });
  return post;
}

async function rewrite(id: string, set: RawBuilder<unknown>): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
}

interface PostRow {
  readonly status: string;
  readonly delivery_mode: string;
  readonly published_at: Date | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly updated_at: Date;
}

async function rowOf(id: string): Promise<PostRow> {
  return withConnection(async (connection) => {
    const result = await sql<PostRow>`
      SELECT status, delivery_mode, published_at, failed_at, failure_reason, updated_at
        FROM social_posts WHERE id = ${id}`.execute(connection.db);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`投稿が無い: ${id}`);
    return row;
  });
}

/**
 * UseCase が投稿を読んだ**直後**に行を書き換える（1 回目の `findPostById` だけ）。読んだ時点の投稿を返す。
 */
function interruptAfterRead(set: RawBuilder<unknown>): void {
  const original = socialRepository.findPostById.bind(socialRepository);
  vi.spyOn(socialRepository, 'findPostById').mockImplementationOnce(async (...args) => {
    const post = await original(...args);
    if (post !== null) {
      await rewrite(post.id, set);
    }
    return post;
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('manualoutcome');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  publishCalls = 0;
  registerPublisher('test-plugin', bothPublisher());
  admin = await contextFor('administrator');
  acc = (
    await createSocialAccount(admin, {
      provider: BOTH_PROVIDER,
      displayName: '両方',
      handle: '@manual',
      credential: null,
      status: 'connected',
    })
  ).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #26 競合
// ---------------------------------------------------------------------------

describe('#26 Repository の recordManualOutcome は条件付き更新の 1 文', () => {
  const interruptions: readonly (readonly [string, RawBuilder<unknown>, string, string])[] = [
    ['配信方法を auto に変えた行', sql`delivery_mode = 'auto'`, 'scheduled', 'auto'],
    ['draft にした行', sql`status = 'draft'`, 'draft', 'manual'],
  ];

  it.each(interruptions)(
    '#26 読んだ後に%sで呼ぶと null（更新されない）',
    async (_title, set, status, deliveryMode) => {
      const post = await makeManualPending();
      await rewrite(post.id, set);

      const result = await repositoryRecord({
        id: post.id,
        outcome: 'posted',
        externalUrl: null,
        now: new Date(),
        expectedUpdatedAt: post.updatedAt,
      });

      expect(result).toBeNull();
      const row = await rowOf(post.id);
      expect(row.status).toBe(status);
      expect(row.delivery_mode).toBe(deliveryMode);
      expect(row.published_at).toBeNull();
    },
  );

  it('#26 対照：書き換えていない手動の予約は更新され、published の投稿を返す', async () => {
    const post = await makeManualPending();

    const result = await repositoryRecord({
      id: post.id,
      outcome: 'posted',
      externalUrl: null,
      now: new Date(),
      expectedUpdatedAt: post.updatedAt,
    });

    expect(result?.status).toBe('published');
    expect((await rowOf(post.id)).status).toBe('published');
  });

  it('#26 expectedUpdatedAt が 1ms 違うと null（更新されない）', async () => {
    const post = await makeManualPending();

    const result = await repositoryRecord({
      id: post.id,
      outcome: 'not_posted',
      externalUrl: null,
      now: new Date(),
      expectedUpdatedAt: new Date(post.updatedAt.getTime() + 1),
    });

    expect(result).toBeNull();
    expect((await rowOf(post.id)).status).toBe('scheduled');
  });

  it('#26 UUID の形でない id は null', async () => {
    const result = await repositoryRecord({
      id: 'abc',
      outcome: 'posted',
      externalUrl: null,
      now: new Date(),
      expectedUpdatedAt: new Date(),
    });

    expect(result).toBeNull();
  });
});

describe('#26 UseCase は読んだ後に書き換えられた行に 409（SocialPostStateChangedError）', () => {
  it.each([
    ['配信方法を auto に変えた', sql`delivery_mode = 'auto'`],
    ['draft にした', sql`status = 'draft'`],
  ] as const)('#26 %s → SocialPostStateChangedError、行は書かれない', async (_title, set) => {
    const post = await makeManualPending();
    interruptAfterRead(set);

    await expect(
      recordManualOutcome(admin, {
        id: post.id,
        outcome: 'posted',
        expectedUpdatedAt: post.updatedAt,
      }),
    ).rejects.toBeInstanceOf(SocialPostStateChangedError);
    expect((await rowOf(post.id)).published_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #27 配信ジョブ
// ---------------------------------------------------------------------------

describe('#27 配信ジョブは手動の予約を取り出さない', () => {
  it('#27 予約時刻を過ぎた手動の予約は publishDuePosts の対象にならない（今のまま）', async () => {
    const post = await makeManualPending();

    await withConnection((connection) => publishDuePosts(connection));

    expect(publishCalls).toBe(0);
    expect((await rowOf(post.id)).status).toBe('scheduled');
  });

  it('#27 posted の後に publishDuePosts を走らせても published_at は変わらない', async () => {
    const post = await makeManualPending();
    await recordManualOutcome(admin, {
      id: post.id,
      outcome: 'posted',
      expectedUpdatedAt: post.updatedAt,
    });
    const afterRecord = await rowOf(post.id);

    await withConnection((connection) => publishDuePosts(connection));

    const row = await rowOf(post.id);
    expect(publishCalls).toBe(0);
    expect(row.status).toBe('published');
    expect(row.published_at).toEqual(afterRecord.published_at);
  });
});

// ---------------------------------------------------------------------------
// #32 区画
// ---------------------------------------------------------------------------

describe('#32 区画の外の投稿 → NotFoundError', () => {
  it('#32 サイト A のトークンの文脈でサイト B のアカウントの投稿に呼ぶ → NotFoundError、行は変わらない', async () => {
    const siteA = uuidv7();
    const siteB = uuidv7();
    await withConnection(async (connection) => {
      await sql`INSERT INTO sites (id, name, url)
                VALUES (${siteA}, 'サイト A', 'https://a.example.com/'),
                       (${siteB}, 'サイト B', 'https://b.example.com/')`.execute(connection.db);
    });
    const accSiteB = (
      await createSocialAccount(admin, {
        provider: BOTH_PROVIDER,
        displayName: 'サイト B のアカウント',
        handle: '@siteb',
        credential: null,
        status: 'connected',
        siteId: siteB,
      })
    ).id;
    const post = await makeManualPending(accSiteB);
    const created = await createApiToken(admin, {
      name: 'サイト A 連携',
      scopes: SNS_SCOPES,
      expiresAt: null,
      siteId: siteA,
    });
    const siteContext = await buildApiTokenContext(created.plaintext, REQUEST_INFO);
    if (siteContext.identity === null) throw new Error('トークンの文脈を作れない');

    await expect(
      recordManualOutcome(siteContext, {
        id: post.id,
        outcome: 'posted',
        expectedUpdatedAt: post.updatedAt,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await rowOf(post.id)).status).toBe('scheduled');
  });
});
