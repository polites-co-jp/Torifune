import { sql } from 'kysely';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rollupAnalytics } from '@/application/analytics/rollup';
import { runJob, startJobInBackground, type RunOutcome } from '@/application/jobs/run-job';
import type { JobContext, JobDefinition, JobTask } from '@/application/jobs/scheduler';
import { withConnection } from '@/application/transaction';
import type { Connection } from '@/database/provider';
import { JOB_RUN_RETENTION, type JobName, type JobRun } from '@/domain/jobs/job';
import {
  JOB_LOCK_NAMESPACE,
  jobLock,
  jobLockKey,
  resetJobLockWaitingForTests,
} from '@/infrastructure/job-lock';
import { jobRunRepository } from '@/infrastructure/job-run-repository';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 1 回の実行（029-scheduled-jobs 設計 §6.1.5、受け入れ条件 #17〜#22、#68、#69、#71、#72、#75）。
 *
 * `runJob(connection, job, { trigger, wait, input })`：
 * ロック → `job_runs` に `running` → 実行 → `ok` / `error` に更新 → 解放 → 保持件数の切り詰め。
 * 例外は握って `outcome: 'error'` で返す（投げない）。記録に失敗してもジョブの結果は変えない。
 *
 * 検証の反映：
 * - ロックの**競合（`skipped`）と失敗（`error`）を分ける**（A-3。#69）
 * - `skipped` / ロック失敗の記録の直後にも `trimHistory` を呼ぶ（A-4。#71）
 * - `release()` の例外は握る（A-5。#72）
 * - 例外メッセージは**伏せてから切る**（A-7。#75）
 *
 * `job_runs` は Kysely の型（`schema.ts`）に依存せず生 SQL で読む。
 */

interface JobRunRow {
  readonly id: string;
  readonly job_name: string;
  readonly triggered_by: string;
  readonly status: string;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly error: string | null;
  readonly summary: Record<string, unknown>;
  readonly runner: string | null;
}

let scratch: ScratchDatabase;

/** 記録された `JobRun`（`null` ならテストを落とす）。 */
function runOf(outcome: RunOutcome): JobRun {
  if (outcome.run === null) throw new Error(`job_runs に記録されていない: ${outcome.outcome}`);
  return outcome.run;
}

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

/** テスト用のジョブ定義。`run` の中身だけ差し替える。 */
function jobOf<TInput = undefined>(
  name: JobName,
  run: (connection: Connection, input: TInput) => Promise<Readonly<Record<string, unknown>>>,
): JobDefinition<TInput> {
  return { name, intervalMs: 60_000, run };
}

async function rowsOf(name: string): Promise<JobRunRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<JobRunRow>`
      SELECT id, job_name, triggered_by, status, started_at, finished_at, error, summary, runner
      FROM job_runs WHERE job_name = ${name} ORDER BY started_at DESC, id DESC
    `.execute(connection.db);
    return result.rows;
  });
}

async function clearJobRuns(): Promise<void> {
  await withConnection((connection) => sql`DELETE FROM job_runs`.execute(connection.db));
}

/** 別の保持者（同じ DB へ別に張った接続）でロックを取る。 */
async function holdLock(
  name: JobName,
): Promise<{ release(): Promise<void>; end(): Promise<void> }> {
  const client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS locked',
    [JOB_LOCK_NAMESPACE, jobLockKey(name)],
  );
  expect(result.rows[0]?.locked).toBe(true);
  return {
    async release() {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        JOB_LOCK_NAMESPACE,
        jobLockKey(name),
      ]);
    },
    async end() {
      await client.end();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('runjob');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetLogger();
  // 記録の後始末を先に済ませる（次のテストの件数が前のテストに引きずられない）。
  await clearJobRuns();
  // 待機枠のゲート（`processState('jobs.lock-waiting', …)`）を空に戻す。
  resetJobLockWaitingForTests();
});

