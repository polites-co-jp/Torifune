import {
  PluginDataInputError,
  PluginPermissionError,
  type PluginDataApi,
} from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { listSites } from '@/application/site/site-use-cases';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { buildPluginContext } from './context';
import { createPluginDataApi } from './data-api';
import { resetPluginRegistry } from './registry';

/**
 * Data API の一覧の入力（043-api-input-fixes-rest 設計 §8・§9.2、受け入れ条件 #21〜#33・#35）。
 *
 * - `page` / `perPage`（#21〜#27）：Core の HTTP と同じく**丸める**。例外にしない。丸めた値が `Page.page` / `Page.perPage` に返る
 * - `socialPosts.list({ accountId })`・`campaigns.list({ siteId })`（#28〜#30）：`undefined` / `null` は絞り込みなし。
 *   それ以外で UUID の形でなければ `PluginDataInputError` で reject（値は `message` にも項目にも含めない）
 * - 検査の順（#31）：Manifest の宣言 → 利用者の Permission → 形の検査。権限の無い呼び出しに入力の誤りを教えない
 * - 変えないもの（#32・#33）：`analytics.list` の `siteId`、`get(id)`、UseCase（画面の経路）のページング
 * - 捕まえなかったとき（#35）：イベントのハンドラなら握られ、`event handler failed` のログが残る
 *
 * `createPluginDataApi` を直接組む（`data-api.integration.test.ts` の形を写した）。
 * 投稿とアカウントは UseCase で作る（publisher の無い provider の `auto`・`draft` は登録できる）。
 */

const PLUGIN_ID = 'input-check-plugin';

/** publisher を登録していない provider（登録簿に無くても `auto`・`draft` なら登録できる）。 */
const PROVIDER = 'x';

/** 版 0・variant 0 の UUID の形（z.uuid() は断るが、形としては UUID。設計 §9.2）。 */
const VERSION_ZERO_UUID = '0192b7a0-5c1e-0a3b-0f10-2d7c4e8a1b23';

/** 5 つの一覧と `analytics`・`get` に要る宣言。 */
const ALL_READ = ['site.read', 'campaign.read', 'social.read', 'user.manage', 'analytics.read'];

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
        login_id: `d${suffix}`,
        email: `d${suffix}@example.com`,
        display_name: 'data api input test',
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
    loginId: `d${suffix}`,
    displayName: 'data api input test',
    email: `d${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(
  declared: readonly string[] = ALL_READ,
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

async function makeSites(count: number): Promise<void> {
  const api = apiFor(['site.read', 'site.write']);
  for (let index = 0; index < count; index += 1) {
    await api.sites.create({ name: `サイト ${index}`, url: `https://s${index}.example.com` });
  }
}

async function makeAccount(label: string): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: `アカウント ${label}`,
    handle: `@input-${label}`,
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

/** アカウント A・B に投稿を 1 件ずつ（設計 #28）。 */
async function twoAccountsWithPosts(): Promise<{
  readonly a: string;
  readonly postA: string;
}> {
  const a = await makeAccount('a');
  const b = await makeAccount('b');
  const postA = await makePost(a, 'A の投稿');
  await makePost(b, 'B の投稿');
  return { a, postA };
}

/** サイト S1 を対象にするキャンペーンと、対象の無いキャンペーン（設計 #30）。 */
async function campaignsWithAndWithoutSite(): Promise<{
  readonly s1: string;
  readonly withSite: string;
}> {
  const api = apiFor(['site.read', 'site.write', 'campaign.read', 'campaign.write']);
  const s1 = (await api.sites.create({ name: 'S1', url: 'https://s1.example.com' })).id;
  const withSite = (
    await api.campaigns.create({ name: 'S1 のキャンペーン', startsOn: '2026-01-01', siteIds: [s1] })
  ).id;
  await api.campaigns.create({ name: '対象なし', startsOn: '2026-01-01' });
  return { s1, withSite };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('dataapiinput');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  nobody = await contextFor([]);
});

