import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ALL_SCOPE } from '@/domain/social/access-scope';
import { INTERRUPTED_REASON, isDue, type SkipVerdict } from '@/domain/social/publishing';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信ジョブの書き込みの条件を Repository を直接呼んで固定する
 * （049-publish-claim-conditions 設計 §6.1〜§6.4、受け入れ条件 #1〜#9・#21・#22）。
 *
 * **着手（`claimForPublish`）と支度待ちへ送る（`deferSkipped`）は、取り出し（`listDue`）と同じ条件を
 * 同じ 1 文の中で見る。** 列を作ってから書くまでに `PATCH` で予約日時を未来へ直された・手動投稿へ変えられた行に
 * 書かないため。条件に当たらなければ `null` / 0 を返し、行には何も書かない（`updated_at` も変えない）。
 *
 * 一方、**結果の記録（`recordOutcome`）と中断の判定（`failInterrupted`）はこの条件を見ない**（設計 §6.4）。
 * #21・#22 がその判断を固定する（後から述語を掛けると、送った投稿が記録されなくなる）。
 *
 * 「期限の来た自動配信の予約」は `createSocialPost`（`scheduled`・`auto`・過去の `scheduledAt`）で作り、
 * 設計が「SQL で直接作る」とした配置と時刻の書き換えは SQL で書く（実装プラン §2 のテストの方法）。
 * 時刻は ±1 時間で置き、境界の秒には置かない（設計 #9）。
 */