describe('成功と失敗の記録', () => {
  /** #17 */
  it('成功するジョブは ok で記録され、summary と runner が入る', async () => {
    const job = jobOf('analytics.rollup', async () => ({ from: '2026-09-03', points: 8 }));

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    expect(outcome.outcome).toBe('ok');
    expect(runOf(outcome).jobName).toBe('analytics.rollup');
    expect(runOf(outcome).status).toBe('ok');

    const rows = await rowsOf('analytics.rollup');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe('ok');
    expect(row?.triggered_by).toBe('scheduled');
    expect(row?.finished_at).toBeInstanceOf(Date);
    expect(row?.started_at.getTime()).toBeLessThanOrEqual(row?.finished_at?.getTime() ?? 0);
    expect(row?.summary).toEqual({ from: '2026-09-03', points: 8 });
    // `hostname:pid` の形。
    expect(row?.runner).toMatch(/^.+:\d+$/);
    expect(row?.error).toBeNull();
    expect(row?.id).toBe(runOf(outcome).id);
  });

  /** #17。trigger は指定どおりに記録される。 */
  it("trigger: 'manual' は triggered_by = 'manual' で記録される", async () => {
    const job = jobOf('webhook.deliver', async () => ({ attempted: 0 }));

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );

    expect((await rowsOf('webhook.deliver'))[0]?.triggered_by).toBe('manual');
  });

  /** #18 */
  it('例外を投げるジョブは outcome: error で返し、例外を投げ返さない', async () => {
    const job = jobOf('analytics.rollup', async () => {
      throw new Error('集計に失敗した');
    });

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    expect(outcome.outcome).toBe('error');
    if (outcome.outcome === 'error') {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe('集計に失敗した');
    }
    expect(runOf(outcome).status).toBe('error');
  });

  /** #18。error 列はメッセージだけ（2000 文字で切る）。 */
  it('例外のメッセージが error に入り、2000 文字で切られる', async () => {
    const job = jobOf('analytics.rollup', async () => {
      throw new Error('e'.repeat(2500));
    });

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    const row = (await rowsOf('analytics.rollup'))[0];
    expect(row?.status).toBe('error');
    expect(row?.error).toBe('e'.repeat(2000));
    expect(row?.finished_at).toBeInstanceOf(Date);
  });

  /** #18。ログ。 */
  it("失敗すると level: 'error'、message: 'job failed' のログが出て fields.job がある", async () => {
    const { records } = capture();
    const job = jobOf('webhook.deliver', async () => {
      throw new Error('受け手が 503 を返した');
    });

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    const failed = records.find((record) => record.message === 'job failed');
    expect(failed).toBeDefined();
    expect(failed?.level).toBe('error');
    expect(failed?.fields?.['job']).toBe('webhook.deliver');
  });
});

