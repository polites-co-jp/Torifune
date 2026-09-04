import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSchedulerConfig, schedulerConfig } from '@/application/jobs/config';
import type { runJob, RunOutcome } from '@/application/jobs/run-job';
import {
  bootScheduler,
  createScheduler,
  resetSchedulerForTests,
  schedulerSnapshot,
  type JobDefinition,
} from '@/application/jobs/scheduler';
import type { Connection } from '@/database/provider';
import { setDatabaseProvider } from '@/database/registry';
import type { JobName, JobRun } from '@/domain/jobs/job';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';

/**
 * 周期実行の基盤（029-scheduled-jobs 設計 §6.1.1〜§6.1.3、受け入れ条件 #23〜#31）。
 *
 * DB を使わない。`tick` は `withConnection` を通るので、**偽の Provider** を差す
 * （`execute` を差し替えるので `db` には触れない）。時間は `vi.useFakeTimers()` で進める。
 *
 * - `setTimeout` の連鎖（完了基準の周期。同一プロセスで重ならない）
 * - どこで例外が出ても基盤は止めない（`log.error('job tick failed')` して次を予約）
 * - `enabled: false` はタイマーを 1 つも作らない
 * - `bootScheduler` はプロセスに 1 つ。`NODE_ENV === 'test'` では何もしない
 */

const fakeConnection: Connection = {
  db: {} as never,
  transaction: (fn) => fn(fakeConnection),
};

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

function fakeRun(name: JobName): JobRun {
  return {
    id: `run-${name}`,
    jobName: name,
    triggeredBy: 'scheduled',
    status: 'ok',
    startedAt: new Date(),
    finishedAt: new Date(),
    error: null,
    summary: {},
    runner: 'test:1',
  };
}

type Execute = typeof runJob;
type ExecuteMock = ReturnType<typeof vi.fn<Execute>>;

/** すぐに ok を返す `execute`。 */
function immediateExecute(): ExecuteMock {
  return vi.fn<Execute>(async (_connection, job) => ({
    outcome: 'ok',
    run: fakeRun(job.name),
  }));
}

/** `durationMs` 待ってから ok を返す `execute`（fake timers で進める）。 */
function slowExecute(durationMs: number): ExecuteMock {
  return vi.fn<Execute>(
    (_connection, job) =>
      new Promise<RunOutcome>((resolve) => {
        setTimeout(() => resolve({ outcome: 'ok', run: fakeRun(job.name) }), durationMs);
      }),
  );
}

function jobOf(name: JobName, intervalMs: number, initialDelayMs?: number): JobDefinition {
  return {
    name,
    intervalMs,
    ...(initialDelayMs === undefined ? {} : { initialDelayMs }),
    run: async () => ({}),
  };
}

const ROLLUP = jobOf('analytics.rollup', 60_000);
const WEBHOOK = jobOf('webhook.deliver', 60_000);

/** 呼び出しの 3 番目の引数（options）。 */
function optionsOf(execute: ExecuteMock, index: number) {
  return execute.mock.calls[index]?.[2];
}

function jobNamesCalled(execute: ExecuteMock): string[] {
  return execute.mock.calls.map((call) => call[1].name);
}

let stopCurrent: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
  setDatabaseProvider({
    connect: async () => fakeConnection,
    disconnect: async () => undefined,
    healthCheck: async () => true,
  });
});

