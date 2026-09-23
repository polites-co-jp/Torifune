import type { PublisherRegistration } from '@torifune/plugin-api';
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
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信直前の再検査（035-social-publishing 設計 §6.5.2.2、受け入れ条件 #95〜#98。
 * 検証レポート S-2）。
 *
 * **publisher が無い間に登録された投稿は `limits` も `validate()` も一度も通っていない。**
 * 裁定 #8 で「配信 Plugin が無くても予約できる」ことにした以上、
 * **その投稿にとって配信時が唯一の判定機会である。**
 *
 * どのテストも「publisher を登録していない状態で投稿を作る → あとから publisher を
 * 登録する」という、裁定 #8 が想定した運用そのものをなぞる。
 *
 * **通らなかった投稿は `publish()` を呼ばずに `failed`。** 理由は「未送信」と読める文言にし、
 * 「結果不明」（送ったか分からない）と混ぜない。運用者の次の行動が違う。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';
const LABEL = 'テストSNS';
const CREDENTIALS = { identifier: 'id-a1b2', appPassword: 'pw-c3d4' } as const;
const CREDENTIAL_FIELDS = [
  { key: 'identifier', label: '識別子', kind: 'text' },
  { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
] as const;

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
        login_id: `pre${suffix}`,
        email: `pre${suffix}@example.com`,
        display_name: 'publish precheck test',
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
    loginId: `pre${suffix}`,
    displayName: 'publish precheck test',
    email: `pre${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** **投稿を作った後で**登録する偽の publisher。 */
function usePublisher(
  overrides: Partial<PublisherRegistration> = {},
): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(async () => ({ ok: true }));
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: LABEL,
    credentialFields: [...CREDENTIAL_FIELDS],
    publish: mock,
    ...overrides,
  });
  return mock;
}

async function accountFor(): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    credentials: { ...CREDENTIALS },
    status: 'connected',
  });
  return account.id;
}

interface PostOptions {
  readonly body?: string;
  readonly media?: readonly { readonly url: string; readonly alt: string | null }[];
}

/** **publisher を登録する前に**投稿を作る（裁定 #8 で 201 になる）。 */
async function makePost(accountId: string, options: PostOptions = {}): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: options.body ?? '配信される本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
    ...(options.media === undefined ? {} : { media: options.media }),
  });
  return post.id;
}

function media(count: number): { readonly url: string; readonly alt: string | null }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    url: `https://example.com/${index}.png`,
    alt: null,
  }));
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

async function run(options?: { readonly timeoutMs?: number; readonly validateTimeoutMs?: number }) {
  return withConnection((connection) =>
    options === undefined ? publishDuePosts(connection) : publishDuePosts(connection, options),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishprecheck');
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
 * #95。**`limits` を配信時にも掛ける**（設計 §6.5.2.2 の 1）。
 *
 * publisher が無い間に登録された 50 文字の本文が、あとから入った
 * `bodyMaxLength: 10` の publisher へそのまま渡って外部 API へ飛んでいた（S-2）。
 */
describe('#95 本文の上限を配信直前に掛ける', () => {
  async function overLongBody(): Promise<{
    readonly postId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const accountId = await accountFor();
    const postId = await makePost(accountId, { body: 'あ'.repeat(50) });

    const publish = usePublisher({ limits: { bodyMaxLength: 10 } });
    const summary = await run();
    return { postId, publish, summary };
  }

  it('#95 publish() が呼ばれない', async () => {
    const { publish } = await overLongBody();

    expect(publish).not.toHaveBeenCalled();
  });

  it('#95 投稿が failed になる', async () => {
    const { postId } = await overLongBody();
    const row = await postRow(postId);

    expect(row.status).toBe('failed');
    expect(row.failed_at).toBeInstanceOf(Date);
  });

  it('#95 failure_reason に上限と publisher の表示名が入る', async () => {
    const { postId } = await overLongBody();
    const reason = (await postRow(postId)).failure_reason ?? '';

    expect(reason).toContain('10文字以内');
    expect(reason).toContain(LABEL);
  });

  /**
   * #95。**「送っていない」と「送ったか分からない」を混ぜない**（設計 §6.5.2.2）。
   *
   * 運用者の次の行動が違う。未送信なら本文を直して登録し直せばよく、
   * 結果不明なら SNS 側を見に行かなければならない。
   */
  it('#95 failure_reason が未送信と読める文言で、「結果不明」を含まない', async () => {
    const { postId } = await overLongBody();
    const reason = (await postRow(postId)).failure_reason ?? '';

    expect(reason).toContain('配信していません');
    expect(reason).not.toContain('結果不明');
  });

  /** #95。着手印は書いた後なので 1 回試したことになる（設計 §6.5.2.2 の末尾）。 */
  it('#95 attempt_count が 1 で着手印は NULL に戻る', async () => {
    const { postId } = await overLongBody();
    const row = await postRow(postId);

    expect(row.attempt_count).toBe(1);
    expect(row.publish_started_at).toBeNull();
  });

  /** #95。**再試行しない。** 宣言に合わない投稿は、時間が経っても合うようにならない。 */
  it('#95 next_attempt_at は NULL（再試行しない）', async () => {
    const { postId } = await overLongBody();

    expect((await postRow(postId)).next_attempt_at).toBeNull();
  });

  it('#95 summary の failed が 1', async () => {
    const { summary } = await overLongBody();

    expect(summary).toMatchObject({ due: 1, attempted: 1, failed: 1, published: 0, retried: 0 });
  });

  it('#95 social.post.failed が発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      events.push(payload);
    });

    await overLongBody();

    expect(events).toHaveLength(1);
  });
});