describe('排他', () => {
  /** #19。定期実行は待たずにスキップする。 */
  it('別の保持者がいる間の wait: false は skipped で、ジョブ関数は呼ばれない', async () => {
    const holder = await holdLock('analytics.rollup');
    try {
      const run = vi.fn(async () => ({}));
      const job = jobOf('analytics.rollup', run);

      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      );

      expect(outcome.outcome).toBe('skipped');
      expect(run).not.toHaveBeenCalled();

      const rows = await rowsOf('analytics.rollup');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('skipped');
      expect(rows[0]?.finished_at?.getTime()).toBe(rows[0]?.started_at.getTime());
    } finally {
      await holder.end();
    }
  });

  /** #19。手動（API）は保持側が解放するまで待つ。 */
  it('別の保持者がいる間の wait: true は解放を待ってから ok になる', async () => {
    const holder = await holdLock('analytics.rollup');
    try {
      const run = vi.fn(async () => ({ waited: true }));
      const job = jobOf('analytics.rollup', run);

      const started = Date.now();
      const pending = withConnection((connection) =>
        runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
      );
      await sleep(700);
      expect(run).not.toHaveBeenCalled();
      await holder.release();

      const outcome = await pending;

      expect(outcome.outcome).toBe('ok');
      expect(run).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(600);
      expect((await rowsOf('analytics.rollup'))[0]?.status).toBe('ok');
    } finally {
      await holder.end();
    }
  });

  /**
   * #68。`waitMs === 0`（定期実行）は待機枠のゲートを通らない（設計 §6.1.6）。
   *
   * ゲートは「待てるのはジョブごとに 1 本」だが、待たない呼び出しはそもそも pin しないので
   * 何本来ても即座に `skipped` になる。
   */
  it('別の保持者がいる間の wait: false を 5 本同時に呼ぶと、5 本とも skipped で待たない', async () => {
    const holder = await holdLock('analytics.rollup');
    try {
      const run = vi.fn(async () => ({}));
      const job = jobOf('analytics.rollup', run);

      const started = Date.now();
      const outcomes = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          withConnection((connection) =>
            runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
          ),
        ),
      );
      const elapsed = Date.now() - started;

      expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
        'skipped',
        'skipped',
        'skipped',
        'skipped',
        'skipped',
      ]);
      expect(run).not.toHaveBeenCalled();
      expect(elapsed, '待ってしまっている').toBeLessThan(1000);

      const rows = await rowsOf('analytics.rollup');
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.status === 'skipped')).toBe(true);
    } finally {
      await holder.end();
    }
  }, 20_000);

  /** #22。同時に 2 つ流しても、集計値は 1 回流したときと同じ。 */
  it('同じジョブを同時に 2 つ流すと片方が ok、もう片方が skipped になり、集計値は 1 回分', async () => {
    const siteId = uuidv7();
    await withConnection(async (connection) => {
      await connection.db
        .insertInto('sites')
        .values({ id: siteId, name: 'runjob', url: 'https://example.com' })
        .execute();
      for (const [index, path] of ['/a', '/b', '/a'].entries()) {
        await connection.db
          .insertInto('access_logs')
          .values({
            id: uuidv7(),
            site_id: siteId,
            occurred_at: `2026-06-10T10:0${index}:00Z`,
            path,
            referrer_host: null,
            visitor_hash: `v${index % 2}`,
            device: 'desktop',
          })
          .execute();
      }
    });
    const job = jobOf('analytics.rollup', async (connection) => {
      const result = await rollupAnalytics(connection, { from: '2026-06-10', to: '2026-06-10' });
      return { ...result };
    });
    const shape = () =>
      withConnection((connection) =>
        connection.db
          .selectFrom('analytics')
          .select(['metric_date', 'source', 'metric', 'key', 'value'])
          .where('site_id', '=', siteId)
          .orderBy('metric')
          .orderBy('key')
          .execute(),
      );

    const outcomes = await Promise.all([
      withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      ),
      withConnection((connection) =>
        runJob(connection, job, { trigger: 'manual', wait: false, input: undefined }),
      ),
    ]);
    const concurrent = await shape();

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(['ok', 'skipped']);
    expect(concurrent.length).toBeGreaterThan(0);

    // 1 回だけ流したときと同じ（冪等な差し替えなので流し直せば比較できる）。
    await withConnection((connection) =>
      connection.db.deleteFrom('analytics').where('site_id', '=', siteId).execute(),
    );
    const single = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );
    expect(single.outcome).toBe('ok');
    expect(await shape()).toEqual(concurrent);
  });
});