const PROVIDER = 'claimcond';
const HOUR_MS = 60 * 60_000;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `clc${suffix}`,
        email: `clc${suffix}@example.com`,
        display_name: 'publish claim conditions test',
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
    loginId: `clc${suffix}`,
    displayName: 'publish claim conditions test',
    email: `clc${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function accountFor(): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    status: 'connected',
  });
  return account.id;
}

/** 期限の来た自動配信の予約（予約日時は 1 時間前、`next_attempt_at` なし）。 */
async function makeDuePost(accountId: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '配信される本文',
    scheduledAt: new Date(Date.now() - HOUR_MS),
    status: 'scheduled',
    deliveryMode: 'auto',
  });
  return post.id;
}

/** 行を SQL で書き換える（設計が「SQL で直接作る」とした配置と、時刻の書き換え）。 */
type Arrange = (id: string) => RawBuilder<unknown>;

async function arrange(id: string, statement: Arrange): Promise<void> {
  await withConnection(async (connection) => {
    await statement(id).execute(connection.db);
  });
}

const toManual: Arrange = (id) =>
  sql`UPDATE social_posts SET delivery_mode = 'manual' WHERE id = ${id}`;
const toFutureSchedule: Arrange = (id) =>
  sql`UPDATE social_posts SET scheduled_at = now() + interval '1 hour' WHERE id = ${id}`;
const toNullSchedule: Arrange = (id) =>
  sql`UPDATE social_posts SET scheduled_at = NULL WHERE id = ${id}`;
const toFutureNextAttempt: Arrange = (id) =>
  sql`UPDATE social_posts SET next_attempt_at = now() + interval '1 hour' WHERE id = ${id}`;

/** 「行が変わらない」を見る列（実装プラン §2 のテストの方法。`updated_at` も含める）。 */
interface WatchedRow {
  readonly status: string;
  readonly delivery_mode: string;
  readonly scheduled_at: Date | null;
  readonly publish_started_at: Date | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly skip_count: number;
  readonly skip_reason: string | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly published_at: Date | null;
  readonly updated_at: Date;
}

async function watched(id: string): Promise<WatchedRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select([
        'status',
        'delivery_mode',
        'scheduled_at',
        'publish_started_at',
        'attempt_count',
        'next_attempt_at',
        'skip_count',
        'skip_reason',
        'failed_at',
        'failure_reason',
        'published_at',
        'updated_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as WatchedRow;
}

async function claim(id: string) {
  return withConnection(async (connection) => socialRepository.claimForPublish(connection, id));
}

async function defer(id: string, verdict: SkipVerdict): Promise<number> {
  return withConnection(async (connection) =>
    socialRepository.deferSkipped(connection, id, verdict),
  );
}

/** 支度待ちの判定（`deferred`）。設計 #5 の値。 */
function deferredVerdict(): SkipVerdict {
  return {
    kind: 'deferred',
    skipCount: 1,
    reason: 'no_publisher',
    nextAttemptAt: new Date(Date.now() + HOUR_MS),
  };
}

/** 支度待ちの判定（`failed`。3 回目で取りやめる）。設計 #6〜#8 の値。 */
function failedVerdict(): SkipVerdict {
  return {
    kind: 'failed',
    skipCount: 3,
    reason: 'no_publisher',
    failureReason: '約24時間が過ぎたため取りやめました（テスト）。',
  };
}

const VERDICTS = [
  { name: 'deferred', verdict: deferredVerdict },
  { name: 'failed（skipCount: 3）', verdict: failedVerdict },
] as const;

beforeAll(async () => {
  scratch = await useScratchDatabase('publishclaimconditions');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor('administrator');
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #1〜#4 claimForPublish の条件（設計 §6.2）
// ---------------------------------------------------------------------------

describe('claimForPublish の条件', () => {
  it('#1 期限の来た自動配信の予約は今までどおり掴め、着手印が立つ', async () => {
    const postId = await makeDuePost(await accountFor());

    const claimed = await claim(postId);

    expect(claimed?.id).toBe(postId);
    expect(claimed?.publishStartedAt).toBeInstanceOf(Date);
  });

  it('#1 掴んだ行の attemptCount が 1 増える', async () => {
    const postId = await makeDuePost(await accountFor());
    const before = await watched(postId);

    const claimed = await claim(postId);

    expect(claimed?.attemptCount).toBe(before.attempt_count + 1);
  });

  it('#1 掴んだ行は skipCount 0・skipReason null・nextAttemptAt null になる', async () => {
    const postId = await makeDuePost(await accountFor());
    // 一度飛ばされた履歴を持たせて、数え直しが消えることを見る（next_attempt_at は無いまま）。
    await arrange(
      postId,
      (id) =>
        sql`UPDATE social_posts SET skip_count = 1, skip_reason = 'credential_missing' WHERE id = ${id}`,
    );

    const claimed = await claim(postId);

    expect({
      skipCount: claimed?.skipCount,
      skipReason: claimed?.skipReason,
      nextAttemptAt: claimed?.nextAttemptAt,
    }).toEqual({ skipCount: 0, skipReason: null, nextAttemptAt: null });
  });

  const REJECTED = [
    { no: '#2', name: "delivery_mode = 'manual'", statement: toManual },
    { no: '#3', name: 'scheduled_at が 1 時間後', statement: toFutureSchedule },
    { no: '#4', name: 'scheduled_at が NULL', statement: toNullSchedule },
  ] as const;

  for (const { no, name, statement } of REJECTED) {
    it(`${no} 他の条件が揃っていて ${name} の行は null`, async () => {
      const postId = await makeDuePost(await accountFor());
      await arrange(postId, statement);

      expect(await claim(postId)).toBeNull();
    });

    it(`${no} 他の条件が揃っていて ${name} の行は変わらない`, async () => {
      const postId = await makeDuePost(await accountFor());
      await arrange(postId, statement);
      const before = await watched(postId);

      await claim(postId);

      expect(await watched(postId)).toEqual(before);
    });
  }
});

// ---------------------------------------------------------------------------
// #5〜#8 deferSkipped の条件（設計 §6.3）
// ---------------------------------------------------------------------------

describe('deferSkipped の条件', () => {
  it('#5 期限の来た自動配信の予約には 1 を返す', async () => {
    const postId = await makeDuePost(await accountFor());

    expect(await defer(postId, deferredVerdict())).toBe(1);
  });

  it('#5 skip_count 1・skip_reason no_publisher・next_attempt_at が判定の値になる', async () => {
    const postId = await makeDuePost(await accountFor());
    const verdict = deferredVerdict();

    await defer(postId, verdict);

    const row = await watched(postId);
    expect({
      skipCount: row.skip_count,
      skipReason: row.skip_reason,
      nextAttemptAt: row.next_attempt_at?.getTime() ?? null,
    }).toEqual({
      skipCount: 1,
      skipReason: 'no_publisher',
      nextAttemptAt: verdict.kind === 'deferred' ? verdict.nextAttemptAt.getTime() : null,
    });
  });

  const REJECTED = [
    { no: '#6', name: "delivery_mode = 'manual'", statement: toManual },
    { no: '#7', name: 'scheduled_at が 1 時間後', statement: toFutureSchedule },
    { no: '#8', name: 'next_attempt_at が 1 時間後', statement: toFutureNextAttempt },
  ] as const;

  for (const { no, name, statement } of REJECTED) {
    for (const { name: kind, verdict } of VERDICTS) {
      it(`${no}（${kind}）他の条件が揃っていて ${name} の行は 0`, async () => {
        const postId = await makeDuePost(await accountFor());
        await arrange(postId, statement);

        expect(await defer(postId, verdict())).toBe(0);
      });

      it(`${no}（${kind}）他の条件が揃っていて ${name} の行は変わらない`, async () => {
        const postId = await makeDuePost(await accountFor());
        await arrange(postId, statement);
        const before = await watched(postId);

        await defer(postId, verdict());

        expect(await watched(postId)).toEqual(before);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// #9 述語と Domain の isDue の突き合わせ（設計 §10.2）
// ---------------------------------------------------------------------------

/**
 * #9。**Domain の `isDue` と SQL の 3 経路（`listDue`・`claimForPublish`・`deferSkipped`）が同じ判定をする。**
 *
 * `claimForPublish` と `deferSkipped` は行を変えるので、配置ごとに 2 行（それぞれ用）を作り、
 * 書き込みの前に 2 行とも `isDue` と `listDue` を見る（実装プラン §8 の 4）。
 */
describe('述語と isDue の突き合わせ', () => {
  const setStatus =
    (status: string): Arrange =>
    (id) =>
      sql`UPDATE social_posts SET status = ${status} WHERE id = ${id}`;

  const ARRANGEMENTS: readonly {
    readonly name: string;
    readonly due: boolean;
    readonly statement: Arrange | null;
  }[] = [
    { name: '期限の来た自動配信の予約', due: true, statement: null },
    { name: 'status が draft', due: false, statement: setStatus('draft') },
    { name: 'status が awaiting_approval', due: false, statement: setStatus('awaiting_approval') },
    { name: 'status が published', due: false, statement: setStatus('published') },
    { name: 'status が failed', due: false, statement: setStatus('failed') },
    { name: "delivery_mode = 'manual'", due: false, statement: toManual },
    {
      name: 'publish_started_at あり',
      due: false,
      statement: (id) =>
        sql`UPDATE social_posts SET publish_started_at = now() - interval '1 hour' WHERE id = ${id}`,
    },
    { name: 'scheduled_at が NULL', due: false, statement: toNullSchedule },
    { name: 'scheduled_at が 1 時間後', due: false, statement: toFutureSchedule },
    { name: 'next_attempt_at が 1 時間後', due: false, statement: toFutureNextAttempt },
    {
      name: 'next_attempt_at が 1 時間前',
      due: true,
      statement: (id) =>
        sql`UPDATE social_posts SET next_attempt_at = now() - interval '1 hour' WHERE id = ${id}`,
    },
  ];

  for (const { name, due, statement } of ARRANGEMENTS) {
    it(`#9 ${name}：isDue・listDue・claimForPublish・deferSkipped がすべて ${String(due)}`, async () => {
      const accountId = await accountFor();
      const claimRow = await makeDuePost(accountId);
      const deferRow = await makeDuePost(accountId);
      if (statement !== null) {
        await arrange(claimRow, statement);
        await arrange(deferRow, statement);
      }

      // 書き込みの前に、Domain の判定と取り出しの結果を取る。
      const now = new Date();
      const rows = await withConnection(async (connection) => ({
        claim: await socialRepository.findPostById(connection, claimRow, ALL_SCOPE),
        defer: await socialRepository.findPostById(connection, deferRow, ALL_SCOPE),
        listed: new Set((await socialRepository.listDue(connection, 200)).map((post) => post.id)),
      }));
      if (rows.claim === null || rows.defer === null) throw new Error('投稿が読めない');

      const claimed = await claim(claimRow);
      const deferred = await defer(deferRow, deferredVerdict());

      expect({
        isDueOfClaimRow: isDue(rows.claim, now),
        isDueOfDeferRow: isDue(rows.defer, now),
        listDueHasClaimRow: rows.listed.has(claimRow),
        listDueHasDeferRow: rows.listed.has(deferRow),
        claimForPublishClaimed: claimed !== null,
        deferSkippedUpdated: deferred === 1,
      }).toEqual({
        isDueOfClaimRow: due,
        isDueOfDeferRow: due,
        listDueHasClaimRow: due,
        listDueHasDeferRow: due,
        claimForPublishClaimed: due,
        deferSkippedUpdated: due,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// #21・#22 述語を掛けないもの（設計 §6.4）
// ---------------------------------------------------------------------------

describe('述語を掛けないもの', () => {
  /** 着手してから予約日時を 1 時間後へ書き換えた行（本体の経路では作れない。DB を直接書き換えた場合）。 */
  async function claimedThenRescheduled(): Promise<string> {
    const postId = await makeDuePost(await accountFor());
    const claimed = await claim(postId);
    if (claimed === null) throw new Error('前提：期限の来た予約を掴めていない');
    await arrange(postId, toFutureSchedule);
    return postId;
  }

  async function recordPublished(postId: string): Promise<number> {
    return withConnection(async (connection) =>
      socialRepository.recordOutcome(connection, postId, {
        kind: 'published',
        externalId: null,
        externalUrl: null,
      }),
    );
  }

  it('#21 着手後に scheduled_at を未来へ書き換えても recordOutcome（published）は 1 を返す', async () => {
    const postId = await claimedThenRescheduled();

    expect(await recordPublished(postId)).toBe(1);
  });

  it('#21 その行は published になり publish_started_at が null に戻る（送った事実を記録する）', async () => {
    const postId = await claimedThenRescheduled();

    await recordPublished(postId);

    const row = await watched(postId);
    expect({ status: row.status, publishStartedAt: row.publish_started_at }).toEqual({
      status: 'published',
      publishStartedAt: null,
    });
  });

  /** 自動配信で着手印が残り、予約日時が 1 時間後の行（SQL で作る）。 */
  async function interruptedFuture(accountId: string): Promise<string> {
    const postId = await makeDuePost(accountId);
    await arrange(
      postId,
      (id) =>
        sql`UPDATE social_posts
               SET publish_started_at = now() - interval '10 minutes',
                   scheduled_at = now() + interval '1 hour'
             WHERE id = ${id}`,
    );
    return postId;
  }

  /** 手動投稿で着手印がある行（SQL で作る）。 */
  async function interruptedManual(accountId: string): Promise<string> {
    const postId = await makeDuePost(accountId);
    await arrange(
      postId,
      (id) =>
        sql`UPDATE social_posts
               SET delivery_mode = 'manual', publish_started_at = now() - interval '10 minutes'
             WHERE id = ${id}`,
    );
    return postId;
  }

  async function failInterrupted() {
    return withConnection(async (connection) =>
      socialRepository.failInterrupted(connection, INTERRUPTED_REASON),
    );
  }

  it('#22 scheduled_at が 1 時間後の着手済みの自動配信の行も failed に落とす', async () => {
    const postId = await interruptedFuture(await accountFor());

    const interrupted = await failInterrupted();

    expect(interrupted.map((post) => post.id)).toEqual([postId]);
    expect((await watched(postId)).status).toBe('failed');
  });

  it('#22 落とした行の failure_reason は INTERRUPTED_REASON', async () => {
    const postId = await interruptedFuture(await accountFor());

    await failInterrupted();

    expect((await watched(postId)).failure_reason).toBe(INTERRUPTED_REASON);
  });

  it('#22 手動投稿で着手印のある行は今までどおり触らない', async () => {
    const postId = await interruptedManual(await accountFor());
    const before = await watched(postId);

    const interrupted = await failInterrupted();

    expect(interrupted).toEqual([]);
    expect(await watched(postId)).toEqual(before);
  });
});
