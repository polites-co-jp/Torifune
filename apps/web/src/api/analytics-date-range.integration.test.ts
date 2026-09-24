import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as breakdownRoute } from '@/app/api/v1/analytics/breakdown/route';
import { POST as rollupRoute } from '@/app/api/v1/analytics/rollup/route';
import { GET as analyticsRoute } from '@/app/api/v1/analytics/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * アナリティクスの日付と `pruneOlderThanDays` の範囲を HTTP で確かめる
 * （046-input-500-nul-and-ranges 設計 §6.4・§6.6、受け入れ条件 #38・#44）。
 *
 * - #38（B2）：`GET /analytics`・`GET /analytics/breakdown`・`POST /analytics/rollup` の `from` / `to` に西暦 0 年 → 500 ではなく
 *   422 `details.to`（`期間を確認してください（開始日以降にする）。`）。`rollup` は `job_runs` の行を増やさない。
 *   西暦 1 年（`0001-01-01`〜`0001-01-02`）は 3 経路とも 200
 * - #44（B4）：`POST /analytics/rollup` の `pruneOlderThanDays` に `36500` → 200。`36501` 以上 → 422 `details.pruneOlderThanDays`
 *   （`36500以下で指定してください。`）で、集計の前に返る（`job_runs` の行を増やさない）。
 *   `system.manage` を持たない Token でも、36501 以上は 403 ではなく 422（Zod の上限は `analytics.read` の後・集計の前）
 *
 * ルートを直接叩く（`list-query.integration.test.ts` の形）。認証は Bearer の API Token。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;
const RANGE_TEXT = '期間を確認してください（開始日以降にする）。';
const PRUNE_TEXT = '36500以下で指定してください。';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** `analytics.read` と `system.manage` を持つ Token。 */
let token: string;
/** `analytics.read` だけを持つ Token。 */
let readOnlyToken: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `ar${suffix}`,
        email: `ar${suffix}@example.com`,
        display_name: 'analytics range api test',
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
    loginId: `ar${suffix}`,
    displayName: 'analytics range api test',
    email: `ar${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function issueToken(scopes: readonly string[]): Promise<string> {
  const created = await createApiToken(admin, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return created.plaintext;
}

async function resultOf(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function getAnalytics(query: string, bearer = token): Promise<JsonResult> {
  return resultOf(
    await analyticsRoute(
      new Request(`${BASE}/analytics?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ),
  );
}

async function getBreakdown(query: string, bearer = token): Promise<JsonResult> {
  return resultOf(
    await breakdownRoute(
      new Request(`${BASE}/analytics/breakdown?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${bearer}` },
      }),
    ),
  );
}

async function postRollup(body: unknown, bearer = token): Promise<JsonResult> {
  return resultOf(
    await rollupRoute(
      new Request(`${BASE}/analytics/rollup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function jobRunCount(): Promise<number> {
  return withConnection(async (connection) => {
    const result = await sql<{ count: string }>`SELECT count(*) AS count FROM job_runs`.execute(
      connection.db,
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('analyticsrangeapi');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  token = await issueToken(['analytics.read', 'system.manage']);
  readOnlyToken = await issueToken(['analytics.read']);
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #38 西暦 0 年                                                                */
/* -------------------------------------------------------------------------- */

describe('#38 from / to の西暦 0 年は 500 ではなく 422 details.to', () => {
  it('#38 GET /analytics?from=0000-01-01&to=0000-01-02 → 422、details.to が期間の文言', async () => {
    const result = await getAnalytics('from=0000-01-01&to=0000-01-02');

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ to: [RANGE_TEXT] });
  });

  it('#38 GET /analytics/breakdown?from=0000-01-01&to=0000-01-02 → 422、details.to が期間の文言', async () => {
    const result = await getBreakdown('from=0000-01-01&to=0000-01-02&metric=path_pageviews');

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ to: [RANGE_TEXT] });
  });

  it("#38 POST /analytics/rollup { from: '0000-01-01', to: '0000-01-02' } → 422、details.to が期間の文言", async () => {
    const result = await postRollup({ from: '0000-01-01', to: '0000-01-02' });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ to: [RANGE_TEXT] });
  });

  it("#38 POST /analytics/rollup { from: '0000-01-01', to: '0000-01-02' } → job_runs の行が増えない", async () => {
    const before = await jobRunCount();

    await postRollup({ from: '0000-01-01', to: '0000-01-02' });

    expect(await jobRunCount()).toBe(before);
  });

  it('#38 GET /analytics?from=0000-02-29&to=0000-02-29 → 422 details.to', async () => {
    const result = await getAnalytics('from=0000-02-29&to=0000-02-29');

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ to: [RANGE_TEXT] });
  });

  it('#38 GET /analytics?from=0001-01-01&to=0001-01-02 → 200', async () => {
    const result = await getAnalytics('from=0001-01-01&to=0001-01-02');

    expect(result.status, result.text).toBe(200);
  });

  it('#38 GET /analytics/breakdown?from=0001-01-01&to=0001-01-02 → 200', async () => {
    const result = await getBreakdown('from=0001-01-01&to=0001-01-02&metric=path_pageviews');

    expect(result.status, result.text).toBe(200);
  });

  it("#38 POST /analytics/rollup { from: '0001-01-01', to: '0001-01-02' } → 200", async () => {
    const result = await postRollup({ from: '0001-01-01', to: '0001-01-02' });

    expect(result.status, result.text).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* #44 pruneOlderThanDays                                                      */
/* -------------------------------------------------------------------------- */

describe('#44 pruneOlderThanDays は 36500 まで', () => {
  it('#44 pruneOlderThanDays: 36500 → 200（system.manage を持つ Token）', async () => {
    const result = await postRollup({ pruneOlderThanDays: 36500 });

    expect(result.status, result.text).toBe(200);
  });

  it.each([36501, 2461309, 3000000, 2147483648, 9007199254740991])(
    '#44 pruneOlderThanDays: %s → 422、details.pruneOlderThanDays が上限の文言',
    async (days) => {
      const result = await postRollup({ pruneOlderThanDays: days });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ pruneOlderThanDays: [PRUNE_TEXT] });
    },
  );

  it.each([36501, 2461309, 3000000, 2147483648, 9007199254740991])(
    '#44 pruneOlderThanDays: %s → job_runs の行が増えない（集計の前に返る）',
    async (days) => {
      const before = await jobRunCount();

      await postRollup({ pruneOlderThanDays: days });

      expect(await jobRunCount()).toBe(before);
    },
  );

  it('#44 system.manage を持たない Token でも pruneOlderThanDays: 36501 は 403 ではなく 422', async () => {
    const result = await postRollup({ pruneOlderThanDays: 36501 }, readOnlyToken);

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ pruneOlderThanDays: [PRUNE_TEXT] });
  });

  it('#44 変わらないもの：pruneOlderThanDays: 0 → 422（下限）', async () => {
    const result = await postRollup({ pruneOlderThanDays: 0 });

    expect(result.status, result.text).toBe(422);
    expect(Object.keys(detailsOf(result))).toEqual(['pruneOlderThanDays']);
  });
});