describe('保持件数', () => {
  /** #20 */
  it('同じジョブを 60 回実行すると 50 件になり、最新 50 件が残る', async () => {
    const job = jobOf('analytics.rollup', async () => ({}));
    const ids: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      );
      ids.push(runOf(outcome).id);
    }

    const rows = await rowsOf('analytics.rollup');

    expect(rows).toHaveLength(JOB_RUN_RETENTION);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(ids.slice(-JOB_RUN_RETENTION)));
  }, 60_000);

  /** #20。別のジョブの行は減らない。 */
  it('別の job_name の行は切り詰めで減らない', async () => {
    const other = jobOf('webhook.deliver', async () => ({}));
    for (let i = 0; i < 3; i += 1) {
      await withConnection((connection) =>
        runJob(connection, other, { trigger: 'scheduled', wait: false, input: undefined }),
      );
    }
    const job = jobOf('analytics.rollup', async () => ({}));
    for (let i = 0; i < 55; i += 1) {
      await withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      );
    }

    expect(await rowsOf('webhook.deliver')).toHaveLength(3);
    expect(await rowsOf('analytics.rollup')).toHaveLength(JOB_RUN_RETENTION);
  }, 60_000);

  /**
   * #71。`skipped` の記録の直後にも切り詰める（設計 §6.1.5 手順 1。security-reviewer A-4）。
   *
   * 切り詰めが `ok` / `error` の経路にしか無いと、ロック競合を繰り返すだけで `job_runs` が
   * 上限なく伸びる（`skipped` は Rate Limit の範囲で誰でも作れる）。
   */
  it('ロック保持中に wait: false を 60 回呼ぶと 50 件になり、すべて skipped', async () => {
    const holder = await holdLock('analytics.rollup');
    try {
      const job = jobOf('analytics.rollup', async () => ({}));
      for (let i = 0; i < 60; i += 1) {
        await withConnection((connection) =>
          runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
        );
      }

      const rows = await rowsOf('analytics.rollup');

      expect(rows).toHaveLength(JOB_RUN_RETENTION);
      expect(rows.every((row) => row.status === 'skipped')).toBe(true);
    } finally {
      await holder.end();
    }
  }, 60_000);

  /** #71。`ok` の行が混ざっていても合計 50 件を超えない。 */
  it('ok の行が混ざっていても、skipped を積んだ後の合計が 50 件を超えない', async () => {
    const job = jobOf('analytics.rollup', async () => ({}));
    for (let i = 0; i < 5; i += 1) {
      await withConnection((connection) =>
        runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
      );
    }
    expect((await rowsOf('analytics.rollup')).filter((row) => row.status === 'ok')).toHaveLength(5);

    const holder = await holdLock('analytics.rollup');
    try {
      for (let i = 0; i < 60; i += 1) {
        await withConnection((connection) =>
          runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
        );
      }
    } finally {
      await holder.end();
    }

    expect(await rowsOf('analytics.rollup')).toHaveLength(JOB_RUN_RETENTION);
  }, 60_000);
});

/**
 * ロック取得そのものの失敗（設計 §6.1.5 手順 1 / §6.1.6、受け入れ条件 #69。security-reviewer A-3）。
 *
 * 競合（他が実行中）と、セッション自体の失敗（Pool 枯渇・DB 停止・権限エラー）は別物。
 * 「取れなかった」に丸めると、DB 停止が「他が実行中」（`skipped` / 409）として記録され、
 * 監視できるようにするという 029 の目的が崩れる。
 *
 * ロックの専用接続だけが失敗する状況を作る（`db.connection()` が投げる `Connection`）。
 * `job_runs` の記録は通常の接続で行うので、`error` の行は残る。
 */
