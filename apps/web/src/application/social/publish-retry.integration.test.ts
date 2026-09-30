import type { PublishInput, PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { INTERRUPTED_REASON, TIMEOUT_REASON } from '@/domain/social/publishing';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 中断行・再試行・例外・タイムアウト
 * （035-social-publishing 設計 §6.5.4 / §6.5.6、受け入れ条件 #44〜#48）。
 *
 * **結果が分からない失敗は再試行しない。** 二重投稿より未投稿のほうがまし（裁定）。
 * 再試行するのは Plugin が `retryable: true` を返したときだけ。
 *
 * 時間は実時間で待たない。再試行の間隔は `next_attempt_at` を過去へ書き換えて詰め、
 * タイムアウトは第 2 引数 `{ timeoutMs: 200 }` で差し替える（実装プラン §8 の 2）。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';

type PublishFn = NonNullable<PublisherRegistration['publish']>;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `ret${suffix}`,
        email: `ret${suffix}@example.com`,
        display_name: 'publish retry test',
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
    loginId: `ret${suffix}`,
    displayName: 'publish retry test',
    email: `ret${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function usePublisher(publish: PublishFn): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(publish);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [{ key: 'identifier', label: '識別子', kind: 'text' }],
    publish: mock,
  });
  return mock;
}

async function accountFor(provider = PROVIDER): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    credentials: { identifier: 'id-a1b2' },
    status: 'connected',
  });
  return account.id;
}

async function makePost(accountId: string, minutesAgo = 1): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '配信される本文',
    scheduledAt: new Date(Date.now() - minutesAgo * 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly publish_started_at: Date | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
}

async function postRow(id: string): Promise<PostRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select([
        'status',
        'failed_at',
        'failure_reason',
        'publish_started_at',
        'attempt_count',
        'next_attempt_at',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

/** 着手印を直接立てる（ジョブしか立てない列なので、中断行はこうして作る）。 */
async function setPublishStartedAt(id: string, at: Date | null): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ publish_started_at: at })
      .where('id', '=', id)
      .execute();
  });
}

/** 再試行の予約時刻を過去へ戻す（実時間で待たないため）。 */
async function rewindNextAttempt(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ next_attempt_at: new Date(Date.now() - 1_000) })
      .where('id', '=', id)
      .execute();
  });
}

async function run(options?: { readonly timeoutMs?: number }) {
  return withConnection((connection) =>
    options === undefined ? publishDuePosts(connection) : publishDuePosts(connection, options),
  );
}

/** 予約時刻が「今から delayMs 後」であること（±5 秒）。 */
function expectDelay(nextAttemptAt: Date | null, delayMs: number): void {
  expect(nextAttemptAt).toBeInstanceOf(Date);
  const diff = (nextAttemptAt?.getTime() ?? 0) - Date.now();
  expect(diff, `次の予約が ${delayMs}ms 後ではない（${diff}ms）`).toBeGreaterThan(delayMs - 5_000);
  expect(diff, `次の予約が ${delayMs}ms 後ではない（${diff}ms）`).toBeLessThan(delayMs + 5_000);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishretry');
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

/**
 * #44。**中断行は再送せず `failed` に落とす**（設計 §6.5.4）。
 *
 * 着手印が残っている ＝ 前回の実行が `publish()` の途中で死んだ行。
 * advisory lock により同時実行は無く、正常に終われば印は必ず NULL に戻る。
 */
describe('#44 中断行', () => {
  async function interrupted(): Promise<{
    readonly postId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor();
    const postId = await makePost(accountId);
    await setPublishStartedAt(postId, new Date(Date.now() - 60_000));

    const summary = await run();
    return { postId, publish, summary };
  }

  it('#44 中断行は failed になる', async () => {
    const { postId } = await interrupted();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#44 理由が INTERRUPTED_REASON', async () => {
    const { postId } = await interrupted();

    expect((await postRow(postId)).failure_reason).toBe(INTERRUPTED_REASON);
  });

  it('#44 failed_at が入り、着手印は NULL に戻る', async () => {
    const { postId } = await interrupted();
    const row = await postRow(postId);

    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.publish_started_at).toBeNull();
  });

  it('#44 その行について publish() は呼ばれない', async () => {
    // **二重投稿より未投稿のほうがまし。** 人が SNS 側を見て投稿し直す。
    const { publish } = await interrupted();

    expect(publish).not.toHaveBeenCalled();
  });

  it('#44 social.post.failed が発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      events.push(payload);
    });

    await interrupted();

    expect(events).toHaveLength(1);
  });

  it('#44 summary の interrupted が 1', async () => {
    const { summary } = await interrupted();

    expect(summary).toMatchObject({ interrupted: 1 });
  });

  it('#44 中断行は取り出しの対象にならない（due に数えない）', async () => {
    const { summary } = await interrupted();

    expect(summary).toMatchObject({ due: 0, attempted: 0 });
  });
});

/** #45。再試行の間隔は 1 → 2 → 4 → 8 分、5 回目で諦める（設計 §6.5.6）。 */
describe('#45 retryable な失敗の再試行', () => {
  async function retryOnce(): Promise<{
    readonly postId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = usePublisher(async () => ({ ok: false, reason: 'r', retryable: true }));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const summary = await run();
    return { postId, publish, summary };
  }

  it('#45 1 回目の後も scheduled のまま', async () => {
    // **状態は増やさない。** 「再試行待ち」は `scheduled` + `failure_reason` で表す（設計 §5.8）。
    const { postId } = await retryOnce();

    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#45 attempt_count が 1 になる', async () => {
    const { postId } = await retryOnce();

    expect((await postRow(postId)).attempt_count).toBe(1);
  });

  it('#45 next_attempt_at がおよそ 60 秒後', async () => {
    const { postId } = await retryOnce();

    expectDelay((await postRow(postId)).next_attempt_at, 60_000);
  });

  it('#45 failure_reason に Plugin の理由が入り、着手印は NULL に戻る', async () => {
    const { postId } = await retryOnce();
    const row = await postRow(postId);

    expect(row.failure_reason).toBe('r');
    expect(row.publish_started_at).toBeNull();
  });

  it('#45 summary の retried が 1', async () => {
    const { summary } = await retryOnce();

    expect(summary).toMatchObject({ attempted: 1, retried: 1, published: 0, failed: 0 });
  });

  it('#45 next_attempt_at が未来の間は取り出さない', async () => {
    const { publish } = await retryOnce();

    const second = await run();

    expect(second).toMatchObject({ due: 0, attempted: 0 });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('#45 2 回目の予約はおよそ 120 秒後', async () => {
    const { postId } = await retryOnce();

    await rewindNextAttempt(postId);
    await run();

    expectDelay((await postRow(postId)).next_attempt_at, 120_000);
  });

  it('#45 3 回目の予約はおよそ 240 秒後', async () => {
    const { postId } = await retryOnce();

    for (let i = 0; i < 2; i += 1) {
      await rewindNextAttempt(postId);
      await run();
    }

    expectDelay((await postRow(postId)).next_attempt_at, 240_000);
  });

  it('#45 4 回目の予約はおよそ 480 秒後', async () => {
    const { postId } = await retryOnce();

    for (let i = 0; i < 3; i += 1) {
      await rewindNextAttempt(postId);
      await run();
    }

    expectDelay((await postRow(postId)).next_attempt_at, 480_000);
  });

  it('#45 5 回目で failed になり、理由に「再試行の上限」が付く', async () => {
    const { postId } = await retryOnce();

    for (let i = 0; i < 4; i += 1) {
      await rewindNextAttempt(postId);
      await run();
    }

    const row = await postRow(postId);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toContain('再試行の上限');
    expect(row.next_attempt_at).toBeNull();
  });

  it('#45 5 回目で social.post.failed が発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      events.push(payload);
    });
    const { postId } = await retryOnce();

    for (let i = 0; i < 4; i += 1) {
      await rewindNextAttempt(postId);
      await run();
    }

    expect(events).toHaveLength(1);
  });

  it('#45 publish() は合計 5 回しか呼ばれない', async () => {
    const { postId, publish } = await retryOnce();

    for (let i = 0; i < 5; i += 1) {
      await rewindNextAttempt(postId);
      await run();
    }

    expect(publish).toHaveBeenCalledTimes(5);
  });
});

/** #46。Plugin の `retryAfterMs`（Rate Limit の `Retry-After`）。 */
describe('#46 retryAfterMs', () => {
  it('#46 既定より長い指定（300 秒）はそちらが使われる', async () => {
    usePublisher(async () => ({
      ok: false,
      reason: 'rate limited',
      retryable: true,
      retryAfterMs: 300_000,
    }));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();

    expectDelay((await postRow(postId)).next_attempt_at, 300_000);
  });

  it('#46 既定より短い指定（1 秒）は無視して 60 秒後', async () => {
    // 短い指定で既定の間隔を縮めさせない（落ちている相手を叩き続けない）。
    usePublisher(async () => ({
      ok: false,
      reason: 'busy',
      retryable: true,
      retryAfterMs: 1_000,
    }));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();

    expectDelay((await postRow(postId)).next_attempt_at, 60_000);
  });
});

/** #47。`retryable: false` は 1 回で諦める。 */
describe('#47 retryable でない失敗', () => {
  async function failOnce(): Promise<{
    readonly postId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = usePublisher(async () => ({ ok: false, reason: 'no', retryable: false }));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const summary = await run();
    return { postId, publish, summary };
  }

  it('#47 1 回で failed になる', async () => {
    const { postId, publish } = await failOnce();

    expect((await postRow(postId)).status).toBe('failed');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('#47 failure_reason が Plugin の理由そのまま', async () => {
    const { postId } = await failOnce();

    expect((await postRow(postId)).failure_reason).toBe('no');
  });

  it('#47 failed_at が入り、next_attempt_at は NULL', async () => {
    const { postId } = await failOnce();
    const row = await postRow(postId);

    expect(row.failed_at).toBeInstanceOf(Date);
    expect(row.next_attempt_at).toBeNull();
  });

  it('#47 social.post.failed が発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      events.push(payload);
    });

    await failOnce();

    expect(events).toHaveLength(1);
  });

  it('#47 summary の failed が 1', async () => {
    const { summary } = await failOnce();

    expect(summary).toMatchObject({ attempted: 1, failed: 1, retried: 0 });
  });
});

/**
 * #48。例外とタイムアウトは**結果不明**として `failed`（再試行しない）。
 *
 * 送る前の失敗は Plugin が `retryable: true` で返す契約（設計 §9.2）なので、
 * 例外まで再試行すると「届いたかもしれない投稿」をもう一度送ることになる。
 */
describe('#48 例外とタイムアウト', () => {
  it('#48 publish() が throw したら failed', async () => {
    usePublisher(async () => {
      throw new Error('boom');
    });
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#48 例外の理由に boom と「結果不明」が入る', async () => {
    usePublisher(async () => {
      throw new Error('boom');
    });
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();

    const reason = (await postRow(postId)).failure_reason ?? '';
    expect(reason).toContain('boom');
    expect(reason).toContain('結果不明');
  });

  it('#48 例外では再試行を予約しない', async () => {
    usePublisher(async () => {
      throw new Error('boom');
    });
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();

    expect((await postRow(postId)).next_attempt_at).toBeNull();
  });

  it('#48 解決しない publisher はタイムアウトで failed になる', async () => {
    // `signal` を無視する publisher でも打ち切る（実装プラン §7 の 7 / §8 の 11）。
    usePublisher(() => new Promise<never>(() => undefined));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run({ timeoutMs: 200 });

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#48 タイムアウトの理由が TIMEOUT_REASON', async () => {
    usePublisher(() => new Promise<never>(() => undefined));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run({ timeoutMs: 200 });

    expect((await postRow(postId)).failure_reason).toBe(TIMEOUT_REASON);
  });

  it('#48 タイムアウトでは publisher へ渡した signal が aborted になる', async () => {
    let received: PublishInput | null = null;
    usePublisher(
      (input) =>
        new Promise<never>(() => {
          received = input;
        }),
    );
    const accountId = await accountFor();
    await makePost(accountId);

    await run({ timeoutMs: 200 });

    expect(received).not.toBeNull();
    expect((received as PublishInput | null)?.signal.aborted).toBe(true);
  });

  it('#48 タイムアウトでも再試行を予約しない', async () => {
    usePublisher(() => new Promise<never>(() => undefined));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run({ timeoutMs: 200 });

    const row = await postRow(postId);
    expect(row.next_attempt_at).toBeNull();
    expect(row.publish_started_at).toBeNull();
  });

  it('#48 タイムアウトした行のログに Plugin へ渡した本文が出ない', async () => {
    const { records } = capture();
    usePublisher(() => new Promise<never>(() => undefined));
    const accountId = await accountFor();
    await makePost(accountId);

    await run({ timeoutMs: 200 });

    expect(JSON.stringify(records)).not.toContain('配信される本文');
  });
});
