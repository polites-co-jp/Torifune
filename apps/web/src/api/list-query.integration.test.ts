import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listCampaignsRoute } from '@/app/api/v1/campaigns/route';
import { GET as listSitesRoute } from '@/app/api/v1/sites/route';
import { GET as listUsersRoute } from '@/app/api/v1/users/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `GET /api/v1/sites`・`/users`・`/campaigns` のクエリ（043-api-input-fixes-rest 設計 §6.2・§6.3・§8）。
 *
 * - `page` / `perPage`（受け入れ条件 #3〜#10）：範囲外は 422 にせず丸め、`meta` に丸めた値が返る
 *
 * **ルートを直接叩く結合テスト**（`social-list-query.integration.test.ts` の形を写した）。
 * 認証は Bearer の API Token（`site.read`・`user.manage`・`campaign.read`）。
 * データは UseCase で作る（ユーザーだけは Token の持ち主と同じく行を直接入れる）。
 * `meta.total` を数えるので、`afterEach` で作ったものを消す。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const SITES_URL = `${ORIGIN}/api/v1/sites`;
const USERS_URL = `${ORIGIN}/api/v1/users`;
const CAMPAIGNS_URL = `${ORIGIN}/api/v1/campaigns`;

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

/** ロールを付けた利用者を行として作る。 */
async function insertUser(roleNames: readonly string[]): Promise<UserIdentity> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `l${suffix}`,
        email: `l${suffix}@example.com`,
        display_name: 'list query test',
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

  return {
    userId: id,
    loginId: `l${suffix}`,
    displayName: 'list query test',
    email: `l${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const identity = await insertUser(roleNames);
  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

type ListRoute = (request: Request) => Promise<Response>;

async function call(route: ListRoute, url: string, token: string | null): Promise<JsonResult> {
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

async function makeSite(label: string): Promise<string> {
  const site = await createSite(admin, {
    name: `サイト ${label}`,
    url: `https://${label}.example.com`,
    description: '',
    status: 'active',
  });
  return site.id;
}

async function makeCampaign(label: string, siteIds: readonly string[] = []): Promise<string> {
  const campaign = await createCampaign(admin, {
    name: `キャンペーン ${label}`,
    description: '',
    status: 'draft',
    startsOn: '2026-01-01',
    endsOn: null,
    siteIds,
  });
  return campaign.id;
}

/** 一覧の対象（設計 §10.1 の #3〜#8 と、それを写す #9・#10）。 */
interface Resource {
  readonly name: string;
  readonly route: ListRoute;
  readonly url: string;
  /** #3〜#8 で書く番号の接頭辞（サイトは素の番号、ユーザーは #9、キャンペーンは #10）。 */
  readonly tag: (criterion: number) => string;
  /** 一覧に 3 件ある状態を作る。 */
  readonly seedThree: () => Promise<void>;
}

const RESOURCES: readonly Resource[] = [
  {
    name: 'GET /sites',
    route: listSitesRoute,
    url: SITES_URL,
    tag: (criterion) => `#${criterion}`,
    seedThree: async () => {
      for (const label of ['a', 'b', 'c']) {
        await makeSite(label);
      }
    },
  },
  {
    name: 'GET /users',
    route: listUsersRoute,
    url: USERS_URL,
    tag: (criterion) => `#9（#${criterion}）`,
    // 認証に使う管理者を含めて 3 人（設計 #9）。
    seedThree: async () => {
      await insertUser([]);
      await insertUser([]);
    },
  },
  {
    name: 'GET /campaigns',
    route: listCampaignsRoute,
    url: CAMPAIGNS_URL,
    tag: (criterion) => `#10（#${criterion}）`,
    seedThree: async () => {
      for (const label of ['a', 'b', 'c']) {
        await makeCampaign(label);
      }
    },
  },
];

beforeAll(async () => {
  scratch = await useScratchDatabase('listqueryrest');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const created = await createApiToken(admin, {
    name: 'list query test',
    scopes: ['site.read', 'user.manage', 'campaign.read'],
    expiresAt: null,
  });
  readToken = created.plaintext;
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #3〜#10 page / perPage                                                       */
/* -------------------------------------------------------------------------- */

describe.each(RESOURCES)('$name の page / perPage を丸める', (resource) => {
  function list(query: string, token: string | null = readToken): Promise<JsonResult> {
    return call(resource.route, `${resource.url}${query}`, token);
  }

  it(`${resource.tag(3)} perPage=-1 → 200、data が 1 件、meta.perPage === 1、meta.total === 3`, async () => {
    await resource.seedThree();

    const result = await list('?perPage=-1');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toHaveLength(1);
    expect(metaOf(result).perPage).toBe(1);
    expect(metaOf(result).total).toBe(3);
  });

  it(`${resource.tag(4)} page=0&perPage=2 → 200、meta.page === 1、data が 2 件`, async () => {
    await resource.seedThree();

    const result = await list('?page=0&perPage=2');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).page).toBe(1);
    expect(dataOf(result)).toHaveLength(2);
  });

  it(`${resource.tag(5)} perPage=0 → 200、data が 1 件、meta.perPage === 1`, async () => {
    await resource.seedThree();

    const result = await list('?perPage=0');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toHaveLength(1);
    expect(metaOf(result).perPage).toBe(1);
  });

  it(`${resource.tag(6)} perPage=100000000 → 200、meta.perPage === 100`, async () => {
    await resource.seedThree();

    const result = await list('?perPage=100000000');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(metaOf(result).perPage).toBe(100);
  });

  it(`${resource.tag(7)} page=99&perPage=2 → 200、data が空、meta.total === 3`, async () => {
    await resource.seedThree();

    const result = await list('?page=99&perPage=2');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dataOf(result)).toEqual([]);
    expect(metaOf(result).total).toBe(3);
  });

  it(`${resource.tag(8)} perPage=abc → 422、details.perPage がある`, async () => {
    await resource.seedThree();

    const result = await list('?perPage=abc');

    expect(result.status).toBe(422);
    expect(errorOf(result).details?.['perPage']).toBeDefined();
  });
});