describe('ロック取得の失敗', () => {
  /** ロックの専用接続だけが失敗する `Connection`。記録用の問い合わせは素通しする。 */
  function connectionWithFailingLock(base: Connection): Connection {
    const db = new Proxy(base.db, {
      get(target, property) {
        if (property === 'connection') {
          return () => ({
            execute: async () => {
              throw new Error('ロックのセッションを開始できない');
            },
          });
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Connection['db'];

    const wrapped: Connection = {
      db,
      transaction: (fn) => base.transaction(fn),
    };
    return wrapped;
  }

  /** #69 */
  it('ロック取得が失敗すると outcome: error で、job_runs に error の行が残る（skipped にしない）', async () => {
    const { records } = capture();
    const run = vi.fn(async () => ({}));
    const job = jobOf('analytics.rollup', run);

    const outcome = await withConnection((connection) =>
      runJob(connectionWithFailingLock(connection), job, {
        trigger: 'manual',
        wait: true,
        input: undefined,
      }),
    );

    expect(outcome.outcome).toBe('error');
    expect(run, 'ジョブ関数は呼ばれない').not.toHaveBeenCalled();

    const rows = await rowsOf('analytics.rollup');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.status).not.toBe('skipped');
    expect(rows[0]?.error).not.toBeNull();
    // ログも競合ではなく失敗として出す。
    expect(
      records.some((record) => record.level === 'error' && record.message === 'job lock failed'),
    ).toBe(true);
  });

  /** #69。`wait: false`（定期実行）でも同じ扱い。 */
  it('wait: false でもロック取得の失敗は skipped ではなく error', async () => {
    const job = jobOf('webhook.deliver', async () => ({}));

    const outcome = await withConnection((connection) =>
      runJob(connectionWithFailingLock(connection), job, {
        trigger: 'scheduled',
        wait: false,
        input: undefined,
      }),
    );

    expect(outcome.outcome).toBe('error');
    expect((await rowsOf('webhook.deliver'))[0]?.status).toBe('error');
  });

  /**
   * #87（security-reviewer L-3）。**`acquire` が同期的に投げても `failed` として扱う。**
   *
   * `connection.db.connection()` を持たない（差し替えた Plugin の）Provider だと、
   * 例外が `await` の前に同期で飛び、`try` の外を素通りしてルートまで抜ける。
   * `job_runs` に記録が残らず、API も 500 の理由を失う。
   */
  it('acquire が同期的に投げても runJob は投げ返さず、error の行が残る', async () => {
    const url = process.env['DATABASE_URL'] ?? '';
    vi.spyOn(jobLock, 'acquire').mockImplementation(() => {
      // `async` にしない（同期の throw を再現する）。
      throw new Error(`connection() が無い Provider: ${url}`);
    });
    const run = vi.fn(async () => ({}));
    const job = jobOf('analytics.rollup', run);

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );

    expect(outcome.outcome).toBe('error');
    expect(run, 'ジョブ関数は呼ばれない').not.toHaveBeenCalled();

    const rows = await rowsOf('analytics.rollup');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    // #75 と同じ経路を通す（接続文字列を残さない）。
    if (url !== '') expect(rows[0]?.error).not.toContain(url);
  });

  /** #71 と同じ理由。失敗の記録の直後にも切り詰める。 */
  it('ロック取得の失敗を 60 回記録しても 50 件で止まる', async () => {
    const job = jobOf('analytics.rollup', async () => ({}));
    for (let i = 0; i < 60; i += 1) {
      await withConnection((connection) =>
        runJob(connectionWithFailingLock(connection), job, {
          trigger: 'scheduled',
          wait: false,
          input: undefined,
        }),
      );
    }

    expect(await rowsOf('analytics.rollup')).toHaveLength(JOB_RUN_RETENTION);
  }, 60_000);
});

/**
 * `release()` の例外を握る（設計 §6.1.5 手順 5、受け入れ条件 #72。security-reviewer A-5）。
 *
 * `release()` はロックのセッション本体が既に失敗している場合だけ投げうる。
 * `finally` で包まないと「例外は握って返す」契約が破れ、成功したジョブが呼び出し元へ例外を投げる。
 *
 * `jobLock.acquire` を差し替えて、`release()` が投げるハンドルを注入する（外部境界の差し替え）。
 */
describe('解放の失敗', () => {
  /** #72 */
  it('release() が投げても runJob は例外を投げず ok を返し、行は ok のまま', async () => {
    const { records } = capture();
    const original = jobLock.acquire.bind(jobLock);
    vi.spyOn(jobLock, 'acquire').mockImplementation(async (connection, name, options) => {
      const outcome = await original(connection, name, options);
      if (!outcome.ok) return outcome;
      return {
        ok: true,
        lock: {
          async release() {
            // 実際には解放したうえで、呼び出し元へ例外を返す（ロックを残さない）。
            await outcome.lock.release();
            throw new Error('解放に失敗した');
          },
        },
      };
    });
    const job = jobOf('analytics.rollup', async () => ({ done: true }));

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );

    expect(outcome.outcome).toBe('ok');
    const rows = await rowsOf('analytics.rollup');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');

    const warned = records.filter(
      (record) => record.level === 'warn' && record.message === 'job lock release failed',
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields?.['job']).toBe('analytics.rollup');
  });
});

/**
 * 例外メッセージの秘匿（設計 §6.1.7、受け入れ条件 #75。security-reviewer A-7）。
 *
 * `jobErrorText(error) = truncateError(redactSecrets(message))`。**伏せてから切る。**
 * 逆にすると、途中で切れた接続文字列が完全一致の秘匿に掛からず残る。
 */
describe('例外メッセージの秘匿', () => {
  /** テスト実行時の接続文字列（この経路に絶対に出てはならない値）。 */
  function databaseUrl(): string {
    const url = process.env['DATABASE_URL'];
    if (url === undefined || url === '') throw new Error('DATABASE_URL が要る');
    return url;
  }

  /** `postgresql://user:password@host` の password 部分。 */
  function passwordOf(url: string): string {
    return /\/\/[^:/@\s]+:([^@\s]+)@/.exec(url)?.[1] ?? '';
  }

  /** #75 */
  it('接続文字列を含む例外は job_runs.error にもログにも残らない', async () => {
    const { records } = capture();
    const url = databaseUrl();
    const job = jobOf('analytics.rollup', async () => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    });

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    const row = (await rowsOf('analytics.rollup'))[0];
    expect(row?.status).toBe('error');
    expect(row?.error).not.toContain(url);
    expect(row?.error).toContain('***');

    const failed = records.find((record) => record.message === 'job failed');
    expect(failed).toBeDefined();
    expect(JSON.stringify(failed?.fields)).not.toContain(url);
    expect(String(failed?.fields?.['reason'])).toContain('***');
  });

  /** #75。password だけが単独で出てきても残らない。 */
  it('接続文字列の password 部分が単独で出ても残らない', async () => {
    const password = passwordOf(databaseUrl());
    expect(password.length, 'DATABASE_URL に password が無い').toBeGreaterThan(0);
    const job = jobOf('analytics.rollup', async () => {
      throw new Error(`password authentication failed: ${password}`);
    });

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    expect((await rowsOf('analytics.rollup'))[0]?.error).not.toContain(password);
  });

  /**
   * #75。**伏せてから切る。**
   *
   * 接続文字列が「credential の直後」で切れる長さのメッセージを作る。
   * 切ってから伏せると、`postgresql://user:password@` までが残った状態で完全一致にも
   * `scheme://user:password@host` の形にも掛からず、password が残る。
   */
  it('2000 文字を超えるメッセージでも接続文字列の断片が残らない', async () => {
    const url = databaseUrl();
    const credentialEnd = url.indexOf('@') + 1;
    expect(credentialEnd, 'DATABASE_URL に credential が無い').toBeGreaterThan(0);
    const prefix = 2000 - credentialEnd;
    expect(prefix).toBeGreaterThan(0);
    const job = jobOf('analytics.rollup', async () => {
      throw new Error(`${'x'.repeat(prefix)}${url} で接続に失敗した`);
    });

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    const error = (await rowsOf('analytics.rollup'))[0]?.error ?? '';
    // 切ってから伏せると、ここに `…://user:password@` が残る。
    // （password 単独の文字列で見ないのは、テスト用の接続文字列ではデータベース名にも
    //   同じ語が含まれうるため。credential の形で見るほうが厳しい。）
    expect(error).not.toContain(url.slice(0, credentialEnd));
    expect(error).not.toContain(`:${passwordOf(url)}@`);
    // 切ってはいる（`job_runs_error_length` の 2000 を超えない）。
    expect([...error].length).toBeLessThanOrEqual(2000);
  });
});