/** #96。媒体の宣言も配信直前に掛ける（設計 §6.5.2.2 の 1）。 */
describe('#96 媒体の宣言を配信直前に掛ける', () => {
  it('#96 媒体が必須の publisher に媒体なしの投稿は failed になる', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const publish = usePublisher({ limits: { mediaRequired: true } });
    await run();

    expect(publish).not.toHaveBeenCalled();
    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#96 媒体が必須のときの理由も未送信と読める', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    usePublisher({ limits: { mediaRequired: true } });
    await run();

    const reason = (await postRow(postId)).failure_reason ?? '';
    expect(reason).toContain('配信していません');
    expect(reason).not.toContain('結果不明');
  });

  it('#96 媒体の上限を超えた投稿も failed になる', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId, { media: media(3) });

    const publish = usePublisher({ limits: { mediaMax: 2 } });
    await run();

    expect(publish).not.toHaveBeenCalled();
    expect((await postRow(postId)).status).toBe('failed');
  });
});

/**
 * #97。**`validate()` を配信時にも掛ける**（設計 §6.5.2.2 の 2・3）。
 *
 * provider 固有の検査（Instagram の媒体、X の数え方）は publisher にしか書けない。
 * 登録時に一度も通っていない投稿は、ここで初めて判定される。
 */
describe('#97 validate() を配信直前に掛ける', () => {
  it('#97 validate() が問題を返したら publish() を呼ばずに failed', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const publish = usePublisher({ validate: () => [{ field: 'body', message: 'm1' }] });
    await run();

    expect(publish).not.toHaveBeenCalled();
    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#97 その理由に field と message が入る', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    usePublisher({ validate: () => [{ field: 'body', message: 'm1' }] });
    await run();

    const reason = (await postRow(postId)).failure_reason ?? '';
    expect(reason).toContain('body');
    expect(reason).toContain('m1');
  });

  it('#97 validate() が例外を投げたら failed で未送信と分かる理由になる', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const publish = usePublisher({
      validate: () => {
        throw new Error('validate boom');
      },
    });
    await run();

    const row = await postRow(postId);
    expect(publish).not.toHaveBeenCalled();
    expect(row.status).toBe('failed');
    expect(row.failure_reason ?? '').toContain('未送信');
  });

  it('#97 validate() が解決しなくても制限時間で打ち切って failed にする', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const publish = usePublisher({ validate: () => new Promise<never>(() => undefined) });
    await run({ validateTimeoutMs: 50 });

    const row = await postRow(postId);
    expect(publish).not.toHaveBeenCalled();
    expect(row.status).toBe('failed');
    expect(row.failure_reason ?? '').toContain('未送信');
  });

  /** #97。**制限時間内に実行が返る。** 応答しない `validate()` にジョブを止めさせない。 */
  it('#97 解決しない validate() でも実行が既定の制限時間より早く返る', async () => {
    const accountId = await accountFor();
    await makePost(accountId);

    usePublisher({ validate: () => new Promise<never>(() => undefined) });
    const startedAt = Date.now();
    await run({ validateTimeoutMs: 50 });

    // 既定は VALIDATE_TIMEOUT_MS = 5 秒。差し替えが効いていなければここを超える。
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });
});

/**
 * #98。**再検査は通る投稿の邪魔をしない**（#42 が回帰しない）。
 *
 * 足した検査が既存の配信を壊していないことを、同じファイルの中で見る。
 */
describe('#98 再検査を通った投稿は従来どおり配信される', () => {
  it('#98 limits と validate() を満たす投稿は published になる', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId, { body: 'みじかい本文' });

    const publish = usePublisher({ limits: { bodyMaxLength: 100 }, validate: () => [] });
    const summary = await run();

    expect(publish).toHaveBeenCalledTimes(1);
    expect((await postRow(postId)).status).toBe('published');
    expect(summary).toMatchObject({ due: 1, attempted: 1, published: 1, failed: 0 });
  });

  it('#98 limits も validate() も持たない publisher では再検査が何も起きない', async () => {
    const accountId = await accountFor();
    const postId = await makePost(accountId, { body: 'あ'.repeat(5000) });

    const publish = usePublisher();
    await run();

    expect(publish).toHaveBeenCalledTimes(1);
    expect((await postRow(postId)).status).toBe('published');
  });
});

