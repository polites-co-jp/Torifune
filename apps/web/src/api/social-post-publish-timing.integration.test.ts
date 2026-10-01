import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GET as listSocialPostsRoute,
  POST as createSocialPostRoute,
} from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, listManualPendingPosts } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { generateApiToken } from '@/domain/api-token';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `POST /api/v1/social/posts` の `publishTiming`（048-social-post-approval 設計 §6.2・§6.7・§6.9・§6.11）。
 *
 * 受け入れ条件 #12〜#24・#54・#56。
 *
 * **ルートを直接叩く結合テスト**（実装プラン §2「テストの方法」）。偽の publisher は `registerPublisher` で
 * プロセス内へ登録する。provider ごとに 3 種類を用意する（設計 §10 の前書き）：
 *
 * * **手動投稿だけ**：`manual` だけを持ち、`publish` のキーを置かない（裁定 5・7 の判定に当てはまる）
 * * **両方**：`publish` と `manual` を持つ
 * * **無し**：publisher を登録しない provider
 *
 * 「いま」で決まる時刻（`now` の `scheduledAt`）は、**要求の直前と直後に取った時刻の間**にあることで見る
 * （フェイクタイマーは DB の `now()` と食い違うので使わない）。
 */

const ENDPOINT = 'http://127.0.0.1:3000/api/v1/social/posts';

const MANUAL_ONLY_PROVIDER = 'apr_manual_only';
const BOTH_PROVIDER = 'apr_both';
const NO_PUBLISHER_PROVIDER = 'apr_none';

const HOUR = 60 * 60_000;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** 手動投稿だけの publisher の provider のアカウント。 */
let manualOnlyAccountId: string;
/** 両方の publisher の provider のアカウント。 */
let bothAccountId: string;
/** publisher の無い provider のアカウント。 */
let noPublisherAccountId: string;
/** `social.read` と `social.write` を持つ Token の平文。 */
let writeToken: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
}

function listOf(result: JsonResult): readonly Record<string, unknown>[] {
  return result.body['data'] as readonly Record<string, unknown>[];
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
        login_id: `t${suffix}`,
        email: `t${suffix}@example.com`,
        display_name: 'publish timing test',
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
    loginId: `t${suffix}`,
    displayName: 'publish timing test',
    email: `t${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function issueToken(owner: AuthorizationContext, scopes: readonly string[]): Promise<string> {
  const created = await createApiToken(owner, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return created.plaintext;
}

/** 手動投稿だけの publisher（`publish` のキーを置かない）。 */
function manualOnlyPublisher(
  overrides: Partial<PublisherRegistration> = {},
): PublisherRegistration {
  return {
    provider: MANUAL_ONLY_PROVIDER,
    label: '手動投稿だけ（テスト）',
    credentialFields: [],
    manual: () => ({ url: 'https://example.com/intent/post' }),
    ...overrides,
  };
}

/** `publish` と `manual` の両方を持つ publisher。 */
function bothPublisher(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: () => ({ url: 'https://example.com/intent/post' }),
    ...overrides,
  };
}

function registerDefaultPublishers(): void {
  registerPublisher('test-plugin', manualOnlyPublisher());
  registerPublisher('test-plugin', bothPublisher());
}

async function callCreate(body: unknown, token: string = writeToken): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function callList(query: string, token: string = writeToken): Promise<JsonResult> {
  const response = await listSocialPostsRoute(
    new Request(`${ENDPOINT}${query}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** 両方の publisher の provider へ出す、通るだけの要求。 */
function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { socialAccountId: bothAccountId, body: '新製品のお知らせです。', ...overrides };
}

function future(offsetMs = HOUR): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function past(offsetMs = HOUR): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