/**
 * #21。記録できないことと集計できないことは別。
 *
 * **このファイルの最後に置く。** `job_runs` を `RENAME` して「表が無い」状態を作り、`finally` で戻す。
 * 設計の「DROP した scratch DB」と観測できる挙動（記録に失敗する）は同じで、後続のテストを壊さない。
 */
describe('記録に失敗する状況', () => {
  it('job_runs が無くてもジョブ関数は実行されて結果が返り、ログに記録失敗が出る', async () => {
    await withConnection((connection) =>
      sql`ALTER TABLE job_runs RENAME TO job_runs_broken`.execute(connection.db),
    );
    try {
      const { records } = capture();
      const run = vi.fn(async () => ({ done: true }));
      const job = jobOf('analytics.rollup', run);

      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      );

      expect(run).toHaveBeenCalledTimes(1);
      expect(outcome.outcome).toBe('ok');
      // 記録の失敗はログに出す（実装プラン T5：`job run could not be recorded`）。
      const recorded = records.filter(
        (record) => record.level === 'error' && record.message === 'job run could not be recorded',
      );
      expect(recorded.length).toBeGreaterThanOrEqual(1);
      // ジョブ自体の失敗としては扱わない。
      expect(records.some((record) => record.message === 'job failed')).toBe(false);
    } finally {
      await withConnection((connection) =>
        sql`ALTER TABLE job_runs_broken RENAME TO job_runs`.execute(connection.db),
      );
    }
  });
});

