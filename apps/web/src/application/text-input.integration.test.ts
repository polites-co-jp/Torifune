import { sql } from 'kysely';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  listAnalytics,
  listAnalyticsBreakdown,
  listAnalyticsPage,
  recordAnalytics,
} from '@/application/analytics/analytics-use-cases';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { savePluginSettings } from '@/application/plugin/plugin-settings-use-cases';
import { createSite, getSite, listSites, updateSite } from '@/application/site/site-use-cases';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  getSocialPost,
  listSocialAccounts,
  updateSocialAccount,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { updateSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import { withConnection } from '@/application/transaction';
import { createUser, getUser, listUsers, updateUser } from '@/application/user/user-use-cases';
import { createWebhook } from '@/application/webhook/webhook-use-cases';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRegistry } from '@/plugin/registry';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * UseCase の使えない文字の検査（L2。046-input-500-nul-and-ranges 設計 §4.2・§10.5、受け入れ条件 #22〜#25）。
 *
 * - #22：設計 §4.2 の **45 組**（UseCase × 項目）を、NUL（U+0000）を含む値と対になっていないサロゲート（片割れ）を含む値の
 *   2 通りで直接呼ぶ。どれも `ValidationError`（`name === 'ValidationError'`、`resource`・`field` が表のとおり、
 *   `details` が `{ <項目名>: [それぞれの文言] }`、`message` に値が無い）で、Postgres の `DatabaseError` ではない。
 *   作成・更新は何も書かない。**`analytics.record` の `key` は片割れだけ**（NUL は既存の検査が先に断る。#25）
 * - #23：認可が先（`site.write` を持たない利用者の `createSite` は `ForbiddenError`）
 * - #24：入れ子（`providerOptions` の入れ子の値・キー、`savePluginSettings` の `values`）の片割れも断る。絵文字は通る
 * - #25：変わらないもの（`get*` の `id` は `NotFoundError`、`keys` / `key` の NUL は従来の文言の `ValidationError`）
 *
 * 「何も書かない」は、対象の表の行を前後で比べて確かめる（`SELECT *` を並べ替えて比べる）。
 * **ソースに壊れた文字を置かない。** NUL と片割れはエスケープで書く。絵文字は `String.fromCodePoint` で作る。
 */

const NUL_TEXT = '使用できない文字（NUL）が含まれています。';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';
/** 送った値が例外の `message` に載らないことを確かめる目印。 */
const MARKER = 'marker-046';
/** U+1F44D（対になったサロゲート）。 */
const EMOJI = String.fromCodePoint(0x1f44d);

const PLUGIN_ID = 'example-plugin';
const PASSWORD = 'text input correct horse battery staple';

type Variant = 'nul' | 'surrogate';

const VARIANTS: readonly { readonly variant: Variant; readonly text: string }[] = [
  { variant: 'nul', text: NUL_TEXT },
  { variant: 'surrogate', text: SURROGATE_TEXT },
];

