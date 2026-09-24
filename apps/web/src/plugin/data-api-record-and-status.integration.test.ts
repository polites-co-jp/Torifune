import type { PluginDataApi } from '@torifune/plugin-api';
import { sql } from 'kysely';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createPluginDataApi } from './data-api';
import { resetPluginRegistry } from './registry';

/**
 * Data API の B1〜B4 以外の 500（046-input-500-nul-and-ranges 設計 §1.2.5・§9.2 の N1〜N3、受け入れ条件 #47〜#49。ユーザー裁定 3）。
 *
 * - #47（N1）：`sites.create` / `sites.update` / `campaigns.create` / `campaigns.update` の `status` に列挙外の値（`'bogus'`）
 *   → `ValidationError`（`field === 'status'`、`状態の値が正しくありません。`）。Postgres の `DatabaseError`（`23514`）ではない。何も書かれない
 * - #48（N2）：`analytics.record` の `siteId` が UUID の形で存在しない → `ValidationError`（`field === 'siteId'`、`存在しないWebサイトです。`）
 * - #49（N3）：`analytics.record` の `value` が `Number.MAX_SAFE_INTEGER` を超える（切り捨ての後）→ `ValidationError`（`field === 'value'`、
 *   `9007199254740991以下の数値を指定してください。`）。`Number.MAX_SAFE_INTEGER` ちょうどは成功
 *
 * `createPluginDataApi` を直接組む（`data-api-text-input.integration.test.ts` と同じ利用者・Plugin の作り方）。
 * 「何も書かれない」は表の行を前後で比べて確かめる。
 */

