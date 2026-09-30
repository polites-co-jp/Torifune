import {
  PluginDataInputError,
  PluginPermissionError,
  type PluginDataApi,
} from '@torifune/plugin-api';
import { sql } from 'kysely';
import pg from 'pg';
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
 * Data API の文字列の引数の使えない文字（046-input-500-nul-and-ranges 設計 §9.2、受け入れ条件 #26〜#29）。
 *
 * - #26：作成・更新・検索の文字列の引数（15 か所）に NUL（U+0000）・対になっていないサロゲート（片割れ）を含むと、
 *   Postgres の `DatabaseError` ではなく Core の `ValidationError`（`name === 'ValidationError'`、`field` は UseCase の項目名。
 *   `markFailed` の `reason` は `'failureReason'`）で reject され、`message` に値が無く、何も書かれない。
 *   `analytics.record` の `key` の片割れも `ValidationError`（`field === 'key'`、サロゲートの文言）
 * - #27：`analytics.record` の `siteId` が UUID の形でない（`'abc'`・NUL を含む値）→ `ValidationError`（`field === 'siteId'`、`UUID の形で指定してください。`）
 * - #28：検査の順は Manifest の宣言 → 利用者の Permission → 入力（`PluginPermissionError`・`ForbiddenError` が先）
 * - #29：変わらないもの（`get()` の `null`、一覧の `PluginDataInputError`）
 *
 * `createPluginDataApi` を直接組む（`data-api-campaign-links.integration.test.ts` の `apiFor` を写した）。
 * **ソースに壊れた文字を置かない。** NUL と片割れはエスケープで書く。
 */

const PLUGIN_ID = 'text-input-plugin';
const NUL_TEXT = '使用できない文字（NUL）が含まれています。';
const SURROGATE_TEXT = '使用できない文字（対になっていないサロゲート）が含まれています。';
const MARKER = 'marker-046';

const ALL = [
  'site.read',
  'site.write',
  'campaign.read',
  'campaign.write',
  'analytics.read',
  'social.read',
  'social.write',
  'user.manage',
];

type Variant = 'nul' | 'surrogate';

const VARIANTS: readonly { readonly variant: Variant; readonly text: string }[] = [
  { variant: 'nul', text: NUL_TEXT },
  { variant: 'surrogate', text: SURROGATE_TEXT },
];

function inject(base: string, variant: Variant): string {
  return variant === 'nul' ? `${base}\u0000x` : `${base}\ud800x`;
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** Permission を 1 つも持たない利用者。 */
let nobody: AuthorizationContext;
let siteId: string;
let campaignId: string;
let accountId: string;
let postId: string;

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
        display_name: 'data api text input test',
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
    displayName: 'data api text input test',
    email: `d${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(
  declared: readonly string[] = ALL,
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

interface ErrorShape {
  readonly name?: unknown;
  readonly field?: unknown;
  readonly detail?: unknown;
  readonly message?: unknown;
  readonly details?: Readonly<Record<string, readonly string[]>>;
}

/** 表の全行（並べ替えた JSON）。「何も書かれない」を前後で比べる。 */
async function tableRows(table: string): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
  });
}

interface Case {
  readonly method: string;
  /** Plugin が渡した引数の名前。 */
  readonly argument: string;
  /** UseCase の項目名（`ValidationError.field`）。 */
  readonly field: string;
  /** 書き込みのメソッドなら、その表。検索なら `null`。 */
  readonly table: string | null;
  readonly call: (variant: Variant) => Promise<unknown>;
}

const RANGE = { from: '2026-09-01', to: '2026-09-02' } as const;

/** 設計 #26 の 15 か所。 */
const CASES: readonly Case[] = [
  ...(['name', 'url', 'description'] as const).map((field): Case => ({
    method: 'sites.create',
    argument: field,
    field,
    table: 'sites',
    call: (v) =>
      apiFor().sites.create({
        name: `サイト ${MARKER}`,
        url: `https://${MARKER}.example.com`,
        description: '',
        [field]: inject(field === 'url' ? `https://${MARKER}.example.com/` : MARKER, v),
      }),
  })),
  ...(['name', 'url', 'description'] as const).map((field): Case => ({
    method: 'sites.update',
    argument: field,
    field,
    table: 'sites',
    call: (v) =>
      apiFor().sites.update(siteId, {
        [field]: inject(field === 'url' ? `https://${MARKER}.example.com/` : MARKER, v),
      }),
  })),
  ...(['name', 'description'] as const).map((field): Case => ({
    method: 'campaigns.create',
    argument: field,
    field,
    table: 'campaigns',
    call: (v) =>
      apiFor().campaigns.create({
        name: `キャンペーン ${MARKER}`,
        startsOn: '2026-01-01',
        [field]: inject(MARKER, v),
      }),
  })),
  ...(['name', 'description'] as const).map((field): Case => ({
    method: 'campaigns.update',
    argument: field,
    field,
    table: 'campaigns',
    call: (v) => apiFor().campaigns.update(campaignId, { [field]: inject(MARKER, v) }),
  })),
  ...(['source', 'key'] as const).map((field): Case => ({
    method: 'analytics.list',
    argument: field,
    field,
    table: null,
    call: (v) => apiFor().analytics.list({ ...RANGE, [field]: inject(MARKER, v) }),
  })),
  {
    method: 'socialPosts.markPublished',
    argument: 'externalId',
    field: 'externalId',
    table: 'social_posts',
    call: (v) => apiFor().socialPosts.markPublished(postId, { externalId: inject(MARKER, v) }),
  },
  {
    method: 'socialPosts.markPublished',
    argument: 'externalUrl',
    field: 'externalUrl',
    table: 'social_posts',
    call: (v) =>
      apiFor().socialPosts.markPublished(postId, {
        externalUrl: inject(`https://x.example.com/${MARKER}`, v),
      }),
  },
  {
    method: 'socialPosts.markFailed',
    argument: 'reason',
    field: 'failureReason',
    table: 'social_posts',
    call: (v) => apiFor().socialPosts.markFailed(postId, inject(MARKER, v)),
  },
];

