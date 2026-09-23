import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  resolveManualHandoff,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * Plugin の関数に制限時間を掛ける（035-social-publishing 設計 §6.6 / §6.1.2、
 * 受け入れ条件 #105。検証レポート L-3）。
 *
 * `publish()` には 30 秒の上限と `AbortSignal` があるのに、`manual()` と
 * 登録時の `validate()` には上限が無かった。
 *
 * * 応答しない `manual()` は **`/social` の画面を丸ごと止める**
 *   （Server Component が最大 50 行ぶん呼ぶ）
 * * 応答しない `validate()` は **`POST /social/posts` を無期限に止める**
 *
 * **Plugin は信頼されたコードという前提の範囲で、「待たされる」だけを防ぐ**
 * （同期の無限ループは打ち切れない。設計 §11 #20）。
 *
 * ## テストが前提にする口（設計 §6.6 が「差し替える」とだけ書いている部分）
 *
 * 設計は「`MANUAL_TIMEOUT_MS` をテスト用に 50ms へ差し替え」と書いているが、
 * **差し替え方は書いていない。**
 * `publishDuePosts(connection, { timeoutMs, validateTimeoutMs })` の流儀に揃え、
 * UseCase の入力に置く（`defineUseCase` は `(context, input)` しか取れない）：
 *
 * ```ts
 * resolveManualHandoff(context, {
 *   id: string;
 *   timeoutMs?: number;   // この呼び出しの上限。既定 MANUAL_TIMEOUT_MS（2 秒）
 *   deadline?: Date;      // 1 回の描画の絶対の締切（壁時計）。
 *                         // 過ぎていれば manual() を呼ばずに plugin_error を返し、
 *                         // 残りが timeoutMs より短ければ残り時間まで切り詰める
 * }) → ManualHandoffOutcome
 * ```
 *
 * **`MANUAL_HANDOFF_BUDGET_MS`（`MANUAL_TIMEOUT_MS * 5` = 10 秒）は「累計の予算」ではなく、
 * 1 回の描画の絶対の締切である**（2026-09-23。裁定 #12-c）。
 * 行ごとに呼ぶ側（`app/social/page.tsx`）は `deadline` を**1 回だけ**作って
 * `Promise.all` の全行へ渡す。行ごとの呼び出しは**並行**なので、
 * 応答しない `manual()` が 50 行ぶんあっても描画が待つのは
 * およそ `MANUAL_TIMEOUT_MS` 1 回ぶんで、**行数に比例しない。**
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';

type ManualFn = NonNullable<PublisherRegistration['manual']>;
type ValidateFn = NonNullable<PublisherRegistration['validate']>;

