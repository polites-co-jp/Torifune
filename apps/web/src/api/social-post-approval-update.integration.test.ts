import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GET as getSocialPostRoute,
  PATCH as updateSocialPostRoute,
} from '@/app/api/v1/social/posts/[id]/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { PostStatus } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `PATCH /api/v1/social/posts/{id}` の承認待ちの規則（048-social-post-approval 設計 §6.3・§6.6）。
 *
 * 受け入れ条件 #25〜#32・#34。
 *
 * **ルートを直接叩く結合テスト。** 承認済みの予約は、承認の操作（G5）に依存させないよう
 * **SQL で `approved_at` を直接入れて作る**（実装プラン §8 の 7）。支度待ち（`next_attempt_at`・`skip_count`）と
 * 配信中（`publish_started_at`）も SQL で作る。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/posts';

/** `publish` と `manual` の両方を持つ偽の publisher の provider。 */
const PROVIDER = 'apr_update';

const HOUR = 60 * 60_000;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
let writeToken: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `u${suffix}`,
        email: `u${suffix}@example.com`,
        display_name: 'approval update test',
      })
      .execute();

    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) throw new Error(`ロールが無い: ${roleName}`);
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: id, role_id: role.id })
        .execute();
    }
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `u${suffix}`,
    displayName: 'approval update test',
    email: `u${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function bothPublisher(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: PROVIDER,
    label: '両方（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true }),
    manual: () => ({ url: 'https://example.com/intent/post' }),
    ...overrides,
  };
}

/** 登録簿を差し替える（既定の publisher を外して別のものを入れる）。 */
function replacePublisher(registration: PublisherRegistration): void {
  resetPublisherRegistry();
  registerPublisher('test-plugin', registration);
}

async function callUpdate(id: string, body: unknown): Promise<JsonResult> {
  const response = await updateSocialPostRoute(
    new Request(`${BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function callGet(id: string): Promise<Record<string, unknown>> {
  const response = await getSocialPostRoute(
    new Request(`${BASE}/${id}`, { headers: { authorization: `Bearer ${writeToken}` } }),
    { params: Promise.resolve({ id }) },
  );
  return ((await response.json()) as { data: Record<string, unknown> }).data;
}

const MEDIA = [
  { url: 'https://cdn.example.com/a.jpg', alt: '製品の写真' },
  { url: 'https://cdn.example.com/b.jpg', alt: null },
];

async function makePost(status: PostStatus, scheduledAt: Date | null): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '新製品のお知らせです。',
    scheduledAt,
    status,
    deliveryMode: 'auto',
    media: MEDIA,
    link: 'https://example.com/news/1',
    providerOptions: { replySettings: 'everyone', nested: { a: 1, b: 2 } },
  });
  return post.id;
}

/** 承認待ちの投稿（`publishTiming` を送らず `status: 'awaiting_approval'` で作る。設計 §6.2.2）。 */
function makeAwaiting(): Promise<string> {
  return makePost('awaiting_approval', new Date(Date.now() + HOUR));
}

/** 承認を経ていない予約。 */
function makeScheduled(): Promise<string> {
  return makePost('scheduled', new Date(Date.now() + HOUR));
}

