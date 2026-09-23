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
 * > **2026-09-23 に書き直した（検証レポート §9.2 の R-3、裁定 #12-b）。** もとは
 * > 「1 回目 `attempted: 0` → **続けてもう一度実行すると** `due: 1` / `published: 1`」と、
 * > **1 周期遅れること自体を固定していた**。飛ばした行が取り出し枠を食わなくなったので、
 * > **同じ周期で送られる**のが正しい振る舞いになる（設計 §6.5.2.1 / §6.5.3）。
 * >
 * > **保証は弱めていない**（純増）。飛ばした 20 件の状態（`attempt_count = 0` /
 * > `skip_count = 1` / `skip_reason` / `next_attempt_at`）と「2 回目に再び現れない」ことは
 * > そのまま残し、「同じ周期で配信される」を足した。
 *
 * この条件は次のいずれでも落ちる：
 * `deferSkipped` を消す／`listDue` の `next_attempt_at` 条件を外す／
 * `claimForPublish` のリセットを外す／**読み進めをやめて 1 ページで打ち切る**。
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

  /**
   * **ここが要**（裁定 #12-b）。飛ばした 20 件は**取り出し枠を食わない**ので、
   * 1 回目の実行で配信可能な 1 件まで読み進んで送られる。
   */
  it('#89 1 回目の実行で配信可能な 1 件が送られる', async () => {
    const { publish } = await twentyPlusOne();

    const summary = await run();

    expect(summary).toMatchObject({
      due: 21,
      skipped: 20,
      skipFailed: 0,
      attempted: 1,
      published: 1,
    });
    expect(publish).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('#89 1 回目で配信可能な投稿が published になる', async () => {
    const { deliverable } = await twentyPlusOne();

    await run();

    expect((await skipRow(deliverable)).status).toBe('published');
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

  /**
   * #89。**2 回目に再び現れない**（元の条件から残している保証）。
   *
   * 飛ばした 20 件は `next_attempt_at` で候補から外れ、送った 1 件は `scheduled` ではない。
   */
  it('#89 続けてもう一度実行すると due が 0', async () => {
    const { publish } = await twentyPlusOne();
    await run();

    const second = await run();

    expect(second).toMatchObject({ due: 0, skipped: 0, attempted: 0, published: 0 });
    // 1 回目の 1 件だけ。2 回目は誰も送らない。
    expect(publish).toHaveBeenCalledTimes(1);
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
 * #93。**予約し直しで消えるのは待ち時刻だけ。飛ばした履歴は残る**
 * （設計 §6.2 / §5.1.1。裁定 #14-a）。
 *
 * 判定は 1 つだけ：`next = { …current, …input }` が
 * `status === 'scheduled'` かつ `scheduledAt > now` なら **`next_attempt_at = NULL`**。
 * **`current.status` は見ない。`skip_count` / `skip_reason` は触らない。**
 *
 * > **2026-09-23 に書き直した（検証レポート §9.2 の R-1 / R-2、裁定 #12-a）。** もとは
 * > **`draft` を経由する形（いまの (c)）しか見ていなかった**ため、`scheduled` のまま
 * > 日時だけ直す更新がリセットされないことを捕まえられず、
 * > **「予約中の投稿の日時を直す」という最も普通の操作**が最大 23 時間配信されない
 * > 欠陥をテストが通してしまった。
 * >
 * > (a)(b)(d)(e) を足し、(c) を残した。**ただし元の条件から 1 件を取り下げている**：
 * > 元の (c) は**過去日時**で予約し直して `skip_count` と `next_attempt_at` が戻ることを
 * > 要求していたが、裁定 #12-a がその保証を取り下げた（取り下げないと 3 回上限の回避路が開く）。
 * > **代償は設計 §11 #21 に記録した。**
 * > 「未来」を条件に足したのは、同じ 1 か所が 3 回上限の回避路でもあるため（R-2）。
 *
 * > **2026-09-23 に (f) を足した（3 回目の検証、裁定 #13-a）。** リセットの条件に
 * > **差分**（`next.scheduledAt > current.scheduledAt`）が入り、
 * > **「先送りする」更新だけがリセットを得る**形になった。
 *
 * > **2026-09-23 にもう一度書き直した（裁定 #14）。** 差分では回避路が塞がらなかった——
 * > 2 段階の 1 つ目「過去日時の投稿を未来へ」は**先送りそのもの**で、
 * > **(a) が要求する正当な操作と `PATCH` の側では見分けられない**。
 * > 裁定 #14 はリセットの引き金を更新に求めるのをやめ、**消すのは `next_attempt_at` だけ**にした。
 * >
 * > **残したもの**：(a)〜(c) の主眼（予約中の投稿の日時を直したらその時刻に出る）、
 * > (d) の「過去日時では待ち時刻が消えない」、(e)、(f) の「3 回上限を回避できない」。
 * > **取り下げたもの**：(1) 予約し直しで `skip_count` / `skip_reason` が 0 に戻ること
 * > （裁定 #14-a が明示的に否定。代償は設計 §11 #24）、
 * > (2) 前へ引き戻す更新で `next_attempt_at` が消えないこと（差分を外したため。
 * > **その保証が守っていた「回避路を塞ぐ」役目は (f) が引き継ぐ**）。
 * > **足したもの**：(f) の「未来へ→過去へ」の 2 段階を繰り返しても `skip_count` が減らず、
 * > **3 回で `failed`** に届くこと。
 */
describe('#93 予約し直しで消えるのは待ち時刻だけ', () => {
  const TEN_MINUTES_MS = 10 * 60_000;

  /** `no_publisher` で 1 回飛ばされた `scheduled` の投稿を作る。 */
  async function skippedOnce(): Promise<string> {
    const accountId = await accountFor({ credentials: CREDENTIALS });
    const postId = await makePost(accountId);
    await run();

    const row = await skipRow(postId);
    expect(row.skip_count).toBe(1);
    expect(row.skip_reason).toBe('no_publisher');
    expectDelay(row.next_attempt_at, HOUR_MS);
    return postId;
  }

  function future(): Date {
    return new Date(Date.now() + TEN_MINUTES_MS);
  }

  function past(): Date {
    return new Date(Date.now() - 60_000);
  }

  /**
   * **待ち時刻だけが消えていること**（裁定 #14-a）。
   * 飛ばした履歴（`skip_count` / `skip_reason`）は**残る**。
   */
  async function expectWaitCleared(postId: string): Promise<void> {
    const row = await skipRow(postId);
    expect(row.next_attempt_at).toBeNull();
    expect(row.skip_count).toBe(1);
    expect(row.skip_reason).toBe('no_publisher');
  }

  /** 飛ばした履歴が残っていること。 */
  async function expectKept(postId: string): Promise<void> {
    const row = await skipRow(postId);
    expect(row.skip_count).toBe(1);
    expect(row.skip_reason).toBe('no_publisher');
    expect(row.next_attempt_at).toBeInstanceOf(Date);
  }

  /** 予約日時を過去へ戻して 1 回実行する（未来の予約を「その時刻まで進める」代わり）。 */
  async function rewindScheduledAt(postId: string): Promise<void> {
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({ scheduled_at: new Date(Date.now() - 1_000) })
        .where('id', '=', postId)
        .execute();
    });
  }

  // -------------------------------------------------------------------------
  // (a) scheduled のまま scheduledAt だけ未来へ直す（編集フォームと同じく status を送る）
  // -------------------------------------------------------------------------

  describe('#93 (a) scheduled のまま日時だけ未来へ直す', () => {
    async function rescheduled(): Promise<string> {
      const postId = await skippedOnce();
      await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
      return postId;
    }

    it('#93 (a) next_attempt_at が消え、skip_count / skip_reason は残る', async () => {
      await expectWaitCleared(await rescheduled());
    });

    /**
     * #93 (a) の要。**`next_attempt_at` が残っていれば 23 時間待たされて落ちる。**
     * 「指定し直した時刻に出る」ことまで見ないと、リセットの有無を見分けられない。
     */
    it('#93 (a) その時刻まで進めるとその回で配信される', async () => {
      const postId = await rescheduled();

      usePublisher(async () => ({ ok: true }));
      await rewindScheduledAt(postId);
      const summary = await run();

      expect(summary).toMatchObject({ due: 1, attempted: 1, published: 1 });
      expect((await skipRow(postId)).status).toBe('published');
    });

    /** 配信できた時点で履歴は役目を終える（着手時のリセット。#92）。 */
    it('#93 (a) 配信できた時点で skip_count が 0 に戻る', async () => {
      const postId = await rescheduled();

      usePublisher(async () => ({ ok: true }));
      await rewindScheduledAt(postId);
      await run();

      const row = await skipRow(postId);
      expect(row.skip_count).toBe(0);
      expect(row.skip_reason).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // (b) status を送らずに scheduledAt だけ未来へ直す
  // -------------------------------------------------------------------------

  describe('#93 (b) status を送らずに日時だけ未来へ直す', () => {
    async function rescheduled(): Promise<string> {
      const postId = await skippedOnce();
      // 判定は `input` ではなく `next = { …current, …input }` で行う（設計 §6.2）。
      await updateSocialPost(admin, { id: postId, scheduledAt: future() });
      return postId;
    }

    it('#93 (b) next_attempt_at が消え、skip_count / skip_reason は残る', async () => {
      await expectWaitCleared(await rescheduled());
    });

    it('#93 (b) その時刻まで進めるとその回で配信される', async () => {
      const postId = await rescheduled();

      usePublisher(async () => ({ ok: true }));
      await rewindScheduledAt(postId);

      expect(await run()).toMatchObject({ due: 1, attempted: 1, published: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // (c) draft を経由する従来の形（**元の条件そのもの。消さない**）
  // -------------------------------------------------------------------------

  describe('#93 (c) draft を経由して予約し直す', () => {
    async function rescheduled(): Promise<string> {
      const postId = await skippedOnce();
      await updateSocialPost(admin, { id: postId, status: 'draft' });
      await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
      return postId;
    }

    it('#93 (c) skip_count / skip_reason は draft を経由しても残る', async () => {
      const row = await skipRow(await rescheduled());

      expect(row.skip_count).toBe(1);
      expect(row.skip_reason).toBe('no_publisher');
    });

    it('#93 (c) next_attempt_at が NULL に戻る（後ろへ送られた待ち時刻を引きずらない）', async () => {
      expect((await skipRow(await rescheduled())).next_attempt_at).toBeNull();
    });

    it('#93 (c) 予約し直した投稿はその時刻の回で配信される', async () => {
      const postId = await rescheduled();

      usePublisher(async () => ({ ok: true }));
      await rewindScheduledAt(postId);
      const summary = await run();

      expect(summary).toMatchObject({ due: 1, published: 1 });
      expect((await skipRow(postId)).status).toBe('published');
    });
  });

  // -------------------------------------------------------------------------
  // (d) 過去日時では待ち時刻も消えない（設計 §11 #21）
  // -------------------------------------------------------------------------

  describe('#93 (d) 過去日時では待ち時刻も消えない', () => {
    it('#93 (d) scheduled のまま過去日時へ直す更新は成功する', async () => {
      const postId = await skippedOnce();

      await expect(
        updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() }),
      ).resolves.toMatchObject({ status: 'scheduled' });
    });

    it('#93 (d) 過去日時では skip_count / skip_reason / next_attempt_at が残る', async () => {
      const postId = await skippedOnce();

      await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() });

      await expectKept(postId);
    });

    it('#93 (d) draft を経由して過去日時へ戻しても残る', async () => {
      const postId = await skippedOnce();

      await updateSocialPost(admin, { id: postId, status: 'draft' });
      await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() });

      await expectKept(postId);
    });
  });

  // -------------------------------------------------------------------------
  // (e) attempt_count は (a)〜(d) のどれでも変わらない
  // -------------------------------------------------------------------------

  describe('#93 (e) attempt_count は戻さない', () => {
    /** 戻すのは飛ばした履歴だけ。再試行の回数（`publish()` を呼んだ回数）ではない。 */
    it.each([
      [
        '(a) scheduled のまま未来へ',
        async (postId: string) => {
          await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
        },
      ],
      [
        '(b) status を送らず未来へ',
        async (postId: string) => {
          await updateSocialPost(admin, { id: postId, scheduledAt: future() });
        },
      ],
      [
        '(c) draft を経由して未来へ',
        async (postId: string) => {
          await updateSocialPost(admin, { id: postId, status: 'draft' });
          await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
        },
      ],
      [
        '(d) 過去日時へ',
        async (postId: string) => {
          await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() });
        },
      ],
    ])('#93 (e) %s でも attempt_count が変わらない', async (_label, update) => {
      const postId = await skippedOnce();
      const before = (await skipRow(postId)).attempt_count;

      await update(postId);

      expect((await skipRow(postId)).attempt_count).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // (f) 3 回上限の回避路が無い（裁定 #14 の要）
  // -------------------------------------------------------------------------

  /**
   * #93 (f)。**どの形で予約し直しても `skip_count` は減らない**（裁定 #14-a）。
   *
   * 裁定 #12-a / #13-a は「リセットさせない更新の形」を探したが、
   * **2 段階の 1 つ目（過去日時の投稿を未来へ）は (a) が要求する正当な操作そのもの**で、
   * `PATCH` の側では見分けられなかった。裁定 #14 は引き金を更新に求めるのをやめ、
   * **`skip_count` / `skip_reason` を予約し直しでは触らない**ことにした。
   *
   * **この describe は、予約し直しで `skip_count` を 0 に戻すと落ちる。**
   */
  describe('#93 (f) 3 回上限の回避路が無い', () => {
    const TWO_HOURS_MS = 2 * HOUR_MS;

    function farFuture(): Date {
      return new Date(Date.now() + TWO_HOURS_MS);
    }

    /**
     * 「未来へ → 過去へ」の 2 段階（裁定 #13-a が塞ごうとして塞げなかった形）。
     * 1 つ目で待ち時刻が消え、2 つ目で期限到来の窓へ戻る。
     */
    async function twoStage(postId: string): Promise<void> {
      await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
      await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() });
    }

    it('#93 (f) 2 段階を 5 回繰り返しても skip_count が減らない', async () => {
      const postId = await skippedOnce();

      for (let i = 0; i < 5; i += 1) {
        await twoStage(postId);
      }

      const row = await skipRow(postId);
      expect(row.skip_count).toBe(1);
      expect(row.skip_reason).toBe('no_publisher');
    });

    /** 2 段階は待ち時刻を消すので、行は次の周期で**もう一度見られる**（だから回数が増える）。 */
    it('#93 (f) 2 段階のあとは待ち時刻が消えて次の周期で見られる', async () => {
      const postId = await skippedOnce();

      await twoStage(postId);

      expect((await skipRow(postId)).next_attempt_at).toBeNull();
      expect(await run()).toMatchObject({ due: 1, skipped: 1 });
    });

    /** #93 (f) の要。**2 段階を挟んで何度戻しても、3 回目で取りやめに届く。** */
    it('#93 (f) 2 段階を挟みながら繰り返すと 3 回で failed になる', async () => {
      const postId = await skippedOnce();

      await twoStage(postId);
      expect(await run()).toMatchObject({ skipped: 1, skipFailed: 0 });
      expect((await skipRow(postId)).skip_count).toBe(2);

      await twoStage(postId);
      const summary = await run();

      expect(summary).toMatchObject({ skipped: 0, skipFailed: 1 });
      const row = await skipRow(postId);
      expect(row.status).toBe('failed');
      expect(row.skip_count).toBe(3);
      expect(row.next_attempt_at).toBeNull();
    });

    /** 過去日時のまま `draft` → `scheduled` を繰り返す形（元の (d) の要。R-2）。 */
    it('#93 (f) 過去日時のまま draft を 5 回往復しても skip_count は 2 のまま', async () => {
      const postId = await skippedOnce();
      await rewindNextAttempt(postId);
      await run();
      expect((await skipRow(postId)).skip_count).toBe(2);

      for (let i = 0; i < 5; i += 1) {
        await updateSocialPost(admin, { id: postId, status: 'draft' });
        await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() });
      }

      expect((await skipRow(postId)).skip_count).toBe(2);
    });

    it('#93 (f) 過去日時のまま往復した後も次に飛ばされた時点で failed になる', async () => {
      const postId = await skippedOnce();
      await rewindNextAttempt(postId);
      await run();

      for (let i = 0; i < 5; i += 1) {
        await updateSocialPost(admin, { id: postId, status: 'draft' });
        await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: past() });
      }
      await rewindNextAttempt(postId);
      const summary = await run();

      expect(summary).toMatchObject({ skipFailed: 1, skipped: 0 });
      expect((await skipRow(postId)).status).toBe('failed');
    });

    /** `draft` で未来（+2 時間）へ挟んでから手前の未来へ引き戻す形（元の (f) の要）。 */
    it('#93 (f) 未来へ挟んで引き戻す形を 5 回繰り返しても skip_count は 2 のまま', async () => {
      const postId = await skippedOnce();
      await rewindNextAttempt(postId);
      await run();
      expect((await skipRow(postId)).skip_count).toBe(2);

      for (let i = 0; i < 5; i += 1) {
        await updateSocialPost(admin, { id: postId, status: 'draft', scheduledAt: farFuture() });
        await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
      }

      expect((await skipRow(postId)).skip_count).toBe(2);
    });

    it('#93 (f) 未来へ挟んで引き戻した後も次に飛ばされた時点で failed になる', async () => {
      const postId = await skippedOnce();
      await rewindNextAttempt(postId);
      await run();

      for (let i = 0; i < 5; i += 1) {
        await updateSocialPost(admin, { id: postId, status: 'draft', scheduledAt: farFuture() });
        await updateSocialPost(admin, { id: postId, status: 'scheduled', scheduledAt: future() });
      }
      await rewindScheduledAt(postId);
      await rewindNextAttempt(postId);
      const summary = await run();

      expect(summary).toMatchObject({ skipFailed: 1, skipped: 0 });
      expect((await skipRow(postId)).status).toBe('failed');
    });
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