/**
 * 記録するジョブ名と、取る鍵の名前を分ける
 * （032-timezone-setting 設計 §6.2.3、受け入れ条件 #48 / #49。実装プラン T5）。
 *
 * 洗い替えと定期ロールアップは**同じ資源**（`analytics` の Core 行）を
 * (site, day) 単位で差し替える。別々の鍵にすると、029 が「同じロックに載せることで
 * 起きなくなる」と書いた `replaceCorePoints` の DELETE → INSERT の衝突が復活する。
 *
 * **既存のジョブは `lockName` を書かない。** 書かなければ `job.lockName ?? job.name` が
 * `job.name` に落ち、029 の挙動と 1 ビットも変わらない。
 */
describe('lockName（鍵の名前をジョブ名と分ける）', () => {
  /** `lockName` を持つ検証用のジョブ。 */
  function taskWithLock<TInput = undefined>(
    name: JobName,
    lockName: JobName,
    run: (
      connection: Connection,
      input: TInput,
      job: JobContext,
    ) => Promise<Readonly<Record<string, unknown>>>,
  ): JobTask<TInput> {
    return { name, lockName, run };
  }

  /**
   * #48。**鍵の名前ではなくジョブ名で記録される。**
   *
   * `analytics.rollup` の鍵で弾かれても `job_runs` に洗い替えの名前が残らなければ、
   * 画面から「洗い替えが実行されなかった」ことを読み取れない。
   */
  it('鍵で弾かれても job_runs.job_name はジョブ名のまま', async () => {
    const run = vi.fn(async () => ({}));
    const job = taskWithLock('analytics.timezoneRebuild', 'analytics.rollup', run);
    const holder = await holdLock('analytics.rollup');

    try {
      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'manual', wait: false, input: undefined }),
      );

      expect(outcome.outcome).toBe('skipped');
      expect(run).not.toHaveBeenCalled();
      const rows = await rowsOf('analytics.timezoneRebuild');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.job_name).toBe('analytics.timezoneRebuild');
      expect(rows[0]?.status).toBe('skipped');
      // 鍵の名前では 1 行も記録しない。
      expect(await rowsOf('analytics.rollup')).toHaveLength(0);
    } finally {
      await holder.release();
      await holder.end();
    }
  });

  /** #46 / #47 の土台。名前が違っても `lockName` が同じなら排他される。 */
  it('別名のジョブでも lockName が同じなら排他される', async () => {
    const run = vi.fn(async () => ({}));
    const job = taskWithLock('analytics.timezoneRebuild', 'analytics.rollup', run);
    const holder = await holdLock('analytics.rollup');

    try {
      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'manual', wait: false, input: undefined }),
      );
      expect(outcome.outcome).toBe('skipped');
    } finally {
      await holder.release();
      await holder.end();
    }

    // 鍵が空けば走る（検査が空振りしていない）。
    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: false, input: undefined }),
    );
    expect(outcome.outcome).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  /** #49。**`lockName` を持たない既存の形の挙動が変わらない。** 自分の名前の鍵で排他する。 */
  it('lockName が無ければ自分の名前の鍵を取る', async () => {
    const run = vi.fn(async () => ({}));
    const job = jobOf('webhook.deliver', run);
    const holder = await holdLock('webhook.deliver');

    try {
      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      );

      expect(outcome.outcome).toBe('skipped');
      expect(run).not.toHaveBeenCalled();
    } finally {
      await holder.release();
      await holder.end();
    }
  });

  /** #49。他のジョブの鍵に巻き込まれない。 */
  it('lockName が無いジョブは、別のジョブの鍵が握られていても走る', async () => {
    const run = vi.fn(async () => ({ ok: 1 }));
    const job = jobOf('webhook.deliver', run);
    const holder = await holdLock('analytics.rollup');

    try {
      const outcome = await withConnection((connection) =>
        runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
      );

      expect(outcome.outcome).toBe('ok');
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await holder.release();
      await holder.end();
    }
  });
});

/**
 * 途中経過（032-timezone-setting 設計 §6.2.5。実装プラン T6）。
 *
 * 洗い替えは長く走りうる。`job_runs` に「開始した」と「終わった」の 2 点しか無いと、
 * 走っているのか止まっているのかが分からない。
 *
 * **記録できないことと処理できないことは別。** `report` の失敗は握って続ける。
 */
