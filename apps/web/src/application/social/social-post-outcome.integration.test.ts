import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { createPluginDataApi } from '@/plugin/data-api';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 「起きた事実の記録」を塞がない（035-social-publishing 設計 §6.2 / §9.1、
 * 受け入れ条件 #99〜#102。検証レポート S-3 / S-4）。
 *
 * **S-3 の詰み**：`manual` の投稿がある状態でその Plugin を無効化すると、
 * 以後その投稿は `published` にも `draft` にもできなくなっていた。
 * `updateSocialPost` が publisher の有無を問わず検査 g を掛けており、
 * `markPublished` / `markFailed` も同じ UseCase を通るため、
 * **失敗を記録する経路まで塞がれていた**（後方互換の破壊。設計 §9.1）。
 *
 * 設計 §7.1 は `handoff.ok === false` の行でも
 * 「投稿した」「取りやめ」は押せると書いている。`unsupported` はまさに
 * publisher が無い場合で、**画面がボタンを出すのに PATCH が 422 で落ちていた。**
 *
 * 掛け方の区分（設計 §6.2。`next = { …current, …input }`）：
 *
 * | 検査 | 掛ける条件 |
 * | --- | --- |
 * | g（manual 非対応 → `deliveryMode`） | `input.deliveryMode === 'manual'` のときだけ |
 * | e / f / j〜m（予約として成立するか） | `next.status` が `draft` または `scheduled` |
 * | 配信中のガード（`publish_started_at`） | 従来どおり無条件 |
 *
 * **S-4**：`externalUrl` / `externalId` は Zod を通らない経路（Data API）からも
 * 入るので、UseCase で検証する（`CLAUDE.md`「検証は UseCase に書く」）。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';