/** 解決しない Promise（応答しない Plugin を模す）。 */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;

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
        login_id: `to${suffix}`,
        email: `to${suffix}@example.com`,
        display_name: 'plugin timeout test',
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
    loginId: `to${suffix}`,
    displayName: 'plugin timeout test',
    email: `to${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function usePublisher(overrides: Partial<PublisherRegistration> = {}): void {
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [],
    manual: () => ({ url: 'https://example.test/compose' }),
    ...overrides,
  });
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

/** 手動投稿待ちの投稿（manual / scheduled / 1 分前）。 */
async function makeManualPost(body = '手動で投稿する本文'): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body,
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'manual',
  });
  return post.id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialplugintimeout');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor('administrator');
  accountId = await accountFor();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    // **`job_runs` を必ず消す**（実装プラン §7 の 17）。
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #105 (a) manual() の制限時間（1 行）
// ---------------------------------------------------------------------------

describe('#105 (a) manual() の制限時間', () => {
  it('#105 MANUAL_TIMEOUT_MS が 2 秒（publish() より短い）', async () => {
    // **静的 import にしない。** 未実装の段階でこのファイル全体が読めなくなると、
    // 何が壊れたのか読めない（`static-checks.test.ts` と同じ流儀）。
    const domain = (await import('@/domain/social/publishing')) as {
      readonly MANUAL_TIMEOUT_MS?: number;
    };

    expect(domain.MANUAL_TIMEOUT_MS).toBe(2_000);
  });

  it('#105 1 回の描画あたりの累計は MANUAL_TIMEOUT_MS の 5 倍', async () => {
    // 50 行 × 2 秒で最悪 100 秒かかるので、**累計にも上限を置く**（設計 §6.6）。
    const domain = (await import('@/domain/social/publishing')) as {
      readonly MANUAL_TIMEOUT_MS?: number;
      readonly MANUAL_HANDOFF_BUDGET_MS?: number;
    };

    expect(domain.MANUAL_HANDOFF_BUDGET_MS).toBe((domain.MANUAL_TIMEOUT_MS ?? 0) * 5);
  });

  it('#105 解決しない manual() は plugin_error になる', async () => {
    usePublisher({ manual: () => never<never>() });
    const id = await makeManualPost();

    await expect(resolveManualHandoff(admin, { id, timeoutMs: 50 })).resolves.toEqual({
      ok: false,
      reason: 'plugin_error',
    });
  });

  it('#105 解決しない manual() でも制限時間内に返る', async () => {
    usePublisher({ manual: () => never<never>() });
    const id = await makeManualPost();

    const startedAt = Date.now();
    await resolveManualHandoff(admin, { id, timeoutMs: 50 });

    // 既定は MANUAL_TIMEOUT_MS = 2 秒。差し替えが効いていなければここを超える。
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it('#105 打ち切ったことが log.error に 1 行残る', async () => {
    // 画面には出さないが、運用者が原因へ辿れる経路は残す（設計 §6.6）。
    usePublisher({ manual: () => never<never>() });
    const id = await makeManualPost();
    const logs = capture();

    await resolveManualHandoff(admin, { id, timeoutMs: 50 });

    const errors = logs.records.filter((record) => record.level === 'error');
    expect(errors).toHaveLength(1);
  });

  it('#105 打ち切りのログに provider と pluginId が入る', async () => {
    usePublisher({ manual: () => never<never>() });
    const id = await makeManualPost();
    const logs = capture();

    await resolveManualHandoff(admin, { id, timeoutMs: 50 });

    const error = logs.records.find((record) => record.level === 'error');
    expect(error?.fields).toMatchObject({ provider: PROVIDER, pluginId: PLUGIN_ID });
  });

  it('#105 制限時間内に返る manual() はこれまでどおり ok', async () => {
    // 足した打ち切りが、応える Plugin の邪魔をしない。
    usePublisher({ manual: () => ({ url: 'https://example.test/compose' }) });
    const id = await makeManualPost();

    await expect(resolveManualHandoff(admin, { id, timeoutMs: 50 })).resolves.toMatchObject({
      ok: true,
      url: 'https://example.test/compose',
    });
  });
});

/**
 * #105 の (b)。**本番と同じ呼び出しの形**（設計 §6.6。裁定 #12-c）。
 *
 * > **2026-09-23 に書き直した（検証レポート §9.2 の R-4）。** もとの条件は
 * > 「50 件ぶん呼ぶ経路でも**累計の上限**で打ち切られ」と書き、テストは**直列に**呼んでいた。
 * > 実装は `Promise.all` で並行に呼ぶので、**本番に存在しない経路を見ていた**
 * > （`spec-verifier` / `security-reviewer` / `boundary-guardian` の 3 者が独立に指摘）。
 * >
 * > **保証は弱めていない**：「50 件でも画面用のデータが必ず返る」は
 * > ここがより強い形（**所要が行数に比例しない**）で引き取り、
 * > 締切そのものの働きは (c)(d)(e) が初めて固定する。
 *
 * `app/social/page.tsx` と同じく、**締切は 1 回だけ作って全行へ渡す。**
 */
describe('#105 (b) Promise.all で 50 行同時に呼んでも返る', () => {
  const ROWS = 50;
  /** 1 行ぶんの制限時間。実時間で待たないために短くする。 */
  const TIMEOUT_MS = 500;

  async function manyManualPosts(): Promise<readonly string[]> {
    const ids: string[] = [];
    for (let index = 0; index < ROWS; index += 1) {
      ids.push(await makeManualPost(`手動投稿 ${index}`));
    }
    return ids;
  }

  /** 本番と同じ形：締切を 1 回だけ作り、`Promise.all` で全行へ渡す。 */
  async function resolveAll(
    ids: readonly string[],
    timeoutMs: number,
  ): Promise<{ readonly outcomes: readonly unknown[]; readonly elapsedMs: number }> {
    const deadline = new Date(Date.now() + timeoutMs * 5);
    const startedAt = Date.now();
    const outcomes = await Promise.all(
      ids.map(async (id) => resolveManualHandoff(admin, { id, timeoutMs, deadline })),
    );
    return { outcomes, elapsedMs: Date.now() - startedAt };
  }

  it('#105 (b) 50 行すべてに結果が返る', { timeout: 60_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const ids = await manyManualPosts();

    const { outcomes } = await resolveAll(ids, TIMEOUT_MS);

    expect(outcomes).toHaveLength(ROWS);
  });

  it('#105 (b) 全 50 件が plugin_error で返る', { timeout: 60_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const ids = await manyManualPosts();

    const { outcomes } = await resolveAll(ids, TIMEOUT_MS);

    expect(outcomes).toEqual(
      Array.from({ length: ROWS }, () => ({ ok: false, reason: 'plugin_error' })),
    );
  });

  /**
   * #105 (b) の要。**行数に比例しない。**
   *
   * 直列に呼べば 50 倍（25 秒）かかる。並行なら 1 行ぶんの制限時間で全行が返る。
   * 余裕を見て「1 行ぶんの 2 倍未満」で固定する。
   */
  it('#105 (b) 所要が 1 行ぶんの制限時間の 2 倍未満', { timeout: 60_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const ids = await manyManualPosts();

    const { elapsedMs } = await resolveAll(ids, TIMEOUT_MS);

    expect(elapsedMs, `50 行で ${elapsedMs}ms（直列になっている）`).toBeLessThan(TIMEOUT_MS * 2);
  });

  it('#105 (b) 応える publisher なら 50 行すべてが ok', { timeout: 60_000 }, async () => {
    usePublisher({ manual: () => ({ url: 'https://example.test/compose' }) });
    const ids = await manyManualPosts();

    const { outcomes } = await resolveAll(ids, TIMEOUT_MS);

    expect(outcomes.every((outcome) => (outcome as { ok: boolean }).ok)).toBe(true);
  });
});

/**
 * #105 の (c)(d)。**締切（壁時計）そのものの働き**（設計 §6.6。裁定 #12-c）。
 *
 * `MANUAL_TIMEOUT_MS` は `manual()` の中しか測っていない。`resolveManualHandoff` は
 * その前に投稿とアカウントを DB から引くので、50 本の UseCase が同時に接続プールへ並ぶと
 * **後ろの行が `manual()` に着くのは何秒か後**になりうる。
 * 締切はその待ち時間も含めて描画全体を覆う。
 */
describe('#105 (c)(d) 締切の働き', () => {
  it('#105 (c) 締切を過ぎていれば manual() を呼ばない', async () => {
    const manual = vi.fn<ManualFn>(() => ({ url: 'https://example.test/compose' }));
    usePublisher({ manual });
    const id = await makeManualPost();

    await resolveManualHandoff(admin, { id, deadline: new Date(Date.now() - 1) });

    expect(manual).not.toHaveBeenCalled();
  });

  it('#105 (c) 締切を過ぎた行は plugin_error になる', async () => {
    usePublisher();
    const id = await makeManualPost();

    await expect(
      resolveManualHandoff(admin, { id, deadline: new Date(Date.now() - 1) }),
    ).resolves.toEqual({ ok: false, reason: 'plugin_error' });
  });

  it('#105 (c) 締切が先なら従来どおり ok が返る', async () => {
    usePublisher();
    const id = await makeManualPost();

    await expect(
      resolveManualHandoff(admin, { id, deadline: new Date(Date.now() + 10_000) }),
    ).resolves.toMatchObject({ ok: true });
  });

  /**
   * #105 (d)。**締切までの残りが制限時間より短ければ、その行は残り時間で打ち切られる。**
   *
   * 締切が「呼ぶ／呼ばない」の 1 回の判定だけだと、
   * **締切の 1 ミリ秒前に始まった行が制限時間ぶん（2 秒）はみ出せる。**
   */
  it('#105 (d) 残り時間まで切り詰められる', { timeout: 20_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const id = await makeManualPost();

    const startedAt = Date.now();
    const outcome = await resolveManualHandoff(admin, {
      id,
      timeoutMs: 1_000,
      deadline: new Date(Date.now() + 50),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toEqual({ ok: false, reason: 'plugin_error' });
    expect(elapsedMs, `${elapsedMs}ms（timeoutMs 側で打ち切られている）`).toBeLessThan(600);
  });

  it('#105 (d) 残りが制限時間より長ければ制限時間のほうで打ち切られる', async () => {
    usePublisher({ manual: () => never<never>() });
    const id = await makeManualPost();

    const startedAt = Date.now();
    await resolveManualHandoff(admin, {
      id,
      timeoutMs: 50,
      deadline: new Date(Date.now() + 10_000),
    });

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

// ---------------------------------------------------------------------------
// 登録時の validate() の制限時間（設計 §6.1.2。L-3 の残り）
// ---------------------------------------------------------------------------

/**
 * 応答しない `validate()` は `POST /social/posts` を無期限に止められた（L-3）。
 *
 * **ここには差し替えの口を作らない。** `validate()` は HTTP 要求 1 本の中で
 * 1 回しか呼ばれず、上限は `VALIDATE_TIMEOUT_MS`（5 秒）そのものが約束である。
 * 実時間で打ち切りを見る（テスト 1 本あたり約 5 秒かかる）。
 */
describe('登録時の validate() の制限時間', () => {
  async function createWithStuckValidate(): Promise<unknown> {
    const validate = (() => never<never>()) as ValidateFn;
    usePublisher({ validate });

    return createSocialPost(admin, {
      socialAccountId: accountId,
      body: '打ち切られるはずの投稿',
      scheduledAt: null,
      status: 'draft',
    }).catch((error: unknown) => error);
  }

  it('VALIDATE_TIMEOUT_MS が 5 秒', async () => {
    const domain = (await import('@/domain/social/publishing')) as {
      readonly VALIDATE_TIMEOUT_MS?: number;
    };

    expect(domain.VALIDATE_TIMEOUT_MS).toBe(5_000);
  });

  it('解決しない validate() は打ち切られて例外になる', { timeout: 20_000 }, async () => {
    expect(await createWithStuckValidate()).toBeInstanceOf(Error);
  });

  it(
    '打ち切りは ValidationError ではない（応答は 500 で、内容を外へ出さない）',
    { timeout: 20_000 },
    async () => {
      // 例外と同じ扱い（設計 §6.1.2。`027` §3.3「Plugin の例外を素で外へ出さない」）。
      expect(await createWithStuckValidate()).not.toBeInstanceOf(ValidationError);
    },
  );

  it('解決しない validate() でも制限時間内に返る', { timeout: 20_000 }, async () => {
    const startedAt = Date.now();
    await createWithStuckValidate();

    // 打ち切りが無ければここへ戻ってこない（テストのタイムアウトで落ちる）。
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  });

  it('打ち切ったことが log.error に残る', { timeout: 20_000 }, async () => {
    const logs = capture();

    await createWithStuckValidate();

    expect(
      logs.records.some(
        (record) => record.level === 'error' && /validate timed out/.test(record.message),
      ),
    ).toBe(true);
  });

  it('制限時間内に応える validate() はこれまでどおり通る', async () => {
    usePublisher({ validate: () => [] });

    await expect(
      createSocialPost(admin, {
        socialAccountId: accountId,
        body: '通るはずの投稿',
        scheduledAt: null,
        status: 'draft',
      }),
    ).resolves.toMatchObject({ created: true });
  });
});
