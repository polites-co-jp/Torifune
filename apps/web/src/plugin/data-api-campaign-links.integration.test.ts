import {
  PluginPermissionError,
  type CampaignInput,
  type PluginDataApi,
} from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createPluginDataApi } from './data-api';
import { resetPluginRegistry } from './registry';

/**
 * Data API の `campaigns.create` / `update` の `siteIds` / `socialPostIds`
 * （045-campaign-input-500 設計 §8・§9.2、受け入れ条件 #26〜#28）。
 *
 * - #26：存在しない ID・形の誤り・配列でない値・数値の要素は、Postgres の `DatabaseError` ではなく
 *   Core の `ValidationError`（`name === 'ValidationError'`、`field` は `'siteIds'` / `'socialPostIds'`）で reject。
 *   `message` に渡した値を含めない。`PluginDataInputError` は使わない
 * - #27：大文字との重複は成功し、戻り値の `siteIds` は小文字の 1 件
 * - #28：検査の順は Manifest の宣言 → 利用者の Permission → 入力（`ValidationError` より先に権限の例外）
 *
 * `createPluginDataApi` を直接組む（`data-api-input.integration.test.ts` の形を写した）。
 */

const PLUGIN_ID = 'campaign-links-plugin';

const WRITE = ['site.read', 'site.write', 'campaign.read', 'campaign.write'];

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** Permission を 1 つも持たない利用者。 */
let nobody: AuthorizationContext;

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
        display_name: 'data api campaign links test',
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
    displayName: 'data api campaign links test',
    email: `p${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(
  declared: readonly string[] = WRITE,
  context: AuthorizationContext = admin,
): PluginDataApi {
  return createPluginDataApi({
    pluginId: PLUGIN_ID,
    declaredPermissions: new Set(declared),
    context,
  });
}

/** 返した Promise が reject したときの例外。resolve したらテストを落とす。 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('reject されなかった');
}

/** 名前と開始日だけの入力に `overrides` を重ねる（型を外した値も渡せるようにする）。 */
function campaignInput(overrides: Record<string, unknown> = {}): CampaignInput {
  return { name: 'キャンペーン', startsOn: '2026-01-01', ...overrides } as CampaignInput;
}

interface ErrorShape {
  readonly name?: unknown;
  readonly field?: unknown;
  readonly message?: unknown;
  readonly details?: Readonly<Record<string, readonly string[]>>;
}

async function makeSite(label: string): Promise<string> {
  return (await apiFor().sites.create({ name: label, url: `https://${label}.example.com` })).id;
}

async function makePost(): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'アカウント',
    handle: '@data-api-links',
    credential: null,
    status: 'connected',
  });
  const { post } = await createSocialPost(admin, {
    socialAccountId: account.id,
    body: 'P1',
    scheduledAt: null,
    status: 'draft',
  });
  return post.id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('dataapicampaignlinks');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  nobody = await contextFor([]);
});