/** 値の末尾に NUL か片割れを足す（`値\u0000x` / `値\ud800x`）。 */
function inject(base: string, variant: Variant): string {
  return variant === 'nul' ? `${base}\u0000x` : `${base}\ud800x`;
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** Permission を 1 つも持たない利用者。 */
let nobody: AuthorizationContext;
/** `social.read`・`social.write` を持つ API Token で認証した文脈（`externalRef` は Token のときだけ意味を持つ）。 */
let tokenContext: AuthorizationContext;

let siteId: string;
let campaignId: string;
let accountId: string;
let postId: string;
let targetUserId: string;

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
        display_name: 'text input test',
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
    displayName: 'text input test',
    email: `t${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** サンプル Plugin を導入して有効にする（`example-plugin.integration.test.ts` の `activate` を写した）。 */
async function activateExamplePlugin(): Promise<void> {
  const entry = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (entry === undefined) throw new Error('サンプル Plugin が読み込めていない');
  await withConnection(async (connection) => {
    await installPlugin(connection, entry.manifest);
    const outcome = await enablePlugin({
      connection,
      manifest: entry.manifest,
      plugin: entry.plugin,
      authorization: admin,
      candidates: new Map([[PLUGIN_ID, { manifest: entry.manifest, enabled: false }]]),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

/** 表の全行（並べ替えた JSON）。「何も書かない」を前後で比べる。 */
async function tableRows(table: string): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
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

interface Case {
  /** UseCase の `name`。 */
  readonly useCase: string;
  readonly resource: string;
  /** UseCase の項目名（`ValidationError.field`・`details` のキー）。 */
  readonly field: string;
  /** 行を書く UseCase なら、その表（前後で比べる）。一覧・検索なら `null`。 */
  readonly table: string | null;
  /** 片割れだけを見る（`analytics.record` の `key`）。 */
  readonly surrogateOnly?: boolean;
  readonly call: (variant: Variant) => Promise<unknown>;
}

/** 通るだけの SNS 投稿の作成の入力。 */
function postInput(overrides: Record<string, unknown>): Parameters<typeof createSocialPost>[1] {
  return {
    socialAccountId: accountId,
    body: `本文 ${MARKER}`,
    scheduledAt: null,
    status: 'draft',
    ...overrides,
  } as Parameters<typeof createSocialPost>[1];
}

const RANGE = { siteId: null, from: '2026-09-01', to: '2026-09-02' } as const;

/**
 * 設計 §4.2 の 45 組。
 *
 * `site` 7・`campaign` 5・`social.account` 5・`social.post` 12・`user` 5・`webhook` 2・`apiToken` 1・
 * `systemSettings` 1・`plugin.settings` 1・`analytics` 6。
 */
const CASES: readonly Case[] = [
  // site 7
  {
    useCase: 'site.list',
    resource: 'Site',
    field: 'keyword',
    table: null,
    call: (v) =>
      listSites(admin, {
        page: 1,
        perPage: 20,
        status: null,
        keyword: inject(MARKER, v),
        sort: [],
      }),
  },
  ...(['name', 'url', 'description'] as const).map((field): Case => ({
    useCase: 'site.create',
    resource: 'Site',
    field,
    table: 'sites',
    call: (v) =>
      createSite(admin, {
        name: `サイト ${MARKER}`,
        url: `https://${MARKER}.example.com`,
        description: `説明 ${MARKER}`,
        status: 'active',
        [field]: inject(field === 'url' ? `https://${MARKER}.example.com/` : MARKER, v),
      }),
  })),
  ...(['name', 'url', 'description'] as const).map((field): Case => ({
    useCase: 'site.update',
    resource: 'Site',
    field,
    table: 'sites',
    call: (v) =>
      updateSite(admin, {
        id: siteId,
        [field]: inject(field === 'url' ? `https://${MARKER}.example.com/` : MARKER, v),
      }),
  })),
  // campaign 5
  {
    useCase: 'campaign.list',
    resource: 'Campaign',
    field: 'keyword',
    table: null,
    call: (v) =>
      listCampaigns(admin, {
        page: 1,
        perPage: 20,
        status: null,
        keyword: inject(MARKER, v),
        activeOn: null,
        siteId: null,
        sort: [],
      }),
  },
  ...(['name', 'description'] as const).map((field): Case => ({
    useCase: 'campaign.create',
    resource: 'Campaign',
    field,
    table: 'campaigns',
    call: (v) =>
      createCampaign(admin, {
        name: `キャンペーン ${MARKER}`,
        description: '',
        status: 'draft',
        startsOn: '2026-01-01',
        endsOn: null,
        siteIds: [],
        [field]: inject(MARKER, v),
      }),
  })),
  ...(['name', 'description'] as const).map((field): Case => ({
    useCase: 'campaign.update',
    resource: 'Campaign',
    field,
    table: 'campaigns',
    call: (v) => updateCampaign(admin, { id: campaignId, [field]: inject(MARKER, v) }),
  })),
  // social.account 5
  {
    useCase: 'social.account.list',
    resource: 'SocialAccount',
    field: 'provider',
    table: null,
    call: (v) => listSocialAccounts(admin, { page: 1, perPage: 20, provider: inject('x', v) }),
  },
  ...(['displayName', 'handle'] as const).map((field): Case => ({
    useCase: 'social.account.create',
    resource: 'SocialAccount',
    field,
    table: 'social_accounts',
    call: (v) =>
      createSocialAccount(admin, {
        provider: 'x',
        displayName: `表示名 ${MARKER}`,
        handle: '@torifune',
        credential: null,
        status: 'connected',
        [field]: inject(MARKER, v),
      }),
  })),
  ...(['displayName', 'handle'] as const).map((field): Case => ({
    useCase: 'social.account.update',
    resource: 'SocialAccount',
    field,
    table: 'social_accounts',
    call: (v) => updateSocialAccount(admin, { id: accountId, [field]: inject(MARKER, v) }),
  })),
  // social.post 12（作成 5・更新 7）
  {
    useCase: 'social.post.create',
    resource: 'SocialPost',
    field: 'body',
    table: 'social_posts',
    call: (v) => createSocialPost(admin, postInput({ body: inject(MARKER, v) })),
  },
  {
    useCase: 'social.post.create',
    resource: 'SocialPost',
    field: 'link',
    table: 'social_posts',
    call: (v) =>
      createSocialPost(admin, postInput({ link: inject(`https://x.example.com/${MARKER}`, v) })),
  },
  {
    useCase: 'social.post.create',
    resource: 'SocialPost',
    field: 'media',
    table: 'social_posts',
    call: (v) =>
      createSocialPost(
        admin,
        postInput({ media: [{ url: 'https://x.example.com/a.png', alt: inject(MARKER, v) }] }),
      ),
  },
  {
    useCase: 'social.post.create',
    resource: 'SocialPost',
    field: 'providerOptions',
    table: 'social_posts',
    call: (v) =>
      createSocialPost(admin, postInput({ providerOptions: { opt: inject(MARKER, v) } })),
  },
  {
    useCase: 'social.post.create',
    resource: 'SocialPost',
    field: 'externalRef',
    table: 'social_posts',
    // 冪等キーは API Token の名前空間でしか意味を持たないので、Token の文脈で呼ぶ。
    call: (v) => createSocialPost(tokenContext, postInput({ externalRef: inject(MARKER, v) })),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'body',
    table: 'social_posts',
    call: (v) => updateSocialPost(admin, { id: postId, body: inject(MARKER, v) }),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'link',
    table: 'social_posts',
    call: (v) =>
      updateSocialPost(admin, { id: postId, link: inject(`https://x.example.com/${MARKER}`, v) }),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'media',
    table: 'social_posts',
    call: (v) =>
      updateSocialPost(admin, {
        id: postId,
        media: [{ url: 'https://x.example.com/a.png', alt: inject(MARKER, v) }],
      }),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'providerOptions',
    table: 'social_posts',
    call: (v) =>
      updateSocialPost(admin, { id: postId, providerOptions: { opt: inject(MARKER, v) } }),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'externalId',
    table: 'social_posts',
    call: (v) => updateSocialPost(admin, { id: postId, externalId: inject(MARKER, v) }),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'externalUrl',
    table: 'social_posts',
    call: (v) =>
      updateSocialPost(admin, {
        id: postId,
        externalUrl: inject(`https://x.example.com/${MARKER}`, v),
      }),
  },
  {
    useCase: 'social.post.update',
    resource: 'SocialPost',
    field: 'failureReason',
    table: 'social_posts',
    call: (v) => updateSocialPost(admin, { id: postId, failureReason: inject(MARKER, v) }),
  },
  // user 5
  {
    useCase: 'user.list',
    resource: 'User',
    field: 'keyword',
    table: null,
    call: (v) =>
      listUsers(admin, {
        page: 1,
        perPage: 20,
        status: null,
        keyword: inject(MARKER, v),
        sort: [],
      }),
  },
  ...(['displayName', 'email'] as const).map((field): Case => ({
    useCase: 'user.create',
    resource: 'User',
    field,
    table: 'users',
    call: (v) => {
      const loginId = `u${uuidv7().replaceAll('-', '').slice(-12)}`;
      return createUser(admin, {
        loginId,
        displayName: `利用者 ${MARKER}`,
        email: `${loginId}@example.com`,
        password: PASSWORD,
        roles: [],
        request: null,
        [field]: inject(field === 'email' ? `${loginId}@example.com` : MARKER, v),
      });
    },
  })),
  ...(['displayName', 'email'] as const).map((field): Case => ({
    useCase: 'user.update',
    resource: 'User',
    field,
    table: 'users',
    call: (v) =>
      updateUser(admin, {
        id: targetUserId,
        request: null,
        [field]: inject(field === 'email' ? `${MARKER}@example.com` : MARKER, v),
      }),
  })),
  // webhook 2
  ...(['name', 'url'] as const).map((field): Case => ({
    useCase: 'webhook.create',
    resource: 'Webhook',
    field,
    table: 'webhooks',
    call: (v) =>
      createWebhook(admin, {
        name: `Webhook ${MARKER}`,
        url: `https://hooks.example.com/${MARKER}`,
        events: [],
        [field]: inject(field === 'url' ? `https://hooks.example.com/${MARKER}` : MARKER, v),
      }),
  })),
  // apiToken 1
  {
    useCase: 'apiToken.create',
    resource: 'ApiToken',
    field: 'name',
    table: 'api_tokens',
    call: (v) =>
      createApiToken(admin, { name: inject(MARKER, v), scopes: ['site.read'], expiresAt: null }),
  },
  // systemSettings 1
  {
    useCase: 'systemSettings.update',
    resource: 'SystemSettings',
    field: 'serviceName',
    table: 'system_settings',
    call: (v) => updateSystemSettings(admin, { serviceName: inject(MARKER, v) }),
  },
  // plugin.settings 1
  {
    useCase: 'plugin.settings.save',
    resource: 'Plugin の設定',
    field: 'values',
    table: 'plugin_store',
    call: (v) =>
      savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { greeting: inject('hi', v) } }),
  },
  // analytics 6
  ...(['source', 'key'] as const).map((field): Case => ({
    useCase: 'analytics.list',
    resource: 'Analytics',
    field,
    table: null,
    call: (v) => listAnalytics(admin, { ...RANGE, source: null, [field]: inject(MARKER, v) }),
  })),
  ...(['source', 'key'] as const).map((field): Case => ({
    useCase: 'analytics.listPage',
    resource: 'Analytics',
    field,
    table: null,
    call: (v) =>
      listAnalyticsPage(admin, {
        ...RANGE,
        source: null,
        page: 1,
        perPage: 20,
        [field]: inject(MARKER, v),
      }),
  })),
  {
    useCase: 'analytics.breakdown',
    resource: 'Analytics',
    field: 'source',
    table: null,
    call: (v) =>
      listAnalyticsBreakdown(admin, {
        ...RANGE,
        metric: 'path_pageviews',
        source: inject(MARKER, v),
        page: 1,
        perPage: 20,
      }),
  },
  {
    useCase: 'analytics.record',
    resource: 'Analytics',
    field: 'key',
    table: 'analytics',
    surrogateOnly: true,
    call: (v) =>
      recordAnalytics(admin, {
        siteId,
        metricDate: '2026-09-01',
        source: 'text-input-plugin',
        metric: 'visits',
        key: inject(`/${MARKER}`, v),
        value: 1,
      }),
  },
];

