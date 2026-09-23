import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信できない予約を後ろへ送る（035-social-publishing 設計 §5.1.1 / §6.5.2.1、
 * 受け入れ条件 #88〜#94。裁定 #9、検証レポート S-1）。
 *
 * **飛ばした行に痕跡を残さないと、その 20 件がバッチの先頭に居座り続け、
 * 他のアカウントの配信まで止まる。** それが S-1 で、#89 がそれを固定する。
 *
 * 飛ばすときは `next_attempt_at` を置いて後ろへ送り、**同じ理由で 3 回飛ばされたら
 * `failed`** にして順番待ちから外す。猶予はおよそ 24 時間（1 時間 → 23 時間）。
 *
 * 時間は実時間で待たない。`next_attempt_at` を過去へ書き換えて周期を詰める
 * （`publish-retry.integration.test.ts` の再試行と同じ作法）。
 */

const PLUGIN_ID = 'test-plugin';
/** publisher を登録する provider。 */
const PROVIDER = 'testsns';
/** publisher を一度も登録しない provider。 */
const NO_PUBLISHER = 'nopublisher';
const CREDENTIALS = { identifier: 'id-a1b2', appPassword: 'pw-c3d4' } as const;
const CREDENTIAL_FIELDS = [
  { key: 'identifier', label: '識別子', kind: 'text' },
  { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
] as const;

const HOUR_MS = 60 * 60_000;

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
        login_id: `skp${suffix}`,
        email: `skp${suffix}@example.com`,
        display_name: 'publish skip test',
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
    loginId: `skp${suffix}`,
    displayName: 'publish skip test',
    email: `skp${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 偽の publisher。資格情報を要求する（`credentialFields` が空でない）。 */
function usePublisher(
  publish: PublishFn,
  overrides: Partial<PublisherRegistration> = {},
): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(publish);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [...CREDENTIAL_FIELDS],
    publish: mock,
    ...overrides,
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

interface SkipRow {
  readonly status: string;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly publish_started_at: Date | null;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly skip_count: number;
  readonly skip_reason: string | null;
}

async function skipRow(id: string): Promise<SkipRow> {
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
        'skip_count',
        'skip_reason',
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as SkipRow;
}

/** 後ろへ送られた予定を過去へ戻す（実時間で待たないため）。 */
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

/** 失敗することを期待する呼び出しから Error を取り出す。 */
async function caught(run_: () => Promise<unknown>): Promise<unknown> {
  try {
    await run_();
  } catch (error) {
    return error;
  }
  throw new Error('例外が投げられなかった');
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishskip');
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
    // **`job_runs` を必ず消す**（実装プラン §7 の 17）。
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/**
 * #88。**後ろへ送った行は次の周期の取り出しに出ない**（設計 §6.5.2.1）。
 *
 * `listDue` の SQL は `022` のときと変わらない。
 * `(next_attempt_at IS NULL OR next_attempt_at <= now())` が既にあり、
 * `next_attempt_at` を置くだけで候補から外れる。
 */
describe('#88 後ろへ送った行は次の取り出しに出ない', () => {
  it('#88 飛ばした直後にもう一度実行すると due が 0', async () => {
    const accountId = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    await makePost(accountId);
    expect(await run()).toMatchObject({ due: 1, skipped: 1 });

    const second = await run();

    expect(second).toMatchObject({ due: 0, skipped: 0, attempted: 0 });
  });

  it('#88 next_attempt_at を過去に書き換えると再び due に出る', async () => {
    const accountId = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    const postId = await makePost(accountId);
    await run();

    await rewindNextAttempt(postId);
    const third = await run();

    expect(third).toMatchObject({ due: 1, skipped: 1 });
  });
});

/**
 * #89。**他のアカウントの配信が止まらない**（検証レポート §8 が指定した再現形）。
 *
 * 修正前は `ORDER BY scheduled_at ASC LIMIT 20` の先頭を飛ばした 20 件が占め続け、
 * `due: 20 / skipped: 20 / attempted: 0` を返し続けて**配信可能な 1 件が永久に送られなかった**。
 * Plugin を入れ忘れた provider の期限切れ予約が 20 件溜まるだけで、
 * その installation の SNS 自動配信が全部止まる。悪意がなくても起きる。
 *
 * 止まるのは最大 1 周期（既定 1 分）にとどまること、をここで固定する。
 */
describe('#89 配信できない 20 件が他のアカウントを止めない', () => {
  /** 飛ばされる 20 件（古い）と、配信できる 1 件（新しい）を入れる。 */
  async function twentyPlusOne(): Promise<{
    readonly stuck: string[];
    readonly deliverable: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
  }> {
    const publish = usePublisher(async () => ({ ok: true }));
    const stuckAccount = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    const liveAccount = await accountFor({ credentials: CREDENTIALS });

    const stuck: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      // `scheduled_at` が最も古い 20 件。取り出しの先頭を占める。
      stuck.push(await makePost(stuckAccount, 30 - i));
    }
    const deliverable = await makePost(liveAccount, 1);

    return { stuck, deliverable, publish };
  }

  it('#89 1 回目は 20 件すべてを飛ばし、1 件も配信しない', async () => {
    const { publish } = await twentyPlusOne();

    const summary = await run();

    expect(summary).toMatchObject({ due: 20, skipped: 20, skipFailed: 0, attempted: 0 });
    expect(publish).not.toHaveBeenCalled();
  }, 60_000);

  it('#89 飛ばした 20 件は scheduled のまま attempt_count が 0', async () => {
    const { stuck } = await twentyPlusOne();

    await run();

    const rows = await Promise.all(stuck.map(async (id) => skipRow(id)));
    expect(rows.every((row) => row.status === 'scheduled')).toBe(true);
    expect(rows.every((row) => row.attempt_count === 0)).toBe(true);
  }, 60_000);

  it('#89 飛ばした 20 件は skip_count = 1 / skip_reason = no_publisher になる', async () => {
    const { stuck } = await twentyPlusOne();

    await run();

    const rows = await Promise.all(stuck.map(async (id) => skipRow(id)));
    expect(rows.every((row) => row.skip_count === 1)).toBe(true);
    expect(rows.every((row) => row.skip_reason === 'no_publisher')).toBe(true);
  }, 60_000);

  it('#89 飛ばした 20 件はおよそ 1 時間後へ送られる', async () => {
    const { stuck } = await twentyPlusOne();

    await run();

    for (const row of await Promise.all(stuck.map(async (id) => skipRow(id)))) {
      expectDelay(row.next_attempt_at, HOUR_MS);
    }
  }, 60_000);

  /** **ここが要。** 修正前はこの 2 回目も `due: 20 / attempted: 0` を返し続けた。 */
  it('#89 続けてもう一度実行すると配信可能な 1 件が送られる', async () => {
    const { deliverable, publish } = await twentyPlusOne();
    await run();

    const second = await run();

    expect(second).toMatchObject({ due: 1, attempted: 1, published: 1 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await skipRow(deliverable)).status).toBe('published');
  }, 60_000);
});

/**
 * #90。**同じ理由で 3 回飛ばされたら `failed`**（裁定 #9）。
 *
 * 1 時間 → 23 時間の猶予（合計およそ 24 時間）で支度が整わなければ諦め、
 * 順番待ちから外す。「Plugin を後から入れる」という裁定 #8 の趣旨は
 * 1 日ぶんの猶予で守り、永久に列を塞がせない。
 */
describe('#90 同じ理由で 3 回飛ばされたら failed', () => {
  async function skipTimes(times: number): Promise<string> {
    const accountId = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    const postId = await makePost(accountId);
    for (let i = 0; i < times; i += 1) {
      if (i > 0) await rewindNextAttempt(postId);
      await run();
    }
    return postId;
  }

  it('#90 1 回目は skip_count = 1 でおよそ 1 時間後', async () => {
    const row = await skipRow(await skipTimes(1));

    expect(row.status).toBe('scheduled');
    expect(row.skip_count).toBe(1);
    expectDelay(row.next_attempt_at, HOUR_MS);
  });

  it('#90 2 回目は skip_count = 2 でおよそ 23 時間後', async () => {
    const row = await skipRow(await skipTimes(2));

    expect(row.status).toBe('scheduled');
    expect(row.skip_count).toBe(2);
    expectDelay(row.next_attempt_at, 23 * HOUR_MS);
  });

  it('#90 3 回目で failed になる', async () => {
    const row = await skipRow(await skipTimes(3));

    expect(row.status).toBe('failed');
    expect(row.failed_at).toBeInstanceOf(Date);
  });

  it('#90 failed になった行は skip_count = 3 で next_attempt_at が NULL', async () => {
    const row = await skipRow(await skipTimes(3));

    expect(row.skip_count).toBe(3);
    expect(row.next_attempt_at).toBeNull();
  });

  it('#90 failure_reason が skipFailureReason の文言になる', async () => {
    const { skipFailureReason } = (await import('@/domain/social/publishing')) as {
      skipFailureReason?: (reason: 'no_publisher') => string;
    };
    const row = await skipRow(await skipTimes(3));

    expect(row.failure_reason).toBe(skipFailureReason?.('no_publisher'));
  });

  /** #90。文言は投稿一覧・履歴にそのまま出る。次に何をすればよいかが読めること。 */
  it('#90 その文言が約24時間で取りやめたことと、登録し直す手順を含む', async () => {
    const reason = (await skipRow(await skipTimes(3))).failure_reason ?? '';

    expect(reason).toContain('24時間');
    expect(reason).toContain('登録し直して');
  });

  /**
   * #90。**`attempt_count` は 0 のまま**（裁定 #9 の細目）。
   *
   * `attempt_count` は `publish()` を呼んだ回数という意味を保つ。
   * 飛ばした回数は `skip_count` が持つ。受け入れ条件 #27(B) / #49 はこの約束の上に立つ。
   */
  it('#90 3 回を通じて attempt_count が 0 のまま', async () => {
    const accountId = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    const postId = await makePost(accountId);

    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await rewindNextAttempt(postId);
      await run();
      const row = await skipRow(postId);
      expect(row.attempt_count, `${i + 1} 回目で着手印が書かれている`).toBe(0);
      expect(row.publish_started_at).toBeNull();
    }
  });

  it('#90 summary は 1・2 回目が skipped: 1、3 回目が skipFailed: 1', async () => {
    const accountId = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    const postId = await makePost(accountId);

    const first = await run();
    await rewindNextAttempt(postId);
    const second = await run();
    await rewindNextAttempt(postId);
    const third = await run();

    expect(first).toMatchObject({ skipped: 1, skipFailed: 0 });
    expect(second).toMatchObject({ skipped: 1, skipFailed: 0 });
    expect(third).toMatchObject({ skipped: 0, skipFailed: 1, failed: 0, attempted: 0 });
  });

  it('#90 social.post.failed が 1 回だけ発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      events.push(payload);
    });

    await skipTimes(3);

    expect(events).toHaveLength(1);
  });

  it('#90 諦めたときに log.error が 1 行残る', async () => {
    const { records } = capture();

    await skipTimes(3);

    const errors = records.filter(
      (record) => record.message === 'social post skipped too many times',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.level).toBe('error');
    expect(errors[0]?.fields?.['reason']).toBe('no_publisher');
  });
});

/**
 * #91。**理由が変われば数え直す**（裁定 #9 の細目）。
 *
 * 運用者は 1 つずつ直している最中である。
 * まとめて数えると、直している途中で打ち切られる。
 */
describe('#91 理由が変われば数え直す', () => {
  /** publisher が無いまま 2 回飛ばし、その後 publisher だけを入れる（資格情報は未設定）。 */
  async function twiceThenPublisher(): Promise<string> {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();
    await rewindNextAttempt(postId);
    await run();
    expect((await skipRow(postId)).skip_count).toBe(2);

    usePublisher(async () => ({ ok: true }));
    await rewindNextAttempt(postId);
    await run();
    return postId;
  }

  it('#91 理由が変わったら failed にならない', async () => {
    expect((await skipRow(await twiceThenPublisher())).status).toBe('scheduled');
  });

  it('#91 skip_reason が credential_missing に変わり skip_count が 1 に戻る', async () => {
    const row = await skipRow(await twiceThenPublisher());

    expect(row.skip_reason).toBe('credential_missing');
    expect(row.skip_count).toBe(1);
  });

  it('#91 待ちが 1 回目の 1 時間に戻る', async () => {
    expectDelay((await skipRow(await twiceThenPublisher())).next_attempt_at, HOUR_MS);
  });

  it('#91 summary は skipped: 1（skipFailed は 0）', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);
    await run();
    await rewindNextAttempt(postId);
    await run();

    usePublisher(async () => ({ ok: true }));
    await rewindNextAttempt(postId);
    const summary = await run();

    expect(summary).toMatchObject({ due: 1, skipped: 1, skipFailed: 0, attempted: 0 });
  });
});

/**
 * #92。**着手できたら数え直しが消える**（設計 §5.1.1）。
 *
 * 一度でも `publish()` まで進めた行に、飛ばした履歴を残す意味は無い。
 */
describe('#92 着手できたら skip_count / skip_reason が戻る', () => {
  async function skippedThenReady(): Promise<string> {
    const accountId = await accountFor({ credentials: CREDENTIALS });
    const postId = await makePost(accountId);
    await run();
    expect((await skipRow(postId)).skip_count).toBe(1);

    usePublisher(async () => ({ ok: true }));
    await rewindNextAttempt(postId);
    await run();
    return postId;
  }

  it('#92 支度が整えば配信される', async () => {
    expect((await skipRow(await skippedThenReady())).status).toBe('published');
  });

  it('#92 skip_count が 0 に、skip_reason が NULL に戻る', async () => {
    const row = await skipRow(await skippedThenReady());

    expect(row.skip_count).toBe(0);
    expect(row.skip_reason).toBeNull();
  });
});

/**
 * #93。**予約し直すと数え直しが消える**（設計 §6.2）。
 *
 * 戻さないと、後ろへ送られた予定を引きずったまま再予約され、指定した時刻に出ない。
 */
describe('#93 予約し直すと数え直しが消える', () => {
  async function skippedThenRescheduled(): Promise<string> {
    const accountId = await accountFor({ credentials: CREDENTIALS });
    const postId = await makePost(accountId);
    await run();
    expect((await skipRow(postId)).skip_count).toBe(1);

    await updateSocialPost(admin, { id: postId, status: 'draft' });
    await updateSocialPost(admin, {
      id: postId,
      status: 'scheduled',
      scheduledAt: new Date(Date.now() - 60_000),
    });
    return postId;
  }

  it('#93 skip_count が 0 に、skip_reason が NULL に戻る', async () => {
    const row = await skipRow(await skippedThenRescheduled());

    expect(row.skip_count).toBe(0);
    expect(row.skip_reason).toBeNull();
  });

  it('#93 next_attempt_at が NULL に戻る（後ろへ送られた予定を引きずらない）', async () => {
    const postId = await skippedThenRescheduled();

    expect((await skipRow(postId)).next_attempt_at).toBeNull();
  });

  it('#93 予約し直した投稿は次の実行で配信される', async () => {
    const postId = await skippedThenRescheduled();

    usePublisher(async () => ({ ok: true }));
    const summary = await run();

    expect(summary).toMatchObject({ due: 1, published: 1 });
    expect((await skipRow(postId)).status).toBe('published');
  });
});

/**
 * #94。**`failed` は終端**（裁定 #9）。
 *
 * 支度が整っても自動では戻らない。文言が「登録し直してください」と言い切るのはそのためで、
 * `failed → scheduled` は既存の遷移規則でも認めていない。
 */
describe('#94 諦めた投稿は終端', () => {
  async function givenUp(): Promise<string> {
    const accountId = await accountFor({ provider: NO_PUBLISHER, credentials: CREDENTIALS });
    const postId = await makePost(accountId);
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) await rewindNextAttempt(postId);
      await run();
    }
    expect((await skipRow(postId)).status).toBe('failed');
    return postId;
  }

  it('#94 publisher を登録して実行しても failed のまま', async () => {
    const postId = await givenUp();

    usePublisher(async () => ({ ok: true }));
    await run();

    expect((await skipRow(postId)).status).toBe('failed');
  });

  it('#94 failed の投稿は due に出ない', async () => {
    await givenUp();

    const publish = usePublisher(async () => ({ ok: true }));
    const summary = await run();

    expect(summary).toMatchObject({ due: 0, attempted: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('#94 scheduled へ戻す更新は ValidationError になる', async () => {
    const postId = await givenUp();

    const error = await caught(async () =>
      updateSocialPost(admin, { id: postId, status: 'scheduled' }),
    );

    expect(error).toBeInstanceOf(ValidationError);
  });
});