afterEach(async () => {
  resetLogger();
  resetEventHandlers();
  resetPublisherRegistry();
  resetPluginRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #21〜#26 sites.list の page / perPage                                         */
/* -------------------------------------------------------------------------- */

describe('#21 sites.list({ page: 0, perPage: -1 }) は例外を投げずに丸める', () => {
  it('#21 page === 1、perPage === 1、items が 1 件、total === 3', async () => {
    await makeSites(3);

    const page = await apiFor().sites.list({ page: 0, perPage: -1 });

    expect(page.page).toBe(1);
    expect(page.perPage).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });
});

describe('#22 sites.list({ perPage: 1000 }) は 100 に丸める', () => {
  it('#22 perPage === 100、items が 3 件', async () => {
    await makeSites(3);

    const page = await apiFor().sites.list({ perPage: 1000 });

    expect(page.perPage).toBe(100);
    expect(page.items).toHaveLength(3);
  });
});

describe('#23 sites.list({ perPage: 0 }) は 1 に丸める', () => {
  it('#23 perPage === 1、items が 1 件', async () => {
    await makeSites(3);

    const page = await apiFor().sites.list({ perPage: 0 });

    expect(page.perPage).toBe(1);
    expect(page.items).toHaveLength(1);
  });
});

describe('#24 sites.list({ page: 2.9, perPage: 1.7 }) は小数を切り捨てる', () => {
  it('#24 page === 2、perPage === 1、items が 1 件（2 件目）', async () => {
    await makeSites(3);
    const api = apiFor();
    const second = await api.sites.list({ page: 2, perPage: 1 });

    const page = await api.sites.list({ page: 2.9, perPage: 1.7 });

    expect(page.page).toBe(2);
    expect(page.perPage).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe(second.items[0]?.id);
  });
});

describe('#25 sites.list({ page: NaN, perPage: Infinity }) は省略と同じ', () => {
  it('#25 page === 1、perPage === 20、items が 3 件', async () => {
    await makeSites(3);

    const page = await apiFor().sites.list({ page: NaN, perPage: Infinity });

    expect(page.page).toBe(1);
    expect(page.perPage).toBe(20);
    expect(page.items).toHaveLength(3);
  });
});

describe('#26 sites.list({ page: 1e300 }) は Number.MAX_SAFE_INTEGER に丸める', () => {
  it('#26 例外を投げず、page === Number.MAX_SAFE_INTEGER、items が空、total === 3', async () => {
    await makeSites(3);

    const page = await apiFor().sites.list({ page: 1e300 });

    expect(page.page).toBe(Number.MAX_SAFE_INTEGER);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* #27 ほかの 4 つの一覧                                                          */
/* -------------------------------------------------------------------------- */

describe('#27 ほかの 4 つの一覧も page / perPage を丸める', () => {
  const LISTS: readonly {
    readonly name: string;
    readonly list: (api: PluginDataApi) => Promise<{ page: number; perPage: number }>;
  }[] = [
    { name: 'campaigns.list', list: (api) => api.campaigns.list({ page: 0, perPage: 1000 }) },
    {
      name: 'socialAccounts.list',
      list: (api) => api.socialAccounts.list({ page: 0, perPage: 1000 }),
    },
    { name: 'socialPosts.list', list: (api) => api.socialPosts.list({ page: 0, perPage: 1000 }) },
    { name: 'users.list', list: (api) => api.users.list({ page: 0, perPage: 1000 }) },
  ];

  it.each(LISTS)(
    '#27 $name({ page: 0, perPage: 1000 }) → page === 1、perPage === 100',
    async ({ list }) => {
      const page = await list(apiFor());

      expect(page.page).toBe(1);
      expect(page.perPage).toBe(100);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #28〜#29 socialPosts.list の accountId                                        */
/* -------------------------------------------------------------------------- */

describe('#28 socialPosts.list の accountId：UUID の形なら従来どおり絞る', () => {
  it('#28 A の id → A の投稿だけ（total === 1）', async () => {
    const { a, postA } = await twoAccountsWithPosts();

    const page = await apiFor().socialPosts.list({ accountId: a });

    expect(page.total).toBe(1);
    expect(page.items.map((post) => post.id)).toEqual([postA]);
  });

  it('#28 A の id の大文字 → 同じ 1 件', async () => {
    const { a, postA } = await twoAccountsWithPosts();

    const page = await apiFor().socialPosts.list({ accountId: a.toUpperCase() });

    expect(page.items.map((post) => post.id)).toEqual([postA]);
  });

  it('#28 省略 → 2 件（絞り込みなし）', async () => {
    await twoAccountsWithPosts();

    const page = await apiFor().socialPosts.list();

    expect(page.total).toBe(2);
  });

  it('#28 null → 2 件（絞り込みなし）', async () => {
    await twoAccountsWithPosts();

    const page = await apiFor().socialPosts.list({
      accountId: null as unknown as string,
    });

    expect(page.total).toBe(2);
  });

  it.each([
    { label: '存在しない UUID', value: () => uuidv7() },
    { label: '版 0・variant 0 の UUID の形', value: () => VERSION_ZERO_UUID },
  ])('#28 $label → 例外を投げず、items が空、total === 0', async ({ value }) => {
    await twoAccountsWithPosts();

    const page = await apiFor().socialPosts.list({ accountId: value() });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('#29 socialPosts.list の accountId：UUID の形でなければ PluginDataInputError', () => {
  const INVALID: readonly { readonly label: string; readonly value: (a: string) => unknown }[] = [
    { label: "'abc-not-a-uuid'", value: () => 'abc-not-a-uuid' },
    { label: "''（空文字）", value: () => '' },
    { label: 'A の id の末尾に 1 文字足した 37 文字', value: (a) => `${a}0` },
    { label: '123（数値）', value: () => 123 },
    { label: '{}（オブジェクト）', value: () => ({}) },
  ];

  async function rejectionFor(value: (a: string) => unknown): Promise<unknown> {
    const { a } = await twoAccountsWithPosts();
    return rejectionOf(apiFor().socialPosts.list({ accountId: value(a) as unknown as string }));
  }

  it.each(INVALID)('#29 $label → reject され、例外が PluginDataInputError', async ({ value }) => {
    const error = await rejectionFor(value);

    expect(error).toBeInstanceOf(PluginDataInputError);
  });

  it.each(INVALID)('#29 $label → 例外が instanceof Error', async ({ value }) => {
    const error = await rejectionFor(value);

    expect(error).toBeInstanceOf(Error);
  });

  it.each(INVALID)(
    "#29 $label → name === 'PluginDataInputError'、field === 'accountId'、pluginId が呼んだ Plugin の ID",
    async ({ value }) => {
      const error = (await rejectionFor(value)) as PluginDataInputError;

      expect(error.name).toBe('PluginDataInputError');
      expect(error.field).toBe('accountId');
      expect(error.pluginId).toBe(PLUGIN_ID);
    },
  );

  it.each(INVALID)(
    '#29 $label → message が accountId を含み、渡した値を含まない',
    async ({ value }) => {
      const error = (await rejectionFor(value)) as Error;

      expect(error.message).toContain('accountId');
      expect(error.message).not.toContain('abc-not-a-uuid');
    },
  );

  it('#29 例外のどの項目にも渡した値が載らない（37 文字の値で確かめる）', async () => {
    const { a } = await twoAccountsWithPosts();
    const value = `${a}0`;

    const error = await rejectionOf(apiFor().socialPosts.list({ accountId: value }));

    expect(
      JSON.stringify({ ...(error as object), message: (error as Error).message }),
    ).not.toContain(value);
  });
});

/* -------------------------------------------------------------------------- */
/* #30 campaigns.list の siteId                                                  */
/* -------------------------------------------------------------------------- */

describe('#30 campaigns.list の siteId', () => {
  it('#30 S1 → S1 を対象にするキャンペーンの 1 件', async () => {
    const { s1, withSite } = await campaignsWithAndWithoutSite();

    const page = await apiFor().campaigns.list({ siteId: s1 });

    expect(page.total).toBe(1);
    expect(page.items.map((campaign) => campaign.id)).toEqual([withSite]);
  });

  it('#30 省略 → 2 件', async () => {
    await campaignsWithAndWithoutSite();

    const page = await apiFor().campaigns.list();

    expect(page.total).toBe(2);
  });

  it.each(['abc', ''])(
    "#30 siteId: '%s' → PluginDataInputError（field === 'siteId'）",
    async (value) => {
      await campaignsWithAndWithoutSite();

      const error = await rejectionOf(apiFor().campaigns.list({ siteId: value }));

      expect(error).toBeInstanceOf(PluginDataInputError);
      expect((error as PluginDataInputError).field).toBe('siteId');
      expect((error as PluginDataInputError).pluginId).toBe(PLUGIN_ID);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #31 検査の順序                                                                 */
/* -------------------------------------------------------------------------- */

describe('#31 形の誤った引数でも、Manifest の宣言と利用者の Permission が先に出る', () => {
  const CASES: readonly {
    readonly name: string;
    readonly permission: string;
    readonly call: (api: PluginDataApi) => Promise<unknown>;
  }[] = [
    {
      name: "socialPosts.list({ accountId: 'abc' })",
      permission: 'social.read',
      call: (api) => api.socialPosts.list({ accountId: 'abc' }),
    },
    {
      name: "campaigns.list({ siteId: 'abc' })",
      permission: 'campaign.read',
      call: (api) => api.campaigns.list({ siteId: 'abc' }),
    },
  ];

  it.each(CASES)(
    '#31 $name：$permission を宣言していない Plugin → PluginPermissionError（PluginDataInputError ではない）',
    async ({ permission, call }) => {
      const declared = ALL_READ.filter((name) => name !== permission);

      const error = await rejectionOf(call(apiFor(declared)));

      expect(error).toBeInstanceOf(PluginPermissionError);
      expect((error as Error).name).not.toBe('PluginDataInputError');
    },
  );

  it.each(CASES)(
    '#31 $name：宣言していても利用者が $permission を持たない → ForbiddenError（PluginDataInputError ではない）',
    async ({ call }) => {
      const error = await rejectionOf(call(apiFor(ALL_READ, nobody)));

      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as Error).name).not.toBe('PluginDataInputError');
    },
  );

  it.each(CASES)(
    '#31 $name：未認証の文脈 → UnauthenticatedError（PluginDataInputError ではない）',
    async ({ call }) => {
      const anonymous: AuthorizationContext = {
        identity: null,
        permissions: new Set(),
        connection: admin.connection,
      };

      const error = await rejectionOf(call(apiFor(ALL_READ, anonymous)));

      expect(error).toBeInstanceOf(UnauthenticatedError);
      expect((error as Error).name).not.toBe('PluginDataInputError');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #32〜#33 変えないもの                                                          */
/* -------------------------------------------------------------------------- */

describe('#32 例外を投げない引数は変わらない', () => {
  it("#32 analytics.list({ siteId: 'abc', from, to }) → []", async () => {
    await expect(
      apiFor().analytics.list({ siteId: 'abc', from: '2026-03-01', to: '2026-03-31' }),
    ).resolves.toEqual([]);
  });

  it("#32 sites.get('abc') → null", async () => {
    await expect(apiFor().sites.get('abc')).resolves.toBeNull();
  });

  it("#32 socialPosts.get('abc') → null", async () => {
    await expect(apiFor().socialPosts.get('abc')).resolves.toBeNull();
  });
});

describe('#33 画面の経路（UseCase）は丸めない', () => {
  it('#33 サイト 101 件で listSites を perPage: 150 で呼ぶと items が 101 件', async () => {
    await makeSites(101);

    const page = await listSites(admin, {
      page: 1,
      perPage: 150,
      status: null,
      keyword: null,
      sort: [{ field: 'created_at', direction: 'desc' }],
    });

    expect(page.items).toHaveLength(101);
  });
});

/* -------------------------------------------------------------------------- */
/* #35 捕まえなかったとき（イベント）                                               */
/* -------------------------------------------------------------------------- */

describe('#35 イベントのハンドラで捕まえなかった PluginDataInputError は握られ、ログに残る', () => {
  const EVENT_PLUGIN = 'input-event-plugin';
  const EVENT_NAME = `${EVENT_PLUGIN}.checked`;

  function capture(): { records: LogRecord[] } {
    const records: LogRecord[] = [];
    setLogger({
      log(level, message, fields) {
        records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
      },
    });
    return { records };
  }

  async function fireWithInvalidAccountId(): Promise<LogRecord[]> {
    // social.read を持つ利用者の文脈で組む（持たないと ForbiddenError が先に出る。実装プラン §7 の 11）。
    const context = buildPluginContext({
      manifest: {
        id: EVENT_PLUGIN,
        name: 'input event plugin',
        version: '1.0.0',
        apiVersion: 1,
        permissions: ['social.read'],
      },
      connection: admin.connection,
      authorization: admin,
    });
    context.events.subscribe(EVENT_NAME, async () => {
      await context.data.socialPosts.list({ accountId: 'abc' });
    });

    const { records } = capture();
    await context.events.emit(EVENT_NAME, {});
    return records.filter((record) => record.message === 'event handler failed');
  }

  it('#35 発火は例外を投げずに終わる', async () => {
    await expect(fireWithInvalidAccountId()).resolves.toBeDefined();
  });

  it('#35 event handler failed のログが 1 件出る', async () => {
    const failures = await fireWithInvalidAccountId();

    expect(failures).toHaveLength(1);
  });

  it('#35 そのログの pluginId が P、reason が accountId を含む', async () => {
    const failures = await fireWithInvalidAccountId();

    expect(failures[0]?.fields?.['pluginId']).toBe(EVENT_PLUGIN);
    expect(String(failures[0]?.fields?.['reason'])).toContain('accountId');
  });
});
