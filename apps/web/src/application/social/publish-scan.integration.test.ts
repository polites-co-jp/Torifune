import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 着手できる行を集めるまで走査上限つきで読み進める
 * （035-social-publishing 設計 §5.6.2 / §6.5.2 / §6.5.2.1 / §6.5.3 / §6.5.7、
 * 受け入れ条件 #109・#110。検証レポート §9.2 の R-3、裁定 #12-b）。
 *
 * **`PUBLISH_BATCH_SIZE` は「送る行」の上限、`PUBLISH_SCAN_LIMIT` は「読む行」の上限。**
 * 飛ばした行は送る枠を食わずに後ろへ送られ、着手できる行が枠ぶん集まるか
 * 走査上限に達するまで読み進める。
 *
 * #89 は N = 20 しか見ていない（枠ちょうど）。**枠を超えたときに何が起きるか**は
 * #109 が初めて固定する。
 *
 * ## テストが前提にする口（設計 §6.5.3 が「テスト用に下げて」とだけ書いている部分）
 *
 * `PUBLISH_SCAN_LIMIT` は環境変数にしない定数（設計 §6.5.3）。差し替えは
 * `publishDuePosts(connection, { timeoutMs, validateTimeoutMs })` の流儀に揃え、
 * **`scanLimit` を `PublishDueOptions` に足す**（結合テストが 200 行を作らずに
 * 打ち切りを見るための口。ジョブ定義は渡さない）：
 *
 * ```ts
 * publishDuePosts(connection, { scanLimit?: number })   // 省略すると PUBLISH_SCAN_LIMIT
 * ```
 *
 * 時間は実時間で待たない。`next_attempt_at` を過去へ書き換えて周期を詰める。
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
/** 走査上限をテスト用に下げる値（設計 §10 #109）。 */
const SCAN_LIMIT = 10;