afterEach(async () => {
  resetEventHandlers();
  resetPublisherRegistry();
  resetPluginRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #26 campaigns.create の誤りは ValidationError                                   */
/* -------------------------------------------------------------------------- */

/** 設計 #26 の `siteIds` の値。`'abc'`（配列でない）と `[123]` は型を外して渡す。 */
const BAD_SITE_IDS: readonly (readonly [string, () => unknown])[] = [
  ['[存在しない ID]', () => [uuidv7()]],
  ["['abc']", () => ['abc']],
  ["'abc'（配列でない）", () => 'abc'],
  ['[123]', () => [123]],
];

describe('#26 campaigns.create の siteIds の誤りは ValidationError で reject される', () => {
  it.each(BAD_SITE_IDS)('#26 siteIds: %s → name === "ValidationError"', async (_label, make) => {
    const error = await rejectionOf(apiFor().campaigns.create(campaignInput({ siteIds: make() })));

    expect((error as ErrorShape).name).toBe('ValidationError');
  });

  it.each(BAD_SITE_IDS)('#26 siteIds: %s → field === "siteIds"', async (_label, make) => {
    const error = await rejectionOf(apiFor().campaigns.create(campaignInput({ siteIds: make() })));

    expect((error as ErrorShape).field).toBe('siteIds');
  });

  it.each(BAD_SITE_IDS)('#26 siteIds: %s → message が abc を含まない', async (_label, make) => {
    const error = await rejectionOf(apiFor().campaigns.create(campaignInput({ siteIds: make() })));

    expect(String((error as ErrorShape).message)).not.toContain('abc');
  });

  it('#26 siteIds: [存在しない ID] → message がその ID を含まない', async () => {
    const missing = uuidv7();

    const error = await rejectionOf(
      apiFor().campaigns.create(campaignInput({ siteIds: [missing] })),
    );

    expect(String((error as ErrorShape).message)).not.toContain(missing);
  });

  it('#26 siteIds: [存在しない ID] → details.siteIds が「存在しないWebサイトが含まれています。」', async () => {
    const error = await rejectionOf(
      apiFor().campaigns.create(campaignInput({ siteIds: [uuidv7()] })),
    );

    expect((error as ErrorShape).details?.['siteIds']).toEqual([
      '存在しないWebサイトが含まれています。',
    ]);
  });

  it("#26 siteIds: ['abc'] → details.siteIds が「UUID の形で指定してください。」", async () => {
    const error = await rejectionOf(apiFor().campaigns.create(campaignInput({ siteIds: ['abc'] })));

    expect((error as ErrorShape).details?.['siteIds']).toEqual(['UUID の形で指定してください。']);
  });

  it('#26 socialPostIds: [存在しない ID] → name === "ValidationError"、field === "socialPostIds"', async () => {
    const error = await rejectionOf(
      apiFor().campaigns.create(campaignInput({ socialPostIds: [uuidv7()] })),
    );

    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('socialPostIds');
  });

  it('#26 失敗した create の後、キャンペーンが作られていない', async () => {
    const api = apiFor();
    await rejectionOf(api.campaigns.create(campaignInput({ siteIds: [uuidv7()] })));

    await expect(api.campaigns.list()).resolves.toMatchObject({ total: 0 });
  });
});

describe('#26 campaigns.update の siteIds の誤りも ValidationError で reject される', () => {
  it('#26 update の siteIds: [存在しない ID] → name === "ValidationError"、field === "siteIds"', async () => {
    const api = apiFor();
    const s1 = await makeSite('s1');
    const campaign = await api.campaigns.create(campaignInput({ siteIds: [s1] }));

    const error = await rejectionOf(api.campaigns.update(campaign.id, { siteIds: [uuidv7()] }));

    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('siteIds');
  });

  it('#26 失敗した update の後、siteIds が [S1] のまま', async () => {
    const api = apiFor();
    const s1 = await makeSite('s1');
    const campaign = await api.campaigns.create(campaignInput({ siteIds: [s1] }));
    await rejectionOf(api.campaigns.update(campaign.id, { siteIds: [uuidv7()] }));

    const after = await api.campaigns.get(campaign.id);

    expect(after?.siteIds).toEqual([s1]);
  });
});

/* -------------------------------------------------------------------------- */
/* #27 大文字との重複                                                                */
/* -------------------------------------------------------------------------- */

describe('#27 campaigns.create の大文字との重複は成功し、小文字の 1 件になる', () => {
  it('#27 siteIds: [S1, S1 の大文字] → 成功、戻り値の siteIds が [S1]', async () => {
    const s1 = await makeSite('s1');

    const campaign = await apiFor().campaigns.create(
      campaignInput({ siteIds: [s1, s1.toUpperCase()] }),
    );

    expect(campaign.siteIds).toEqual([s1]);
  });

  it('#27 socialPostIds: [P1, P1 の大文字] → 成功、戻り値の socialPostIds が [P1]', async () => {
    const p1 = await makePost();

    const campaign = await apiFor().campaigns.create(
      campaignInput({ socialPostIds: [p1, p1.toUpperCase()] }),
    );

    expect(campaign.socialPostIds).toEqual([p1]);
  });
});

/* -------------------------------------------------------------------------- */
/* #28 検査の順                                                                      */
/* -------------------------------------------------------------------------- */

describe('#28 権限の例外は ValidationError より先', () => {
  it("#28 campaign.write を宣言していない Plugin の create({ siteIds: ['abc'] }) → PluginPermissionError", async () => {
    const api = apiFor(['campaign.read']);

    const error = await rejectionOf(api.campaigns.create(campaignInput({ siteIds: ['abc'] })));

    expect(error).toBeInstanceOf(PluginPermissionError);
  });

  it("#28 宣言していても利用者が campaign.write を持たない create({ siteIds: ['abc'] }) → ForbiddenError", async () => {
    const api = apiFor(WRITE, nobody);

    const error = await rejectionOf(api.campaigns.create(campaignInput({ siteIds: ['abc'] })));

    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it("#28 campaign.write を宣言していない Plugin の update(id, { siteIds: ['abc'] }) → PluginPermissionError", async () => {
    const api = apiFor(['campaign.read']);

    const error = await rejectionOf(api.campaigns.update(uuidv7(), { siteIds: ['abc'] }));

    expect(error).toBeInstanceOf(PluginPermissionError);
  });

  it("#28 宣言していても利用者が campaign.write を持たない update(id, { siteIds: ['abc'] }) → ForbiddenError", async () => {
    const api = apiFor(WRITE, nobody);

    const error = await rejectionOf(api.campaigns.update(uuidv7(), { siteIds: ['abc'] }));

    expect(error).toBeInstanceOf(ForbiddenError);
  });
});
