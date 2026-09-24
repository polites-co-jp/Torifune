import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as getSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `POST /api/v1/social/posts`（035-social-publishing 設計 §6.1）。
 *
 * 受け入れ条件 #19〜#30、#33。
 *
 * **ルートを直接叩く結合テスト**にしている（実装プラン §2「テストの方法」）。
 * 偽の publisher は `registerPublisher` でプロセス内へ登録するので、
 * テストプロセスと本体プロセスが分かれる Playwright では成立しない。
 * 形は `api/route-error-redaction.integration.test.ts` に倣う。
 *
 * **設計は 2026-09-23 に改訂されている（要件 §4 裁定 #8）。**
 * 「配信 Plugin が無い」「資格情報が未設定」は予約を断る理由にしない（#24 / #27）。
 * 422 で断るのは `deliveryMode: 'manual'` のときだけ（#23）。
 */

const ENDPOINT = 'http://127.0.0.1:3000/api/v1/social/posts';
const CSRF_TOKEN = 'csrf-token-for-social-post-create';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
/** `social.read` と `social.write` を持つ Token の平文。 */
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

function errorCodeOf(result: JsonResult): string {
  return (result.body['error'] as { readonly code?: string } | undefined)?.code ?? '';
}

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `c${suffix}`,
        email: `c${suffix}@example.com`,
        display_name: 'social post create test',
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
    loginId: `c${suffix}`,
    displayName: 'social post create test',
    email: `c${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** Bearer 認証用の Token を発行して平文を返す。 */
async function issueToken(
  owner: AuthorizationContext,
  scopes: readonly string[],
): Promise<{ readonly id: string; readonly plaintext: string }> {
  const created = await createApiToken(owner, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return { id: created.token.id, plaintext: created.plaintext };
}

/** 偽の publisher。**Plugin の読み込みを経ない**（設計 §10 冒頭）。 */
function publisherFor(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: 'x',
    label: 'X（テスト）',
    credentialFields: [],
    ...overrides,
  };
}

interface CallOptions {
  /** Bearer の平文。省略すると Authorization を付けない。 */
  readonly token?: string | undefined;
  /** セッション経路（Cookie）を模す。CSRF を通すためのヘッダを付ける。 */
  readonly browser?: boolean;
}

function requestFor(body: unknown, options: CallOptions): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  if (options.browser === true) {
    // Bearer が無い経路は CSRF を通らないと 403 になり、401 を確かめられない。
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = 'http://127.0.0.1:3000';
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
    headers['x-csrf-token'] = CSRF_TOKEN;
  }
  return new Request(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function callCreate(body: unknown, options: CallOptions = {}): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    requestFor(body, { ...options, token: options.token ?? writeToken }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** 追加項目を省略した、通るだけの要求。 */
function minimalPost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { socialAccountId: accountId, body: 'こんにちは', ...overrides };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpostcreate');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: 'account-credential',
    status: 'connected',
  });
  accountId = account.id;
  writeToken = (await issueToken(admin, ['social.read', 'social.write'])).plaintext;
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    // FK の向きに従う。
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('偽の publisher とルートの前提', () => {
  /**
   * 実装プラン §7 リスク 4。
   *
   * ルートの先頭で `ensurePluginsStartedAnonymously()` を呼ぶようになるので、
   * **偽の publisher がそれで消えないこと**を先に固定する。
   * 消えるなら、以降のテストは `beforeEach` ではなく各 `it` の中で登録する
   * （この版はすでに各 `it` の中で登録している）。
   */
  it('ensurePluginsStartedAnonymously を通しても、登録した偽の publisher が残る', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ manual: () => ({ url: 'https://x.com/intent/post' }) }),
    );

    await ensurePluginsStartedAnonymously();

    // 消えていれば「手動投稿に対応していません」で 422 になる。
    const result = await callCreate(minimalPost({ deliveryMode: 'manual' }));

    expect(result.status).toBe(201);
  });
});

describe('#19 追加項目を省略した作成', () => {
  it('#19 追加項目を省略しても 201 で作成できる', async () => {
    const result = await callCreate(minimalPost());

    expect(result.status).toBe(201);
  });

  it('#19 追加項目の既定値が応答に入る', async () => {
    const result = await callCreate(minimalPost());

    expect(dataOf(result)).toMatchObject({
      deliveryMode: 'auto',
      media: [],
      link: null,
      providerOptions: {},
      externalRef: null,
      externalId: null,
      externalUrl: null,
      attemptCount: 0,
      nextAttemptAt: null,
    });
  });

  it('#19 既存の項目はそのまま返る', async () => {
    const result = await callCreate(minimalPost());

    expect(dataOf(result)).toMatchObject({
      socialAccountId: accountId,
      body: 'こんにちは',
      scheduledAt: null,
      status: 'draft',
      publishedAt: null,
      failedAt: null,
      failureReason: null,
    });
  });

  it('#19 応答に publishStartedAt と createdByTokenId を出さない', async () => {
    // 前者は内部の進行状態、後者は他の外部アプリの Token ID（設計 §6.1.4）。
    //
    // **2026-09-23 に `skipCount` / `skipReason` が増えた**（裁定 #15-a、条件 #118）。
    // 出さないと運用者が「あと何回で取りやめか」を知れないまま予約し直す（設計 §11 #24）。
    // **増えただけで、出さないと決めた 2 つはそのまま出ない。**
    const result = await callCreate(minimalPost());

    expect(Object.keys(dataOf(result)).sort()).toEqual(
      [
        'attemptCount',
        'body',
        'createdAt',
        'deliveryMode',
        'externalId',
        'externalRef',
        'externalUrl',
        'failedAt',
        'failureReason',
        'id',
        'link',
        'media',
        'nextAttemptAt',
        'providerOptions',
        'publishedAt',
        'scheduledAt',
        'skipCount',
        'skipReason',
        'socialAccountId',
        'status',
        'updatedAt',
      ].sort(),
    );
  });
});

describe('#20 media・link・providerOptions', () => {
  it('#20 送った media・link・providerOptions がそのまま返る', async () => {
    const result = await callCreate(
      minimalPost({
        media: [{ url: 'https://cdn.example.com/a.png', alt: 'a' }],
        link: 'https://example.com/lp',
        providerOptions: { replyTo: '1' },
      }),
    );

    expect(result.status).toBe(201);
    expect(dataOf(result)).toMatchObject({
      media: [{ url: 'https://cdn.example.com/a.png', alt: 'a' }],
      link: 'https://example.com/lp',
      providerOptions: { replyTo: '1' },
    });
  });

  it('#20 media の alt を省略すると alt が null で返る', async () => {
    const result = await callCreate(
      minimalPost({ media: [{ url: 'https://cdn.example.com/a.png' }] }),
    );

    expect(dataOf(result)['media']).toEqual([{ url: 'https://cdn.example.com/a.png', alt: null }]);
  });
});

describe('#21 形の検証（422 と details のキー）', () => {
  it('#21 media が 11 件なら 422 で details のキーが media', async () => {
    const media = Array.from({ length: 11 }, (_, index) => ({
      url: `https://cdn.example.com/${index}.png`,
    }));

    const result = await callCreate(minimalPost({ media }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });

  it('#21 media の url が http なら 422 で details のキーが media', async () => {
    const result = await callCreate(
      minimalPost({ media: [{ url: 'http://cdn.example.com/a.png' }] }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });

  it('#21 link が http なら 422 で details のキーが link', async () => {
    const result = await callCreate(minimalPost({ link: 'http://example.com/lp' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('link');
  });

  it('#21 providerOptions が JSON で 4097 バイトなら 422 で details のキーが providerOptions', async () => {
    // `{"k":"<a...>"}` は 8 + N バイト。N = 4089 で 4097 になる。
    const providerOptions = { k: 'a'.repeat(4089) };
    expect(JSON.stringify(providerOptions)).toHaveLength(4097);

    const result = await callCreate(minimalPost({ providerOptions }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('providerOptions');
  });

  it('#21 externalRef が空文字なら 422 で details のキーが externalRef', async () => {
    const result = await callCreate(minimalPost({ externalRef: '' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('externalRef');
  });

  it('#21 externalRef が 201 文字なら 422 で details のキーが externalRef', async () => {
    const result = await callCreate(minimalPost({ externalRef: 'r'.repeat(201) }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('externalRef');
  });

  it('#21 externalRef が 200 文字なら通る（境界）', async () => {
    const result = await callCreate(minimalPost({ externalRef: 'r'.repeat(200) }));

    expect(result.status).toBe(201);
  });

  it('#21 deliveryMode が列挙に無い値なら 422 で details のキーが deliveryMode', async () => {
    const result = await callCreate(minimalPost({ deliveryMode: 'later' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('deliveryMode');
  });
});

describe('#22 scheduled には予約日時が要る', () => {
  it('#22 status が scheduled で scheduledAt が無ければ 422 scheduledAt', async () => {
    const result = await callCreate(minimalPost({ status: 'scheduled' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('scheduledAt');
  });

  it('#22 status が draft なら scheduledAt が無くても 201', async () => {
    const result = await callCreate(minimalPost({ status: 'draft' }));

    expect(result.status).toBe(201);
  });

  it('#22 status が scheduled でも scheduledAt があれば 201', async () => {
    const result = await callCreate(
      minimalPost({
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    expect(result.status).toBe(201);
  });
});

describe('#23 手動投稿の制約', () => {
  it('#23 publisher の無い provider に manual を指定すると 422 deliveryMode', async () => {
    // 手動投稿は publisher の `manual()` からしか投稿画面の URL を得られない。
    // 待てば整うものではないので、ここだけは断る（設計 §6.1.2）。
    const result = await callCreate(minimalPost({ deliveryMode: 'manual' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('deliveryMode');
  });

  it('#23 manual を実装していない publisher の provider は 422 deliveryMode', async () => {
    registerPublisher('test-plugin', publisherFor({ publish: async () => ({ ok: true }) }));

    const result = await callCreate(minimalPost({ deliveryMode: 'manual' }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('deliveryMode');
  });

  it('#23 manual に対応した provider でも media を添えると 422 media', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ manual: () => ({ url: 'https://x.com/intent/post' }) }),
    );

    const result = await callCreate(
      minimalPost({
        deliveryMode: 'manual',
        media: [{ url: 'https://cdn.example.com/a.png' }],
      }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });

  it('#23 manual に対応した provider へ media 無しなら 201', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ manual: () => ({ url: 'https://x.com/intent/post' }) }),
    );

    const result = await callCreate(minimalPost({ deliveryMode: 'manual' }));

    expect(result.status).toBe(201);
  });
});

describe('#24 配信 Plugin が無くても予約を断らない（要件 §4 裁定 #8）', () => {
  it('#24 publisher の無い provider に auto + scheduled でも 201', async () => {
    // 422 で断ると、Plugin を 1 つも入れていない素の Torifune で
    // SNS の予約機能そのものが使えなくなる（設計 §6.1.2 の注記）。
    const result = await callCreate(
      minimalPost({
        deliveryMode: 'auto',
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    expect(result.status).toBe(201);
  });

  it('#24 publisher の無い provider に auto + draft でも 201', async () => {
    const result = await callCreate(minimalPost({ deliveryMode: 'auto', status: 'draft' }));

    expect(result.status).toBe(201);
  });

  // 検証レポート §4 の 6。もとの名前（「断られた予約は…」）は、内容
  // （**断られずに**保存される）と逆の意味に読めた。挙動は変えていない。
  it('#24 断られなかった予約は保存され、状態は scheduled のまま', async () => {
    const result = await callCreate(
      minimalPost({
        status: 'scheduled',
        scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    expect(dataOf(result)['status']).toBe('scheduled');
  });
});

describe('#25 publisher の limits', () => {
  it('#25 bodyMaxLength を超える本文は 422 body', async () => {
    registerPublisher('test-plugin', publisherFor({ limits: { bodyMaxLength: 280 } }));

    const result = await callCreate(minimalPost({ body: 'a'.repeat(281) }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('body');
  });

  it('#25 bodyMaxLength ちょうどの本文は 201（境界）', async () => {
    registerPublisher('test-plugin', publisherFor({ limits: { bodyMaxLength: 280 } }));

    const result = await callCreate(minimalPost({ body: 'a'.repeat(280) }));

    expect(result.status).toBe(201);
  });

  it('#25 limits は draft でも掛かる', async () => {
    // 「配信時刻に初めて失敗する」を減らすのが目的なので、下書きでも弾く。
    registerPublisher('test-plugin', publisherFor({ limits: { bodyMaxLength: 280 } }));

    const result = await callCreate(minimalPost({ body: 'a'.repeat(281), status: 'draft' }));

    expect(result.status).toBe(422);
  });

  it('#25 mediaMax を超える媒体は 422 media', async () => {
    registerPublisher('test-plugin', publisherFor({ limits: { mediaMax: 4 } }));
    const media = Array.from({ length: 5 }, (_, index) => ({
      url: `https://cdn.example.com/${index}.png`,
    }));

    const result = await callCreate(minimalPost({ media }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });

  it('#25 mediaRequired の provider へ auto で媒体無しは 422 media', async () => {
    registerPublisher('test-plugin', publisherFor({ limits: { mediaRequired: true } }));

    const result = await callCreate(minimalPost({ deliveryMode: 'auto', media: [] }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('media');
  });

  it('#25 mediaRequired でも manual なら media では弾かれない', async () => {
    // 手動投稿は媒体を持てない（検査 f）ので、mediaRequired を掛けない。
    registerPublisher(
      'test-plugin',
      publisherFor({
        limits: { mediaRequired: true },
        manual: () => ({ url: 'https://x.com/intent/post' }),
      }),
    );

    const result = await callCreate(minimalPost({ deliveryMode: 'manual', media: [] }));

    expect(result.status).toBe(201);
  });

  it('#25 mediaRequired かつ manual 未対応なら media ではなく deliveryMode で断る', async () => {
    registerPublisher('test-plugin', publisherFor({ limits: { mediaRequired: true } }));

    const result = await callCreate(minimalPost({ deliveryMode: 'manual', media: [] }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toEqual(['deliveryMode']);
  });
});

describe('#26 publisher の validate()', () => {
  it('#26 validate が返した複数のフィールドが details に載る', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({
        validate: () => [
          { field: 'providerOptions.replyTo', message: 'm1' },
          { field: 'body', message: 'm2' },
        ],
      }),
    );

    const result = await callCreate(minimalPost());

    expect(result.status).toBe(422);
    expect(detailsOf(result)['providerOptions.replyTo']).toContain('m1');
    expect(detailsOf(result)['body']).toContain('m2');
  });

  it('#26 形式に合わない field は providerOptions に丸められる', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ validate: () => [{ field: 'bad field!', message: 'm3' }] }),
    );

    const result = await callCreate(minimalPost());

    expect(result.status).toBe(422);
    expect(detailsOf(result)['providerOptions']).toContain('m3');
    expect(Object.keys(detailsOf(result))).not.toContain('bad field!');
  });

  it('#26 validate が例外を投げたら 500 INTERNAL_ERROR', async () => {
    capture();
    registerPublisher(
      'test-plugin',
      publisherFor({
        validate: () => {
          throw new Error('plugin exploded with secret-detail');
        },
      }),
    );

    const result = await callCreate(minimalPost());

    expect(result.status).toBe(500);
    expect(errorCodeOf(result)).toBe('INTERNAL_ERROR');
  });

  it('#26 validate の例外の内容が応答本文に出ない', async () => {
    capture();
    registerPublisher(
      'test-plugin',
      publisherFor({
        validate: () => {
          throw new Error('plugin exploded with secret-detail');
        },
      }),
    );

    const result = await callCreate(minimalPost());

    expect(JSON.stringify(result.body)).not.toContain('secret-detail');
  });

  it('#26 validate が Promise を返しても扱える', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ validate: async () => [{ field: 'body', message: 'm4' }] }),
    );

    const result = await callCreate(minimalPost());

    expect(result.status).toBe(422);
    expect(detailsOf(result)['body']).toContain('m4');
  });

  it('#26 validate が空配列を返せば通る', async () => {
    registerPublisher('test-plugin', publisherFor({ validate: () => [] }));

    const result = await callCreate(minimalPost());

    expect(result.status).toBe(201);
  });
});

describe('#27 資格情報が未設定でも予約を断らない（要件 §4 裁定 #8）', () => {
  async function accountWithoutCredential(): Promise<string> {
    const account = await createSocialAccount(admin, {
      provider: 'bluesky',
      displayName: '資格情報なし',
      handle: '@nocred',
      credential: null,
      status: 'disconnected',
    });
    return account.id;
  }

  it('#27 credentialFields があり資格情報が未設定でも auto + scheduled は 201', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({
        provider: 'bluesky',
        label: 'Bluesky（テスト）',
        credentialFields: [
          { key: 'identifier', label: 'ID', kind: 'text' },
          { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
        ],
        publish: async () => ({ ok: true }),
      }),
    );
    const id = await accountWithoutCredential();

    const result = await callCreate({
      socialAccountId: id,
      body: 'こんにちは',
      deliveryMode: 'auto',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(result.status).toBe(201);
  });

  it('#27 credentialFields が空の publisher でも 201', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({
        provider: 'bluesky',
        label: 'Bluesky（テスト）',
        credentialFields: [],
        publish: async () => ({ ok: true }),
      }),
    );
    const id = await accountWithoutCredential();

    const result = await callCreate({
      socialAccountId: id,
      body: 'こんにちは',
      deliveryMode: 'auto',
      status: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(result.status).toBe(201);
  });
});

describe('#28 同じ externalRef の再送は冪等', () => {
  it('#28 1 回目は 201、2 回目は 200 になる', async () => {
    const first = await callCreate(minimalPost({ externalRef: 'r1' }));
    const second = await callCreate(minimalPost({ externalRef: 'r1' }));

    expect([first.status, second.status]).toEqual([201, 200]);
  });

  it('#28 再送でも同じ id が返る', async () => {
    const first = await callCreate(minimalPost({ externalRef: 'r1' }));
    const second = await callCreate(minimalPost({ externalRef: 'r1' }));

    expect(dataOf(second)['id']).toBe(dataOf(first)['id']);
  });

  it('#28 再送で本文を変えても保存された本文は 1 回目のまま', async () => {
    // 冪等キーの意味は「同じ登録要求の再送」。内容を変えたいなら PATCH（設計 §6.1.3）。
    await callCreate(minimalPost({ externalRef: 'r1', body: '最初の本文' }));

    const second = await callCreate(minimalPost({ externalRef: 'r1', body: '違う本文' }));

    expect(dataOf(second)['body']).toBe('最初の本文');
  });

  it('#28 social.post.created は作成したときだけ発火する', async () => {
    const received: unknown[] = [];
    subscribe('social.post.created', (payload) => {
      received.push(payload);
    });

    await callCreate(minimalPost({ externalRef: 'r1' }));
    await callCreate(minimalPost({ externalRef: 'r1' }));

    expect(received).toHaveLength(1);
  });

  it('#28 監査ログには再送も記録され、2 行目の detail.replayed が true', async () => {
    await callCreate(minimalPost({ externalRef: 'r1' }));
    await callCreate(minimalPost({ externalRef: 'r1' }));

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

    expect(rows).toHaveLength(2);
    expect(rows[0]?.detail['replayed']).toBe(false);
    expect(rows[1]?.detail['replayed']).toBe(true);
  });

  it('#28 再送でも行は 1 つしか増えない', async () => {
    await callCreate(minimalPost({ externalRef: 'r1' }));
    await callCreate(minimalPost({ externalRef: 'r1' }));

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('social_posts').select('id').execute(),
    );

    expect(rows).toHaveLength(1);
  });
});

describe('#30 Token を差し替えても他の外部アプリの投稿に届かない', () => {
  it('#30 別の Token が同じ externalRef を送ると別の投稿になる', async () => {
    // 冪等キーの名前空間は Token ごと。またぐと、別の外部アプリの登録を
    // 「再送」として横取りできてしまう。
    const other = await contextFor(['administrator']);
    const tokenB = (await issueToken(other, ['social.read', 'social.write'])).plaintext;

    const fromA = await callCreate(minimalPost({ externalRef: 'r1' }));
    const fromB = await callCreate(minimalPost({ externalRef: 'r1' }), { token: tokenB });

    expect(fromB.status).toBe(201);
    expect(dataOf(fromB)['id']).not.toBe(dataOf(fromA)['id']);
  });

  it('#30 投稿そのものは social.read を持つ別の Token から読める', async () => {
    // 投稿は利用者単位のデータではない（設計 §10 #30）。現行どおり。
    const other = await contextFor(['administrator']);
    const tokenB = (await issueToken(other, ['social.read'])).plaintext;
    const created = await callCreate(minimalPost({ externalRef: 'r1' }));
    const id = String(dataOf(created)['id']);

    const response = await getSocialPostRoute(
      new Request(`${ENDPOINT}/${id}`, { headers: { authorization: `Bearer ${tokenB}` } }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(200);
  });

  it('#30 social.read を持たない Token では読めない', async () => {
    const other = await contextFor(['administrator']);
    const tokenB = (await issueToken(other, ['site.read'])).plaintext;
    const created = await callCreate(minimalPost());
    const id = String(dataOf(created)['id']);

    const response = await getSocialPostRoute(
      new Request(`${ENDPOINT}/${id}`, { headers: { authorization: `Bearer ${tokenB}` } }),
      { params: Promise.resolve({ id }) },
    );

    expect(response.status).toBe(403);
  });
});

describe('#33 認証と認可', () => {
  it('#33 social.write を持つ Token なら 201', async () => {
    const result = await callCreate(minimalPost());

    expect(result.status).toBe(201);
  });

  it('#33 scope が social.read だけの Token は 403', async () => {
    const readOnly = (await issueToken(admin, ['social.read'])).plaintext;

    const result = await callCreate(minimalPost(), { token: readOnly });

    expect(result.status).toBe(403);
  });

  it('#33 失効した Token は 401', async () => {
    const issued = await issueToken(admin, ['social.read', 'social.write']);
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('api_tokens')
        .set({ revoked_at: new Date() })
        .where('id', '=', issued.id)
        .execute();
    });

    const result = await callCreate(minimalPost(), { token: issued.plaintext });

    expect(result.status).toBe(401);
  });

  it('#33 未認証（Authorization も セッションも無い）は 401', async () => {
    const response = await createSocialPostRoute(requestFor(minimalPost(), { browser: true }));

    expect(response.status).toBe(401);
  });
});

/**
 * #114。**登録の 422 本文も秘匿を通る**（設計 §6.1.2。3 回目の検証、裁定 #13-b の低-A）。
 *
 * `checkPublisherLimits` が返す `message`（`label` を埋め込む）と `validate()` の
 * `problem.message` / `problem.field` は**すべて Plugin が書いた文字列**で、
 * `ValidationError` の `detail` / `details` から**そのまま応答本文へ出る**。
 * `api/route.ts` は `ValidationError` を写すだけで秘匿を掛けない。
 *
 * 配信直前の再検査（#111）は同じ文字列を `redactSecrets` に通してから `failure_reason` へ書いており、
 * 設計 §6.5.2.2 は「**経路によって差を作らない**」と宣言している。
 * **DB とログに書くときだけ伏せて、要求元へ返すときは伏せない、では秘匿になっていない。**
 *
 * **秘匿の形は `redactSecrets` が実際に落とせるものに合わせる**（#111 と同じ流儀。
 * `scheme://user:password@host` の credential 部だけを落とす。DB 名は `torifune` にしない）。
 */
describe('#114 登録の 422 本文も秘匿を通る', () => {
  /** Plugin が書いた自由文に紛れ込んだ資格情報。 */
  const LIVE_TOKEN = 'sk-livetoken-xyz';
  const LEAKY_LABEL = `postgresql://plugin:${LIVE_TOKEN}@db.internal:5432/appdb`;
  const REDACTED = 'postgresql://***@db.internal:5432/appdb';

  /** 応答の全体（`message` も `details` も含む）を 1 本の文字列で見る。 */
  function bodyTextOf(result: JsonResult): string {
    return JSON.stringify(result.body);
  }

  async function limitsResult(): Promise<JsonResult> {
    // **登録簿を空にしてから登録する**（#111 と同じ理由。同じ `it` の中で 2 回呼ぶと
    // 先に登録したほうが勝ち、後から渡した宣言が効かない）。
    resetPublisherRegistry();
    registerPublisher(
      'test-plugin',
      publisherFor({ label: LEAKY_LABEL, limits: { bodyMaxLength: 10 } }),
    );
    return callCreate(minimalPost({ body: 'あ'.repeat(50) }));
  }

  async function validateResult(): Promise<JsonResult> {
    resetPublisherRegistry();
    registerPublisher(
      'test-plugin',
      publisherFor({
        label: LEAKY_LABEL,
        validate: () => [{ field: 'body', message: `接続に失敗しました: ${LEAKY_LABEL}` }],
      }),
    );
    return callCreate(minimalPost());
  }

  it('#114 limits 経路の 422 に生の値が出ない', async () => {
    const result = await limitsResult();

    expect(result.status).toBe(422);
    expect(bodyTextOf(result), 'Plugin の label がそのまま応答に出ている').not.toContain(
      LIVE_TOKEN,
    );
  });

  it('#114 limits 経路の 422 が伏せ字になっている', async () => {
    expect(bodyTextOf(await limitsResult())).toContain(REDACTED);
  });

  it('#114 validate() 経路の 422 にも生の値が出ない', async () => {
    const result = await validateResult();

    expect(result.status).toBe(422);
    expect(bodyTextOf(result)).not.toContain(LIVE_TOKEN);
  });

  /** #114 の要。**経路によって差が無い**（#111 の 422 版）。 */
  it('#114 limits 経路と validate() 経路で同じ形に伏せられる', async () => {
    expect(bodyTextOf(await limitsResult())).toContain(REDACTED);
    expect(bodyTextOf(await validateResult())).toContain(REDACTED);
  });

  it('#114 伏せてもどのフィールドが問題かは変わらない', async () => {
    // 秘匿を足したことで `details` のキーが壊れていない。
    expect(Object.keys(detailsOf(await limitsResult()))).toContain('body');
    expect(Object.keys(detailsOf(await validateResult()))).toContain('body');
  });
});

/* -------------------------------------------------------------------------- */
/* 046 の 2 回目の検証の指摘 N2・I2                                                */
/* -------------------------------------------------------------------------- */

/** 本文を JSON の文字列のまま送る（`JSON.stringify` で書けない深さの入れ子を送るため）。 */
async function callCreateRaw(rawJson: string): Promise<JsonResult> {
  const response = await createSocialPostRoute(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: rawJson,
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** `JSON.stringify` が書けない深さ（この環境で約 4,800 段）を十分に超える。 */
const DEEP = 10_000;
const PROVIDER_OPTIONS_TOO_LARGE = 'JSON にして4096バイト以内にしてください。';

/** `providerOptions` に 1 万段の入れ子を入れた本文（JSON の文字列）。 */
function postWithDeepProviderOptions(shape: 'array' | 'object'): string {
  const nested =
    shape === 'array'
      ? `${'['.repeat(DEEP)}${']'.repeat(DEEP)}`
      : `${'{"a":'.repeat(DEEP)}1${'}'.repeat(DEEP)}`;
  const head = JSON.stringify(minimalPost()).slice(0, -1);
  return `${head},"providerOptions":{"k":${nested}}}`;
}

describe('N2 providerOptions の入れ子が深くても 500 にならず、大きさの 422', () => {
  it.each(['array', 'object'] as const)(
    'N2 providerOptions に 1 万段の入れ子（%s）→ 422、details.providerOptions が大きさの文言',
    async (shape) => {
      const result = await callCreateRaw(postWithDeepProviderOptions(shape));

      expect(result.status, JSON.stringify(result.body)).toBe(422);
      expect(errorCodeOf(result)).toBe('VALIDATION_ERROR');
      expect(detailsOf(result)['providerOptions']).toEqual([PROVIDER_OPTIONS_TOO_LARGE]);
    },
  );

  it.each(['array', 'object'] as const)(
    'N2 providerOptions に 1 万段の入れ子（%s）→ unhandled error in route のログが出ない',
    async (shape) => {
      const { records } = capture();

      await callCreateRaw(postWithDeepProviderOptions(shape));

      expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
    },
  );

  it('N2 対照：providerOptions に 4096 バイト以内の値 → 従来どおり作れる', async () => {
    registerPublisher('test-plugin', publisherFor({ validate: () => [] }));

    const result = await callCreate(minimalPost({ providerOptions: { k: [[['v']]] } }));

    expect(result.status).toBe(201);
  });
});

/**
 * 配信 Plugin の `validate()` が返す `field` は Plugin の文字列で、利用者が送った
 * `providerOptions` のキーをそのまま返すことがある。`Object.prototype` の名前でも 500 にしない。
 * `__proto__` は `field` の形（英字で始まる）に合わないので、従来どおり `providerOptions` に丸める。
 */
describe('I2 validate() の field が原型の名前でも 500 にならず 422', () => {
  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'I2 field が %s → 422、details がその名前 1 つだけ',
    async (field) => {
      registerPublisher(
        'test-plugin',
        publisherFor({ validate: () => [{ field, message: 'i2-message' }] }),
      );

      const result = await callCreate(minimalPost());

      expect(result.status, JSON.stringify(result.body)).toBe(422);
      expect(Object.entries(detailsOf(result))).toEqual([[field, ['i2-message']]]);
    },
  );

  it('I2 field が __proto__ → 422、従来どおり providerOptions に丸める', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ validate: () => [{ field: '__proto__', message: 'i2-proto' }] }),
    );

    const result = await callCreate(minimalPost());

    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(Object.entries(detailsOf(result))).toEqual([['providerOptions', ['i2-proto']]]);
  });

  it('I2 同じ原型の名前の field が 2 つ → 1 つのキーに 2 つの文言', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({
        validate: () => [
          { field: 'constructor', message: 'first' },
          { field: 'constructor', message: 'second' },
          { field: 'body', message: 'third' },
        ],
      }),
    );

    const result = await callCreate(minimalPost());

    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(Object.entries(detailsOf(result))).toEqual([
      ['constructor', ['first', 'second']],
      ['body', ['third']],
    ]);
  });

  it('I2 field が constructor → unhandled error in route のログが出ない', async () => {
    registerPublisher(
      'test-plugin',
      publisherFor({ validate: () => [{ field: 'constructor', message: 'i2-log' }] }),
    );
    const { records } = capture();

    await callCreate(minimalPost());

    expect(records.map((record) => record.message)).not.toContain('unhandled error in route');
  });
});