const LABEL = 'テストSNS';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `out${suffix}`,
        email: `out${suffix}@example.com`,
        display_name: 'social post outcome test',
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
    loginId: `out${suffix}`,
    displayName: 'social post outcome test',
    email: `out${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 未認証（`identity` が無い）の文脈。 */
async function anonymousContext(): Promise<AuthorizationContext> {
  return withConnection(async (connection) => ({
    identity: null,
    permissions: new Set<never>(),
    connection,
  }));
}

/** Permission を 1 つも持たない文脈。 */
function withoutPermissions(context: AuthorizationContext): AuthorizationContext {
  return { ...context, permissions: new Set<never>() };
}

function usePublisher(overrides: Partial<PublisherRegistration> = {}): void {
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: LABEL,
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

interface PostOptions {
  readonly body?: string;
  readonly deliveryMode?: 'auto' | 'manual';
  readonly status?: 'draft' | 'scheduled';
}

async function makePost(options: PostOptions = {}): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: options.body ?? '手で投稿する本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: options.status ?? 'scheduled',
    deliveryMode: options.deliveryMode ?? 'manual',
  });
  return post.id;
}

/**
 * **S-3 の再現形**（検証レポート S-3）。
 *
 * publisher を登録した状態で `manual` の投稿を作り、そのあと Plugin を無効化する
 * （＝ Plugin マネージャの通常操作）。ここから先、この投稿は画面の
 * 「投稿した」「取りやめ」でしか動かせない。
 */
async function manualPostWithoutPublisher(): Promise<string> {
  usePublisher();
  const id = await makePost();
  resetPublisherRegistry();
  return id;
}

interface PostRow {
  readonly status: string;
  readonly published_at: Date | null;
  readonly failed_at: Date | null;
  readonly failure_reason: string | null;
  readonly external_id: string | null;
  readonly external_url: string | null;
  readonly publish_started_at: Date | null;
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
      ])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

/** 配信が進行中の行を直接作る（着手印はジョブしか立てない）。 */
async function markPublishStarted(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ publish_started_at: new Date() })
      .where('id', '=', id)
      .execute();
  });
}

/** Plugin の Data API（`markPublished` / `markFailed` は同じ UseCase を通る）。 */
function dataApi(context: AuthorizationContext = admin) {
  return createPluginDataApi({
    pluginId: PLUGIN_ID,
    declaredPermissions: new Set(['social.read', 'social.write']),
    context,
  });
}

/** 失敗することを期待する呼び出しから Error を取り出す。 */
async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('失敗するはずの処理が成功した');
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostoutcome');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor('administrator');
  accountId = await accountFor();
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #99 publisher が無くても「投稿した／取りやめ／失敗の記録」ができる
// ---------------------------------------------------------------------------

describe('#99 publisher が無くても手動投稿の出口がある', () => {
  it('#99 publisher を無効化した manual の投稿を published にできる', async () => {
    const id = await manualPostWithoutPublisher();

    await expect(
      updateSocialPost(admin, {
        id,
        status: 'published',
        externalUrl: 'https://x.com/a/status/1',
      }),
    ).resolves.toMatchObject({ status: 'published' });
  });

  it('#99 published にすると published_at が入る', async () => {
    const id = await manualPostWithoutPublisher();

    await updateSocialPost(admin, { id, status: 'published' });

    expect((await postRow(id)).published_at).toBeInstanceOf(Date);
  });

  it('#99 published にすると externalUrl が保存される', async () => {
    const id = await manualPostWithoutPublisher();

    await updateSocialPost(admin, { id, status: 'published', externalUrl: 'https://x.com/a/1' });

    expect((await postRow(id)).external_url).toBe('https://x.com/a/1');
  });

  it('#99 published にすると social.post.published が発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.published', (payload) => {
      events.push(payload);
    });
    const id = await manualPostWithoutPublisher();

    await updateSocialPost(admin, { id, status: 'published' });

    expect(events).toHaveLength(1);
  });

  it('#99 publisher を無効化した manual の投稿を failed にできる', async () => {
    // **失敗を記録する経路が検証で塞がれるのは特に筋が悪い**（検証レポート S-3）。
    const id = await manualPostWithoutPublisher();

    await expect(
      updateSocialPost(admin, { id, status: 'failed', failureReason: '手で投稿できなかった' }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('#99 failed にすると理由が保存される', async () => {
    const id = await manualPostWithoutPublisher();

    await updateSocialPost(admin, { id, status: 'failed', failureReason: '手で投稿できなかった' });

    expect((await postRow(id)).failure_reason).toBe('手で投稿できなかった');
  });

  it('#99 failed にすると social.post.failed が発火する', async () => {
    const events: unknown[] = [];
    subscribe('social.post.failed', (payload) => {
      events.push(payload);
    });
    const id = await manualPostWithoutPublisher();

    await updateSocialPost(admin, { id, status: 'failed' });

    expect(events).toHaveLength(1);
  });

  it('#99 publisher を無効化した manual の投稿を取りやめられる（draft）', async () => {
    // 取りやめは失敗ではない。後で予約し直せる（設計 §6.2）。
    const id = await manualPostWithoutPublisher();

    await expect(updateSocialPost(admin, { id, status: 'draft' })).resolves.toMatchObject({
      status: 'draft',
    });
  });

  it('#99 Data API の markPublished も通る', async () => {
    // `markPublished` / `markFailed` は同じ UseCase を通る（設計 §9.1）。
    const id = await manualPostWithoutPublisher();

    await expect(
      dataApi().socialPosts.markPublished(id, { externalUrl: 'https://x.com/a/2' }),
    ).resolves.toMatchObject({ status: 'published' });
  });

  it('#99 Data API の markFailed も通る', async () => {
    const id = await manualPostWithoutPublisher();

    await expect(dataApi().socialPosts.markFailed(id, 'Plugin 側で失敗')).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('#99 markFailed が渡した理由も保存される', async () => {
    const id = await manualPostWithoutPublisher();

    await dataApi().socialPosts.markFailed(id, 'Plugin 側で失敗');

    expect((await postRow(id)).failure_reason).toBe('Plugin 側で失敗');
  });

  it('#99 manual に「しようとする」更新だけは ValidationError', async () => {
    // 検査 g が守っているのは「manual にしても投稿画面の URL を作れない」ことで、
    // それは **manual にしようとするとき**にしか問われない（設計 §6.2）。
    const id = await manualPostWithoutPublisher();

    await expect(updateSocialPost(admin, { id, deliveryMode: 'manual' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('#99 manual にしようとした例外のフィールドは deliveryMode', async () => {
    const id = await manualPostWithoutPublisher();

    const error = await errorFrom(updateSocialPost(admin, { id, deliveryMode: 'manual' }));

    expect((error as ValidationError).field).toBe('deliveryMode');
  });

  describe('manual を実装していない publisher が登録されている場合', () => {
    /** Plugin は生きているが `manual()` を落とした、という形。結果は同じでなければならない。 */
    async function withoutManualSupport(): Promise<string> {
      usePublisher();
      const id = await makePost();
      resetPublisherRegistry();
      registerPublisher(PLUGIN_ID, { provider: PROVIDER, label: LABEL, credentialFields: [] });
      return id;
    }

    it('#99 published にできる', async () => {
      const id = await withoutManualSupport();

      await expect(updateSocialPost(admin, { id, status: 'published' })).resolves.toMatchObject({
        status: 'published',
      });
    });

    it('#99 failed にできる', async () => {
      const id = await withoutManualSupport();

      await expect(updateSocialPost(admin, { id, status: 'failed' })).resolves.toMatchObject({
        status: 'failed',
      });
    });

    it('#99 draft にできる', async () => {
      const id = await withoutManualSupport();

      await expect(updateSocialPost(admin, { id, status: 'draft' })).resolves.toMatchObject({
        status: 'draft',
      });
    });

    it('#99 manual にしようとする更新は ValidationError', async () => {
      const id = await withoutManualSupport();

      await expect(updateSocialPost(admin, { id, deliveryMode: 'manual' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });
  });

  describe('権限', () => {
    it('#99 social.write を持たない主体の更新は ForbiddenError', async () => {
      const id = await manualPostWithoutPublisher();

      await expect(
        updateSocialPost(withoutPermissions(admin), { id, status: 'published' }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('#99 未認証の更新は UnauthenticatedError', async () => {
      const id = await manualPostWithoutPublisher();
      const anonymous = await anonymousContext();

      await expect(updateSocialPost(anonymous, { id, status: 'published' })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it('#99 未認証は ForbiddenError ではない（401 と 403 を取り違えない）', async () => {
      const id = await manualPostWithoutPublisher();
      const anonymous = await anonymousContext();

      await expect(
        updateSocialPost(anonymous, { id, status: 'published' }),
      ).rejects.not.toBeInstanceOf(ForbiddenError);
    });

    it('#99 権限が無ければ Data API の markPublished も通らない', async () => {
      const id = await manualPostWithoutPublisher();

      await expect(
        dataApi(withoutPermissions(admin)).socialPosts.markPublished(id),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

// ---------------------------------------------------------------------------
// #100 published / failed への遷移に limits / validate() を掛けない
// ---------------------------------------------------------------------------

describe('#100 起きた事実の記録に予約の検査を掛けない', () => {
  /**
   * publisher を**登録する前に**本文 50 文字の投稿を作る（裁定 #8 で 201）。
   * そのあと `bodyMaxLength: 10` の publisher が入る、という運用をなぞる。
   */
  async function longBodyPost(status: 'draft' | 'scheduled' = 'scheduled'): Promise<string> {
    const id = await makePost({ body: 'あ'.repeat(50), deliveryMode: 'auto', status });
    usePublisher({ limits: { bodyMaxLength: 10 } });
    return id;
  }

  it('#100 limits に反する投稿でも published にできる', async () => {
    // **起きた事実を、いまの Plugin の宣言に照らして拒むのは筋が悪い**（設計 §6.2）。
    const id = await longBodyPost();

    await expect(updateSocialPost(admin, { id, status: 'published' })).resolves.toMatchObject({
      status: 'published',
    });
  });

  it('#100 limits に反する投稿でも failed にできる', async () => {
    const id = await longBodyPost();

    await expect(updateSocialPost(admin, { id, status: 'failed' })).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('#100 validate() が問題を返す publisher でも published にできる', async () => {
    const id = await makePost({ deliveryMode: 'auto' });
    usePublisher({ validate: () => [{ field: 'body', message: 'だめです' }] });

    await expect(updateSocialPost(admin, { id, status: 'published' })).resolves.toMatchObject({
      status: 'published',
    });
  });

  it('#100 validate() が問題を返す publisher でも failed にできる', async () => {
    const id = await makePost({ deliveryMode: 'auto' });
    usePublisher({ validate: () => [{ field: 'body', message: 'だめです' }] });

    await expect(updateSocialPost(admin, { id, status: 'failed' })).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('#100 draft へ戻す更新には limits が掛かる', async () => {
    // `draft` はこれから配信される状態で、予約として成立するかが問われる（設計 §6.2）。
    const id = await longBodyPost();

    await expect(updateSocialPost(admin, { id, status: 'draft' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('#100 draft へ戻す更新の例外のフィールドは body', async () => {
    const id = await longBodyPost();

    const error = await errorFrom(updateSocialPost(admin, { id, status: 'draft' }));

    expect((error as ValidationError).field).toBe('body');
  });

  it('#100 scheduled のまま本文を変える更新にも limits が掛かる', async () => {
    const id = await longBodyPost();

    await expect(updateSocialPost(admin, { id, body: 'い'.repeat(50) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('#100 scheduled のまま本文を変える更新の例外のフィールドは body', async () => {
    const id = await longBodyPost();

    const error = await errorFrom(updateSocialPost(admin, { id, body: 'い'.repeat(50) }));

    expect((error as ValidationError).field).toBe('body');
  });
});

// ---------------------------------------------------------------------------
// #101 配信中のガードは変わらない
// ---------------------------------------------------------------------------

describe('#101 配信中のガードは従来どおり', () => {
  /** 着手印の立った `auto` / `scheduled` の行（#37 と同じ形）。 */
  async function publishingPost(): Promise<string> {
    const id = await makePost({ deliveryMode: 'auto' });
    await markPublishStarted(id);
    return id;
  }

  it('#101 着手印の立った行への markPublished は ValidationError', async () => {
    const id = await publishingPost();

    await expect(dataApi().socialPosts.markPublished(id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('#101 markPublished が止まる例外のフィールドは status', async () => {
    const id = await publishingPost();

    const error = await errorFrom(dataApi().socialPosts.markPublished(id));

    expect((error as ValidationError).field).toBe('status');
  });

  it('#101 着手印の立った行への markFailed も ValidationError', async () => {
    const id = await publishingPost();

    await expect(dataApi().socialPosts.markFailed(id, 'だめ')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('#101 markFailed が止まる例外のフィールドも status', async () => {
    const id = await publishingPost();

    const error = await errorFrom(dataApi().socialPosts.markFailed(id, 'だめ'));

    expect((error as ValidationError).field).toBe('status');
  });

  it('#101 着手印の立った行は published にも draft にもならない', async () => {
    const id = await publishingPost();

    await dataApi()
      .socialPosts.markPublished(id)
      .catch(() => undefined);

    expect((await postRow(id)).status).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
// #102 externalUrl / externalId を UseCase で検証する
// ---------------------------------------------------------------------------

describe('#102 externalUrl と externalId の検証', () => {
  /**
   * **publisher のいない `auto` の投稿を使う。**
   *
   * S-3（検査 g が無条件に掛かる）に巻き込まれると、`externalUrl` を見る前に
   * `deliveryMode` で落ちて、この検査が通っているのか分からなくなる。
   */
  async function autoPost(): Promise<string> {
    return makePost({ deliveryMode: 'auto' });
  }

  async function publishedAttempt(externalUrl: string): Promise<Error> {
    const id = await autoPost();
    return errorFrom(updateSocialPost(admin, { id, status: 'published', externalUrl }));
  }

  it.each([
    ['http の URL', 'http://evil/'],
    ['資格情報付きの URL', 'https://user:pass@evil/'],
    ['javascript: の URL', 'javascript:alert(1)'],
  ])('#102 %s は ValidationError', async (_label, url) => {
    // `href` にそのまま出る値を、Zod を通らない経路からも素通しにしない（S-4）。
    const error = await publishedAttempt(url);

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('#102 2048 文字を超える URL は ValidationError（境界の外）', async () => {
    const url = `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}`;
    expect(url).toHaveLength(2049);

    expect(await publishedAttempt(url)).toBeInstanceOf(ValidationError);
  });

  it('#102 例外のフィールドは externalUrl', async () => {
    const error = await publishedAttempt('http://evil/');

    expect((error as ValidationError).field).toBe('externalUrl');
  });

  it('#102 正しい https の URL は通る', async () => {
    const id = await autoPost();

    await expect(
      updateSocialPost(admin, { id, status: 'published', externalUrl: 'https://x.com/a/status/1' }),
    ).resolves.toMatchObject({ externalUrl: 'https://x.com/a/status/1' });
  });

  it('#102 2048 文字ちょうどの URL は通る（境界）', async () => {
    const url = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
    expect(url).toHaveLength(2048);
    const id = await autoPost();

    await expect(
      updateSocialPost(admin, { id, status: 'published', externalUrl: url }),
    ).resolves.toMatchObject({ status: 'published' });
  });

  it('#102 externalUrl: null（消す）は通る', async () => {
    const id = await autoPost();

    await expect(
      updateSocialPost(admin, { id, status: 'published', externalUrl: null }),
    ).resolves.toMatchObject({ externalUrl: null });
  });

  it('#102 externalId が 201 文字なら ValidationError', async () => {
    const id = await autoPost();

    await expect(
      updateSocialPost(admin, { id, status: 'published', externalId: 'a'.repeat(201) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('#102 externalId の例外のフィールドは externalId', async () => {
    const id = await autoPost();

    const error = await errorFrom(
      updateSocialPost(admin, { id, status: 'published', externalId: 'a'.repeat(201) }),
    );

    expect((error as ValidationError).field).toBe('externalId');
  });

  it('#102 externalId が 200 文字なら通る（境界）', async () => {
    const id = await autoPost();

    await expect(
      updateSocialPost(admin, { id, status: 'published', externalId: 'a'.repeat(200) }),
    ).resolves.toMatchObject({ status: 'published' });
  });

  it('#102 externalId: null（消す）は通る', async () => {
    const id = await autoPost();

    await expect(
      updateSocialPost(admin, { id, status: 'published', externalId: null }),
    ).resolves.toMatchObject({ externalId: null });
  });

  it('#102 Data API の markPublished でも javascript: は弾かれる', async () => {
    // **Zod を通らない経路**（設計 §6.2 の枠。ここが S-4 の本体）。
    const id = await autoPost();

    await expect(
      dataApi().socialPosts.markPublished(id, { externalUrl: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('#102 markPublished で弾かれた投稿は published にならない', async () => {
    const id = await autoPost();

    await dataApi()
      .socialPosts.markPublished(id, { externalUrl: 'javascript:alert(1)' })
      .catch(() => undefined);

    expect((await postRow(id)).status).toBe('scheduled');
  });

  it('#102 Data API の markPublished でも資格情報付きの URL は弾かれる', async () => {
    const id = await autoPost();

    await expect(
      dataApi().socialPosts.markPublished(id, { externalUrl: 'https://user:pass@evil/' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('#102 Data API の markPublished に正しい URL を渡せば通る', async () => {
    const id = await autoPost();

    await expect(
      dataApi().socialPosts.markPublished(id, { externalUrl: 'https://x.com/a/status/9' }),
    ).resolves.toMatchObject({ externalUrl: 'https://x.com/a/status/9' });
  });

  it('#102 Data API の markPublished でも 201 文字の externalId は弾かれる', async () => {
    const id = await autoPost();

    await expect(
      dataApi().socialPosts.markPublished(id, { externalId: 'a'.repeat(201) }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
