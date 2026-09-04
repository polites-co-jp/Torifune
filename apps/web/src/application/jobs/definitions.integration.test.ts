import { sql } from 'kysely';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { analyticsTimeZone } from '@/application/analytics/timezone';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { emit, resetEventHandlers, subscribe } from '@/application/events';
import { ROLLUP_JOB, WEBHOOK_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { withConnection } from '@/application/transaction';
import { createWebhook } from '@/application/webhook/webhook-use-cases';
import type { UserIdentity } from '@/authentication/identity';
import {
  dateInTimeZone,
  dateOnly,
  daysAgoInTimeZone,
  todayInTimeZone,
} from '@/domain/analytics/day';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 登録するジョブ（029-scheduled-jobs 設計 §6.2、受け入れ条件 #34〜#37）。
 *
 * - `ROLLUP_JOB.run(connection, undefined)`：対象期間は「最後に成功した実行の開始日〜今日、最大 7 日、成功が無ければ昨日〜今日」
 *   （裁定 #5）。summary は `{ from, to, days, points }`
 * - `ROLLUP_JOB.run(connection, { from, to })`：指定した範囲だけ
 * - `WEBHOOK_JOB.run(connection, undefined)`：予約済みの配信を送る。summary は `{ attempted, delivered, failed }`
 * - `analytics.rolledUp` は集計が済んだ単位で 1 回（定期実行でも同じ）
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** テスト用の受け手（`webhook.integration.test.ts` と同じ）。 */
async function receiver(): Promise<{
  url: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `j${suffix}`,
        email: `j${suffix}@example.com`,
        display_name: 'jobs test',
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
    loginId: `j${suffix}`,
    displayName: 'jobs test',
    email: `j${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function makeSite(): Promise<string> {
  const id = uuidv7();
  await withConnection((connection) =>
    connection.db
      .insertInto('sites')
      .values({ id, name: `jobs-${id.slice(-6)}`, url: 'https://example.com' })
      .execute(),
  );
  return id;
}

/** 生ログを 1 件入れる（`occurred_at` は ISO 8601）。 */
async function insertLog(siteId: string, at: string, device: 'desktop' | 'bot' = 'desktop') {
  await withConnection((connection) =>
    connection.db
      .insertInto('access_logs')
      .values({
        id: uuidv7(),
        site_id: siteId,
        occurred_at: at,
        path: '/',
        referrer_host: null,
        visitor_hash: `v-${at}`,
        device,
      })
      .execute(),
  );
}

/** `job_runs` に実行記録を直接入れる（`started_at` は ISO 8601）。 */
async function insertJobRun(status: 'ok' | 'error', startedAt: string): Promise<void> {
  await withConnection((connection) =>
    sql`
      INSERT INTO job_runs (id, job_name, triggered_by, status, started_at, finished_at, error, summary)
      VALUES (${uuidv7()}, 'analytics.rollup', 'scheduled', ${status}, ${startedAt}::timestamptz,
              ${startedAt}::timestamptz + interval '1 second',
              ${status === 'error' ? '失敗' : null}, '{}'::jsonb)
    `.execute(connection.db),
  );
}

/** そのサイトの Core の集計日ごとの pageviews。 */
async function pageviewsByDay(siteId: string): Promise<Record<string, number>> {
  const rows = await withConnection((connection) =>
    connection.db
      .selectFrom('analytics')
      .select(['metric_date', 'value'])
      .where('site_id', '=', siteId)
      .where('source', '=', 'core')
      .where('metric', '=', 'pageviews')
      .where('key', '=', '')
      .execute(),
  );
  return Object.fromEntries(rows.map((row) => [dateOnly(row.metric_date), Number(row.value)]));
}

async function coreRowCount(siteId: string): Promise<number> {
  const rows = await withConnection((connection) =>
    connection.db
      .selectFrom('analytics')
      .select('metric')
      .where('site_id', '=', siteId)
      .where('source', '=', 'core')
      .execute(),
  );
  return rows.length;
}

/** `now` を基準に、運用タイムゾーンでの日付と ISO 8601 の瞬間を作る。 */
function clock() {
  const now = new Date();
  const tz = analyticsTimeZone();
  return {
    now,
    tz,
    today: todayInTimeZone(tz, now),
    daysAgo: (days: number) => daysAgoInTimeZone(days, tz, now),
    /** `days` 日前の同時刻（瞬間）。 */
    instantDaysAgo: (days: number) => new Date(now.getTime() - days * 86_400_000),
  };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('jobdefs');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await sql`DELETE FROM job_runs`.execute(connection.db);
    await connection.db.deleteFrom('webhook_deliveries').execute();
    await connection.db.deleteFrom('webhooks').execute();
    await connection.db.deleteFrom('access_logs').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('sites').execute();
  });
});

describe('ROLLUP_JOB', () => {
  it('名前は analytics.rollup、既定の間隔は 15 分', () => {
    expect(ROLLUP_JOB.name).toBe('analytics.rollup');
    expect(ROLLUP_JOB.intervalMs).toBe(15 * 60_000);
  });

  /** #34 (a)。成功の記録が無ければ from = 昨日。 */
  it('成功の記録が無ければ昨日〜今日を集計し、summary に from / to / days / points が入る', async () => {
    const { now, today, daysAgo } = clock();
    const siteId = await makeSite();
    await insertLog(siteId, now.toISOString());

    const summary = await withConnection((connection) => ROLLUP_JOB.run(connection, undefined));

    expect(summary).toMatchObject({ from: daysAgo(1), to: today, days: 1 });
    expect(await pageviewsByDay(siteId)).toEqual({ [today]: 1 });
    // points は書いた行数（key 無しの 8 指標 + key 付きの行）。
    const written = await coreRowCount(siteId);
    expect(summary['points']).toBe(written);
    expect(written).toBeGreaterThanOrEqual(8);
  });

  /** #34 (b)。最後の成功の開始日から。 */
  it('3 日前に成功していれば from = 3 日前で、3 日前の生ログも集計される', async () => {
    const { now, today, daysAgo, instantDaysAgo } = clock();
    const siteId = await makeSite();
    await insertJobRun('ok', instantDaysAgo(3).toISOString());
    await insertLog(siteId, instantDaysAgo(3).toISOString());
    await insertLog(siteId, now.toISOString());

    const summary = await withConnection((connection) => ROLLUP_JOB.run(connection, undefined));

    expect(summary).toMatchObject({ from: daysAgo(3), to: today });
    expect(await pageviewsByDay(siteId)).toEqual({ [daysAgo(3)]: 1, [today]: 1 });
  });

  /** #34 (c)。最大 7 日さかのぼる。 */
  it('10 日前に成功していれば from = 7 日前で、10 日前の生ログは集計されない', async () => {
    const { today, daysAgo, instantDaysAgo } = clock();
    const siteId = await makeSite();
    await insertJobRun('ok', instantDaysAgo(10).toISOString());
    await insertLog(siteId, instantDaysAgo(10).toISOString());
    await insertLog(siteId, instantDaysAgo(7).toISOString());

    const summary = await withConnection((connection) => ROLLUP_JOB.run(connection, undefined));

    expect(summary).toMatchObject({ from: daysAgo(7), to: today });
    const byDay = await pageviewsByDay(siteId);
    expect(byDay[daysAgo(7)]).toBe(1);
    expect(byDay[daysAgo(10)]).toBeUndefined();
  });

  /** #34。status = 'error' の行しか無ければ (a) と同じ。 */
  it("status = 'error' の行しか無ければ、成功の記録が無いときと同じ（昨日〜今日）", async () => {
    const { today, daysAgo, instantDaysAgo } = clock();
    await makeSite();
    await insertJobRun('error', instantDaysAgo(3).toISOString());

    const summary = await withConnection((connection) => ROLLUP_JOB.run(connection, undefined));

    expect(summary).toMatchObject({ from: daysAgo(1), to: today });
  });

  /** #34。日付は TORIFUNE_TIMEZONE で決まる（`started_at` を運用タイムゾーンの日付にする）。 */
  it('最後の成功の開始日は運用タイムゾーンで数える', async () => {
    const { tz, instantDaysAgo } = clock();
    await makeSite();
    const startedAt = instantDaysAgo(2);
    await insertJobRun('ok', startedAt.toISOString());

    const summary = await withConnection((connection) => ROLLUP_JOB.run(connection, undefined));

    expect(summary['from']).toBe(dateInTimeZone(startedAt, tz));
  });

  /** #35 */
  it('input を渡すと、指定した範囲だけを集計する', async () => {
    const siteId = await makeSite();
    await insertLog(siteId, '2026-06-10T10:00:00Z');
    await insertLog(siteId, '2026-06-11T10:00:00Z');
    await insertJobRun('ok', '2026-06-01T00:00:00Z');

    const summary = await withConnection((connection) =>
      ROLLUP_JOB.run(connection, { from: '2026-06-10', to: '2026-06-10' }),
    );

    expect(summary).toMatchObject({ from: '2026-06-10', to: '2026-06-10', days: 1 });
    expect(await pageviewsByDay(siteId)).toEqual({ '2026-06-10': 1 });
  });

  /** #37 */
  it('runJob で流すと analytics.rolledUp が 1 回だけ発火する', async () => {
    const { now } = clock();
    const siteId = await makeSite();
    await insertLog(siteId, now.toISOString());
    const payloads: unknown[] = [];
    subscribe('analytics.rolledUp', (payload) => void payloads.push(payload));

    const outcome = await withConnection((connection) =>
      runJob(connection, ROLLUP_JOB, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    expect(outcome.outcome).toBe('ok');
    expect(payloads).toHaveLength(1);
    // `RunOutcome.run` は skipped / ロック失敗のとき null になりうる（設計 §6.1.5）。
    expect(outcome.run).not.toBeNull();
    expect(payloads[0]).toMatchObject({
      from: outcome.run?.summary['from'],
      to: outcome.run?.summary['to'],
    });
  });
});

describe('WEBHOOK_JOB', () => {
  it('名前は webhook.deliver、既定の間隔は 1 分', () => {
    expect(WEBHOOK_JOB.name).toBe('webhook.deliver');
    expect(WEBHOOK_JOB.intervalMs).toBe(60_000);
  });

  /** #36 */
  it('予約済みの配信をローカルの受け手へ送り、summary が { attempted: 1, delivered: 1, failed: 0 } になる', async () => {
    const target = await receiver();
    try {
      await createWebhook(admin, { name: 'jobs', url: target.url, events: ['site.created'] });
      await emit('site.created', { siteId: 's1', name: 'とりふね' });
      expect(target.received).toHaveLength(0);

      const summary = await withConnection((connection) => WEBHOOK_JOB.run(connection, undefined));

      expect(summary).toEqual({ attempted: 1, delivered: 1, failed: 0 });
      expect(target.received).toHaveLength(1);
      expect(JSON.parse(target.received[0]?.body ?? '{}')).toMatchObject({ event: 'site.created' });
    } finally {
      await target.close();
    }
  });

  /** #36 の対。配信が無ければ 0。 */
  it('予約が無ければ { attempted: 0, delivered: 0, failed: 0 }', async () => {
    const summary = await withConnection((connection) => WEBHOOK_JOB.run(connection, undefined));

    expect(summary).toEqual({ attempted: 0, delivered: 0, failed: 0 });
  });
});
