import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { listAnalytics, recordAnalytics } from '@/application/analytics/analytics-use-cases';
import {
  createCampaign,
  getCampaign,
  updateCampaign,
} from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers, subscribe } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import {
  createSocialAccount,
  createSocialPost,
  deleteSocialPost,
  listSocialPostsByIds,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import {
  analysisRange,
  countPostsByStatus,
  summarizeBySite,
} from '@/domain/campaign/campaign-analysis';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * キャンペーンとSNS投稿の関連付け、および分析画面が組み立てる材料
 * （026-screen-completion 設計 §3）。
 *
 * **新しい集計テーブルを作らない。** 既存の `listAnalytics` と
 * SNS の UseCase を組み合わせて出せることを、ここで固定する。
 */

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
        login_id: `s${suffix}`,
        email: `s${suffix}@example.com`,
        display_name: 'campaign social test',
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
    loginId: `s${suffix}`,
    displayName: 'campaign social test',
    email: `s${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** ロールを1つも持たない相手。**認証済みだが Permission が無い**状態を作る。 */
async function strangerContext(): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const identity: UserIdentity = {
    userId: id,
    loginId: `x${suffix}`,
    displayName: 'no roles',
    email: `x${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: identity.loginId,
        email: identity.email,
        display_name: identity.displayName,
      })
      .execute();
  });

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function campaignInput(overrides: Partial<Parameters<typeof createCampaign>[1]> = {}) {
  return {
    name: '春の施策',
    description: '',
    status: 'draft' as const,
    startsOn: '2026-04-01',
    endsOn: '2026-04-30' as string | null,
    siteIds: [] as readonly string[],
    socialPostIds: [] as readonly string[],
    ...overrides,
  };
}

async function makeSite(name: string): Promise<string> {
  const site = await createSite(admin, {
    name,
    url: `https://${name}.example.com`,
    description: '',
    status: 'active',
  });
  return site.id;
}

let accountId: string;

async function makePost(body: string, status: 'draft' | 'scheduled' = 'draft'): Promise<string> {
  const post = await createSocialPost(admin, {
    socialAccountId: accountId,
    body,
    scheduledAt: null,
    status,
  });
  return post.id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('campaignsocial');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

async function freshAccount(): Promise<void> {
  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    status: 'connected',
  });
  accountId = account.id;
}

describe('SNS投稿の関連付け', () => {
  it('作成時に投稿を紐づけられる', async () => {
    await freshAccount();
    const a = await makePost('告知1');
    const b = await makePost('告知2');

    const created = await createCampaign(admin, campaignInput({ socialPostIds: [a, b] }));

    expect([...created.socialPostIds].sort()).toEqual([a, b].sort());
  });

  it('紐づけずに作れる', async () => {
    const created = await createCampaign(admin, campaignInput());
    expect(created.socialPostIds).toEqual([]);
  });

  /** 差分では「消す」を表現できない。指定したら丸ごと置き換える（siteIds と同じ）。 */
  it('更新で丸ごと置き換えられる', async () => {
    await freshAccount();
    const a = await makePost('告知1');
    const b = await makePost('告知2');
    const created = await createCampaign(admin, campaignInput({ socialPostIds: [a, b] }));

    const updated = await updateCampaign(admin, { id: created.id, socialPostIds: [b] });

    expect(updated.socialPostIds).toEqual([b]);
  });

  it('空にできる', async () => {
    await freshAccount();
    const a = await makePost('告知1');
    const created = await createCampaign(admin, campaignInput({ socialPostIds: [a] }));

    const updated = await updateCampaign(admin, { id: created.id, socialPostIds: [] });

    expect(updated.socialPostIds).toEqual([]);
  });

  /** 指定しなければ触らない。名前だけ直したつもりで関連が消えると困る。 */
  it('指定しない更新では関連が残る', async () => {
    await freshAccount();
    const a = await makePost('告知1');
    const created = await createCampaign(admin, campaignInput({ socialPostIds: [a] }));

    const updated = await updateCampaign(admin, { id: created.id, name: '春の施策（改）' });

    expect(updated.socialPostIds).toEqual([a]);
  });

  /**
   * 投稿を消しても、その投稿を紐づけていたキャンペーンは残す。
   * 対象が減っただけで、取り組みの記録は消さない（サイトと同じ扱い）。
   */
  it('投稿を削除してもキャンペーンは残る', async () => {
    await freshAccount();
    const a = await makePost('告知1');
    const created = await createCampaign(admin, campaignInput({ socialPostIds: [a] }));

    await deleteSocialPost(admin, { id: a });

    const found = await getCampaign(admin, { id: created.id });
    expect(found.socialPostIds).toEqual([]);
  });

  it('イベントの Payload に投稿が載る', async () => {
    await freshAccount();
    const a = await makePost('告知1');

    const seen: unknown[] = [];
    subscribe('campaign.created', (payload) => {
      seen.push(payload);
    });

    await createCampaign(admin, campaignInput({ socialPostIds: [a] }));

    expect(seen).toHaveLength(1);
    expect((seen[0] as { socialPostIds?: readonly string[] }).socialPostIds).toEqual([a]);
  });
});