async function createdAuditDetails(): Promise<Record<string, unknown>[]> {
  const rows = await withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select(['detail'])
      .where('resource_type', '=', 'social_post')
      .where('action', '=', 'created')
      .orderBy('occurred_at', 'asc')
      .orderBy('id', 'asc')
      .execute(),
  );
  return rows.map((row) => row.detail as Record<string, unknown>);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishtiming');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const accountOf = async (provider: string, displayName: string): Promise<string> =>
    (
      await createSocialAccount(admin, {
        provider,
        displayName,
        handle: '@torifune',
        credential: 'account-credential',
        status: 'connected',
      })
    ).id;
  manualOnlyAccountId = await accountOf(MANUAL_ONLY_PROVIDER, '手動投稿だけ');
  bothAccountId = await accountOf(BOTH_PROVIDER, '両方');
  noPublisherAccountId = await accountOf(NO_PUBLISHER_PROVIDER, '配信 Plugin なし');
  writeToken = await issueToken(admin, ['social.read', 'social.write']);
  registerDefaultPublishers();
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    // FK の向きに従う。
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #12 publishTiming を送らない既存の要求
// ---------------------------------------------------------------------------

describe('#12 publishTiming を送らない要求は今までどおり', () => {
  it('#12 status 省略 → 201・draft・approvedAt: null', async () => {
    const result = await callCreate(post());

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'draft', approvedAt: null });
  });

  it('#12 status: scheduled ＋ scheduledAt → 201・scheduled・その日時・approvedAt: null', async () => {
    const scheduledAt = future();

    const result = await callCreate(post({ status: 'scheduled', scheduledAt }));

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt, approvedAt: null });
  });

  it('#12 status: draft → 201・draft・approvedAt: null', async () => {
    const result = await callCreate(post({ status: 'draft' }));

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'draft', approvedAt: null });
  });

  it('#12 応答に approvedAt のキーがある', async () => {
    const result = await callCreate(post());

    expect(Object.keys(dataOf(result))).toContain('approvedAt');
  });
});

// ---------------------------------------------------------------------------
// #13〜#16 publishTiming の各値
// ---------------------------------------------------------------------------

describe('#13 publishTiming: now（auto・両方の publisher）', () => {
  it('#13 201・status: scheduled・scheduledAt が要求の前後の時刻の間', async () => {
    const before = Date.now();
    const result = await callCreate(post({ publishTiming: 'now', deliveryMode: 'auto' }));
    const after = Date.now();

    expect(result.status).toBe(201);
    expect(dataOf(result)['status']).toBe('scheduled');
    const scheduledAt = Date.parse(String(dataOf(result)['scheduledAt']));
    expect(scheduledAt).toBeGreaterThanOrEqual(before);
    expect(scheduledAt).toBeLessThanOrEqual(after);
  });

  it('#13 approvedAt は null（承認を経ていない）', async () => {
    const result = await callCreate(post({ publishTiming: 'now' }));

    expect(dataOf(result)['approvedAt']).toBeNull();
  });
});

describe('#14 publishTiming: now ＋ deliveryMode: manual（両方の publisher）', () => {
  it('#14 201 で、直後の listManualPendingPosts に含まれる', async () => {
    const result = await callCreate(post({ publishTiming: 'now', deliveryMode: 'manual' }));

    expect(result.status).toBe(201);
    const pending = await listManualPendingPosts(admin, { limit: 50 });
    expect(pending.items.map((item) => item.id)).toContain(dataOf(result)['id']);
  });
});

describe('#15 publishTiming: scheduled', () => {
  it('#15 未来の scheduledAt → 201・scheduled・その日時', async () => {
    const scheduledAt = future();

    const result = await callCreate(post({ publishTiming: 'scheduled', scheduledAt }));

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt });
  });

  it('#15 過去の scheduledAt → 201・scheduled・その日時（登録は過去も許す）', async () => {
    const scheduledAt = past();

    const result = await callCreate(post({ publishTiming: 'scheduled', scheduledAt }));

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt });
  });
});