const MATRIX = CASES.flatMap((entry) =>
  VARIANTS.map(({ variant, text }) => ({
    ...entry,
    variant,
    text,
    label: `${entry.method} の ${entry.argument} に${variant === 'nul' ? ' NUL' : '片割れ'}`,
  })),
);

beforeAll(async () => {
  scratch = await useScratchDatabase('dataapitextinput');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  nobody = await contextFor([]);

  siteId = (await apiFor().sites.create({ name: 'サイト', url: 'https://site.example.com' })).id;
  campaignId = (await apiFor().campaigns.create({ name: 'キャンペーン', startsOn: '2026-01-01' }))
    .id;
  accountId = (
    await createSocialAccount(admin, {
      provider: 'x',
      displayName: 'アカウント',
      handle: '@data-api-text',
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
});

afterEach(async () => {
  resetEventHandlers();
  resetPublisherRegistry();
  resetPluginRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #26 15 か所 × NUL・片割れ                                                     */
/* -------------------------------------------------------------------------- */

describe('#26 作成・更新・検索の文字列の引数の NUL・片割れは ValidationError で reject される', () => {
  it('#26 表が 15 か所', () => {
    expect(CASES).toHaveLength(15);
  });

  it.each(MATRIX)(
    '#26 $label → name === "ValidationError"・field・details',
    async ({ call, variant, field, text }) => {
      const error = await rejectionOf(call(variant));

      expect(error).not.toBeInstanceOf(pg.DatabaseError);
      expect((error as ErrorShape).name).toBe('ValidationError');
      expect((error as ErrorShape).field).toBe(field);
      expect((error as ErrorShape).details).toEqual({ [field]: [text] });
    },
  );

  it.each(MATRIX)('#26 $label → message に送った値が無い', async ({ call, variant }) => {
    const error = await rejectionOf(call(variant));

    expect(String((error as ErrorShape).message)).not.toContain(MARKER);
  });

  it.each(MATRIX.filter((entry) => entry.table !== null))(
    '#26 $label → 何も書かれない',
    async ({ call, variant, table }) => {
      const before = await tableRows(table ?? '');

      await call(variant).catch(() => undefined);

      expect(await tableRows(table ?? '')).toEqual(before);
    },
  );

  it('#26 analytics.record の key に片割れ → ValidationError（field === "key"、サロゲートの文言）', async () => {
    const error = await rejectionOf(
      apiFor().analytics.record({
        siteId,
        metricDate: '2026-09-01',
        metric: 'visits',
        key: `/${MARKER}\ud800`,
        value: 1,
      }),
    );

    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('key');
    expect((error as ErrorShape).details).toEqual({ key: [SURROGATE_TEXT] });
    expect(String((error as ErrorShape).message)).not.toContain(MARKER);
  });

  it('#26 analytics.record の key に片割れ → 何も書かれない', async () => {
    const before = await tableRows('analytics');

    await apiFor()
      .analytics.record({
        siteId,
        metricDate: '2026-09-01',
        metric: 'visits',
        key: `/${MARKER}\ud800`,
        value: 1,
      })
      .catch(() => undefined);

    expect(await tableRows('analytics')).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #27 analytics.record の siteId の形                                           */
/* -------------------------------------------------------------------------- */

describe('#27 analytics.record の siteId が UUID の形でなければ ValidationError', () => {
  const SHAPE = 'UUID の形で指定してください。';

  it.each([
    ["'abc'", () => 'abc'],
    ['NUL を含む値', () => `${siteId}\u0000`],
    ['NUL だけ', () => '\u0000'],
  ])(
    '#27 siteId: %s → ValidationError（field === "siteId"、UUID の形の文言）',
    async (_label, make) => {
      const error = await rejectionOf(
        apiFor().analytics.record({
          siteId: make(),
          metricDate: '2026-09-01',
          metric: 'visits',
          value: 1,
        }),
      );

      expect(error).not.toBeInstanceOf(pg.DatabaseError);
      expect((error as ErrorShape).name).toBe('ValidationError');
      expect((error as ErrorShape).field).toBe('siteId');
      expect((error as ErrorShape).detail).toBe(SHAPE);
      expect(String((error as ErrorShape).message)).not.toContain('abc');
    },
  );

  it('#27 存在するサイトの ID → 成功（従来どおり）', async () => {
    await expect(
      apiFor().analytics.record({
        siteId,
        metricDate: '2026-09-01',
        metric: 'visits',
        value: 1,
      }),
    ).resolves.toBeUndefined();

    await expect(
      apiFor().analytics.list({ siteId, ...RANGE, metric: 'visits' }),
    ).resolves.toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #28 検査の順                                                                 */
/* -------------------------------------------------------------------------- */

describe('#28 検査の順は Manifest の宣言 → 利用者の Permission → 入力', () => {
  it('#28 site.write を宣言していない Plugin の sites.create（name に NUL）→ PluginPermissionError', async () => {
    const error = await rejectionOf(
      apiFor(['site.read']).sites.create({ name: 'n\u0000', url: 'https://x.example.com' }),
    );

    expect(error).toBeInstanceOf(PluginPermissionError);
  });

  it('#28 site.write を宣言していても利用者が site.write を持たなければ ForbiddenError（name に NUL）', async () => {
    const error = await rejectionOf(
      apiFor(ALL, nobody).sites.create({ name: 'n\u0000', url: 'https://x.example.com' }),
    );

    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('#28 site.write を宣言していない Plugin の sites.create（name に片割れ）→ PluginPermissionError', async () => {
    const error = await rejectionOf(
      apiFor(['site.read']).sites.create({ name: 'n\ud800', url: 'https://x.example.com' }),
    );

    expect(error).toBeInstanceOf(PluginPermissionError);
  });

  it('#28 site.write を宣言していても利用者が site.write を持たなければ ForbiddenError（name に片割れ）', async () => {
    const error = await rejectionOf(
      apiFor(ALL, nobody).sites.create({ name: 'n\ud800', url: 'https://x.example.com' }),
    );

    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

/* -------------------------------------------------------------------------- */
/* #29 変わらないもの                                                           */
/* -------------------------------------------------------------------------- */

describe('#29 変わらないもの', () => {
  const NUL_ID = () => `${uuidv7()}\u0000`;

  it('#29 sites.get の NUL を含む ID → null', async () => {
    await expect(apiFor().sites.get(NUL_ID())).resolves.toBeNull();
  });

  it('#29 campaigns.get の NUL を含む ID → null', async () => {
    await expect(apiFor().campaigns.get(NUL_ID())).resolves.toBeNull();
  });

  it('#29 socialAccounts.get の NUL を含む ID → null', async () => {
    await expect(apiFor().socialAccounts.get(NUL_ID())).resolves.toBeNull();
  });

  it('#29 socialPosts.get の NUL を含む ID → null', async () => {
    await expect(apiFor().socialPosts.get(NUL_ID())).resolves.toBeNull();
  });

  it('#29 users.get の NUL を含む ID → null', async () => {
    await expect(apiFor().users.get(NUL_ID())).resolves.toBeNull();
  });

  it('#29 socialPosts.list({ accountId }) の NUL → PluginDataInputError', async () => {
    await expect(
      apiFor().socialPosts.list({ accountId: `${accountId}\u0000` }),
    ).rejects.toBeInstanceOf(PluginDataInputError);
  });

  it('#29 campaigns.list({ siteId }) の NUL → PluginDataInputError', async () => {
    await expect(apiFor().campaigns.list({ siteId: `${siteId}\u0000` })).rejects.toBeInstanceOf(
      PluginDataInputError,
    );
  });
});
