import type { PublisherRegistration } from '@torifune/plugin-api';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { SOCIAL_PUBLISH_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信ジョブの本筋（035-social-publishing 設計 §6.5、受け入れ条件 #42、#43、#49、#50、#51、#54、#56、#57、#58）。
 *
 * **`publishDuePosts` を直接呼ぶ。** publisher はテストが登録する偽物で、
 * Plugin の読み込みは経ない（設計 §10 の B）。
 *
 * 再試行・中断行は `publish-retry.integration.test.ts`、
 * 資格情報と秘匿は `publish-credential.integration.test.ts`（実装プラン §8 の 5）。
 *
 * **`publish()` は直列に呼ばれる**（実装プラン §7 の 6）ので、件数を絞り、
 * 実時間で待たない。タイムアウトの差し替えが要るものは第 2 引数
 * `{ timeoutMs }` を使う（同 §8 の 2）。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';
const CREDENTIALS = { identifier: 'id-a1b2', appPassword: 'pw-c3d4' } as const;

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
        login_id: `pub${suffix}`,
        email: `pub${suffix}@example.com`,
        display_name: 'publish test',
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
    loginId: `pub${suffix}`,
    displayName: 'publish test',
    email: `pub${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 偽の publisher。`publish` は `vi.fn()` にして引数と回数を見る。 */
function usePublisher(
  publish: PublishFn,
  overrides: Partial<PublisherRegistration> = {},
): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(publish);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [
      { key: 'identifier', label: '識別子', kind: 'text' },
      { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
    ],
    publish: mock,
    ...overrides,
  });
  return mock;
}

async function accountFor(provider: string): Promise<string> {
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

interface PostOptions {
  readonly accountId: string;
  readonly minutesAgo?: number;
  readonly body?: string;
  readonly deliveryMode?: 'auto' | 'manual';
  readonly status?: 'draft' | 'scheduled';
  readonly scheduledAt?: Date | null;
}

async function makePost(options: PostOptions): Promise<string> {
  const scheduledAt =
    options.scheduledAt === undefined
      ? new Date(Date.now() - (options.minutesAgo ?? 1) * 60_000)
      : options.scheduledAt;
  const { post } = await createSocialPost(admin, {
    socialAccountId: options.accountId,
    body: options.body ?? '配信される本文',
    scheduledAt,
    status: options.status ?? 'scheduled',
    deliveryMode: options.deliveryMode ?? 'auto',
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly published_at: Date | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly external_id: string | null;
  readonly external_url: string | null;
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
        'published_at',
        'failed_at',
        'failure_reason',
        'external_id',
        'external_url',
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

async function auditRows(action: string): Promise<
  {
    readonly actor_user_id: string | null;
    readonly resource_type: string;
    readonly resource_id: string | null;
    readonly detail: Record<string, unknown>;
  }[]
> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['actor_user_id', 'resource_type', 'resource_id', 'detail'])
      .where('action', '=', action)
      .execute();
    return rows as {
      readonly actor_user_id: string | null;
      readonly resource_type: string;
      readonly resource_id: string | null;
      readonly detail: Record<string, unknown>;
    }[];
  });
}

async function run(options?: { readonly timeoutMs?: number }) {
  return withConnection((connection) =>
    options === undefined ? publishDuePosts(connection) : publishDuePosts(connection, options),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublish');
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
    // **`job_runs` を必ず消す**（実装プラン §7 の 17）。残すと #57 / #58 が
    // 前のテストの行を拾って件数を誤る。
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#42 配信に成功したとき', () => {
  async function publishOne(): Promise<{
    readonly postId: string;
    readonly accountId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = usePublisher(async () => ({
      ok: true,
      externalId: 'e1',
      externalUrl: 'https://testsns.example.com/p/e1',
    }));
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    const summary = await run();
    return { postId, accountId, publish, summary };
  }

  it('#42 投稿が published になる', async () => {
    const { postId } = await publishOne();

    expect((await postRow(postId)).status).toBe('published');
  });

  it('#42 published_at が入る', async () => {
    const { postId } = await publishOne();

    expect((await postRow(postId)).published_at).toBeInstanceOf(Date);
  });

  it('#42 external_id と external_url が保存される', async () => {
    const { postId } = await publishOne();
    const row = await postRow(postId);

    expect(row.external_id).toBe('e1');
    expect(row.external_url).toBe('https://testsns.example.com/p/e1');
  });

  it('#42 着手印は NULL に戻る', async () => {
    // **非 NULL ⇔ 進行中**（設計 §5.8）。戻し忘れた行は次の実行で「中断」になる。
    const { postId } = await publishOne();

    expect((await postRow(postId)).publish_started_at).toBeNull();
  });

  it('#42 attempt_count が 1 で next_attempt_at は NULL', async () => {
    const { postId } = await publishOne();
    const row = await postRow(postId);

    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).toBeNull();
  });

  it('#42 summary が §6.5.7 の 8 キーの値になる', async () => {
    const { summary } = await publishOne();

    expect(summary).toEqual({
      interrupted: 0,
      due: 1,
      skipped: 0,
      attempted: 1,
      published: 1,
      retried: 0,
      failed: 0,
      unrecorded: 0,
    });
  });

  it('#42 publisher が受け取った credential が登録した credentials と等しい', async () => {
    const { publish } = await publishOne();

    expect(publish.mock.calls[0]?.[0].credential).toEqual({ ...CREDENTIALS });
  });

  it('#42 publisher が受け取った attempt が 1', async () => {
    const { publish } = await publishOne();

    expect(publish.mock.calls[0]?.[0].attempt).toBe(1);
  });

  it('#42 publisher が受け取った signal が AbortSignal', async () => {
    const { publish } = await publishOne();

    expect(publish.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('#42 social.post.published が 1 回だけ発火する', async () => {
    const publish = usePublisher(async () => ({ ok: true }));
    const events: unknown[] = [];
    subscribe('social.post.published', (payload) => {
      events.push(payload);
    });
    const accountId = await accountFor(PROVIDER);
    await makePost({ accountId });

    await run();

    expect(publish).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it('#42 audit_logs に credential_read の行が 1 つできる', async () => {
    await publishOne();

    expect(await auditRows('credential_read')).toHaveLength(1);
  });

  it('#42 credential_read の行が本体の処理として記録される（actor_user_id は NULL）', async () => {
    // ジョブは `AuthorizationContext` を持たない（設計 §6.5.8）。
    const { accountId } = await publishOne();
    const row = (await auditRows('credential_read'))[0];

    expect(row?.actor_user_id).toBeNull();
    expect(row?.resource_type).toBe('social_account');
    expect(row?.resource_id).toBe(accountId);
  });

  it('#42 credential_read の detail が purpose / postId / provider / pluginId / attempt', async () => {
    const { postId } = await publishOne();
    const row = (await auditRows('credential_read'))[0];

    expect(row?.detail).toEqual({
      purpose: 'publish',
      postId,
      provider: PROVIDER,
      pluginId: PLUGIN_ID,
      attempt: 1,
    });
  });

  it('#42 credential_read の detail に資格情報の値もキー名も残らない', async () => {
    // **「入れても落ちる」ではなく「入れない」ことを固定する**（設計 §6.5.8）。
    await publishOne();
    const detail = JSON.stringify((await auditRows('credential_read'))[0]?.detail ?? {});

    expect(detail).not.toContain(CREDENTIALS.identifier);
    expect(detail).not.toContain(CREDENTIALS.appPassword);
    expect(detail).not.toContain('identifier');
    expect(detail).not.toContain('appPassword');
    expect(detail).not.toContain('credential');
  });
});

/**
 * #43。**着手印を先に書いてコミットしてから `publish()` を呼ぶ**（設計 §6.5.4）。
 *
 * 同じトランザクションの中で呼ぶと、プロセスが死んだときに印がロールバックされ、
 * 次の実行が同じ投稿をもう一度送る。SNS の投稿は取り消せない。
 */
describe('#43 着手印が publish() より先にコミットされている', () => {
  interface Seen {
    readonly status: string;
    readonly publish_started_at: Date | null;
    readonly attempt_count: number;
  }

  /** `publish()` の中から**別接続で**同じ行を読む。 */
  async function seenDuringPublish(postId: string): Promise<Seen | null> {
    let seen: Seen | null = null;
    usePublisher(async () => {
      const client = new pg.Client({ connectionString: scratch.connectionString });
      await client.connect();
      try {
        const result = await client.query<Seen>(
          'SELECT status, publish_started_at, attempt_count FROM social_posts WHERE id = $1',
          [postId],
        );
        seen = result.rows[0] ?? null;
      } finally {
        await client.end();
      }
      return { ok: true };
    });
    await run();
    return seen;
  }

  it('#43 publish() の最中に別接続から status = scheduled が見える', async () => {
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    const seen = await seenDuringPublish(postId);

    expect(seen?.status).toBe('scheduled');
  });

  it('#43 publish() の最中に別接続から publish_started_at が見える', async () => {
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    const seen = await seenDuringPublish(postId);

    expect(seen?.publish_started_at).toBeInstanceOf(Date);
  });

  it('#43 publish() の最中に別接続から attempt_count = 1 が見える', async () => {
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    const seen = await seenDuringPublish(postId);

    expect(seen?.attempt_count).toBe(1);
  });
});

/**
 * #49。**配信 Plugin が無い投稿は、行に触らずに飛ばす**（要件 §4 裁定 #8、設計 §6.5.2 の a）。
 *
 * 失敗にすると、Plugin を入れる前に予約した投稿が全部 `failed` になり、
 * あとから Plugin を入れても配信されない。
 */
describe('#49 publisher が無い provider は飛ばす', () => {
  it('#49 実行後も scheduled のまま', async () => {
    const accountId = await accountFor('nopublisher');
    const postId = await makePost({ accountId });

    await run();

    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#49 着手印を書かない（publish_started_at は NULL のまま）', async () => {
    const accountId = await accountFor('nopublisher');
    const postId = await makePost({ accountId });

    await run();

    expect((await postRow(postId)).publish_started_at).toBeNull();
  });

  it('#49 attempt_count が 0 のまま', async () => {
    const accountId = await accountFor('nopublisher');
    const postId = await makePost({ accountId });

    await run();

    expect((await postRow(postId)).attempt_count).toBe(0);
  });

  it('#49 summary が due: 1 / skipped: 1 / attempted: 0', async () => {
    const accountId = await accountFor('nopublisher');
    await makePost({ accountId });

    const summary = await run();

    expect(summary).toMatchObject({ due: 1, skipped: 1, attempted: 0 });
  });

  it('#49 警告は provider ごとに 1 行だけ（同じ provider が 3 件でも 1 行）', async () => {
    const { records } = capture();
    const accountId = await accountFor('nopublisher');
    await makePost({ accountId, minutesAgo: 3 });
    await makePost({ accountId, minutesAgo: 2 });
    await makePost({ accountId, minutesAgo: 1 });

    await run();

    const warned = records.filter(
      (record) => record.message === 'social publisher is not registered',
    );
    expect(warned).toHaveLength(1);
  });

  it('#49 その警告は level: warn で fields.provider を持つ', async () => {
    const { records } = capture();
    const accountId = await accountFor('nopublisher');
    await makePost({ accountId });

    await run();

    const warned = records.find(
      (record) => record.message === 'social publisher is not registered',
    );
    expect(warned?.level).toBe('warn');
    expect(warned?.fields?.['provider']).toBe('nopublisher');
  });

  it('#49 飛ばした投稿は publisher を登録した次の実行で published になる', async () => {
    // **飛ばしたことが行に痕跡を残さない**ので、支度が整えばそのまま配信される。
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });
    await run();
    expect((await postRow(postId)).status).toBe('scheduled');

    usePublisher(async () => ({ ok: true }));
    await run();

    expect((await postRow(postId)).status).toBe('published');
  });

  it('#49 publish が未実装の publisher も飛ばす（触らない）', async () => {
    registerPublisher(PLUGIN_ID, {
      provider: PROVIDER,
      label: 'テストSNS',
      credentialFields: [],
    });
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    const summary = await run();

    expect(summary).toMatchObject({ due: 1, skipped: 1, attempted: 0 });
    expect((await postRow(postId)).attempt_count).toBe(0);
  });
});

/** #50。ジョブは手動投稿を一切触らない（設計 §6.5.3）。 */
describe('#50 手動投稿はジョブが触らない', () => {
  async function manualDue(): Promise<{
    readonly postId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = usePublisher(async () => ({ ok: true }), {
      manual: () => ({ url: 'https://testsns.example.com/compose' }),
    });
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId, deliveryMode: 'manual' });

    const summary = await run();
    return { postId, publish, summary };
  }

  it('#50 publish() が呼ばれない', async () => {
    const { publish } = await manualDue();

    expect(publish).not.toHaveBeenCalled();
  });

  it('#50 summary の due が 0（そもそも取り出さない）', async () => {
    const { summary } = await manualDue();

    expect(summary).toMatchObject({ due: 0, attempted: 0 });
  });

  it('#50 attempt_count が 0 のまま', async () => {
    const { postId } = await manualDue();

    expect((await postRow(postId)).attempt_count).toBe(0);
  });

  it('#50 着手印が立たない', async () => {
    const { postId } = await manualDue();
    const row = await postRow(postId);

    expect(row.publish_started_at).toBeNull();
    expect(row.status).toBe('scheduled');
  });
});

/** #51。取り出し条件（設計 §6.5.3）と 1 回の上限（`PUBLISH_BATCH_SIZE = 20`）。 */
describe('#51 取り出し条件と 20 件の区切り', () => {
  it('#51 draft の投稿は取り出さない', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId, status: 'draft' });

    const summary = await run();

    expect(summary).toMatchObject({ due: 0 });
    expect((await postRow(postId)).status).toBe('draft');
  });

  it('#51 scheduled_at が未来の投稿は取り出さない', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId, scheduledAt: new Date(Date.now() + 600_000) });

    const summary = await run();

    expect(summary).toMatchObject({ due: 0 });
    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#51 scheduled_at が NULL の投稿は取り出さない', async () => {
    // 既存行（022 より前に作られた予約）を壊さないための条件（設計 §5.3）。
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId, status: 'draft' });
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({ status: 'scheduled', scheduled_at: null })
        .where('id', '=', postId)
        .execute();
    });

    const summary = await run();

    expect(summary).toMatchObject({ due: 0 });
    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#51 期限の来た 25 件のうち 1 回の実行で取り出すのは 20 件', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    for (let i = 0; i < 25; i += 1) {
      await makePost({ accountId, minutesAgo: 25 - i });
    }

    const summary = await run();

    expect(summary).toMatchObject({ due: 20, published: 20 });
  }, 30_000);

  it('#51 published になるのは scheduled_at の古い 20 件', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      ids.push(await makePost({ accountId, minutesAgo: 25 - i }));
    }

    await run();

    const statuses = await Promise.all(ids.map(async (id) => (await postRow(id)).status));
    expect(statuses.slice(0, 20).every((status) => status === 'published')).toBe(true);
    expect(statuses.slice(20)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
      'scheduled',
      'scheduled',
    ]);
  }, 30_000);

  it('#51 残りの 5 件は次の実行で配信される', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    for (let i = 0; i < 25; i += 1) {
      await makePost({ accountId, minutesAgo: 25 - i });
    }
    await run();

    const second = await run();

    expect(second).toMatchObject({ due: 5, published: 5 });
  }, 30_000);
});

/**
 * #54。書き戻しが 0 行（`unrecorded`）。
 *
 * 別プロセスの中断判定（設計 §6.5.4）で着手印が消された場合を模す。
 * **結果を書けなかったのにイベントを出すと、外部が「配信された」と誤認する。**
 */
describe('#54 結果を書き戻せなかったとき', () => {
  /** `publish()` の中で着手印を NULL に戻す publisher。 */
  function clearingPublisher(postId: () => string): ReturnType<typeof vi.fn<PublishFn>> {
    return usePublisher(async () => {
      await withConnection(async (connection) => {
        await connection.db
          .updateTable('social_posts')
          .set({ publish_started_at: null })
          .where('id', '=', postId())
          .execute();
      });
      return { ok: true };
    });
  }

  it('#54 summary の unrecorded が 1 になる', async () => {
    let id = '';
    clearingPublisher(() => id);
    const accountId = await accountFor(PROVIDER);
    id = await makePost({ accountId });

    const summary = await run();

    expect(summary).toMatchObject({ attempted: 1, unrecorded: 1, published: 0 });
  });

  it('#54 level: warn の publish result could not be recorded が出る', async () => {
    const { records } = capture();
    let id = '';
    clearingPublisher(() => id);
    const accountId = await accountFor(PROVIDER);
    id = await makePost({ accountId });

    await run();

    const warned = records.find(
      (record) => record.message === 'publish result could not be recorded',
    );
    expect(warned?.level).toBe('warn');
    expect(warned?.fields?.['postId']).toBe(id);
  });

  it('#54 social.post.published は発火しない', async () => {
    let id = '';
    clearingPublisher(() => id);
    const events: unknown[] = [];
    subscribe('social.post.published', (payload) => {
      events.push(payload);
    });
    const accountId = await accountFor(PROVIDER);
    id = await makePost({ accountId });

    await run();

    expect(events).toHaveLength(0);
  });
});

/** #56。イベントの payload は `{ postId, accountId, status }` だけ（設計 §9.6）。 */
describe('#56 イベントの payload', () => {
  it('#56 social.post.published の payload のキーは 3 つだけ', async () => {
    usePublisher(async () => ({ ok: true }));
    const payloads: Record<string, unknown>[] = [];
    subscribe('social.post.published', (payload) => {
      payloads.push(payload as Record<string, unknown>);
    });
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    await run();

    expect(Object.keys(payloads[0] ?? {}).sort()).toEqual(['accountId', 'postId', 'status']);
    expect(payloads[0]).toEqual({ postId, accountId, status: 'published' });
  });

  it('#56 social.post.failed の payload のキーも 3 つだけ', async () => {
    // **理由は載せない。** `redactCredentialValues` は既知の値しか伏せられない
    // （実装プラン §7 の 8）ので、自由文そのものを外へ出さない。
    usePublisher(async () => ({ ok: false, reason: 'だめだった', retryable: false }));
    const payloads: Record<string, unknown>[] = [];
    subscribe('social.post.failed', (payload) => {
      payloads.push(payload as Record<string, unknown>);
    });
    const accountId = await accountFor(PROVIDER);
    const postId = await makePost({ accountId });

    await run();

    expect(Object.keys(payloads[0] ?? {}).sort()).toEqual(['accountId', 'postId', 'status']);
    expect(payloads[0]).toEqual({ postId, accountId, status: 'failed' });
  });
});

/** #57 / #58。`runJob` を通した記録と排他（設計 §6.5.1）。 */
describe('#57 runJob 経由の記録', () => {
  interface JobRunRow {
    readonly job_name: string;
    readonly status: string;
    readonly triggered_by: string;
    readonly summary: Record<string, unknown>;
  }

  async function jobRuns(): Promise<JobRunRow[]> {
    return withConnection(async (connection) => {
      const rows = await connection.db
        .selectFrom('job_runs')
        .select(['job_name', 'status', 'triggered_by', 'summary'])
        .execute();
      return rows as JobRunRow[];
    });
  }

  it('#57 outcome が ok になる', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    await makePost({ accountId });

    const outcome = await withConnection((connection) =>
      runJob(connection, SOCIAL_PUBLISH_JOB, {
        trigger: 'scheduled',
        wait: false,
        input: undefined,
      }),
    );

    expect(outcome.outcome).toBe('ok');
  });

  it('#57 job_runs に job_name = social.publish の行が残る', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    await makePost({ accountId });

    await withConnection((connection) =>
      runJob(connection, SOCIAL_PUBLISH_JOB, {
        trigger: 'scheduled',
        wait: false,
        input: undefined,
      }),
    );

    const rows = await jobRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.job_name).toBe('social.publish');
  });

  it('#57 job_runs.summary が §6.5.7 の 8 キーを持つ', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    await makePost({ accountId });

    await withConnection((connection) =>
      runJob(connection, SOCIAL_PUBLISH_JOB, {
        trigger: 'scheduled',
        wait: false,
        input: undefined,
      }),
    );

    expect(Object.keys((await jobRuns())[0]?.summary ?? {}).sort()).toEqual([
      'attempted',
      'due',
      'failed',
      'interrupted',
      'published',
      'retried',
      'skipped',
      'unrecorded',
    ]);
  });

  it('#58 同時に 2 本流すと片方が ok、片方が skipped', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    for (let i = 0; i < 3; i += 1) {
      await makePost({ accountId, minutesAgo: 3 - i });
    }

    const outcomes = await Promise.all([
      withConnection((connection) =>
        runJob(connection, SOCIAL_PUBLISH_JOB, {
          trigger: 'scheduled',
          wait: false,
          input: undefined,
        }),
      ),
      withConnection((connection) =>
        runJob(connection, SOCIAL_PUBLISH_JOB, {
          trigger: 'manual',
          wait: false,
          input: undefined,
        }),
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['ok', 'skipped']);
  });

  it('#58 二重投稿しない（publish() の呼び出しは投稿ごとに 1 回）', async () => {
    // SNS の投稿は取り消せない。**同時実行で 2 回送らないことが要**（設計 §6.5.4）。
    const publish = usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor(PROVIDER);
    for (let i = 0; i < 3; i += 1) {
      await makePost({ accountId, minutesAgo: 3 - i });
    }

    await Promise.all([
      withConnection((connection) =>
        runJob(connection, SOCIAL_PUBLISH_JOB, {
          trigger: 'scheduled',
          wait: false,
          input: undefined,
        }),
      ),
      withConnection((connection) =>
        runJob(connection, SOCIAL_PUBLISH_JOB, {
          trigger: 'manual',
          wait: false,
          input: undefined,
        }),
      ),
    ]);

    expect(publish).toHaveBeenCalledTimes(3);
  });
});
