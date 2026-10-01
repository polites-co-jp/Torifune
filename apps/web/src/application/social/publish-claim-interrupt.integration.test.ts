import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  approveSocialPost,
  createSocialAccount,
  createSocialPost,
  listManualPendingPosts,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信ジョブの列を作った後に割り込む `PATCH`（049-publish-claim-conditions 設計 §1.1・§6.2・§6.3・§6.5、
 * 受け入れ条件 #10〜#20・#23）。
 *
 * ジョブは**期限の来た行の列を先に作り、後から 1 行ずつ書き込む**。列の末尾の行は前の行の `publish()`
 * （最長 30 秒）を待つので、その間に `PATCH` がコミットされうる。**`PATCH` で「まだ送らない」ことにされた予約
 * （予約日時を未来へ・手動投稿へ・取りやめてから未来へ予約し直し・承認し直して未来へ）は、列に並んだ後でも送らない。**
 * 手動投稿へ変えた予約をジョブが送ると、人が後で手で出したときに二重投稿になる（SNS の投稿は取り消せない）。
 *
 * 割り込みの作り方は 2 つ（設計 §10）。
 *
 * * (i) **先に着手した行 A の `publish()` の中で、列の後ろの行 B へ `PATCH`** する（実際の窓＝前の行の配信を待つ間）。
 *   A の `scheduledAt` を 2 時間前、B を 1 時間前にして A を列の先頭に置く。B が列に並んだこと（`summary.due === 2`）を
 *   必ず確かめる（並ばなかったときに「B は送られない」が空振りで成り立つのを防ぐ。実装プラン §8 の 3）
 * * (ii) `vi.spyOn(socialRepository, 'claimForPublish' | 'deferSkipped')` で**元の関数を呼ぶ前に `PATCH`** を挟む
 *   （元の関数は spy の前に `bind` して取っておく。`048` の結合テストと同じ流儀）
 *
 * `PATCH` は UseCase `updateSocialPost`（`PATCH /api/v1/social/posts/{id}` と同じ経路）。UseCase は自分で接続を取って
 * コミットするので、ジョブとは別の接続でコミットされる。
 */

