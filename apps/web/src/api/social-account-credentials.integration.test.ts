import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as updateSocialAccountRoute } from '@/app/api/v1/social/accounts/[id]/route';
import { POST as createSocialAccountRoute } from '@/app/api/v1/social/accounts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { readSocialCredential } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * SNS アカウント API の `credentials`（035-social-publishing 設計 §6.4）。
 *
 * 受け入れ条件 #39、#40、#41。
 *
 * **応答は変えない。** `credentialConfigured` だけを返し、
 * どのキーが設定されているかも返さない（`05_API設計.md` §18）。
 */

const BASE = 'http://127.0.0.1:3000/api/v1/social/accounts';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
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
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'social account credentials test',
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
    loginId: `a${suffix}`,
    displayName: 'social account credentials test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function publisherFor(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: 'bluesky',
    label: 'Bluesky（テスト）',
    credentialFields: [
      { key: 'identifier', label: 'ID', kind: 'text' },
      { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
    ],
    ...overrides,
  };
}

/** `credentialFields` を宣言した偽の publisher を登録する。 */
function registerBlueskyPublisher(): void {
  registerPublisher('test-plugin', publisherFor());
}

async function callCreate(body: unknown): Promise<JsonResult> {
  const response = await createSocialAccountRoute(
    new Request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${writeToken}` },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function callUpdate(id: string, body: unknown): Promise<JsonResult> {
  const response = await updateSocialAccountRoute(
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

function accountInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'bluesky',
    displayName: 'とりふね公式',
    handle: '@torifune',
    status: 'connected',
    ...overrides,
  };
}

/** DB に保存されている暗号文そのもの。 */
async function storedCredential(id: string): Promise<string | null> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select('credential')
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  return row?.credential ?? null;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialaccountcred');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const created = await createApiToken(admin, {
    name: 'credentials test',
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  writeToken = created.plaintext;
});

afterEach(async () => {
  resetPublisherRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#39 宣言どおりの credentials で登録する', () => {
  it('#39 宣言を満たす credentials なら 201', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b' } }),
    );

    expect(result.status).toBe(201);
  });

  it('#39 応答のキー集合が現行と同じ', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b' } }),
    );

    expect(Object.keys(dataOf(result)).sort()).toEqual(
      [
        'createdAt',
        'credentialConfigured',
        'displayName',
        'handle',
        'id',
        'provider',
        'status',
        'updatedAt',
      ].sort(),
    );
  });

  it('#39 credentialConfigured が true になる', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b' } }),
    );

    expect(dataOf(result)['credentialConfigured']).toBe(true);
  });

  it('#39 DB の credential は暗号化されている', async () => {
    registerBlueskyPublisher();
    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b' } }),
    );

    const stored = await storedCredential(String(dataOf(result)['id']));

    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('appPassword');
  });

  it('#39 復号すると JSON オブジェクトとして取り出せる', async () => {
    // 保存形式は「暗号化した 1 つの文字列」のまま（設計 §5.7）。
    registerBlueskyPublisher();
    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b' } }),
    );

    const secret = await readSocialCredential(admin, { id: String(dataOf(result)['id']) });

    expect(JSON.parse(secret?.expose() ?? 'null')).toEqual({ identifier: 'a', appPassword: 'b' });
  });

  it('#39 応答本文に資格情報の値が出ない', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'secret-app-password' } }),
    );

    expect(JSON.stringify(result.body)).not.toContain('secret-app-password');
  });
});

describe('#40 credentials の 422 と、publisher が無いときの扱い', () => {
  it('#40 宣言された項目が足りなければ 422 credentials', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(accountInput({ credentials: { identifier: 'a' } }));

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('credentials');
  });

  it('#40 不足の文言に足りないキー名が入る', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(accountInput({ credentials: { identifier: 'a' } }));

    expect(detailsOf(result)['credentials']?.join('\n')).toContain('appPassword');
  });

  it('#40 宣言に無いキーは 422 credentials', async () => {
    // 打ち間違いを黙って保存しない。
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b', extra: 'x' } }),
    );

    expect(result.status).toBe(422);
    expect(detailsOf(result)['credentials']?.join('\n')).toContain('extra');
  });

  it('#40 credential と credentials の両方を指定すると 422 credentials', async () => {
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({
        credential: 'plain-token',
        credentials: { identifier: 'a', appPassword: 'b' },
      }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('credentials');
  });

  it('#40 JSON にして 4097 文字なら 422 credentials', async () => {
    // `{"identifier":"a","appPassword":"<b...>"}` の長さで 4097 に合わせる。
    const fixed = JSON.stringify({ identifier: 'a', appPassword: '' }).length;
    registerBlueskyPublisher();

    const result = await callCreate(
      accountInput({
        credentials: { identifier: 'a', appPassword: 'b'.repeat(4097 - fixed) },
      }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('credentials');
  });

  it('#40 publisher の無い provider には、そのまま保存して 201', async () => {
    // Plugin が後から入っても、キーが合えば使える（設計 §6.4）。
    const result = await callCreate(
      accountInput({ provider: 'mastodon', credentials: { any: 'x' } }),
    );

    expect(result.status).toBe(201);
  });

  it('#40 publisher の無い provider でも JSON 文字列として暗号化される', async () => {
    const result = await callCreate(
      accountInput({ provider: 'mastodon', credentials: { any: 'x' } }),
    );

    const secret = await readSocialCredential(admin, { id: String(dataOf(result)['id']) });

    expect(JSON.parse(secret?.expose() ?? 'null')).toEqual({ any: 'x' });
  });

  it('#40 credentials の値に文字列でないものがあれば 422 credentials', async () => {
    const result = await callCreate(
      accountInput({ provider: 'mastodon', credentials: { any: 1 } }),
    );

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('credentials');
  });
});

describe('#41 PATCH の credentials', () => {
  async function makeAccount(): Promise<string> {
    registerBlueskyPublisher();
    const result = await callCreate(
      accountInput({ credentials: { identifier: 'a', appPassword: 'b' } }),
    );
    return String(dataOf(result)['id']);
  }

  it('#41 credentials を送ると更新される', async () => {
    const id = await makeAccount();

    const result = await callUpdate(id, {
      credentials: { identifier: 'a2', appPassword: 'b2' },
    });

    expect(result.status).toBe(200);
    const secret = await readSocialCredential(admin, { id });
    expect(JSON.parse(secret?.expose() ?? 'null')).toEqual({ identifier: 'a2', appPassword: 'b2' });
  });

  it('#41 credentials を省略すると既存が残る', async () => {
    // 区別しないと、表示名だけ直したつもりで資格情報が消える。
    const id = await makeAccount();

    await callUpdate(id, { displayName: '新しい名前' });

    const secret = await readSocialCredential(admin, { id });
    expect(JSON.parse(secret?.expose() ?? 'null')).toEqual({ identifier: 'a', appPassword: 'b' });
  });

  it('#41 credentials に空のオブジェクトを送ると消える', async () => {
    const id = await makeAccount();

    const result = await callUpdate(id, { credentials: {} });

    expect(result.status).toBe(200);
    expect(dataOf(result)['credentialConfigured']).toBe(false);
  });

  it('#41 消した後は資格情報を読み出せない', async () => {
    const id = await makeAccount();

    await callUpdate(id, { credentials: {} });

    expect(await readSocialCredential(admin, { id })).toBeNull();
  });

  it('#41 credentials の値が数値なら 422 credentials', async () => {
    const id = await makeAccount();

    const result = await callUpdate(id, { credentials: { identifier: 'a', appPassword: 2 } });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('credentials');
  });

  it('#41 credential と credentials の両方を送ると 422 credentials', async () => {
    const id = await makeAccount();

    const result = await callUpdate(id, {
      credential: 'plain',
      credentials: { identifier: 'a', appPassword: 'b' },
    });

    expect(result.status).toBe(422);
    expect(Object.keys(detailsOf(result))).toContain('credentials');
  });
});

describe('認証と認可', () => {
  it('scope が social.read だけの Token では登録できない（403）', async () => {
    const readOnly = await createApiToken(admin, {
      name: 'read only',
      scopes: ['social.read'],
      expiresAt: null,
    });
    const response = await createSocialAccountRoute(
      new Request(BASE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${readOnly.plaintext}`,
        },
        body: JSON.stringify(accountInput({ credentials: { any: 'x' } })),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('未認証なら 401', async () => {
    const csrf = 'csrf-token-for-social-accounts';
    const response = await createSocialAccountRoute(
      new Request(BASE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-host': '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          cookie: `torifune_csrf=${csrf}`,
          'x-csrf-token': csrf,
        },
        body: JSON.stringify(accountInput({ credentials: { any: 'x' } })),
      }),
    );

    expect(response.status).toBe(401);
  });
});