describe('JobContext.report', () => {
  it('report を呼ぶと走行中に job_runs.summary が更新される', async () => {
    let duringRun: Record<string, unknown> | undefined;

    const job: JobTask = {
      name: 'analytics.rollup',
      async run(_connection, _input, context) {
        await context.report({ completedThrough: '2026-03-31' });
        duringRun = (await rowsOf('analytics.rollup'))[0]?.summary;
        return { completedThrough: '2026-04-30' };
      },
    };

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );

    expect(outcome.outcome).toBe('ok');
    expect(duringRun).toEqual({ completedThrough: '2026-03-31' });
    // 最後にもう一度 summary を書く（途中経過と最終結果で 2 系統の書き方をしない）。
    expect((await rowsOf('analytics.rollup'))[0]?.summary).toEqual({
      completedThrough: '2026-04-30',
    });
  });

  it('report が受け取る runId は job_runs の id と同じ', async () => {
    let seen: string | undefined;
    const job: JobTask = {
      name: 'analytics.rollup',
      async run(_connection, _input, context) {
        seen = context.runId;
        return {};
      },
    };

    await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );

    expect(seen).toBe((await rowsOf('analytics.rollup'))[0]?.id);
  });

  it('summary の更新が失敗してもジョブは ok で終わる', async () => {
    const { records } = capture();
    vi.spyOn(jobRunRepository, 'updateSummary').mockRejectedValue(new Error('書けない'));

    const job: JobTask = {
      name: 'analytics.rollup',
      async run(_connection, _input, context) {
        await context.report({ completedThrough: '2026-03-31' });
        return { done: true };
      },
    };

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'manual', wait: true, input: undefined }),
    );

    expect(outcome.outcome).toBe('ok');
    expect(
      records.some(
        (record) => record.level === 'error' && record.message === 'job run could not be recorded',
      ),
    ).toBe(true);
  });

  /** #49。既存の 2 つのジョブは第 3 引数を受け取らずにそのまま動く。 */
  it('run が引数を 2 つしか取らなくても動く', async () => {
    const run = vi.fn(async (_connection: Connection, _input: undefined) => ({ done: true }));
    const job = jobOf('webhook.deliver', run);

    const outcome = await withConnection((connection) =>
      runJob(connection, job, { trigger: 'scheduled', wait: false, input: undefined }),
    );

    expect(outcome.outcome).toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/**
 * `startJobInBackground`（032-timezone-setting 設計 §6.4 末尾。実装プラン T7）。
 *
 * **要求の接続を使わない。** 自分で `withConnection` を張るので、
 * 応答を返したあとに要求のスコープが閉じても影響を受けない。
 * 呼ぶ側は「起こした」ことだけを知る（fire and forget）。
 */
describe('startJobInBackground', () => {
  /** 条件が満たされるまで待つ（決め打ちの `setTimeout` を書かない）。 */
  async function waitForRuns(name: JobName, count: number): Promise<JobRunRow[]> {
    const until = Date.now() + 10_000;
    let rows = await rowsOf(name);
    while (rows.length < count) {
      if (Date.now() > until) {
        throw new Error(`${name} の記録が ${count} 件にならない（${rows.length} 件）`);
      }
      await sleep(50);
      rows = await rowsOf(name);
    }
    return rows;
  }

  it('呼んだ直後に返り、しばらくすると job_runs に行ができる', async () => {
    let started = false;
    const job: JobTask = {
      name: 'analytics.rollup',
      async run() {
        started = true;
        return { done: true };
      },
    };

    // **戻り値を持たない。** 待てないことを型でも示す。
    const returned: void = startJobInBackground(job, undefined);
    expect(returned).toBeUndefined();

    const rows = await waitForRuns('analytics.rollup', 1);
    expect(started).toBe(true);
    expect(rows[0]?.status).toBe('ok');
  });

  it('ジョブが投げても未処理の rejection を残さず、error として記録される', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      const job: JobTask = {
        name: 'analytics.rollup',
        async run() {
          throw new Error('落ちた');
        },
      };

      startJobInBackground(job, undefined);

      const rows = await waitForRuns('analytics.rollup', 1);
      expect(rows[0]?.status).toBe('error');
      // マイクロタスクを 1 周させてから確かめる。
      await sleep(100);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