const PLUGIN_ID = 'test-plugin';
/** `publish` と `manual` の両方を持つ偽の publisher の provider。 */
const PROVIDER = 'claimintr';
/** publisher を一度も登録しない provider。 */
const NO_PUBLISHER = 'claimnopub';
const CREDENTIALS = { identifier: 'id-a1b2', appPassword: 'pw-c3d4' } as const;
const CREDENTIAL_FIELDS = [
  { key: 'identifier', label: '識別子', kind: 'text' },
  { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TIMEOUT_MS = 30_000;

type PublishFn = NonNullable<PublisherRegistration['publish']>;
type PublishMock = ReturnType<typeof vi.fn<PublishFn>>;

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
        login_id: `cli${suffix}`,
        email: `cli${suffix}@example.com`,
        display_name: 'publish claim interrupt test',
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
    loginId: `cli${suffix}`,
    displayName: 'publish claim interrupt test',
    email: `cli${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 両方の publisher（`publish` と `manual`。`credentialFields` を宣言する）。 */
function useBothPublisher(publish: PublishFn = async () => ({ ok: true })): PublishMock {
  const mock = vi.fn<PublishFn>(publish);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [...CREDENTIAL_FIELDS],
    publish: mock,
    manual: () => ({ url: 'https://example.com/intent/post' }),
  });
  return mock;
}

interface AccountOptions {
  readonly provider?: string;
  /** 省略すると資格情報が未設定のアカウントになる。 */
  readonly credentials?: Readonly<Record<string, string>>;
}

async function accountFor(options: AccountOptions = {}): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: options.provider ?? PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    status: 'connected',
  });
  return account.id;
}

/** 期限の来た自動配信の予約。 */
async function makeDuePost(accountId: string, minutesAgo: number): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '配信される本文',
    scheduledAt: new Date(Date.now() - minutesAgo * MINUTE_MS),
    status: 'scheduled',
    deliveryMode: 'auto',
  });
  return post.id;
}

/**
 * 承認を経た B（`publishTiming: 'after_approval'` で登録し、`publishTiming: 'now'` で承認した予約。設計 #14）。
 *
 * 承認の時刻はアプリの `new Date()` なので、DB の `now()` との時計のずれで列に並ばないことを防ぐため、
 * 承認の後に SQL で `scheduled_at` を 1 時間前へ書き換える（`approved_at`・`updated_at` は触らない。実装プラン §8 の 3）。
 */
async function makeApprovedDuePost(accountId: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '承認を経た本文',
    scheduledAt: new Date(Date.now() + 2 * HOUR_MS),
    publishTiming: 'after_approval',
    deliveryMode: 'auto',
  });
  if (post.status !== 'awaiting_approval') throw new Error('前提：承認待ちで登録できていない');
  await approveSocialPost(admin, {
    id: post.id,
    publishTiming: 'now',
    expectedUpdatedAt: post.updatedAt,
  });
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET scheduled_at = now() - interval '1 hour' WHERE id = ${post.id}`.execute(
      connection.db,
    );
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly delivery_mode: string;
  readonly scheduled_at: Date | null;
  readonly approved_at: Date | null;
  readonly publish_started_at: Date | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly skip_count: number;
  readonly skip_reason: string | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
}

async function rowOf(id: string): Promise<PostRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select([
        'status',
        'delivery_mode',
        'scheduled_at',
        'approved_at',
        'publish_started_at',
        'attempt_count',
        'next_attempt_at',
        'skip_count',
        'skip_reason',
        'failed_at',
        'failure_reason',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

function capture(): LogRecord[] {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return records;
}

/** 発火したイベントの `postId`（`unknown[]` で受ける。実装プラン §2 のテストの方法）。 */
function captureEvents(): { readonly published: unknown[]; readonly failed: unknown[] } {
  const published: unknown[] = [];
  const failed: unknown[] = [];
  subscribe('social.post.published', (payload) => {
    published.push(payload);
  });
  subscribe('social.post.failed', (payload) => {
    failed.push(payload);
  });
  return { published, failed };
}

function postIdsOf(payloads: readonly unknown[]): unknown[] {
  return payloads.map((payload) => (payload as { readonly postId?: unknown }).postId);
}

/** `publish()` が受け取った投稿の ID（呼ばれた順）。 */
function publishedIds(publish: PublishMock): string[] {
  return publish.mock.calls.map(([input]) => input.post.id);
}

/** 割り込みの UseCase が何を返したか。失敗したら前提が崩れているので、その場で落とす。 */
type Interrupt<T> = (b: string) => Promise<T>;

interface InterruptedRun<T> {
  readonly a: string;
  readonly b: string;
  readonly accountId: string;
  readonly publish: PublishMock;
  readonly summary: Awaited<ReturnType<typeof run>>;
  /** 割り込みの戻り値。 */
  readonly interrupted: T;
  readonly logs: LogRecord[];
  readonly events: ReturnType<typeof captureEvents>;
}

/**
 * (i) の割り込み：A の `publish()` の中で B へ割り込み、成功を返す。
 *
 * A は 2 時間前、B は 1 時間前（A が列の先頭）。同じアカウント、資格情報あり、両方の publisher。
 */
async function runWithInterruptDuringA<T>(
  interrupt: Interrupt<T>,
  makeB: (accountId: string) => Promise<string> = async (accountId) => makeDuePost(accountId, 60),
): Promise<InterruptedRun<T>> {
  const accountId = await accountFor({ credentials: CREDENTIALS });
  const a = await makeDuePost(accountId, 120);
  const b = await makeB(accountId);

  const outcomes: ({ ok: true; value: T } | { ok: false; error: unknown })[] = [];
  const publish = useBothPublisher(async (input) => {
    if (input.post.id === a && outcomes.length === 0) {
      try {
        outcomes.push({ ok: true, value: await interrupt(b) });
      } catch (error) {
        outcomes.push({ ok: false, error });
      }
    }
    return { ok: true };
  });
  const logs = capture();
  const events = captureEvents();

  const summary = await run();

  const outcome = outcomes[0];
  if (outcome === undefined) throw new Error('前提：A の publish() の中で割り込めていない');
  if (!outcome.ok) throw outcome.error;
  // **B が列に並んだこと**（割り込みが「列を作った後」に起きたことの確かめ。実装プラン §8 の 3）。
  if (summary.due !== 2) throw new Error(`前提：B が列に並んでいない（due: ${summary.due}）`);

  return { a, b, accountId, publish, summary, interrupted: outcome.value, logs, events };
}

/**
 * (ii) の割り込み：Repository のメソッドの元の関数を呼ぶ前に 1 度だけ割り込む。
 *
 * 元の関数は spy の前に `bind` して取っておく（`048` の結合テストと同じ流儀）。
 */
function interruptBefore(
  method: 'claimForPublish' | 'deferSkipped',
  interrupt: (postId: string) => Promise<void>,
): { readonly calls: () => number } {
  let calls = 0;
  if (method === 'claimForPublish') {
    const original = socialRepository.claimForPublish.bind(socialRepository);
    vi.spyOn(socialRepository, 'claimForPublish').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) await interrupt(args[1]);
      return original(...args);
    });
  } else {
    const original = socialRepository.deferSkipped.bind(socialRepository);
    vi.spyOn(socialRepository, 'deferSkipped').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) await interrupt(args[1]);
      return original(...args);
    });
  }
  return { calls: () => calls };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('publishclaiminterrupt');
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
// #10〜#16 前の行の配信中に割り込む PATCH（(i)）
// ---------------------------------------------------------------------------