const PLUGIN_ID = 'record-status-plugin';
const ALL = ['site.read', 'site.write', 'campaign.read', 'campaign.write', 'analytics.read'];
const STATUS_TEXT = '状態の値が正しくありません。';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let siteId: string;
let campaignId: string;

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `r${suffix}`,
        email: `r${suffix}@example.com`,
        display_name: 'data api record and status test',
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
    loginId: `r${suffix}`,
    displayName: 'data api record and status test',
    email: `r${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(): PluginDataApi {
  return createPluginDataApi({
    pluginId: PLUGIN_ID,
    declaredPermissions: new Set(ALL),
    context: admin,
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
}

async function tableRows(table: string): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('dataapirecordstatus');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  siteId = (await apiFor().sites.create({ name: 'サイト', url: 'https://site.example.com' })).id;
  campaignId = (await apiFor().campaigns.create({ name: 'キャンペーン', startsOn: '2026-01-01' }))
    .id;
});

afterEach(async () => {
  resetEventHandlers();
  resetPluginRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #47 N1：列挙外の status                                                      */
/* -------------------------------------------------------------------------- */

const STATUS_CASES = [
  {
    method: 'sites.create',
    table: 'sites',
    call: (status: string) =>
      apiFor().sites.create({ name: 'サイト2', url: 'https://site2.example.com', status }),
  },
  {
    method: 'sites.update',
    table: 'sites',
    call: (status: string) => apiFor().sites.update(siteId, { status }),
  },
  {
    method: 'campaigns.create',
    table: 'campaigns',
    call: (status: string) =>
      apiFor().campaigns.create({ name: 'キャンペーン2', startsOn: '2026-01-01', status }),
  },
  {
    method: 'campaigns.update',
    table: 'campaigns',
    call: (status: string) => apiFor().campaigns.update(campaignId, { status }),
  },
] as const;

describe('#47 列挙外の status は ValidationError', () => {
  it.each(STATUS_CASES)(
    "#47 $method の status: 'bogus' → ValidationError（field === 'status'）",
    async ({ call }) => {
      const error = await rejectionOf(call('bogus'));

      expect(error).not.toBeInstanceOf(pg.DatabaseError);
      expect((error as ErrorShape).name).toBe('ValidationError');
      expect((error as ErrorShape).field).toBe('status');
      expect((error as ErrorShape).detail).toBe(STATUS_TEXT);
      expect(String((error as ErrorShape).message)).not.toContain('bogus');
    },
  );

  it.each(STATUS_CASES)(
    "#47 $method の status: 'bogus' → 何も書かれない",
    async ({ call, table }) => {
      const before = await tableRows(table);

      await call('bogus').catch(() => undefined);

      expect(await tableRows(table)).toEqual(before);
    },
  );

  it("#47 sites.create の status: 'archived'（列挙の値）→ 成功", async () => {
    const site = await apiFor().sites.create({
      name: 'サイト3',
      url: 'https://site3.example.com',
      status: 'archived',
    });

    expect(site.status).toBe('archived');
  });

  it("#47 sites.update の status: 'archived'（列挙の値）→ 成功", async () => {
    const site = await apiFor().sites.update(siteId, { status: 'archived' });

    expect(site.status).toBe('archived');
  });

  it("#47 campaigns.create の status: 'running'（列挙の値）→ 成功", async () => {
    const campaign = await apiFor().campaigns.create({
      name: 'キャンペーン3',
      startsOn: '2026-01-01',
      status: 'running',
    });

    expect(campaign.status).toBe('running');
  });

  it("#47 campaigns.update の status: 'finished'（列挙の値）→ 成功", async () => {
    const campaign = await apiFor().campaigns.update(campaignId, { status: 'finished' });

    expect(campaign.status).toBe('finished');
  });
});

/* -------------------------------------------------------------------------- */
/* #48 N2：存在しない siteId                                                     */
/* -------------------------------------------------------------------------- */

describe('#48 analytics.record の siteId が UUID の形で存在しなければ ValidationError', () => {
  it("#48 存在しない UUID → ValidationError（field === 'siteId'、存在しないWebサイトです。）", async () => {
    const missing = uuidv7();

    const error = await rejectionOf(
      apiFor().analytics.record({
        siteId: missing,
        metricDate: '2026-09-01',
        metric: 'visits',
        value: 1,
      }),
    );

    expect(error).not.toBeInstanceOf(pg.DatabaseError);
    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('siteId');
    expect((error as ErrorShape).detail).toBe('存在しないWebサイトです。');
    expect(String((error as ErrorShape).message)).not.toContain(missing);
  });

  it('#48 存在しない UUID → 何も書かれない', async () => {
    const before = await tableRows('analytics');

    await apiFor()
      .analytics.record({ siteId: uuidv7(), metricDate: '2026-09-01', metric: 'visits', value: 1 })
      .catch(() => undefined);

    expect(await tableRows('analytics')).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */
/* #49 N3：value の上限                                                          */
/* -------------------------------------------------------------------------- */

describe('#49 analytics.record の value の上限は Number.MAX_SAFE_INTEGER', () => {
  it('#49 value: Number.MAX_SAFE_INTEGER → 成功し、その値が読める', async () => {
    await apiFor().analytics.record({
      siteId,
      metricDate: '2026-09-01',
      metric: 'visits',
      value: Number.MAX_SAFE_INTEGER,
    });

    const points = await apiFor().analytics.list({
      siteId,
      from: '2026-09-01',
      to: '2026-09-01',
      metric: 'visits',
    });
    expect(points.map((point) => point.value)).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it.each([
    ['Number.MAX_SAFE_INTEGER + 2', Number.MAX_SAFE_INTEGER + 2],
    ['1e300', 1e300],
  ])("#49 value: %s → ValidationError（field === 'value'）", async (_label, value) => {
    const error = await rejectionOf(
      apiFor().analytics.record({ siteId, metricDate: '2026-09-01', metric: 'visits', value }),
    );

    expect(error).not.toBeInstanceOf(pg.DatabaseError);
    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('value');
    expect((error as ErrorShape).detail).toBe('9007199254740991以下の数値を指定してください。');
  });

  it.each([
    ['Number.MAX_SAFE_INTEGER + 2', Number.MAX_SAFE_INTEGER + 2],
    ['1e300', 1e300],
  ])('#49 value: %s → 何も書かれない', async (_label, value) => {
    const before = await tableRows('analytics');

    await apiFor()
      .analytics.record({ siteId, metricDate: '2026-09-01', metric: 'visits', value })
      .catch(() => undefined);

    expect(await tableRows('analytics')).toEqual(before);
  });
});