describe('#16 publishTiming: after_approval', () => {
  it('#16 scheduledAt あり → 201・awaiting_approval・送った日時・approvedAt: null', async () => {
    const scheduledAt = future();

    const result = await callCreate(post({ publishTiming: 'after_approval', scheduledAt }));

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({
      status: 'awaiting_approval',
      scheduledAt,
      approvedAt: null,
    });
  });

  it('#16 scheduledAt なし → 201・awaiting_approval・scheduledAt: null', async () => {
    const result = await callCreate(post({ publishTiming: 'after_approval' }));

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', scheduledAt: null });
  });
});

// ---------------------------------------------------------------------------
// #17 422
// ---------------------------------------------------------------------------

describe('#17 publishTiming の 422', () => {
  it("#17 publishTiming: 'later' → 422 publishTiming", async () => {
    const result = await callCreate(post({ publishTiming: 'later' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('publishTiming');
  });

  it.each(['draft', 'scheduled', 'awaiting_approval'])(
    '#17 publishTiming: now ＋ status: %s → 422 status（status の値によらない）',
    async (status) => {
      const result = await callCreate(post({ publishTiming: 'now', status }));

      expect(result.status).toBe(422);
      expect(Object.keys(detailsOf(result))).toContain('status');
    },
  );

  it('#17 publishTiming: after_approval ＋ status: draft → 422 status', async () => {
    const result = await callCreate(post({ publishTiming: 'after_approval', status: 'draft' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('status');
  });

  it('#17 publishTiming: now ＋ scheduledAt の値 → 422 scheduledAt', async () => {
    const result = await callCreate(post({ publishTiming: 'now', scheduledAt: future() }));

    expect(result.status).toBe(422);
    expect(detailsOf(result)['scheduledAt']).toContain(
      'publishTiming が now のときは scheduledAt を指定できません。',
    );
  });

  it('#17 両方の違反を同時に送ると 1 回の 422 に status と scheduledAt が並ぶ', async () => {
    const result = await callCreate(
      post({ publishTiming: 'now', status: 'draft', scheduledAt: future() }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toEqual(
      expect.arrayContaining(['status', 'scheduledAt']),
    );
  });

  it('#17 publishTiming: now ＋ scheduledAt: null → 201', async () => {
    const result = await callCreate(post({ publishTiming: 'now', scheduledAt: null }));

    expect(result.status).toBe(201);
    expect(dataOf(result)['status']).toBe('scheduled');
  });

  it('#17 publishTiming: scheduled で scheduledAt なし → 422 scheduledAt', async () => {
    const result = await callCreate(post({ publishTiming: 'scheduled' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('scheduledAt');
  });

  it('#17 publishTiming: scheduled で scheduledAt: null → 422 scheduledAt', async () => {
    const result = await callCreate(post({ publishTiming: 'scheduled', scheduledAt: null }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('scheduledAt');
  });

  it("#17 対照：publishTiming: 'later' ＋ status: draft では details に publishTiming だけ（1 が通らなければ 1b を掛けない）", async () => {
    const result = await callCreate(post({ publishTiming: 'later', status: 'draft' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('publishTiming');
    expect(Object.keys(detailsOf(result))).not.toContain('status');
  });

  it('#17 422 では行が増えない', async () => {
    await callCreate(post({ publishTiming: 'now', status: 'draft' }));

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('social_posts').select('id').execute(),
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #18〜#20 裁定 5：手動投稿だけの publisher の provider
// ---------------------------------------------------------------------------

describe('#18 手動投稿だけの publisher の provider では常に承認待ち', () => {
  it('#18 publishTiming: now → 201・awaiting_approval・scheduledAt: null', async () => {
    const result = await callCreate({
      socialAccountId: manualOnlyAccountId,
      body: '手動投稿だけ',
      deliveryMode: 'manual',
      publishTiming: 'now',
    });

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', scheduledAt: null });
  });

  it('#18 publishTiming: scheduled ＋ 日時 → 201・awaiting_approval・送った日時', async () => {
    const scheduledAt = future();

    const result = await callCreate({
      socialAccountId: manualOnlyAccountId,
      body: '手動投稿だけ',
      deliveryMode: 'manual',
      publishTiming: 'scheduled',
      scheduledAt,
    });

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'awaiting_approval', scheduledAt });
  });

  it('#18 publishTiming: after_approval → 201・awaiting_approval', async () => {
    const result = await callCreate({
      socialAccountId: manualOnlyAccountId,
      body: '手動投稿だけ',
      deliveryMode: 'manual',
      publishTiming: 'after_approval',
    });

    expect(result.status).toBe(201);
    expect(dataOf(result)['status']).toBe('awaiting_approval');
  });

  it('#18 読み替えた登録は手動投稿待ちに並ばない', async () => {
    await callCreate({
      socialAccountId: manualOnlyAccountId,
      body: '手動投稿だけ',
      deliveryMode: 'manual',
      publishTiming: 'now',
    });

    const pending = await listManualPendingPosts(admin, { limit: 50 });
    expect(pending.total).toBe(0);
  });
});

describe('#19 同じ provider で publishTiming を送らない予約は今の振る舞い（§6.7.4）', () => {
  it('#19 status: scheduled ＋ scheduledAt → 201・scheduled', async () => {
    const scheduledAt = future();

    const result = await callCreate({
      socialAccountId: manualOnlyAccountId,
      body: '手動投稿だけ',
      deliveryMode: 'manual',
      status: 'scheduled',
      scheduledAt,
    });

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({ status: 'scheduled', scheduledAt });
  });
});

describe('#20 手動投稿だけでない provider では読み替えない', () => {
  it('#20 両方の publisher の provider で deliveryMode: manual ＋ now → scheduled', async () => {
    const result = await callCreate(post({ deliveryMode: 'manual', publishTiming: 'now' }));

    expect(result.status).toBe(201);
    expect(dataOf(result)['status']).toBe('scheduled');
  });

  it('#20 publisher が無い provider で now → scheduled', async () => {
    const result = await callCreate({
      socialAccountId: noPublisherAccountId,
      body: '配信 Plugin なし',
      publishTiming: 'now',
    });

    expect(result.status).toBe(201);
    expect(dataOf(result)['status']).toBe('scheduled');
  });
});

// ---------------------------------------------------------------------------
// #21 承認待ちの登録にも 8a・8b が掛かる
// ---------------------------------------------------------------------------

describe('#21 after_approval でも配信 Plugin の検査が掛かる', () => {
  it('#21 validate() が問題を返す publisher → 422（キーは validate() が返したもの）', async () => {
    resetPublisherRegistry();
    registerPublisher(
      'test-plugin',
      bothPublisher({ validate: () => [{ field: 'body', message: '本文が規則に反します' }] }),
    );

    const result = await callCreate(post({ publishTiming: 'after_approval' }));

    expect(result.status).toBe(422);
    expect(detailsOf(result)['body']).toContain('本文が規則に反します');
  });

  it('#21 deliveryMode: manual ＋ media 1 件 → 422 media', async () => {
    const result = await callCreate(
      post({
        publishTiming: 'after_approval',
        deliveryMode: 'manual',
        media: [{ url: 'https://cdn.example.com/a.jpg', alt: null }],
      }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });
});

// ---------------------------------------------------------------------------
// #22 status: awaiting_approval
// ---------------------------------------------------------------------------

describe('#22 status: awaiting_approval（publishTiming なし）', () => {
  it('#22 201・awaiting_approval', async () => {
    const result = await callCreate(post({ status: 'awaiting_approval' }));

    expect(result.status).toBe(201);
    expect(dataOf(result)['status']).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// #23 externalRef の再送
// ---------------------------------------------------------------------------

describe('#23 externalRef の再送', () => {
  it('#23 1 回目 after_approval、2 回目 now → 200 で 1 回目の投稿（awaiting_approval）のまま', async () => {
    const first = await callCreate(post({ externalRef: 'r1', publishTiming: 'after_approval' }));
    const second = await callCreate(post({ externalRef: 'r1', publishTiming: 'now' }));

    expect([first.status, second.status]).toEqual([201, 200]);
    expect(dataOf(second)).toMatchObject({
      id: dataOf(first)['id'],
      status: 'awaiting_approval',
    });
  });

  it('#23 2 回目が publishTiming ＋ status の同時指定なら 422 status（再送でも形の検査は掛かる）', async () => {
    await callCreate(post({ externalRef: 'r1', publishTiming: 'after_approval' }));

    const second = await callCreate(
      post({ externalRef: 'r1', publishTiming: 'now', status: 'draft' }),
    );

    expect(second.status).toBe(422);
    expect(Object.keys(detailsOf(second))).toContain('status');
  });
});

// ---------------------------------------------------------------------------
// #24 イベントと監査（B）
// ---------------------------------------------------------------------------

describe('#24 social.post.created と監査', () => {
  it('#24 social.post.created が status: awaiting_approval で 1 回発火する', async () => {
    const received: { status: string }[] = [];
    subscribe('social.post.created', (payload) => {
      received.push(payload);
    });

    await callCreate(post({ publishTiming: 'after_approval' }));

    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe('awaiting_approval');
  });

  it("#24 監査 created の detail に publishTiming: 'after_approval'・approvalForced: false", async () => {
    await callCreate(post({ publishTiming: 'after_approval' }));

    const details = await createdAuditDetails();
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      publishTiming: 'after_approval',
      approvalForced: false,
      status: 'awaiting_approval',
    });
  });

  it('#24 publishTiming を送らない登録の監査は publishTiming: null', async () => {
    await callCreate(post());

    const details = await createdAuditDetails();
    expect(details[0]).toMatchObject({ publishTiming: null, approvalForced: false });
  });

  it('#24 条件 18 の登録（手動投稿だけの provider）では approvalForced: true', async () => {
    await callCreate({
      socialAccountId: manualOnlyAccountId,
      body: '手動投稿だけ',
      deliveryMode: 'manual',
      publishTiming: 'now',
    });

    const details = await createdAuditDetails();
    expect(details[0]).toMatchObject({ publishTiming: 'now', approvalForced: true });
  });
});

// ---------------------------------------------------------------------------
// #54 権限
// ---------------------------------------------------------------------------

describe('#54 publishTiming を送る登録の認証と認可', () => {
  it('#54 Scope social.read だけの Token → 403', async () => {
    const readOnly = await issueToken(admin, ['social.read']);

    const result = await callCreate(post({ publishTiming: 'after_approval' }), readOnly);

    expect(result.status).toBe(403);
  });

  it('#54 形の合った無効な Token → 401', async () => {
    const result = await callCreate(
      post({ publishTiming: 'after_approval' }),
      generateApiToken().plaintext,
    );

    expect(result.status).toBe(401);
  });

  it('#54 対照：Scope social.read + social.write の Token → 201', async () => {
    const result = await callCreate(post({ publishTiming: 'after_approval' }));

    expect(result.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// #56 一覧の絞り込み
// ---------------------------------------------------------------------------

describe('#56 GET /social/posts?status=awaiting_approval', () => {
  it('#56 承認待ちだけが返る', async () => {
    const awaiting = await callCreate(post({ publishTiming: 'after_approval' }));
    await callCreate(post({ status: 'draft' }));
    await callCreate(post({ publishTiming: 'scheduled', scheduledAt: future() }));

    const result = await callList('?status=awaiting_approval');

    expect(result.status).toBe(200);
    expect(listOf(result).map((item) => item['id'])).toEqual([dataOf(awaiting)['id']]);
    expect(listOf(result).every((item) => item['status'] === 'awaiting_approval')).toBe(true);
  });

  it('#56 ?status=pending → 422 status', async () => {
    const result = await callList('?status=pending');

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('status');
  });
});
