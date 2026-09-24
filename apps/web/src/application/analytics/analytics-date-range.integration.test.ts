import type { PluginDataApi } from '@torifune/plugin-api';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pruneAccessLogs } from '@/application/analytics/rollup';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { createPluginDataApi } from '@/plugin/data-api';
import { resetPluginRegistry } from '@/plugin/registry';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * アナリティクスの日付と生ログの削除の範囲（046-input-500-nul-and-ranges 設計 §6.4・§6.6、受け入れ条件 #39・#45）。
 *
 * - #39（B2）：Data API `analytics.list({ from: '0000-01-01', to: '0000-01-02' })` → `ValidationError`（`field === 'to'`）。
 *   `analytics.record({ metricDate: '0000-01-01', … })` → `ValidationError`（`field === 'metricDate'`）。`0001-01-01` は成功。
 *   いまは PostgreSQL の `date` が西暦 0 年を断り（`22008`）、`DatabaseError` がそのまま Plugin へ上がる
 * - #45（B4）：`pruneAccessLogs(connection, 36501)`・`(connection, 0)`・`(connection, 1.5)` → `ValidationError`（`field === 'pruneOlderThanDays'`）。
 *   `36500` は成功し、36500 日より古い生ログだけが消える（HTTP 以外の呼び出しの守り）
 */

const PLUGIN_ID = 'date-range-plugin';
const DAY_MS = 24 * 60 * 60 * 1000;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let siteId: string;

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `ad${suffix}`,
        email: `ad${suffix}@example.com`,
        display_name: 'analytics date range test',
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
    loginId: `ad${suffix}`,
    displayName: 'analytics date range test',
    email: `ad${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(): PluginDataApi {
  return createPluginDataApi({
    pluginId: PLUGIN_ID,
    declaredPermissions: new Set(['analytics.read']),
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
}

async function insertAccessLog(occurredAt: Date, path: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('access_logs')
      .values({
        id: uuidv7(),
        site_id: siteId,
        occurred_at: occurredAt,
        path,
        referrer_host: null,
        visitor_hash: 'v',
        device: 'desktop',
      })
      .execute();
  });
}

async function accessLogPaths(): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const rows = await connection.db.selectFrom('access_logs').select('path').execute();
    return rows.map((row) => row.path).sort();
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('analyticsdaterange');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  siteId = (
    await createSite(admin, {
      name: 'サイト',
      url: 'https://site.example.com',
      description: '',
      status: 'active',
    })
  ).id;
});

afterEach(async () => {
  resetEventHandlers();
  resetPluginRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('access_logs').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #39 Data API の西暦 0 年                                                      */
/* -------------------------------------------------------------------------- */

describe('#39 Data API の西暦 0 年は ValidationError', () => {
  it("#39 analytics.list({ from: '0000-01-01', to: '0000-01-02' }) → ValidationError（field === 'to'）", async () => {
    const error = await rejectionOf(
      apiFor().analytics.list({ from: '0000-01-01', to: '0000-01-02' }),
    );

    expect(error).not.toBeInstanceOf(pg.DatabaseError);
    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('to');
    expect((error as ErrorShape).detail).toBe('期間を確認してください（開始日以降にする）。');
  });

  it("#39 analytics.record({ metricDate: '0000-01-01' }) → ValidationError（field === 'metricDate'）", async () => {
    const error = await rejectionOf(
      apiFor().analytics.record({ siteId, metricDate: '0000-01-01', metric: 'visits', value: 1 }),
    );

    expect(error).not.toBeInstanceOf(pg.DatabaseError);
    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('metricDate');
    expect((error as ErrorShape).detail).toBe('日付の形式が不正です。');
  });

  it("#39 analytics.record({ metricDate: '0000-02-29' }) → ValidationError（field === 'metricDate'）", async () => {
    const error = await rejectionOf(
      apiFor().analytics.record({ siteId, metricDate: '0000-02-29', metric: 'visits', value: 1 }),
    );

    expect((error as ErrorShape).name).toBe('ValidationError');
    expect((error as ErrorShape).field).toBe('metricDate');
  });

  it("#39 analytics.record({ metricDate: '0001-01-01' }) → 成功", async () => {
    await expect(
      apiFor().analytics.record({ siteId, metricDate: '0001-01-01', metric: 'visits', value: 3 }),
    ).resolves.toBeUndefined();
  });

  it("#39 analytics.list({ from: '0001-01-01', to: '0001-01-01' }) → 成功し、記録した値が読める", async () => {
    await apiFor().analytics.record({
      siteId,
      metricDate: '0001-01-01',
      metric: 'visits',
      value: 3,
    });

    const points = await apiFor().analytics.list({
      siteId,
      from: '0001-01-01',
      to: '0001-01-01',
      metric: 'visits',
    });

    expect(points.map((point) => point.value)).toEqual([3]);
  });
});

/* -------------------------------------------------------------------------- */
/* #45 pruneAccessLogs の上限                                                    */
/* -------------------------------------------------------------------------- */

describe('#45 pruneAccessLogs は 1〜36500 の整数だけを受ける', () => {
  it.each([36501, 0, 1.5, 2461309, 2147483648])(
    "#45 pruneAccessLogs(connection, %s) → ValidationError（field === 'pruneOlderThanDays'）",
    async (days) => {
      const error = await rejectionOf(
        withConnection((connection) => pruneAccessLogs(connection, days)),
      );

      expect(error).not.toBeInstanceOf(pg.DatabaseError);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('pruneOlderThanDays');
    },
  );

  it('#45 pruneAccessLogs(connection, 36501) は生ログを消さない', async () => {
    await insertAccessLog(new Date(Date.now() - 36_600 * DAY_MS), '/very-old');

    await rejectionOf(withConnection((connection) => pruneAccessLogs(connection, 36501)));

    expect(await accessLogPaths()).toEqual(['/very-old']);
  });

  it('#45 pruneAccessLogs(connection, 36500) → 成功し、36500 日より古い生ログだけが消える', async () => {
    await insertAccessLog(new Date(Date.now() - 36_600 * DAY_MS), '/very-old');
    await insertAccessLog(new Date(Date.now() - 36_400 * DAY_MS), '/old-but-kept');
    await insertAccessLog(new Date(Date.now() - 1 * DAY_MS), '/recent');

    const deleted = await withConnection((connection) => pruneAccessLogs(connection, 36500));

    expect(deleted).toBe(1);
    expect(await accessLogPaths()).toEqual(['/old-but-kept', '/recent']);
  });
});