describe('IDでまとめて引く', () => {
  it('指定した投稿だけを返す', async () => {
    await freshAccount();
    const a = await makePost('告知1');
    const b = await makePost('告知2');
    await makePost('無関係');

    const posts = await listSocialPostsByIds(admin, { ids: [a, b] });

    expect(posts.map((post) => post.id).sort()).toEqual([a, b].sort());
  });

  it('空の指定では問い合わせない', async () => {
    expect(await listSocialPostsByIds(admin, { ids: [] })).toEqual([]);
  });

  /** 消えた投稿のIDが混ざっても落ちない。 */
  it('存在しないIDは黙って落とす', async () => {
    await freshAccount();
    const a = await makePost('告知1');

    const posts = await listSocialPostsByIds(admin, {
      ids: [a, '00000000-0000-0000-0000-000000000000'],
    });

    expect(posts.map((post) => post.id)).toEqual([a]);
  });

  it('social.read が無ければ引けない', async () => {
    const stranger = await strangerContext();
    await expect(listSocialPostsByIds(stranger, { ids: [] })).rejects.toThrow(ForbiddenError);
  });
});

describe('分析の材料', () => {
  it('対象サイトの期間内アクセスを既存の UseCase で出せる', async () => {
    const site = await makeSite('alpha');
    const other = await makeSite('beta');

    await recordAnalytics(admin, {
      siteId: site,
      metricDate: '2026-04-05',
      source: 'plugin-x',
      metric: 'pageviews',
      value: 12,
    });
    await recordAnalytics(admin, {
      siteId: site,
      metricDate: '2026-04-06',
      source: 'plugin-x',
      metric: 'visitors',
      value: 4,
    });
    // 期間の外。集計に入ってはならない。
    await recordAnalytics(admin, {
      siteId: site,
      metricDate: '2026-05-10',
      source: 'plugin-x',
      metric: 'pageviews',
      value: 99,
    });
    // 対象外のサイト。
    await recordAnalytics(admin, {
      siteId: other,
      metricDate: '2026-04-05',
      source: 'plugin-x',
      metric: 'pageviews',
      value: 50,
    });

    const created = await createCampaign(admin, campaignInput({ siteIds: [site] }));
    const range = analysisRange(created.startsOn, created.endsOn, '2026-06-01');

    const points = await listAnalytics(admin, {
      siteId: site,
      from: range.from,
      to: range.to,
      source: null,
    });

    const summary = summarizeBySite(points);
    expect(summary.get(site)).toEqual({ pageviews: 12, visitors: 4 });
    expect(summary.has(other)).toBe(false);
  });

  it('紐づく投稿の状態を数えられる', async () => {
    await freshAccount();
    const a = await makePost('告知1', 'draft');
    const b = await makePost('告知2', 'scheduled');

    const created = await createCampaign(admin, campaignInput({ socialPostIds: [a, b] }));
    const posts = await listSocialPostsByIds(admin, { ids: created.socialPostIds });

    expect(countPostsByStatus(posts)).toEqual({
      draft: 1,
      scheduled: 1,
      published: 0,
      failed: 0,
    });
  });

  it('campaign.read が無ければキャンペーンを読めない', async () => {
    const created = await createCampaign(admin, campaignInput());
    const stranger = await strangerContext();

    await expect(getCampaign(stranger, { id: created.id })).rejects.toThrow(ForbiddenError);
  });
});
