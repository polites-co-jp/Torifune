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
 * 設計は「`MANUAL_TIMEOUT_MS` をテスト用に 50ms へ差し替え」「累計が
 * `MANUAL_TIMEOUT_MS * 5` を超えた時点で残りの行を `plugin_error` として描く」と
 * 書いているが、**差し替え方と累計の持ち方は書いていない。**
 * `publishDuePosts(connection, { timeoutMs, validateTimeoutMs })` の流儀に揃え、
 * UseCase の入力に置く（`defineUseCase` は `(context, input)` しか取れない）：
 *
 * ```ts
 * resolveManualHandoff(context, {
 *   id: string;
 *   timeoutMs?: number;   // この呼び出しの上限。既定 MANUAL_TIMEOUT_MS（2 秒）
 *   deadline?: Date;      // 1 回の描画あたりの打ち切り時刻。
 *                         // 過ぎていれば manual() を呼ばずに plugin_error を返す
 * }) → ManualHandoffOutcome
 * ```
 *
 * 行ごとに呼ぶ側（`app/social/page.tsx`）は、`deadline` を
 * **1 回だけ**（`now + MANUAL_HANDOFF_BUDGET_MS`）作ってすべての行へ渡す。
 * こうすると累計の上限が Domain の定数で決まり、**画面は必ず返る。**
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
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #105 manual() の制限時間
// ---------------------------------------------------------------------------

describe('#105 manual() の制限時間', () => {
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
 * #105 の後半。**50 件ぶん呼ぶ経路でも画面用のデータが必ず返る**（設計 §6.6）。
 *
 * 行ごとの上限だけでは足りない。50 行 × 2 秒で最悪 100 秒かかり、
 * `/social` はその間まっ白になる。**1 回の描画の累計にも上限を置く。**
 */
describe('#105 1 回の描画あたりの累計の上限', () => {
  const ROWS = 50;

  async function manyManualPosts(): Promise<readonly string[]> {
    const ids: string[] = [];
    for (let index = 0; index < ROWS; index += 1) {
      ids.push(await makeManualPost(`手動投稿 ${index}`));
    }
    return ids;
  }

  it('#105 50 行すべてに結果が返る', { timeout: 30_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const ids = await manyManualPosts();
    const deadline = new Date(Date.now() + 200);

    const outcomes = [];
    for (const id of ids) {
      outcomes.push(await resolveManualHandoff(admin, { id, deadline }));
    }

    expect(outcomes).toHaveLength(ROWS);
  });

  it('#105 打ち切られた行は plugin_error として返る', { timeout: 30_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const ids = await manyManualPosts();
    const deadline = new Date(Date.now() + 200);

    const outcomes = [];
    for (const id of ids) {
      outcomes.push(await resolveManualHandoff(admin, { id, deadline }));
    }

    expect(outcomes.every((outcome) => outcome.ok === false)).toBe(true);
  });

  it('#105 50 行ぶん呼んでも累計の上限で打ち切られる', { timeout: 30_000 }, async () => {
    usePublisher({ manual: () => never<never>() });
    const ids = await manyManualPosts();
    const deadline = new Date(Date.now() + 200);

    const startedAt = Date.now();
    for (const id of ids) {
      await resolveManualHandoff(admin, { id, deadline });
    }

    // 行ごとの上限（2 秒）だけなら 50 行で 100 秒かかる。
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('#105 打ち切り時刻を過ぎていれば manual() は呼ばれない', async () => {
    const manual = vi.fn<ManualFn>(() => ({ url: 'https://example.test/compose' }));
    usePublisher({ manual });
    const id = await makeManualPost();

    await resolveManualHandoff(admin, { id, deadline: new Date(Date.now() - 1) });

    expect(manual).not.toHaveBeenCalled();
  });

  it('#105 打ち切り時刻を過ぎた行は plugin_error になる', async () => {
    usePublisher();
    const id = await makeManualPost();

    await expect(
      resolveManualHandoff(admin, { id, deadline: new Date(Date.now() - 1) }),
    ).resolves.toEqual({ ok: false, reason: 'plugin_error' });
  });

  it('#105 打ち切り時刻が先なら従来どおり ok が返る', async () => {
    usePublisher();
    const id = await makeManualPost();

    await expect(
      resolveManualHandoff(admin, { id, deadline: new Date(Date.now() + 10_000) }),
    ).resolves.toMatchObject({ ok: true });
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