describe('前の行の配信中に割り込む PATCH', () => {
  /** B を手動投稿へ変える（#10・#11）。 */
  const toManual: Interrupt<Awaited<ReturnType<typeof updateSocialPost>>> = async (b) =>
    updateSocialPost(admin, { id: b, deliveryMode: 'manual' });

  /** 10 と同じ summary（#10・#12）。 */
  const SUMMARY_OF_10 = {
    due: 2,
    attempted: 1,
    published: 1,
    failed: 0,
    unrecorded: 0,
    skipped: 0,
    skipFailed: 0,
  } as const;

  describe('#10 手動投稿へ変えた B', () => {
    it(
      '#10 PATCH { deliveryMode: manual } は通り、応答は scheduled・manual',
      async () => {
        const { interrupted } = await runWithInterruptDuringA(toManual);

        expect({ status: interrupted.status, deliveryMode: interrupted.deliveryMode }).toEqual({
          status: 'scheduled',
          deliveryMode: 'manual',
        });
      },
      TIMEOUT_MS,
    );

    it(
      '#10 publish() は A の 1 回だけ呼ばれる',
      async () => {
        const { a, publish } = await runWithInterruptDuringA(toManual);

        expect(publishedIds(publish)).toEqual([a]);
      },
      TIMEOUT_MS,
    );

    it(
      '#10 B は着手されず、scheduled・manual のまま',
      async () => {
        const { b } = await runWithInterruptDuringA(toManual);

        const row = await rowOf(b);
        expect({
          publishStartedAt: row.publish_started_at,
          attemptCount: row.attempt_count,
          status: row.status,
          deliveryMode: row.delivery_mode,
        }).toEqual({
          publishStartedAt: null,
          attemptCount: 0,
          status: 'scheduled',
          deliveryMode: 'manual',
        });
      },
      TIMEOUT_MS,
    );

    it(
      '#10 summary は due 2・attempted 1・published 1・ほかは 0',
      async () => {
        const { summary } = await runWithInterruptDuringA(toManual);

        expect(summary).toMatchObject(SUMMARY_OF_10);
      },
      TIMEOUT_MS,
    );

    it(
      '#10 B について social.post.published / social.post.failed が発火しない',
      async () => {
        const { b, events } = await runWithInterruptDuringA(toManual);

        expect([...postIdsOf(events.published), ...postIdsOf(events.failed)]).not.toContain(b);
      },
      TIMEOUT_MS,
    );

    it(
      '#10 postId が B のログは出ない',
      async () => {
        const { b, logs } = await runWithInterruptDuringA(toManual);

        expect(logs.filter((record) => record.fields?.['postId'] === b)).toEqual([]);
      },
      TIMEOUT_MS,
    );

    it(
      '#10 B は手動投稿待ちに含まれる',
      async () => {
        const { b } = await runWithInterruptDuringA(toManual);

        const pending = await listManualPendingPosts(admin, { limit: 50 });

        expect(pending.items.map((post) => post.id)).toContain(b);
      },
      TIMEOUT_MS,
    );
  });

  /** #11。**手動投稿へ変えた予約がジョブと人の両方から出ることは無い。** */
  describe('#11 手動投稿へ変えた B を人が手で出す', () => {
    async function recordByHand(b: string) {
      return updateSocialPost(admin, {
        id: b,
        status: 'published',
        externalUrl: 'https://example.com/posts/b',
      });
    }

    it(
      '#11 B を手で出した記録（PATCH { status: published, externalUrl }）が通る',
      async () => {
        const { b } = await runWithInterruptDuringA(toManual);

        const recorded = await recordByHand(b);

        expect(recorded.status).toBe('published');
      },
      TIMEOUT_MS,
    );

    it(
      '#11 続けて publishDuePosts を回しても B の publish() は呼ばれない',
      async () => {
        const { b, publish } = await runWithInterruptDuringA(toManual);
        await recordByHand(b);

        await run();

        expect(publishedIds(publish).filter((id) => id === b)).toEqual([]);
      },
      TIMEOUT_MS,
    );
  });

  describe('#12 予約日時を未来へ直した B', () => {
    function toFuture(): { readonly at: Date; readonly interrupt: Interrupt<unknown> } {
      const at = new Date(Date.now() + HOUR_MS);
      return {
        at,
        interrupt: async (b) => updateSocialPost(admin, { id: b, scheduledAt: at }),
      };
    }

    it(
      '#12 publish() は A の 1 回だけ呼ばれる',
      async () => {
        const { a, publish } = await runWithInterruptDuringA(toFuture().interrupt);

        expect(publishedIds(publish)).toEqual([a]);
      },
      TIMEOUT_MS,
    );

    it(
      '#12 B は scheduled のまま着手されず、scheduled_at が送った値・next_attempt_at が null',
      async () => {
        const { at, interrupt } = toFuture();
        const { b } = await runWithInterruptDuringA(interrupt);

        const row = await rowOf(b);
        expect({
          status: row.status,
          attemptCount: row.attempt_count,
          publishStartedAt: row.publish_started_at,
          scheduledAt: row.scheduled_at?.getTime() ?? null,
          nextAttemptAt: row.next_attempt_at,
        }).toEqual({
          status: 'scheduled',
          attemptCount: 0,
          publishStartedAt: null,
          scheduledAt: at.getTime(),
          nextAttemptAt: null,
        });
      },
      TIMEOUT_MS,
    );

    it(
      '#12 summary は 10 と同じ',
      async () => {
        const { summary } = await runWithInterruptDuringA(toFuture().interrupt);

        expect(summary).toMatchObject(SUMMARY_OF_10);
      },
      TIMEOUT_MS,
    );

    it(
      '#12 その後 B の scheduled_at を 1 分前にして回すと、B が（そのときに）1 回だけ配信される',
      async () => {
        const { b, publish } = await runWithInterruptDuringA(toFuture().interrupt);
        const afterFirst = publishedIds(publish).filter((id) => id === b).length;
        await withConnection(async (connection) => {
          await sql`UPDATE social_posts SET scheduled_at = now() - interval '1 minute' WHERE id = ${b}`.execute(
            connection.db,
          );
        });

        await run();

        const afterSecond = publishedIds(publish).filter((id) => id === b).length;
        expect({ afterFirst, afterSecond, status: (await rowOf(b)).status }).toEqual({
          afterFirst: 0,
          afterSecond: 1,
          status: 'published',
        });
      },
      TIMEOUT_MS,
    );
  });

  describe('#13 取りやめてから未来へ予約し直した B', () => {
    const redraftThenReschedule: Interrupt<readonly string[]> = async (b) => {
      const drafted = await updateSocialPost(admin, { id: b, status: 'draft' });
      const rescheduled = await updateSocialPost(admin, {
        id: b,
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + HOUR_MS),
      });
      return [drafted.status, rescheduled.status];
    };

    it(
      '#13 PATCH { status: draft } と PATCH { status: scheduled, scheduledAt: 1 時間後 } がどちらも通る',
      async () => {
        const { interrupted } = await runWithInterruptDuringA(redraftThenReschedule);

        expect(interrupted).toEqual(['draft', 'scheduled']);
      },
      TIMEOUT_MS,
    );

    it(
      '#13 B は送られず、scheduled・attempt_count 0',
      async () => {
        const { b, publish } = await runWithInterruptDuringA(redraftThenReschedule);

        const row = await rowOf(b);
        expect({
          sentB: publishedIds(publish).includes(b),
          status: row.status,
          attemptCount: row.attempt_count,
        }).toEqual({ sentB: false, status: 'scheduled', attemptCount: 0 });
      },
      TIMEOUT_MS,
    );

    it(
      '#13 summary は due 2・attempted 1',
      async () => {
        const { summary } = await runWithInterruptDuringA(redraftThenReschedule);

        expect(summary).toMatchObject({ due: 2, attempted: 1 });
      },
      TIMEOUT_MS,
    );
  });

  describe('#14 承認を経た B を書き換え、指定の時間（未来）で承認し直す', () => {
    function reapproveInFuture(): { readonly at: Date; readonly interrupt: Interrupt<unknown> } {
      const at = new Date(Date.now() + HOUR_MS);
      return {
        at,
        interrupt: async (b) => {
          const edited = await updateSocialPost(admin, { id: b, body: '直した本文' });
          if (edited.status !== 'awaiting_approval') {
            throw new Error(`前提：承認待ちへ戻っていない（${edited.status}）`);
          }
          return approveSocialPost(admin, {
            id: b,
            publishTiming: 'scheduled',
            scheduledAt: at,
            expectedUpdatedAt: edited.updatedAt,
          });
        },
      };
    }

    it(
      '#14 B は送られず、scheduled・approvedAt あり・scheduled_at が承認で選んだ値・attempt_count 0',
      async () => {
        const { at, interrupt } = reapproveInFuture();
        const { b, publish } = await runWithInterruptDuringA(interrupt, makeApprovedDuePost);

        const row = await rowOf(b);
        expect({
          sentB: publishedIds(publish).includes(b),
          status: row.status,
          approved: row.approved_at !== null,
          scheduledAt: row.scheduled_at?.getTime() ?? null,
          attemptCount: row.attempt_count,
        }).toEqual({
          sentB: false,
          status: 'scheduled',
          approved: true,
          scheduledAt: at.getTime(),
          attemptCount: 0,
        });
      },
      TIMEOUT_MS,
    );

    it(
      '#14 summary は due 2・attempted 1',
      async () => {
        const { summary } = await runWithInterruptDuringA(
          reapproveInFuture().interrupt,
          makeApprovedDuePost,
        );

        expect(summary).toMatchObject({ due: 2, attempted: 1 });
      },
      TIMEOUT_MS,
    );
  });

  describe('#15 配信の条件を変えない PATCH（変わらない振る舞い）', () => {
    const editBody: Interrupt<unknown> = async (b) =>
      updateSocialPost(admin, { id: b, body: '直した本文' });

    it(
      '#15 B も着手され、B の publish() が受け取る post.body は直した本文',
      async () => {
        const { b, publish } = await runWithInterruptDuringA(editBody);

        const bodies = publish.mock.calls
          .filter(([input]) => input.post.id === b)
          .map(([input]) => input.post.body);
        expect(bodies).toEqual(['直した本文']);
      },
      TIMEOUT_MS,
    );

    it(
      '#15 summary は attempted 2・published 2',
      async () => {
        const { summary } = await runWithInterruptDuringA(editBody);

        expect(summary).toMatchObject({ due: 2, attempted: 2, published: 2 });
      },
      TIMEOUT_MS,
    );
  });

  describe('#16 過去のまま別の時刻へ直した B（変わらない振る舞い）', () => {
    const toAnotherPast: Interrupt<unknown> = async (b) =>
      updateSocialPost(admin, { id: b, scheduledAt: new Date(Date.now() - 30 * MINUTE_MS) });

    it(
      '#16 B は同じ実行で配信される',
      async () => {
        const { b, publish } = await runWithInterruptDuringA(toAnotherPast);

        expect({
          sentB: publishedIds(publish).filter((id) => id === b).length,
          status: (await rowOf(b)).status,
        }).toEqual({ sentB: 1, status: 'published' });
      },
      TIMEOUT_MS,
    );

    it(
      '#16 summary は due 2・published 2',
      async () => {
        const { summary } = await runWithInterruptDuringA(toAnotherPast);

        expect(summary).toMatchObject({ due: 2, published: 2 });
      },
      TIMEOUT_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// #17 着手の直前に割り込む PATCH（(ii)）
// ---------------------------------------------------------------------------

describe('着手の直前に割り込む PATCH', () => {
  /** 期限の来た自動配信の予約 1 件。`claimForPublish` の直前に手動投稿へ変える。 */
  async function arrange(): Promise<{
    readonly postId: string;
    readonly publish: PublishMock;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = useBothPublisher();
    const postId = await makeDuePost(await accountFor({ credentials: CREDENTIALS }), 60);
    const spy = interruptBefore('claimForPublish', async (id) => {
      await updateSocialPost(admin, { id, deliveryMode: 'manual' });
    });

    const summary = await run();

    if (spy.calls() === 0) throw new Error('前提：claimForPublish まで進んでいない');
    return { postId, publish, summary };
  }

  it(
    '#17 publish() は呼ばれない',
    async () => {
      const { publish } = await arrange();

      expect(publish).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  it(
    '#17 summary は due 1・attempted 0・ほかは 0',
    async () => {
      const { summary } = await arrange();

      expect(summary).toEqual({
        interrupted: 0,
        due: 1,
        skipped: 0,
        skipFailed: 0,
        attempted: 0,
        published: 0,
        retried: 0,
        failed: 0,
        unrecorded: 0,
      });
    },
    TIMEOUT_MS,
  );

  it(
    '#17 行は着手されず、scheduled・manual のまま（10 の B と同じ）',
    async () => {
      const { postId } = await arrange();

      const row = await rowOf(postId);
      expect({
        publishStartedAt: row.publish_started_at,
        attemptCount: row.attempt_count,
        status: row.status,
        deliveryMode: row.delivery_mode,
      }).toEqual({
        publishStartedAt: null,
        attemptCount: 0,
        status: 'scheduled',
        deliveryMode: 'manual',
      });
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// #18〜#20 支度待ちへ送る直前に割り込む PATCH（(ii)）
// ---------------------------------------------------------------------------

describe('支度待ちへ送る直前に割り込む PATCH', () => {
  interface Arranged {
    readonly postId: string;
    readonly summary: Awaited<ReturnType<typeof run>>;
    /** 割り込んだ `PATCH` の直後（`deferSkipped` の元の関数を呼ぶ前）の行。 */
    readonly afterPatch: PostRow;
    readonly logs: LogRecord[];
    readonly events: ReturnType<typeof captureEvents>;
  }

  /**
   * 資格情報が未設定のアカウント（両方の publisher。`credential_missing` で飛ばされる）の期限の来た自動配信の予約。
   * `deferSkipped` の直前に手動投稿へ変える（#18・#19）。
   */
  async function credentialMissingThenManual(
    before?: (postId: string) => Promise<void>,
  ): Promise<Arranged> {
    useBothPublisher();
    const postId = await makeDuePost(await accountFor(), 60);
    if (before !== undefined) await before(postId);
    let afterPatch: PostRow | undefined;
    const spy = interruptBefore('deferSkipped', async (id) => {
      await updateSocialPost(admin, { id, deliveryMode: 'manual' });
      afterPatch = await rowOf(id);
    });
    const logs = capture();
    const events = captureEvents();

    const summary = await run();

    if (spy.calls() === 0 || afterPatch === undefined) {
      throw new Error('前提：deferSkipped まで進んでいない');
    }
    return { postId, summary, afterPatch, logs, events };
  }

  describe('#18 手動投稿へ変えた行を支度待ちとして数えない', () => {
    it(
      '#18 summary は due 1・skipped 0・skipFailed 0',
      async () => {
        const { summary } = await credentialMissingThenManual();

        expect(summary).toMatchObject({ due: 1, skipped: 0, skipFailed: 0 });
      },
      TIMEOUT_MS,
    );

    it(
      '#18 行の skip_count・skip_reason・next_attempt_at は PATCH の後のまま',
      async () => {
        const { postId, afterPatch } = await credentialMissingThenManual();

        const row = await rowOf(postId);
        expect({
          skipCount: row.skip_count,
          skipReason: row.skip_reason,
          nextAttemptAt: row.next_attempt_at,
        }).toEqual({
          skipCount: afterPatch.skip_count,
          skipReason: afterPatch.skip_reason,
          nextAttemptAt: afterPatch.next_attempt_at,
        });
      },
      TIMEOUT_MS,
    );

    it(
      '#18 行は manual・scheduled のまま',
      async () => {
        const { postId } = await credentialMissingThenManual();

        const row = await rowOf(postId);
        expect({ deliveryMode: row.delivery_mode, status: row.status }).toEqual({
          deliveryMode: 'manual',
          status: 'scheduled',
        });
      },
      TIMEOUT_MS,
    );
  });

  /** #19。**本来なら 3 回目で取りやめる行**でも、手動投稿へ変えられていればジョブは取りやめない。 */
  describe('#19 skip_count = 2 の行も取りやめない', () => {
    const twiceSkipped = async (postId: string): Promise<void> => {
      await withConnection(async (connection) => {
        await sql`UPDATE social_posts SET skip_count = 2, skip_reason = 'credential_missing' WHERE id = ${postId}`.execute(
          connection.db,
        );
      });
    };

    it(
      '#19 実行の後も scheduled・skip_count 2・failed_at null・failure_reason は変わらない',
      async () => {
        const { postId, afterPatch } = await credentialMissingThenManual(twiceSkipped);

        const row = await rowOf(postId);
        expect({
          status: row.status,
          skipCount: row.skip_count,
          failedAt: row.failed_at,
          failureReason: row.failure_reason,
        }).toEqual({
          status: 'scheduled',
          skipCount: 2,
          failedAt: null,
          failureReason: afterPatch.failure_reason,
        });
      },
      TIMEOUT_MS,
    );

    it(
      '#19 social.post.failed は発火しない',
      async () => {
        const { events } = await credentialMissingThenManual(twiceSkipped);

        expect(events.failed).toEqual([]);
      },
      TIMEOUT_MS,
    );

    it(
      "#19 log.error('social post skipped too many times') は出ない",
      async () => {
        const { logs } = await credentialMissingThenManual(twiceSkipped);

        expect(
          logs.filter((record) => record.message === 'social post skipped too many times'),
        ).toEqual([]);
      },
      TIMEOUT_MS,
    );

    it(
      '#19 summary.skipFailed は 0',
      async () => {
        const { summary } = await credentialMissingThenManual(twiceSkipped);

        expect(summary.skipFailed).toBe(0);
      },
      TIMEOUT_MS,
    );
  });

  /**
   * #20。**`PATCH` が消した待ち時刻を、直後の `deferSkipped` が 1 時間後へ書き戻さない。**
   * 書き戻すと、直した予約日時が 1 時間以内なら指定した時刻に出ない（`035` 裁定 #14-a が塞いだのと同じ症状）。
   *
   * 前に 1 度飛ばされて待ち時刻が過ぎた行（`skip_count = 1`・`next_attempt_at` が過去）にしておき、
   * `PATCH` が待ち時刻を消したこと・`skip_count` が増えないことを見る。
   */
  describe('#20 publisher 無しの行の予約日時を 30 分後へ直す', () => {
    async function noPublisherThenFuture(): Promise<{
      readonly postId: string;
      readonly summary: Awaited<ReturnType<typeof run>>;
      readonly before: PostRow;
    }> {
      useBothPublisher();
      const postId = await makeDuePost(
        await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS }),
        60,
      );
      await withConnection(async (connection) => {
        await sql`UPDATE social_posts
                     SET skip_count = 1, skip_reason = 'no_publisher',
                         next_attempt_at = now() - interval '1 minute'
                   WHERE id = ${postId}`.execute(connection.db);
      });
      const before = await rowOf(postId);
      const spy = interruptBefore('deferSkipped', async (id) => {
        await updateSocialPost(admin, { id, scheduledAt: new Date(Date.now() + 30 * MINUTE_MS) });
      });

      const summary = await run();

      if (spy.calls() === 0) throw new Error('前提：deferSkipped まで進んでいない');
      return { postId, summary, before };
    }

    it(
      '#20 summary.skipped は 0',
      async () => {
        const { summary } = await noPublisherThenFuture();

        expect(summary.skipped).toBe(0);
      },
      TIMEOUT_MS,
    );

    it(
      '#20 next_attempt_at は null のまま（PATCH が消したまま。1 時間後へ書き戻されない）',
      async () => {
        const { postId } = await noPublisherThenFuture();

        expect((await rowOf(postId)).next_attempt_at).toBeNull();
      },
      TIMEOUT_MS,
    );

    it(
      '#20 skip_count は変わらない',
      async () => {
        const { postId, before } = await noPublisherThenFuture();

        expect((await rowOf(postId)).skip_count).toBe(before.skip_count);
      },
      TIMEOUT_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// #23 普通の配信（変わらない振る舞い）
// ---------------------------------------------------------------------------

describe('普通の配信', () => {
  async function threeDue(): Promise<{
    readonly ids: readonly string[];
    readonly publish: PublishMock;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = useBothPublisher();
    const accountId = await accountFor({ credentials: CREDENTIALS });
    const ids = [
      await makeDuePost(accountId, 30),
      await makeDuePost(accountId, 20),
      await makeDuePost(accountId, 10),
    ];
    const summary = await run();
    return { ids, publish, summary };
  }

  it(
    '#23 期限の来た 3 件を 1 回の実行で配信すると publish() が 3 回呼ばれる',
    async () => {
      const { ids, publish } = await threeDue();

      expect([...publishedIds(publish)].sort()).toEqual([...ids].sort());
    },
    TIMEOUT_MS,
  );

  it(
    '#23 3 件とも published になる',
    async () => {
      const { ids } = await threeDue();

      const statuses = await Promise.all(ids.map(async (id) => (await rowOf(id)).status));
      expect(statuses).toEqual(['published', 'published', 'published']);
    },
    TIMEOUT_MS,
  );

  it(
    '#23 summary は due 3・attempted 3・published 3・ほかは 0',
    async () => {
      const { summary } = await threeDue();

      expect(summary).toEqual({
        interrupted: 0,
        due: 3,
        skipped: 0,
        skipFailed: 0,
        attempted: 3,
        published: 3,
        retried: 0,
        failed: 0,
        unrecorded: 0,
      });
    },
    TIMEOUT_MS,
  );
});