/**
 * #111。**`limits` 経路の理由文も秘匿を通る**（検証レポート §9.2 の R-5。設計 §6.5.2.2）。
 *
 * 配信直前の再検査のうち、**`limits` 経路（1）だけが `redactSecrets` を通っていなかった。**
 * 3 の `validate()` 例外経路は通っている。片方だけ通す理由は無い。
 *
 * **Plugin 由来の自由文は `message` だけではない。** `publisherRejectedReason` が埋め込む
 * `registration.label`（表示名）も、`checkPublisherLimits` が返す `problems[].field` /
 * `problems[].message` も**すべて Plugin が書いた文字列**である。
 *
 * #84 の見出しは「Plugin 由来の自由文をログ・DB に載せる経路が**すべて**」と言っている。
 * 見出しが言っていることを実装が満たしていないなら、直すのは実装のほうである。
 *
 * **秘匿の形は `redactSecrets` が実際に落とせるものに合わせる**
 * （`infrastructure/secret-text.ts`。`scheme://user:password@host` の credential 部と
 * `DATABASE_URL` の完全一致だけを落とす）。`route-error-redaction.integration.test.ts` と
 * 同じ流儀で、**接続文字列の形に埋めた生きた値**が出ないことを見る。
 */
describe('#111 limits 経路の理由文も秘匿を通る', () => {
  /** Plugin が書いた自由文に紛れ込んだ資格情報。 */
  const LIVE_TOKEN = 'sk-livetoken-xyz';
  /**
   * `redactSecrets` が credential 部として落とす形（設計 §6.5.5 の「伏せてから切る」）。
   *
   * **DB 名を `torifune` にしてはいけない。** `redactSecrets` は credential 部だけでなく
   * **`DATABASE_URL` の password 部の単独一致も伏せる**（`infrastructure/secret-text.ts` の (b)）。
   * 開発・CI のどちらも password は `torifune` なので、DB 名を同じにすると `/torifune` まで
   * `/***` になり、**どんな実装でも通らない期待値**になる。
   */
  const LEAKY_LABEL = `postgresql://plugin:${LIVE_TOKEN}@db.internal:5432/appdb`;

  async function reasonVia(overrides: Partial<PublisherRegistration>): Promise<string> {
    // **登録簿を空にしてから作る。** publisher が登録されていると作成時の事前検査に掛かり、
    // 上限を超えた本文の投稿そのものを作れない（それでは配信直前の再検査を観測できない）。
    // 同じ `it` の中で 2 回呼ぶと、1 回目の publisher が残っていてここで 422 になる。
    resetPublisherRegistry();

    const accountId = await accountFor();
    const postId = await makePost(accountId, { body: 'あ'.repeat(50) });

    usePublisher(overrides);
    await run();

    const row = await postRow(postId);
    expect(row.status, 'failed になっていない（検査が空振りしている）').toBe('failed');
    return row.failure_reason ?? '';
  }

  /** `limits` 経路。`label` は `publisherRejectedReason` が理由文へ埋め込む。 */
  async function limitsReason(): Promise<string> {
    return reasonVia({ label: LEAKY_LABEL, limits: { bodyMaxLength: 10 } });
  }

  /** `validate()` 経路。同じ文字列を `message` で返す。 */
  async function validateReason(): Promise<string> {
    return reasonVia({
      label: LEAKY_LABEL,
      validate: () => [{ field: 'body', message: `接続に失敗しました: ${LEAKY_LABEL}` }],
    });
  }

  it('#111 limits 経路の failure_reason に生の値が出ない', async () => {
    const reason = await limitsReason();

    expect(reason, 'Plugin の label がそのまま DB に入っている').not.toContain(LIVE_TOKEN);
  });

  it('#111 limits 経路の failure_reason が伏せ字になっている', async () => {
    expect(await limitsReason()).toContain('***');
  });

  it('#111 validate() 経路の failure_reason にも生の値が出ない（従来どおり）', async () => {
    expect(await validateReason()).not.toContain(LIVE_TOKEN);
  });

  /** #111 の要。**経路によって差が無い。** */
  it('#111 limits 経路と validate() 経路で同じ文字列が同じ形に伏せられる', async () => {
    const redactedInLimits = await limitsReason();
    // 同じ `label` を含む理由文なので、伏せた後の形も一致する。
    expect(redactedInLimits).toContain('postgresql://***@db.internal:5432/appdb');
    expect(await validateReason()).toContain('postgresql://***@db.internal:5432/appdb');
  });

  it('#111 limits 経路でも「配信していません」（未送信）と読める', async () => {
    // 秘匿を足したことで、未送信であることの手がかりが消えていない。
    const reason = await limitsReason();

    expect(reason).toContain('配信していません');
    expect(reason).not.toContain('結果不明');
  });
});
