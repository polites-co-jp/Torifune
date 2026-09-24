import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listAnalyticsBreakdown,
  recordAnalytics,
} from '@/application/analytics/analytics-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign, listCampaigns } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { createSite, listSites } from '@/application/site/site-use-cases';
import {
  createSocialAccount,
  createSocialPost,
  listSocialPostHistory,
  listSocialPosts,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import { listUsers } from '@/application/user/user-use-cases';
import type { UserIdentity } from '@/authentication/identity';
import { normalizePage } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 画面が UseCase へ渡す最大の `page`（044-screen-page-param 設計 §10.2、受け入れ条件 #9・#10）。
 *
 * 画面は `?page=1e18` を `normalizePage` で `Number.MAX_SAFE_INTEGER` に丸めて UseCase へ渡す。
 * そのまま Repository の `OFFSET`（`(page − 1) × perPage`）になるので、PostgreSQL が断らないこと
 * （`bigint` に収まり、指数表記にならない）を DB を通して確かめる。
 *
 * 引数は画面（`app/**\/page.tsx`）が渡すものと同じにする。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let analyticsSiteId: string;

/** 画面が `?page=1e18` から求める値。 */
const HUGE_PAGE = (): number => normalizePage('1e18');

/** 内訳の集計値を入れる日。 */
const DAY = '2026-04-10';

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `p${suffix}`,
        email: `p${suffix}@example.com`,
        display_name: 'page param test',
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
    loginId: `p${suffix}`,
    displayName: 'page param test',
    email: `p${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('pageparam');
  admin = await contextFor(['administrator']);

  // 5 つの一覧のそれぞれで、1 ページ目が 1 件以上になる行を作る。
  const site = await createSite(admin, {
    name: 'page-param-site',
    url: 'https://page-param.example.com',
    description: '',
    status: 'active',
  });

  await createCampaign(admin, {
    name: 'page-param-campaign',
    description: '',
    status: 'draft',
    startsOn: '2026-04-01',
    endsOn: '2026-04-30',
    siteIds: [],
    socialPostIds: [],
  });

  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'page param',
    handle: '@pageparam',
    credential: null,
    status: 'connected',
  });
  await createSocialPost(admin, {
    socialAccountId: account.id,
    body: '下書きの投稿',
    scheduledAt: null,
    status: 'draft',
  });
  // 配信履歴は結果が確定した投稿（`published` / `failed`）の一覧。
  const { post } = await createSocialPost(admin, {
    socialAccountId: account.id,
    body: '失敗した投稿',
    scheduledAt: null,
    status: 'draft',
  });
  await updateSocialPost(admin, { id: post.id, status: 'failed', failureReason: 'timeout' });

  // 内訳の集計値（`/analytics` の「ページ」タブが読む `path_pageviews`）。
  analyticsSiteId = site.id;
  for (const key of ['/a', '/b']) {
    await recordAnalytics(admin, {
      siteId: analyticsSiteId,
      metricDate: DAY,
      source: 'com.example.pageparam',
      metric: 'path_pageviews',
      key,
      value: 3,
    });
  }
});

afterAll(async () => {
  resetEventHandlers();
  await scratch.dispose();
});

/** 画面と同じ引数で、`page` だけを差し替えて呼ぶ。 */
const LISTS: readonly {
  readonly name: string;
  readonly list: (page: number) => Promise<{ items: readonly unknown[]; total: number }>;
}[] = [
  {
    name: 'listSites（/sites）',
    list: (page) =>
      listSites(admin, {
        page,
        perPage: 20,
        status: null,
        keyword: null,
        sort: [{ field: 'created_at', direction: 'desc' }],
      }),
  },
  {
    name: 'listCampaigns（/campaigns）',
    list: (page) =>
      listCampaigns(admin, {
        page,
        perPage: 20,
        status: null,
        keyword: null,
        activeOn: null,
        siteId: null,
        sort: [{ field: 'starts_on', direction: 'desc' }],
      }),
  },
  {
    name: 'listUsers（/settings?tab=users）',
    list: (page) =>
      listUsers(admin, {
        page,
        perPage: 20,
        status: null,
        keyword: null,
        sort: [{ field: 'created_at', direction: 'desc' }],
      }),
  },
  {
    name: 'listSocialPostHistory（/social/history）',
    list: (page) => listSocialPostHistory(admin, { page, perPage: 20, status: null }),
  },
  {
    name: 'listSocialPosts（/social の postPage）',
    list: (page) =>
      listSocialPosts(admin, { page, perPage: 20, socialAccountId: null, status: null }),
  },
];

describe('#9 画面の一覧の UseCase に normalizePage("1e18")・perPage 20 を渡しても断られない', () => {
  for (const { name, list } of LISTS) {
    it(`#9 ${name} の 1 ページ目に行がある（前提）`, async () => {
      const first = await list(1);

      expect(first.items.length).toBeGreaterThanOrEqual(1);
    });

    it(`#9 ${name} は例外を投げない`, async () => {
      await expect(list(HUGE_PAGE())).resolves.toBeDefined();
    });

    it(`#9 ${name} は items が空`, async () => {
      const page = await list(HUGE_PAGE());

      expect(page.items).toEqual([]);
    });

    it(`#9 ${name} の total は 1 ページ目のときと等しい`, async () => {
      const first = await list(1);
      const last = await list(HUGE_PAGE());

      expect(last.total).toBe(first.total);
    });
  }
});

describe('#10 listAnalyticsBreakdown に normalizePage("1e18")・perPage 50 を渡しても断られない', () => {
  function breakdown(page: number) {
    // 画面（`app/analytics/page.tsx`）と同じく出所は全部（`source: null`）。
    return listAnalyticsBreakdown(admin, {
      siteId: analyticsSiteId,
      from: DAY,
      to: DAY,
      metric: 'path_pageviews',
      source: null,
      page,
      perPage: 50,
    });
  }

  it('#10 1 ページ目に内訳の行がある（前提）', async () => {
    const first = await breakdown(1);

    expect(first.items.length).toBeGreaterThanOrEqual(1);
  });

  it('#10 例外を投げない', async () => {
    await expect(breakdown(HUGE_PAGE())).resolves.toBeDefined();
  });

  it('#10 items が空', async () => {
    const page = await breakdown(HUGE_PAGE());

    expect(page.items).toEqual([]);
  });

  it('#10 total は 1 ページ目のときと等しい', async () => {
    const first = await breakdown(1);
    const last = await breakdown(HUGE_PAGE());

    expect(last.total).toBe(first.total);
  });
});
