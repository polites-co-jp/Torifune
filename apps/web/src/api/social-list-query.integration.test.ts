import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listSocialAccountsRoute } from '@/app/api/v1/social/accounts/route';
import { GET as listSocialPostsRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `GET /api/v1/social/posts`・`GET /api/v1/social/accounts` のクエリ
 * （042-social-api-input-fixes 設計 §6.2・§6.3・§8）。
 *
 * - `page` / `perPage`（受け入れ条件 #18〜#24）：範囲外は 422 にせず丸め、`meta` に丸めた値が返る
 * - `accountId`（受け入れ条件 #28〜#31）：UUID の形でなければ（空文字も）422 `accountId`。
 *   UUID の形で存在しなければ 200 で空。**認可は検査より先**（401・403 が 422 より先に返る）
 *
 * **ルートを直接叩く結合テスト。** 認証は Bearer の API Token。
 * 投稿とアカウントは UseCase で作る（publisher の無い provider の `auto`・`draft` は登録できる）。
 * `meta.total` を数えるので、`afterEach` で投稿とアカウントを消す。
 */

const POSTS_URL = 'http://127.0.0.1:3000/api/v1/social/posts';
const ACCOUNTS_URL = 'http://127.0.0.1:3000/api/v1/social/accounts';

/** publisher を登録していない provider（登録簿に無くても `auto`・`draft` なら登録できる）。 */
const PROVIDER = 'x';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let readToken: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface PageMeta {
  readonly page: number;
  readonly perPage: number;
  readonly total: number;
}

function dataOf(result: JsonResult): readonly Record<string, unknown>[] {
  return result.body['data'] as readonly Record<string, unknown>[];
}

function metaOf(result: JsonResult): PageMeta {
  return result.body['meta'] as PageMeta;
}

function errorOf(result: JsonResult): {
  readonly code?: string;
  readonly details?: Record<string, readonly string[]>;
} {
  return (result.body['error'] ?? {}) as {
    readonly code?: string;
    readonly details?: Record<string, readonly string[]>;
  };
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `q${suffix}`,
        email: `q${suffix}@example.com`,
        display_name: 'social list query test',
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
    loginId: `q${suffix}`,
    displayName: 'social list query test',
    email: `q${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function call(
  route: typeof listSocialPostsRoute,
  url: string,
  token: string | null,
): Promise<JsonResult> {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const response = await route(new Request(url, { method: 'GET', headers }));
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function listPosts(query: string, token: string | null = readToken): Promise<JsonResult> {
  return call(listSocialPostsRoute, `${POSTS_URL}${query}`, token);
}

function listAccounts(query: string, token: string | null = readToken): Promise<JsonResult> {
  return call(listSocialAccountsRoute, `${ACCOUNTS_URL}${query}`, token);
}

async function makeAccount(label: string): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: `アカウント ${label}`,
    handle: `@list-${label}`,
    credential: null,
    status: 'connected',
  });
  return account.id;
}

async function makePost(accountId: string, body: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body,
    scheduledAt: null,
    status: 'draft',
  });
  return post.id;
}

/** アカウント 1 つに投稿を 3 件作る。 */
async function threePosts(): Promise<string> {
  const accountId = await makeAccount('posts');
  for (const label of ['1', '2', '3']) {
    await makePost(accountId, `投稿 ${label}`);
  }
  return accountId;
}

/** アカウントを 3 件作る。 */
async function threeAccounts(): Promise<void> {
  for (const label of ['a', 'b', 'c']) {
    await makeAccount(label);
  }
}

beforeAll(async () => {
  scratch = await useScratchDatabase('sociallistquery');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const created = await createApiToken(admin, {
    name: 'list query test',
    scopes: ['social.read'],
    expiresAt: null,
  });
  readToken = created.plaintext;
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

/* -------------------------------------------------------------------------- */
/* #18〜#23 GET /social/posts の page / perPage                                  */
/* -------------------------------------------------------------------------- */

describe('#18 GET /social/posts?perPage=-1 は 1 に丸める', () => {
  it('#18 200、data が 1 件、meta.perPage === 1、meta.total === 3', async () => {
    await threePosts();

    const result = await listPosts('?perPage=-1');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toHaveLength(1);
    expect(metaOf(result).perPage).toBe(1);
    expect(metaOf(result).total).toBe(3);
  });
});

describe('#19 GET /social/posts?page=0&perPage=2 は page を 1 に丸める', () => {
  it('#19 200、meta.page === 1、data が 2 件', async () => {
    await threePosts();

    const result = await listPosts('?page=0&perPage=2');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).page).toBe(1);
    expect(dataOf(result)).toHaveLength(2);
  });
});

describe('#20 GET /social/posts?perPage=0 は 1 に丸める', () => {
  it('#20 200、data が 1 件、meta.perPage === 1', async () => {
    await threePosts();

    const result = await listPosts('?perPage=0');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toHaveLength(1);
    expect(metaOf(result).perPage).toBe(1);
  });
});

describe('#21 GET /social/posts?perPage=1000 は 100 に丸める', () => {
  it('#21 200、meta.perPage === 100', async () => {
    await threePosts();

    const result = await listPosts('?perPage=1000');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).perPage).toBe(100);
  });
});

describe('#22 GET /social/posts の最終ページより先は空', () => {
  it('#22 page=99&perPage=2 → 200、data が空、meta.total === 3', async () => {
    await threePosts();

    const result = await listPosts('?page=99&perPage=2');

    expect(result.status).toBe(200);
    expect(dataOf(result)).toEqual([]);
    expect(metaOf(result).total).toBe(3);
  });
});

describe('#23 GET /social/posts?perPage=abc は 422', () => {
  it('#23 422、details.perPage がある', async () => {
    await threePosts();

    const result = await listPosts('?perPage=abc');

    expect(result.status).toBe(422);
    expect(errorOf(result).details?.['perPage']).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #24 GET /social/accounts の page / perPage                                    */
/* -------------------------------------------------------------------------- */

describe('#24 GET /social/accounts でも page / perPage を丸める', () => {
  it('#24（#18）perPage=-1 → 200、data が 1 件、meta.perPage === 1、meta.total === 3', async () => {
    await threeAccounts();

    const result = await listAccounts('?perPage=-1');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toHaveLength(1);
    expect(metaOf(result).perPage).toBe(1);
    expect(metaOf(result).total).toBe(3);
  });

  it('#24（#19）page=0&perPage=2 → 200、meta.page === 1、data が 2 件', async () => {
    await threeAccounts();

    const result = await listAccounts('?page=0&perPage=2');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).page).toBe(1);
    expect(dataOf(result)).toHaveLength(2);
  });

  it('#24（#20）perPage=0 → 200、data が 1 件、meta.perPage === 1', async () => {
    await threeAccounts();

    const result = await listAccounts('?perPage=0');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toHaveLength(1);
    expect(metaOf(result).perPage).toBe(1);
  });

  it('#24（#21）perPage=1000 → 200、meta.perPage === 100', async () => {
    await threeAccounts();

    const result = await listAccounts('?perPage=1000');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).perPage).toBe(100);
  });

  it('#24（#23）perPage=abc → 422、details.perPage がある', async () => {
    await threeAccounts();

    const result = await listAccounts('?perPage=abc');

    expect(result.status).toBe(422);
    expect(errorOf(result).details?.['perPage']).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #28〜#31 GET /social/posts?accountId=                                         */
/* -------------------------------------------------------------------------- */

describe('#28 accountId を指定すればそのアカウントの投稿だけが返る', () => {
  async function twoAccounts(): Promise<{
    readonly a: string;
    readonly b: string;
    readonly postA: string;
  }> {
    const a = await makeAccount('a');
    const b = await makeAccount('b');
    const postA = await makePost(a, 'A の投稿');
    await makePost(b, 'B の投稿');
    return { a, b, postA };
  }

  it('#28 accountId=<A の id> → 200、meta.total === 1、A の投稿だけ', async () => {
    const { a, postA } = await twoAccounts();

    const result = await listPosts(`?accountId=${a}`);

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).total).toBe(1);
    expect(dataOf(result).map((post) => post['id'])).toEqual([postA]);
    expect(dataOf(result).every((post) => post['socialAccountId'] === a)).toBe(true);
  });

  it('#28 大文字にした A の id でも A の投稿だけ（UUID の形は大小文字を問わない）', async () => {
    const { a, postA } = await twoAccounts();

    const result = await listPosts(`?accountId=${a.toUpperCase()}`);

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result).map((post) => post['id'])).toEqual([postA]);
  });
});

describe('#29 UUID の形でない accountId は 422 accountId（絞り込みを黙って外さない）', () => {
  it('#29 accountId=abc → 422、details.accountId がある', async () => {
    await threePosts();

    const result = await listPosts('?accountId=abc');

    expect(result.status).toBe(422);
    expect(errorOf(result).details?.['accountId']).toBeDefined();
  });

  it('#29 accountId=（空文字）→ 422、details.accountId がある', async () => {
    await threePosts();

    const result = await listPosts('?accountId=');

    expect(result.status).toBe(422);
    expect(errorOf(result).details?.['accountId']).toBeDefined();
  });

  it('#29 422 の応答に投稿が 1 件も載らない（全件を返さない）', async () => {
    await threePosts();

    const result = await listPosts('?accountId=abc');

    expect(result.body['data']).toBeUndefined();
  });
});

describe('#30 UUID の形で存在しない accountId は 200 で空', () => {
  it('#30 200、data が空、meta.total === 0', async () => {
    await threePosts();

    const result = await listPosts(`?accountId=${uuidv7()}`);

    expect(result.status).toBe(200);
    expect(dataOf(result)).toEqual([]);
    expect(metaOf(result).total).toBe(0);
  });
});

describe('#31 認可は accountId の検査より先', () => {
  it('#31 social.read を持たない Token で accountId=abc → 403 FORBIDDEN', async () => {
    const other = await createApiToken(admin, {
      name: 'site read only',
      scopes: ['site.read'],
      expiresAt: null,
    });

    const result = await listPosts('?accountId=abc', other.plaintext);

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it('#31 認証なしで accountId=abc → 401 UNAUTHENTICATED', async () => {
    const result = await listPosts('?accountId=abc', null);

    expect(result.status).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it('#31 social.read を持つ Token なら同じ要求は 422（403・401 が値のせいでないことの対照）', async () => {
    const result = await listPosts('?accountId=abc');

    expect(result.status).toBe(422);
  });
});
