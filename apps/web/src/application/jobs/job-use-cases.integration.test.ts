import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { listJobStatuses } from '@/application/jobs/job-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { JOB_NAMES, type JobName } from '@/domain/jobs/job';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 実行状況の参照（029-scheduled-jobs 設計 §6.5、受け入れ条件 #38〜#40）。
 *
 * `listJobStatuses`（UseCase 名 `jobs.status`、Permission `system.manage`）は
 * `JOB_NAMES` の順で常に 2 件返す。未実行でも `lastRun: null` で返す。
 * `recentErrors` は `status = 'error'` の直近 5 件（新しい順）。
 *
 * テストでは基盤が起動していないので `scheduled: false`、`nextRunAt: null`、`running: false`。
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
        display_name: 'job status test',
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
    displayName: 'job status test',
    email: `s${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** `job_runs` へ 1 行入れて id を返す。`startedAt` は ISO 8601。 */
async function insertJobRun(input: {
  readonly name: JobName;
  readonly status: 'ok' | 'error' | 'skipped' | 'running';
  readonly startedAt: string;
  readonly error?: string;
}): Promise<string> {
  const id = uuidv7();
  const finished = input.status === 'running';
  await withConnection((connection) =>
    sql`
      INSERT INTO job_runs (id, job_name, triggered_by, status, started_at, finished_at, error, summary, runner)
      VALUES (${id}, ${input.name}, 'scheduled', ${input.status}, ${input.startedAt}::timestamptz,
              ${finished ? null : input.startedAt}::timestamptz,
              ${input.error ?? null}, '{"n": 1}'::jsonb, 'host:1')
    `.execute(connection.db),
  );
  return id;
}

/** 基準時刻から `seconds` 秒後の ISO 8601。 */
function at(seconds: number): string {
  return new Date(Date.parse('2026-09-04T00:00:00Z') + seconds * 1000).toISOString();
}

beforeAll(async () => {
  scratch = await useScratchDatabase('jobstatus');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection((connection) => sql`DELETE FROM job_runs`.execute(connection.db));
});

describe('listJobStatuses', () => {
  /** #38 */
  it('JOB_NAMES の順に 2 件返し、実行が無ければ lastRun / lastSuccess は null、recentErrors は空', async () => {
    const statuses = await listJobStatuses(admin, {});

    expect(statuses.map((status) => status.name)).toEqual([...JOB_NAMES]);
    for (const status of statuses) {
      expect(status.lastRun).toBeNull();
      expect(status.lastSuccess).toBeNull();
      expect(status.recentErrors).toEqual([]);
      // 基盤が起動していない（Vitest では bootScheduler は何もしない）。
      expect(status.scheduled).toBe(false);
      expect(status.nextRunAt).toBeNull();
      expect(status.running).toBe(false);
    }
    // 未起動でも間隔は env の解釈後の値（実装プラン §8 #1）。
    expect(statuses.map((status) => status.intervalMinutes)).toEqual([15, 1]);
  });

  /** #38。権限。 */
  it('system.manage が無ければ ForbiddenError', async () => {
    const viewer = await contextFor('viewer');

    await expect(listJobStatuses(viewer, {})).rejects.toThrow(ForbiddenError);
  });

  /** #38 の対。管理者は読める。 */
  it('system.manage を持てば読める', async () => {
    await expect(listJobStatuses(admin, {})).resolves.toHaveLength(2);
  });

  /** #39 */
  it('ok → error の順に記録すると、lastRun は error、lastSuccess は ok の行、recentErrors は 1 件', async () => {
    const okId = await insertJobRun({ name: 'analytics.rollup', status: 'ok', startedAt: at(0) });
    const errorId = await insertJobRun({
      name: 'analytics.rollup',
      status: 'error',
      startedAt: at(60),
      error: '集計に失敗した',
    });

    const rollup = (await listJobStatuses(admin, {})).find(
      (status) => status.name === 'analytics.rollup',
    );

    expect(rollup?.lastRun?.id).toBe(errorId);
    expect(rollup?.lastRun?.status).toBe('error');
    expect(rollup?.lastRun?.error).toBe('集計に失敗した');
    expect(rollup?.lastSuccess?.id).toBe(okId);
    expect(rollup?.lastSuccess?.status).toBe('ok');
    expect(rollup?.recentErrors.map((run) => run.id)).toEqual([errorId]);
    // JobRun の形。
    expect(rollup?.lastRun).toMatchObject({
      jobName: 'analytics.rollup',
      triggeredBy: 'scheduled',
      summary: { n: 1 },
      runner: 'host:1',
    });
    expect(rollup?.lastRun?.startedAt).toBeInstanceOf(Date);
    expect(rollup?.lastRun?.finishedAt).toBeInstanceOf(Date);
  });

  /** #39。skipped も「前回の実行」になる（前回の成功は別）。 */
  it('直近が skipped なら lastRun は skipped で、lastSuccess は直前の ok', async () => {
    const okId = await insertJobRun({ name: 'webhook.deliver', status: 'ok', startedAt: at(0) });
    const skippedId = await insertJobRun({
      name: 'webhook.deliver',
      status: 'skipped',
      startedAt: at(60),
    });

    const webhook = (await listJobStatuses(admin, {})).find(
      (status) => status.name === 'webhook.deliver',
    );

    expect(webhook?.lastRun?.id).toBe(skippedId);
    expect(webhook?.lastSuccess?.id).toBe(okId);
    expect(webhook?.recentErrors).toEqual([]);
  });

  /** #39 の前提。ジョブごとに独立。 */
  it('他のジョブの記録は混ざらない', async () => {
    await insertJobRun({ name: 'webhook.deliver', status: 'error', startedAt: at(0), error: 'x' });

    const rollup = (await listJobStatuses(admin, {})).find(
      (status) => status.name === 'analytics.rollup',
    );

    expect(rollup?.lastRun).toBeNull();
    expect(rollup?.recentErrors).toEqual([]);
  });

  /** #40 */
  it('error を 7 回記録すると recentErrors は新しい順に 5 件', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(
        await insertJobRun({
          name: 'analytics.rollup',
          status: 'error',
          startedAt: at(i * 60),
          error: `失敗 ${i}`,
        }),
      );
    }

    const rollup = (await listJobStatuses(admin, {})).find(
      (status) => status.name === 'analytics.rollup',
    );

    expect(rollup?.recentErrors).toHaveLength(5);
    expect(rollup?.recentErrors.map((run) => run.id)).toEqual(ids.slice(2).reverse());
    expect(rollup?.recentErrors.every((run) => run.status === 'error')).toBe(true);
  });
});