/** `CASES` × NUL・片割れ（`surrogateOnly` は片割れだけ）。 */
const MATRIX = CASES.flatMap((entry) =>
  VARIANTS.filter(({ variant }) => entry.surrogateOnly !== true || variant === 'surrogate').map(
    ({ variant, text }) => ({
      ...entry,
      variant,
      text,
      label: `${entry.useCase} の ${entry.field} に${variant === 'nul' ? ' NUL' : '片割れ'}`,
    }),
  ),
);

beforeAll(async () => {
  scratch = await useScratchDatabase('textinput');
  admin = await contextFor(['administrator']);
  nobody = await contextFor([]);

  const token = await createApiToken(admin, {
    name: 'text input token',
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  tokenContext = await buildApiTokenContext(token.plaintext, { ipAddress: null, userAgent: null });

  siteId = (
    await createSite(admin, {
      name: 'サイト',
      url: 'https://site.example.com',
      description: '',
      status: 'active',
    })
  ).id;
  campaignId = (
    await createCampaign(admin, {
      name: 'キャンペーン',
      description: '',
      status: 'draft',
      startsOn: '2026-01-01',
      endsOn: null,
      siteIds: [],
    })
  ).id;
  accountId = (
    await createSocialAccount(admin, {
      provider: 'x',
      displayName: 'とりふね公式',
      handle: '@torifune',
      credential: null,
      status: 'connected',
    })
  ).id;
  postId = (
    await createSocialPost(admin, {
      socialAccountId: accountId,
      body: '本文',
      scheduledAt: null,
      status: 'draft',
    })
  ).post.id;
  targetUserId = (
    await createUser(admin, {
      loginId: 'textinputtarget',
      displayName: '対象の利用者',
      email: 'textinputtarget@example.com',
      password: PASSWORD,
      roles: [],
      request: null,
    })
  ).user.id;

  await activateExamplePlugin();
});

afterAll(async () => {
  resetPluginRegistry();
  resetPermissionRegistry();
  resetPublisherRegistry();
  resetEventHandlers();
  await scratch.dispose();
});

afterEach(() => {
  resetEventHandlers();
});

/* -------------------------------------------------------------------------- */
/* #22 45 組                                                                    */
/* -------------------------------------------------------------------------- */

describe('#22 設計 §4.2 の 45 組', () => {
  it('#22 表が 45 組（site 7・campaign 5・social.account 5・social.post 12・user 5・webhook 2・apiToken 1・systemSettings 1・plugin.settings 1・analytics 6）', () => {
    const counts: Record<string, number> = {};
    for (const entry of CASES) {
      const group = entry.useCase.startsWith('social.')
        ? entry.useCase.split('.').slice(0, 2).join('.')
        : entry.useCase.startsWith('plugin.')
          ? 'plugin.settings'
          : (entry.useCase.split('.')[0] ?? '');
      counts[group] = (counts[group] ?? 0) + 1;
    }

    expect(CASES).toHaveLength(45);
    expect(counts).toEqual({
      site: 7,
      campaign: 5,
      'social.account': 5,
      'social.post': 12,
      user: 5,
      webhook: 2,
      apiToken: 1,
      systemSettings: 1,
      'plugin.settings': 1,
      analytics: 6,
    });
  });

  it.each(MATRIX)(
    '#22 $label → ValidationError（field・details・resource）',
    async ({ call, variant, field, resource, text }) => {
      const error = await rejectionOf(call(variant));

      expect(error).not.toBeInstanceOf(pg.DatabaseError);
      expect(error).toBeInstanceOf(ValidationError);
      const validation = error as ValidationError;
      expect(validation.name).toBe('ValidationError');
      expect(validation.resource).toBe(resource);
      expect(validation.field).toBe(field);
      expect(validation.details).toEqual({ [field]: [text] });
    },
  );

  it.each(MATRIX)('#22 $label → message に送った値が無い', async ({ call, variant }) => {
    const error = await rejectionOf(call(variant));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(MARKER);
    expect((error as Error).message).not.toContain('\u0000');
  });

  it.each(MATRIX.filter((entry) => entry.table !== null))(
    '#22 $label → 何も書かない',
    async ({ call, variant, table }) => {
      const before = await tableRows(table ?? '');

      await call(variant).catch(() => undefined);

      expect(await tableRows(table ?? '')).toEqual(before);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #23 認可が先                                                                 */
/* -------------------------------------------------------------------------- */

describe('#23 認可は使えない文字の検査より先', () => {
  it('#23 site.write を持たない利用者が name に NUL を含めて createSite → ForbiddenError', async () => {
    const error = await rejectionOf(
      createSite(nobody, {
        name: `サイト\u0000${MARKER}`,
        url: 'https://site.example.com',
        description: '',
        status: 'active',
      }),
    );

    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('#23 site.write を持たない利用者が name に片割れを含めて createSite → ForbiddenError', async () => {
    const error = await rejectionOf(
      createSite(nobody, {
        name: `サイト\ud800${MARKER}`,
        url: 'https://site.example.com',
        description: '',
        status: 'active',
      }),
    );

    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

/* -------------------------------------------------------------------------- */
/* #24 入れ子                                                                   */
/* -------------------------------------------------------------------------- */

describe('#24 入れ子の片割れも断る', () => {
  it('#24 createSocialPost の providerOptions の入れ子の値の片割れ → ValidationError(providerOptions)、何も書かない', async () => {
    const before = await tableRows('social_posts');

    const error = await rejectionOf(
      createSocialPost(admin, postInput({ providerOptions: { outer: { inner: 'v\ud800' } } })),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('providerOptions');
    expect((error as ValidationError).details).toEqual({ providerOptions: [SURROGATE_TEXT] });
    expect(await tableRows('social_posts')).toEqual(before);
  });

  it('#24 createSocialPost の providerOptions の入れ子のキーの片割れ → ValidationError(providerOptions)、何も書かない', async () => {
    const before = await tableRows('social_posts');

    const error = await rejectionOf(
      createSocialPost(admin, postInput({ providerOptions: { outer: { 'k\ud800': 1 } } })),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('providerOptions');
    expect(await tableRows('social_posts')).toEqual(before);
  });

  it('#24 savePluginSettings の values の片割れ → ValidationError(values)、何も書かない', async () => {
    const before = await tableRows('plugin_store');

    const error = await rejectionOf(
      savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { greeting: 'g\ud800' } }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('values');
    expect((error as ValidationError).details).toEqual({ values: [SURROGATE_TEXT] });
    expect(await tableRows('plugin_store')).toEqual(before);
  });

  it('#24 savePluginSettings の values のキーの NUL → ValidationError(values)', async () => {
    const error = await rejectionOf(
      savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { 'greeting\u0000': 'g' } }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('values');
    expect((error as ValidationError).details).toEqual({ values: [NUL_TEXT] });
  });

  it('#24 絵文字を含む body・providerOptions の createSocialPost は成功し、そのまま保存される', async () => {
    const body = `いいね${EMOJI}`;
    const providerOptions = { reaction: EMOJI, nested: { [`k${EMOJI}`]: `v${EMOJI}` } };

    const { post } = await createSocialPost(admin, postInput({ body, providerOptions }));

    expect(post.body).toBe(body);
    expect(post.providerOptions).toEqual(providerOptions);
    const stored = await getSocialPost(admin, { id: post.id });
    expect(stored.body).toBe(body);
    expect(stored.providerOptions).toEqual(providerOptions);
  });
});

/* -------------------------------------------------------------------------- */
/* #25 変わらないもの                                                           */
/* -------------------------------------------------------------------------- */

describe('#25 変わらないもの', () => {
  const ID_VARIANTS = [
    ['NUL', () => `${uuidv7()}\u0000`],
    ['片割れ', () => `${uuidv7()}\ud800`],
  ] as const;

  it.each(ID_VARIANTS)('#25 getSite の id に %s → NotFoundError', async (_label, make) => {
    await expect(getSite(admin, { id: make() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(ID_VARIANTS)('#25 getCampaign の id に %s → NotFoundError', async (_label, make) => {
    await expect(getCampaign(admin, { id: make() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(ID_VARIANTS)('#25 getUser の id に %s → NotFoundError', async (_label, make) => {
    await expect(getUser(admin, { id: make() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(ID_VARIANTS)('#25 getSocialPost の id に %s → NotFoundError', async (_label, make) => {
    await expect(getSocialPost(admin, { id: make() })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('#25 listAnalyticsBreakdown の keys に NUL → 従来どおりの ValidationError（keys・従来の文言）', async () => {
    const error = await rejectionOf(
      listAnalyticsBreakdown(admin, {
        ...RANGE,
        metric: 'path_pageviews',
        source: null,
        page: 1,
        perPage: 20,
        keys: ['/ok', '/bad\u0000'],
      }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('keys');
    expect((error as ValidationError).detail).toBe('内訳キーの形式が不正です。');
  });

  it('#25 recordAnalytics の key に NUL → 従来どおりの ValidationError（key・従来の文言）', async () => {
    const error = await rejectionOf(
      recordAnalytics(admin, {
        siteId,
        metricDate: '2026-09-01',
        source: 'text-input-plugin',
        metric: 'visits',
        key: '/bad\u0000',
        value: 1,
      }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('key');
    expect((error as ValidationError).detail).toBe('内訳キーの形式が不正です。');
  });
});