type PublishFn = NonNullable<PublisherRegistration['publish']>;

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
        login_id: `scn${suffix}`,
        email: `scn${suffix}@example.com`,
        display_name: 'publish scan test',
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
    loginId: `scn${suffix}`,
    displayName: 'publish scan test',
    email: `scn${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function usePublisher(): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(async () => ({ ok: true }));
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [...CREDENTIAL_FIELDS],
    publish: mock,
  });
  return mock;
}

async function accountFor(provider: string = PROVIDER): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    credentials: { ...CREDENTIALS },
    status: 'connected',
  });
  return account.id;
}

async function makePost(accountId: string, minutesAgo: number): Promise<string> {
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
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly skip_count: number;
  readonly skip_reason: string | null;
}

async function skipRow(id: string): Promise<SkipRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status', 'attempt_count', 'next_attempt_at', 'skip_count', 'skip_reason'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as SkipRow;
}

/**
 * `scanLimit` は `PublishDueOptions` の口（実装済み。上の「テストが前提にする口」）。
 *
 * テストを書いた時点では `PublishDueOptions` に無かったので `as` を置いていたが、
 * 実装が口を足したので外してある（外れないなら、口の名前がここと違う）。
 */
async function run(options?: { readonly scanLimit?: number }) {
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

/**
 * 支度未了 25 件（古い）と、配信できる 1 件（新しい）を入れる。
 *
 * 25 は `PUBLISH_BATCH_SIZE`（20）を**超える**件数。#89 の 20 件では
 * 「枠を超えた行がどうなるか」が見えない。
 */
async function twentyFivePlusOne(): Promise<{
  readonly stuck: readonly string[];
  readonly deliverable: string;
  readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
}> {
  const publish = usePublisher();
  const stuckAccount = await accountFor(NO_PUBLISHER);
  const liveAccount = await accountFor();

  const stuck: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    // `scheduled_at` が最も古い 25 件。取り出しの先頭を占める。
    stuck.push(await makePost(stuckAccount, 40 - i));
  }
  const deliverable = await makePost(liveAccount, 1);

  return { stuck, deliverable, publish };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishscan');
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

// ---------------------------------------------------------------------------
// #109 の前提：定数そのもの（設計 §5.6.2）
// ---------------------------------------------------------------------------

describe('#109 走査上限の定数', () => {
  it('#109 PUBLISH_SCAN_LIMIT が 200', async () => {
    // **静的 import にしない。** 未実装の段階でこのファイル全体が読めなくなると、
    // 何が壊れたのか読めない（`static-checks.test.ts` と同じ流儀）。
    const domain = (await import('@/domain/social/publishing')) as {
      readonly PUBLISH_SCAN_LIMIT?: number;
    };

    expect(domain.PUBLISH_SCAN_LIMIT).toBe(200);
  });

  it('#109 PUBLISH_SCAN_LIMIT は PUBLISH_BATCH_SIZE より大きい（読む > 送る）', async () => {
    const domain = (await import('@/domain/social/publishing')) as {
      readonly PUBLISH_SCAN_LIMIT?: number;
      readonly PUBLISH_BATCH_SIZE?: number;
    };

    expect(domain.PUBLISH_SCAN_LIMIT ?? 0).toBeGreaterThan(domain.PUBLISH_BATCH_SIZE ?? 0);
  });
});

// ---------------------------------------------------------------------------
// #109 支度未了が取り出し枠を超えても、配信可能な投稿が同じ周期で送られる
// ---------------------------------------------------------------------------

/**
 * #109（裁定 #12-b）。**#89 は N = 20 しか見ていない。**
 *
 * 支度未了が `PUBLISH_BATCH_SIZE`（20）を超えると、枠を超えた 5 件は
 * 「見送られる」のか「後ろへ送られる」のかが #89 では決まらない。
 * **見送ると次の周期も同じ 5 件が先頭に残り、`skip_count` が増えない**
 * （裁定 #9 の「3 回で `failed`」が働かない）。
 */
describe('#109 枠を超える支度未了があっても同じ周期で配信される', () => {
  it('#109 1 回の実行で due 26 / skipped 25 / attempted 1 / published 1', async () => {
    const { publish } = await twentyFivePlusOne();

    const summary = await run();

    expect(summary).toMatchObject({
      due: 26,
      skipped: 25,
      skipFailed: 0,
      attempted: 1,
      published: 1,
    });
    expect(publish).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('#109 配信可能な 1 件が published になる', async () => {
    const { deliverable } = await twentyFivePlusOne();

    await run();

    expect((await skipRow(deliverable)).status).toBe('published');
  }, 60_000);

  /** **枠を超えた 5 件も見送られずに後ろへ送られている。** */
  it('#109 25 件すべてに skip_count = 1 / skip_reason = no_publisher が入る', async () => {
    const { stuck } = await twentyFivePlusOne();

    await run();

    const rows = await Promise.all(stuck.map(async (id) => skipRow(id)));
    expect(rows.filter((row) => row.skip_count === 1)).toHaveLength(25);
    expect(rows.every((row) => row.skip_reason === 'no_publisher')).toBe(true);
  }, 60_000);

  it('#109 25 件すべてがおよそ 1 時間後へ送られる', async () => {
    const { stuck } = await twentyFivePlusOne();

    await run();

    for (const row of await Promise.all(stuck.map(async (id) => skipRow(id)))) {
      expectDelay(row.next_attempt_at, HOUR_MS);
    }
  }, 60_000);

  it('#109 25 件は scheduled のまま attempt_count が 0', async () => {
    const { stuck } = await twentyFivePlusOne();

    await run();

    const rows = await Promise.all(stuck.map(async (id) => skipRow(id)));
    expect(rows.every((row) => row.status === 'scheduled')).toBe(true);
    expect(rows.every((row) => row.attempt_count === 0)).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #109 走査上限で打ち切られる／一度見た行を読み直さない
// ---------------------------------------------------------------------------

/**
 * #109。**走査上限は 1 回の実行時間を状況で青天井にしないための蓋**（設計 §6.5.3）。
 *
 * カーソルは `(scheduled_at, id)` のキーセットで、`OFFSET` は使えない。
 * 走査中に飛ばした行は `next_attempt_at` が付いて条件から外れるので、
 * **`OFFSET` だと外れた行の数だけ後ろの行を読み飛ばす**（見ていない行が静かに残る）。
 */
describe('#109 走査上限で打ち切られる', () => {
  it('#109 走査上限 10 では due 10 / skipped 10 / attempted 0', async () => {
    await twentyFivePlusOne();

    const summary = await run({ scanLimit: SCAN_LIMIT });

    expect(summary).toMatchObject({
      due: 10,
      skipped: 10,
      skipFailed: 0,
      attempted: 0,
      published: 0,
    });
  }, 60_000);

  it('#109 2 回目も due 10（残りの 10 件を飛ばす）', async () => {
    await twentyFivePlusOne();
    await run({ scanLimit: SCAN_LIMIT });

    const second = await run({ scanLimit: SCAN_LIMIT });

    expect(second).toMatchObject({ due: 10, skipped: 10, attempted: 0, published: 0 });
  }, 60_000);

  /**
   * #109 の要。**1 回目に見た 10 件は `next_attempt_at` で候補から外れ、読み直さない。**
   *
   * 読み直していれば、その 10 件の `skip_count` が 2 になる。
   */
  it('#109 2 回目までに飛ばされた 20 件の skip_count がすべて 1', async () => {
    const { stuck } = await twentyFivePlusOne();
    await run({ scanLimit: SCAN_LIMIT });
    await run({ scanLimit: SCAN_LIMIT });

    const rows = await Promise.all(stuck.map(async (id) => skipRow(id)));

    expect(rows.filter((row) => row.skip_count === 1)).toHaveLength(20);
    expect(rows.filter((row) => row.skip_count === 0)).toHaveLength(5);
  }, 60_000);

  it('#109 3 回目で残り 5 件と配信可能な 1 件に届く', async () => {
    const { deliverable, publish } = await twentyFivePlusOne();
    await run({ scanLimit: SCAN_LIMIT });
    await run({ scanLimit: SCAN_LIMIT });

    const third = await run({ scanLimit: SCAN_LIMIT });

    expect(third).toMatchObject({ due: 6, skipped: 5, attempted: 1, published: 1 });
    expect(publish).toHaveBeenCalledTimes(1);
    expect((await skipRow(deliverable)).status).toBe('published');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// #109 着手できる行が枠ぶん集まったら読み進めをやめる
// ---------------------------------------------------------------------------

/**
 * #109。**支度が整っている普通の installation では 1 ページ読んで終わり**
 * （設計 §6.5.3）。枠が埋まってもなお `PUBLISH_SCAN_LIMIT` まで読み進めると、
 * 1 分周期のジョブが毎回 200 行を読むことになる。
 */
describe('#109 枠ぶん集まったら読み進めをやめる', () => {
  async function twentyFiveDeliverable(): Promise<ReturnType<typeof usePublisher>> {
    const publish = usePublisher();
    const liveAccount = await accountFor();
    for (let i = 0; i < 25; i += 1) {
      await makePost(liveAccount, 40 - i);
    }
    return publish;
  }

  it('#109 配信可能な 25 件では due 20 / attempted 20 / published 20', async () => {
    await twentyFiveDeliverable();

    const summary = await run();

    expect(summary).toMatchObject({ due: 20, attempted: 20, published: 20, skipped: 0 });
  }, 120_000);

  it('#109 publish() は 20 回だけ呼ばれる（PUBLISH_SCAN_LIMIT まで読み進めない）', async () => {
    const publish = await twentyFiveDeliverable();

    await run();

    expect(publish).toHaveBeenCalledTimes(20);
  }, 120_000);

  it('#109 残りの 5 件は次の周期で配信される', async () => {
    await twentyFiveDeliverable();
    await run();

    expect(await run()).toMatchObject({ due: 5, attempted: 5, published: 5 });
  }, 120_000);
});

// ---------------------------------------------------------------------------
// #110 summary の不変条件
// ---------------------------------------------------------------------------

/**
 * #110。**`summary` の意味**（設計 §6.5.7）。
 *
 * `due` は「走査して判定した期限到来の行の件数」（≤ `PUBLISH_SCAN_LIMIT`）で、
 * 取り出し枠（`PUBLISH_BATCH_SIZE`）は `attempted` のほうに掛かる。
 * **「見た件数」と「送ろうとした件数」が別々の上限を持つ。**
 *
 * キーは **9 つのまま**（`publishSummarySchema` の形が変わっていない）。
 */
describe('#110 summary の不変条件', () => {
  const KEYS = [
    'interrupted',
    'due',
    'skipped',
    'skipFailed',
    'attempted',
    'published',
    'retried',
    'failed',
    'unrecorded',
  ] as const;

  type Summary = Record<(typeof KEYS)[number], number>;

  async function limits(): Promise<{ batch: number; scan: number }> {
    const domain = (await import('@/domain/social/publishing')) as {
      readonly PUBLISH_BATCH_SIZE?: number;
      readonly PUBLISH_SCAN_LIMIT?: number;
    };
    return {
      batch: domain.PUBLISH_BATCH_SIZE ?? Number.NaN,
      scan: domain.PUBLISH_SCAN_LIMIT ?? Number.NaN,
    };
  }

  function expectInvariants(summary: Summary, scan: number, batch: number): void {
    expect(summary.attempted).toBe(
      summary.published + summary.retried + summary.failed + summary.unrecorded,
    );
    expect(summary.attempted, 'attempted が取り出し枠を超えている').toBeLessThanOrEqual(batch);
    expect(summary.due, 'due が走査上限を超えている').toBeLessThanOrEqual(scan);
    expect(summary.due, 'due が内訳の合計より小さい').toBeGreaterThanOrEqual(
      summary.skipped + summary.skipFailed + summary.attempted,
    );
  }

  it('#110 summary のキーはちょうど 9 つ', async () => {
    await twentyFivePlusOne();

    const summary = (await run()) as unknown as Summary;

    expect(Object.keys(summary).sort()).toEqual([...KEYS].sort());
  }, 60_000);

  it('#110 #89 の配置（20 + 1）で不変条件が成り立つ', async () => {
    const { batch, scan } = await limits();
    const publish = usePublisher();
    const stuckAccount = await accountFor(NO_PUBLISHER);
    const liveAccount = await accountFor();
    for (let i = 0; i < 20; i += 1) await makePost(stuckAccount, 30 - i);
    await makePost(liveAccount, 1);

    const summary = (await run()) as unknown as Summary;

    expectInvariants(summary, scan, batch);
    expect(publish).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('#110 #109 の配置（25 + 1）で不変条件が成り立つ', async () => {
    const { batch, scan } = await limits();
    await twentyFivePlusOne();

    const summary = (await run()) as unknown as Summary;

    expectInvariants(summary, scan, batch);
  }, 60_000);

  it('#110 走査上限を下げた実行でも due が走査上限を超えない', async () => {
    const { batch } = await limits();
    await twentyFivePlusOne();

    const summary = (await run({ scanLimit: SCAN_LIMIT })) as unknown as Summary;

    expectInvariants(summary, SCAN_LIMIT, batch);
  }, 60_000);

  it('#110 配信可能が枠を超える配置でも attempted が枠を超えない', async () => {
    const { batch, scan } = await limits();
    usePublisher();
    const liveAccount = await accountFor();
    for (let i = 0; i < 25; i += 1) await makePost(liveAccount, 40 - i);

    const summary = (await run()) as unknown as Summary;

    expectInvariants(summary, scan, batch);
    expect(summary.attempted).toBe(batch);
  }, 120_000);
});