afterEach(() => {
  stopCurrent?.();
  stopCurrent = null;
  resetSchedulerForTests();
  resetSchedulerConfig();
  setDatabaseProvider(null);
  resetLogger();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function start(options: Parameters<typeof createScheduler>[0]) {
  const scheduler = createScheduler(options);
  scheduler.start();
  stopCurrent = () => scheduler.stop();
  return scheduler;
}

describe('初回と周期', () => {
  /** #23 */
  it('start() から initialDelayMs（既定 15 秒）後に各ジョブの execute が 1 回ずつ呼ばれる', async () => {
    const execute = immediateExecute();
    start({ jobs: [ROLLUP, WEBHOOK], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(14_000);
    expect(execute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(jobNamesCalled(execute).sort()).toEqual(['analytics.rollup', 'webhook.deliver']);
  });

  /** #23。定期実行は trigger: 'scheduled'、wait: false（待たずにスキップ）。 */
  it("execute は trigger: 'scheduled'、wait: false で呼ばれる", async () => {
    const execute = immediateExecute();
    start({ jobs: [ROLLUP], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(15_000);

    expect(optionsOf(execute, 0)).toMatchObject({ trigger: 'scheduled', wait: false });
    expect(execute.mock.calls[0]?.[0]).toBe(fakeConnection);
  });

  /** #23。initialDelayMs を指定すればその値。 */
  it('initialDelayMs を指定するとその遅延で初回が呼ばれる', async () => {
    const execute = immediateExecute();
    start({ jobs: [jobOf('analytics.rollup', 60_000, 2_000)], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /** #24。周期は完了基準。 */
  it('実行が完了してから intervalMs 後に次が呼ばれる（20 秒かかるジョブ・間隔 60 秒で 100 秒進めて 2 回）', async () => {
    const execute = slowExecute(20_000);
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], enabled: true, execute });

    // 0 秒：1 回目開始 → 20 秒：完了 → 80 秒：2 回目開始（setInterval なら 60 秒で 2 回目になる）。
    await vi.advanceTimersByTimeAsync(70_000);
    expect(execute).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  /** #24。同一プロセス内で同じジョブが重ならない。 */
  it('実行中は同じジョブの次の実行が始まらない', async () => {
    const execute = slowExecute(120_000);
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(110_000);

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('失敗しても止まらない', () => {
  /** #25 */
  it('execute が reject しても job tick failed のログが出て、次の周期にまた呼ばれる', async () => {
    const { records } = capture();
    const execute = vi.fn<Execute>(async () => {
      throw new Error('DB に接続できない');
    });
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    const failed = records.filter((record) => record.message === 'job tick failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe('error');
    expect(failed[0]?.fields?.['job']).toBe('analytics.rollup');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  /** #26 */
  it('prepare が reject するとその回は execute を呼ばず、次の周期に prepare からやり直す', async () => {
    const { records } = capture();
    let attempts = 0;
    const prepare = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Plugin の起動に失敗した');
      return undefined;
    });
    const execute = immediateExecute();
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], prepare, enabled: true, execute });

    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(
      records.some((record) => record.level === 'error' && record.message === 'job tick failed'),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /**
   * #84（security-reviewer M-2）。**`job tick failed` の `reason` にも秘匿を通す。**
   *
   * `prepare()` は Plugin の起動（`ensurePluginsStartedAnonymously`）で、
   * `withConnection` は Provider の `connect()` を通る。どちらも
   * **Plugin が差し替えた実装の例外**を受けうるので、メッセージに接続文字列が入りうる
   * （標準 Provider の `redact()` は通らない）。
   */
  it('prepare が接続文字列を含むメッセージで reject しても、ログの reason に出ない', async () => {
    const url = 'postgresql://appuser:sup3rs3cret@db.internal:5432/torifune';
    vi.stubEnv('DATABASE_URL', url);
    const { records } = capture();
    const prepare = vi.fn(async () => {
      throw new Error(`Plugin の起動に失敗した: ${url}`);
    });
    start({
      jobs: [jobOf('analytics.rollup', 60_000, 0)],
      prepare,
      enabled: true,
      execute: immediateExecute(),
    });

    await vi.advanceTimersByTimeAsync(0);

    const failed = records.find((record) => record.message === 'job tick failed');
    expect(failed).toBeDefined();
    const reason = String(failed?.fields?.['reason'] ?? '');
    expect(reason).not.toContain(url);
    expect(reason).not.toContain('sup3rs3cret');
    expect(reason).toContain('***');
  });

  /** #84。`execute`（= `runJob`）から漏れた例外も同じ経路を通る。 */
  it('execute が接続文字列を含むメッセージで reject しても、ログの reason に出ない', async () => {
    const url = 'postgresql://appuser:sup3rs3cret@db.internal:5432/torifune';
    vi.stubEnv('DATABASE_URL', url);
    const { records } = capture();
    const execute = vi.fn<Execute>(async () => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    });
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(0);

    const reason = String(
      records.find((record) => record.message === 'job tick failed')?.fields?.['reason'] ?? '',
    );
    expect(reason).not.toContain(url);
    expect(reason).toContain('***');
  });

  /** #84 の対。接続情報を含まない理由はそのまま出す（原因の手がかりを消さない）。 */
  it('接続情報を含まない失敗の理由はそのまま出る', async () => {
    const { records } = capture();
    const execute = vi.fn<Execute>(async () => {
      throw new Error('DB に接続できない');
    });
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], enabled: true, execute });

    await vi.advanceTimersByTimeAsync(0);

    expect(records.find((record) => record.message === 'job tick failed')?.fields?.['reason']).toBe(
      'DB に接続できない',
    );
  });

  /** #26 の前提。prepare は各実行の前に毎回呼ばれる。 */
  it('prepare は各実行の前に呼ばれる', async () => {
    const order: string[] = [];
    const prepare = vi.fn(async () => {
      order.push('prepare');
    });
    const execute = vi.fn<Execute>(async (_connection, job) => {
      order.push('execute');
      return { outcome: 'ok', run: fakeRun(job.name) };
    });
    start({ jobs: [jobOf('analytics.rollup', 60_000, 0)], prepare, enabled: true, execute });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(order).toEqual(['prepare', 'execute', 'prepare', 'execute']);
  });
});

describe('無効と停止', () => {
  /** #27 */
  it('enabled: false のとき start() はタイマーを作らず、時間を進めても execute は呼ばれない', async () => {
    const execute = immediateExecute();
    const scheduler = start({ jobs: [ROLLUP, WEBHOOK], enabled: false, execute });

    expect(vi.getTimerCount()).toBe(0);
    const snapshot = scheduler.snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.jobs.map((job) => job.nextRunAt)).toEqual([null, null]);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(execute).not.toHaveBeenCalled();
  });

  /** #28 */
  it('stop() 後は時間を進めても execute が呼ばれない', async () => {
    const execute = immediateExecute();
    const scheduler = start({ jobs: [ROLLUP, WEBHOOK], enabled: true, execute });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(execute).toHaveBeenCalledTimes(2);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** #28 */
  it('stop() を 2 回呼んでも例外にならない', () => {
    const scheduler = start({ jobs: [ROLLUP], enabled: true, execute: immediateExecute() });

    scheduler.stop();
    expect(() => scheduler.stop()).not.toThrow();
  });
});

describe('snapshot()', () => {
  /** #29 */
  it('nextRunAt が予約した時刻と一致する', async () => {
    const execute = immediateExecute();
    const scheduler = start({ jobs: [jobOf('analytics.rollup', 60_000)], enabled: true, execute });

    const initial = scheduler.snapshot();
    expect(initial.enabled).toBe(true);
    expect(initial.jobs).toHaveLength(1);
    expect(initial.jobs[0]?.name).toBe('analytics.rollup');
    expect(initial.jobs[0]?.intervalMinutes).toBe(1);
    // 初回は start() + 15 秒。
    expect(initial.jobs[0]?.nextRunAt?.toISOString()).toBe('2026-09-04T00:00:15.000Z');

    await vi.advanceTimersByTimeAsync(15_000);
    // 完了（即時）+ 60 秒。
    expect(scheduler.snapshot().jobs[0]?.nextRunAt?.toISOString()).toBe('2026-09-04T00:01:15.000Z');
  });

  /** #29 */
  it('execute の実行中は running: true、完了後は false', async () => {
    const execute = slowExecute(5_000);
    const scheduler = start({
      jobs: [jobOf('analytics.rollup', 60_000, 0)],
      enabled: true,
      execute,
    });

    expect(scheduler.snapshot().jobs[0]?.running).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot().jobs[0]?.running).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(scheduler.snapshot().jobs[0]?.running).toBe(false);
  });

  /** #29。tick(name) は手で 1 回だけ実行する口。 */
  it('tick(name) で 1 回だけ実行できる', async () => {
    const execute = immediateExecute();
    const scheduler = createScheduler({ jobs: [ROLLUP, WEBHOOK], enabled: true, execute });

    await scheduler.tick('webhook.deliver');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(jobNamesCalled(execute)).toEqual(['webhook.deliver']);
  });
});

describe('bootScheduler', () => {
  /** #30。Vitest（NODE_ENV=test）では何もしない。 */
  it('NODE_ENV=test では起動せず、schedulerSnapshot().booted は false', () => {
    expect(process.env['NODE_ENV']).toBe('test');

    bootScheduler({ prepare: async () => undefined });

    expect(vi.getTimerCount()).toBe(0);
    expect(schedulerSnapshot()).toEqual({ booted: false, enabled: false, jobs: [] });
  });

  /** #30。processState で 1 つ。2 回呼んでもタイマーが増えない。 */
  it('2 回呼んでも初期化は 1 回で、タイマーがジョブ数のまま増えない', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TORIFUNE_SCHEDULER', 'on');
    resetSchedulerConfig();

    bootScheduler({ prepare: async () => undefined });
    const after1 = vi.getTimerCount();
    bootScheduler({ prepare: async () => undefined });
    const after2 = vi.getTimerCount();

    // Core の 2 ジョブ（analytics.rollup / webhook.deliver）。
    expect(after1).toBe(2);
    expect(after2).toBe(2);
    const snapshot = schedulerSnapshot();
    expect(snapshot.booted).toBe(true);
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.jobs.map((job) => job.name)).toEqual(['analytics.rollup', 'webhook.deliver']);
  });

  /** #30 の前提。既定の間隔は 15 分 / 1 分。 */
  it('既定の間隔は analytics.rollup が 15 分、webhook.deliver が 1 分', () => {
    vi.stubEnv('NODE_ENV', 'production');
    resetSchedulerConfig();

    bootScheduler({ prepare: async () => undefined });

    expect(schedulerSnapshot().jobs.map((job) => [job.name, job.intervalMinutes])).toEqual([
      ['analytics.rollup', 15],
      ['webhook.deliver', 1],
    ]);
  });
});

describe('環境変数', () => {
  /** #31 */
  it("TORIFUNE_ROLLUP_INTERVAL_MINUTES = '5' で間隔が 5 分になる", () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TORIFUNE_ROLLUP_INTERVAL_MINUTES', '5');
    resetSchedulerConfig();

    expect(schedulerConfig().rollupIntervalMinutes).toBe(5);

    bootScheduler({ prepare: async () => undefined });
    expect(
      schedulerSnapshot().jobs.find((job) => job.name === 'analytics.rollup')?.intervalMinutes,
    ).toBe(5);
  });

  /** #31 */
  it("TORIFUNE_WEBHOOK_INTERVAL_MINUTES = '3' で間隔が 3 分になる", () => {
    vi.stubEnv('TORIFUNE_WEBHOOK_INTERVAL_MINUTES', '3');
    resetSchedulerConfig();

    expect(schedulerConfig().webhookIntervalMinutes).toBe(3);
  });

  /** #31 */
  it("TORIFUNE_ROLLUP_INTERVAL_MINUTES = 'abc' は既定の 15 分に落ち、warn のログが出る", () => {
    const { records } = capture();
    vi.stubEnv('TORIFUNE_ROLLUP_INTERVAL_MINUTES', 'abc');
    resetSchedulerConfig();

    expect(schedulerConfig().rollupIntervalMinutes).toBe(15);
    const warned = records.filter((record) => record.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain('TORIFUNE_ROLLUP_INTERVAL_MINUTES');
  });

  /** #31 */
  it("TORIFUNE_SCHEDULER = 'off' で enabled: false", () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TORIFUNE_SCHEDULER', 'off');
    resetSchedulerConfig();

    expect(schedulerConfig().enabled).toBe(false);

    bootScheduler({ prepare: async () => undefined });
    expect(vi.getTimerCount()).toBe(0);
    const snapshot = schedulerSnapshot();
    expect(snapshot.booted).toBe(true);
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.jobs.map((job) => job.nextRunAt)).toEqual([null, null]);
  });

  /** #31 */
  it("TORIFUNE_SCHEDULER = 'maybe' は enabled: true に落ち、警告が出る", () => {
    const { records } = capture();
    vi.stubEnv('TORIFUNE_SCHEDULER', 'maybe');
    resetSchedulerConfig();

    expect(schedulerConfig().enabled).toBe(true);
    const warned = records.filter((record) => record.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(JSON.stringify(warned[0])).toContain('TORIFUNE_SCHEDULER');
  });

  /** #31。警告はプロセスで 1 回だけ。 */
  it('不正な値の警告は何度読んでも 1 回だけ', () => {
    const { records } = capture();
    vi.stubEnv('TORIFUNE_ROLLUP_INTERVAL_MINUTES', '0');
    resetSchedulerConfig();

    schedulerConfig();
    schedulerConfig();
    schedulerConfig();

    expect(records.filter((record) => record.level === 'warn')).toHaveLength(1);
  });

  /** #31 の対。未設定は警告しない。 */
  it('未設定なら警告せず既定（on / 15 / 1）', () => {
    const { records } = capture();
    vi.stubEnv('TORIFUNE_SCHEDULER', '');
    vi.stubEnv('TORIFUNE_ROLLUP_INTERVAL_MINUTES', '');
    vi.stubEnv('TORIFUNE_WEBHOOK_INTERVAL_MINUTES', '');
    resetSchedulerConfig();

    expect(schedulerConfig()).toMatchObject({
      enabled: true,
      rollupIntervalMinutes: 15,
      webhookIntervalMinutes: 1,
    });
    expect(records.filter((record) => record.level === 'warn')).toHaveLength(0);
  });
});