/** 承認を経た予約（SQL で `approved_at` を入れる。実装プラン §8 の 7）。 */
async function makeApprovedScheduled(): Promise<string> {
  const id = await makeScheduled();
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET approved_at = now() - interval '5 minutes' WHERE id = ${id}`.execute(
      connection.db,
    );
  });
  return id;
}

async function approvedAtOf(id: string): Promise<Date | null> {
  return withConnection(async (connection) => {
    const result = await sql<{
      approved_at: Date | null;
    }>`SELECT approved_at FROM social_posts WHERE id = ${id}`.execute(connection.db);
    return result.rows[0]?.approved_at ?? null;
  });
}

async function statusOf(id: string): Promise<string | undefined> {
  return withConnection(async (connection) => {
    const row = await connection.db
      .selectFrom('social_posts')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.status;
  });
}

/** `GET` で読んだ値をそのまま送る（編集フォームの保存。設計 §6.3.3）。 */
function sameValuesOf(read: Record<string, unknown>): Record<string, unknown> {
  return {
    body: read['body'],
    scheduledAt: read['scheduledAt'],
    media: read['media'],
    link: read['link'],
    providerOptions: read['providerOptions'],
    deliveryMode: read['deliveryMode'],
    status: read['status'],
  };
}

async function updatedAuditDetails(): Promise<Record<string, unknown>[]> {
  const rows = await withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['detail'])
      .where('resource_type', '=', 'social_post')
      .where('action', '=', 'updated')
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute(),
  );
  return rows.map((row) => row.detail as Record<string, unknown>);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialapprovalupdate');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  accountId = (
    await createSocialAccount(admin, {
      provider: PROVIDER,
      displayName: '更新の検査',
      handle: '@update',
      credential: 'account-credential',
      status: 'connected',
    })
  ).id;
  writeToken = (
    await createApiToken(admin, {
      name: `t-${uuidv7().slice(-8)}`,
      scopes: ['social.read', 'social.write'],
      expiresAt: null,
    })
  ).plaintext;
  registerPublisher('test-plugin', bothPublisher());
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #25 承認を依頼する・承認待ちへ戻す
// ---------------------------------------------------------------------------

describe('#25 承認待ちへ移す', () => {
  it('#25 draft → { status: awaiting_approval } → 200・awaiting_approval', async () => {
    const id = await makePost('draft', null);

    const result = await callUpdate(id, { status: 'awaiting_approval' });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('awaiting_approval');
  });

  it('#25 支度待ちの scheduled → awaiting_approval → 200・nextAttemptAt: null・skipCount: 1 のまま', async () => {
    const id = await makeScheduled();
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({
          next_attempt_at: new Date(Date.now() + 10 * 60_000),
          skip_count: 1,
          skip_reason: 'no_publisher',
        })
        .where('id', '=', id)
        .execute();
    });

    const result = await callUpdate(id, { status: 'awaiting_approval' });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({
      status: 'awaiting_approval',
      nextAttemptAt: null,
      skipCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// #26 承認待ちから予約・結果へは PATCH で移せない
// ---------------------------------------------------------------------------

describe('#26 承認待ち → scheduled / published / failed は 422 status', () => {
  it('#26 承認待ち → { status: scheduled } → 422 status（承認の操作でだけ予約にできる）', async () => {
    const id = await makeAwaiting();

    const result = await callUpdate(id, {
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + HOUR).toISOString(),
    });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['status']).toContain(
      '承認待ちの投稿は、承認の操作でだけ予約にできます。',
    );
  });

  it('#26 422 の後も行は承認待ちのまま', async () => {
    const id = await makeAwaiting();

    await callUpdate(id, { status: 'scheduled' });

    expect(await statusOf(id)).toBe('awaiting_approval');
  });

  it.each(['published', 'failed'])('#26 承認待ち → { status: %s } → 422 status', async (status) => {
    const id = await makeAwaiting();

    const result = await callUpdate(id, { status });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('status');
    expect(await statusOf(id)).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #27 差し戻し・取りやめ
// ---------------------------------------------------------------------------

describe('#27 承認待ち → draft（差し戻し）', () => {
  it('#27 { status: draft } → 200・draft', async () => {
    const id = await makeAwaiting();

    const result = await callUpdate(id, { status: 'draft' });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('draft');
  });

  it('#27 validate() が例外を投げる publisher でも 200（出口を塞がない）', async () => {
    const id = await makeAwaiting();
    replacePublisher(
      bothPublisher({
        validate: () => {
          throw new Error('validate exploded');
        },
      }),
    );

    const result = await callUpdate(id, { status: 'draft' });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// #28 承認待ちの内容の修正
// ---------------------------------------------------------------------------

describe('#28 承認待ちの本文の修正', () => {
  it('#28 body の修正 → 200・awaiting_approval のまま', async () => {
    const id = await makeAwaiting();

    const result = await callUpdate(id, { body: '直した本文' });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', body: '直した本文' });
  });

  it('#28 validate() が問題を返す publisher では 422（承認待ちにも配信 Plugin の検査が掛かる）', async () => {
    const id = await makeAwaiting();
    replacePublisher(
      bothPublisher({ validate: () => [{ field: 'body', message: '本文が規則に反します' }] }),
    );

    const result = await callUpdate(id, { body: '直した本文' });

    expect(result.status).toBe(422);
    expect(detailsOf(result)['body']).toContain('本文が規則に反します');
  });
});

// ---------------------------------------------------------------------------
// #29 PATCH の publishTiming
// ---------------------------------------------------------------------------

describe('#29 PATCH に publishTiming を送ると 422', () => {
  it.each(['now', 'scheduled', 'after_approval', 'bogus', null])(
    '#29 publishTiming: %s → 422 publishTiming',
    async (publishTiming) => {
      const id = await makePost('draft', null);

      const result = await callUpdate(id, { publishTiming });

      expect(result.status).toBe(422);
      expect(Object.keys(detailsOf(result))).toContain('publishTiming');
    },
  );

  it('#29 文言は「登録のときだけ」と承認の依頼のしかたを案内する', async () => {
    const id = await makePost('draft', null);

    const result = await callUpdate(id, { publishTiming: 'after_approval' });

    expect(detailsOf(result)['publishTiming']).toContain(
      'publishTiming は登録のときだけ指定できます。承認を依頼するときは status に awaiting_approval を指定してください。',
    );
  });

  it('#29 422 の後も状態は変わらない', async () => {
    const id = await makePost('draft', null);

    await callUpdate(id, { publishTiming: 'after_approval', status: 'awaiting_approval' });

    expect(await statusOf(id)).toBe('draft');
  });
});

// ---------------------------------------------------------------------------
// #30 承認済みの予約の書き換え（裁定 10）
// ---------------------------------------------------------------------------

describe('#30 承認済みの予約を書き換えると承認待ちへ戻る', () => {
  it('#30 body の変更 → 200・awaiting_approval・approvedAt: null', async () => {
    const id = await makeApprovedScheduled();

    const result = await callUpdate(id, { body: '承認の後に書き換えた本文' });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', approvedAt: null });
    expect(await approvedAtOf(id)).toBeNull();
  });

  it('#30 全項目を同じ値で送る（編集フォームの保存）→ scheduled・approvedAt はそのまま', async () => {
    const id = await makeApprovedScheduled();
    const read = await callGet(id);

    const result = await callUpdate(id, sameValuesOf(read));

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('scheduled');
    expect(dataOf(result)['approvedAt']).toBe(read['approvedAt']);
    expect(read['approvedAt']).not.toBeNull();
  });

  it('#30 providerOptions のキーの順序だけ違う同じ中身 → scheduled のまま', async () => {
    const id = await makeApprovedScheduled();
    const read = await callGet(id);

    const result = await callUpdate(id, {
      ...sameValuesOf(read),
      providerOptions: { nested: { b: 2, a: 1 }, replySettings: 'everyone' },
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('scheduled');
    expect(dataOf(result)['approvedAt']).toBe(read['approvedAt']);
  });

  it('#30 scheduledAt の変更 → awaiting_approval', async () => {
    const id = await makeApprovedScheduled();

    const result = await callUpdate(id, {
      scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', approvedAt: null });
  });

  it('#30 承認が外れるときも next_attempt_at を NULL にする', async () => {
    const id = await makeApprovedScheduled();
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({ next_attempt_at: new Date(Date.now() + 10 * 60_000) })
        .where('id', '=', id)
        .execute();
    });

    const result = await callUpdate(id, { body: '承認の後に書き換えた本文' });

    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', nextAttemptAt: null });
  });

  it('#30 { status: draft } → draft・approvedAt: null', async () => {
    const id = await makeApprovedScheduled();

    const result = await callUpdate(id, { status: 'draft' });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'draft', approvedAt: null });
  });

  it('#30 { status: awaiting_approval }（明示）→ awaiting_approval・approvedAt: null', async () => {
    const id = await makeApprovedScheduled();

    const result = await callUpdate(id, { status: 'awaiting_approval' });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', approvedAt: null });
  });

  it('#30 { status: published } → published・approvedAt はそのまま', async () => {
    const id = await makeApprovedScheduled();
    const read = await callGet(id);

    const result = await callUpdate(id, { status: 'published' });

    expect(result.status).toBe(200);
    expect(dataOf(result)['status']).toBe('published');
    expect(dataOf(result)['approvedAt']).toBe(read['approvedAt']);
    expect(read['approvedAt']).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #31 承認を経ていない予約
// ---------------------------------------------------------------------------

describe('#31 承認を経ていない予約の書き換え', () => {
  it('#31 approvedAt: null の予約の body の変更 → scheduled のまま', async () => {
    const id = await makeScheduled();

    const result = await callUpdate(id, { body: '書き換えた本文' });

    expect(result.status).toBe(200);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', approvedAt: null });
  });
});

// ---------------------------------------------------------------------------
// #32 配信中のガードが先
// ---------------------------------------------------------------------------

describe('#32 承認済みの予約が配信中なら 422', () => {
  it('#32 publish_started_at があるときの body の変更 → 422 status', async () => {
    const id = await makeApprovedScheduled();
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({ publish_started_at: new Date() })
        .where('id', '=', id)
        .execute();
    });

    const result = await callUpdate(id, { body: '配信中に書き換えた本文' });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('status');
    expect(await statusOf(id)).toBe('scheduled');
    expect(await approvedAtOf(id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #34 監査（B）
// ---------------------------------------------------------------------------

describe('#34 監査 updated の detail に status（更新後）', () => {
  it('#34 承認を依頼した更新の detail.status が awaiting_approval', async () => {
    const id = await makePost('draft', null);

    await callUpdate(id, { status: 'awaiting_approval' });

    const details = await updatedAuditDetails();
    expect(details).toHaveLength(1);
    expect(details[0]?.['status']).toBe('awaiting_approval');
  });

  it('#34 承認が外れた body の変更では status: awaiting_approval と changed に body', async () => {
    const id = await makeApprovedScheduled();

    await callUpdate(id, { body: '承認の後に書き換えた本文' });

    const details = await updatedAuditDetails();
    expect(details).toHaveLength(1);
    expect(details[0]?.['status']).toBe('awaiting_approval');
    expect(details[0]?.['changed']).toEqual(expect.arrayContaining(['body']));
  });

  it('#34 承認を経ていない予約の更新では status: scheduled', async () => {
    const id = await makeScheduled();

    await callUpdate(id, { body: '書き換えた本文' });

    const details = await updatedAuditDetails();
    expect(details[0]?.['status']).toBe('scheduled');
  });
});
