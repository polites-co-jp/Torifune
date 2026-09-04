import { schedulerConfig } from '@/application/jobs/config';
import { ROLLUP_JOB, WEBHOOK_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { withConnection } from '@/application/transaction';
import type { Connection } from '@/database/provider';
import type { JobName } from '@/domain/jobs/job';
import { log } from '@/infrastructure/logging';
import { processState } from '@/infrastructure/process-state';
import { redactSecrets } from '@/infrastructure/secret-text';

/**
 * 周期実行の基盤（029-scheduled-jobs 設計 §6.1.1〜§6.1.3）。
 *
 * **`setTimeout` の連鎖にする（`setInterval` にしない）。** 実行が終わってから
 * `intervalMs` 後に次を予約するので、同一プロセス内で同じジョブが重ならない。
 * タイマーは `unref()` してプロセスの終了を妨げない。
 *
 * **どこで例外が出ても基盤は止めない。** ログに出して次を予約する。
 *
 * プロセス間の排他は `runJob` の advisory lock が持つ（§6.1.6）。
 * ここが見ているのは「このプロセスの予定」だけ。
 */

/** 起動からの初回遅延。DB や Plugin の立ち上がりを少し待つ。 */
const DEFAULT_INITIAL_DELAY_MS = 15_000;

const MINUTE_MS = 60_000;

export interface JobDefinition<TInput = undefined> {
  readonly name: JobName;
  readonly intervalMs: number;
  /** 起動からの初回遅延。既定 15 秒。 */
  readonly initialDelayMs?: number;
  /** 実行本体。戻り値が `job_runs.summary` になる。 */
  run(connection: Connection, input: TInput): Promise<Readonly<Record<string, unknown>>>;
}

export interface SchedulerOptions {
  readonly jobs: readonly JobDefinition<undefined>[];
  /**
   * 各実行の前に呼ぶ（Plugin の起動）。失敗したらその回は走らせない。
   *
   * Application から `plugin/` を import しないよう、`instrumentation.ts` が注入する（§6.1.4）。
   */
  readonly prepare?: () => Promise<unknown>;
  readonly enabled: boolean;
  /** テスト用。既定は `runJob`。 */
  readonly execute?: typeof runJob;
}

export interface JobSnapshot {
  readonly name: JobName;
  readonly intervalMinutes: number;
  /** 次回の予定（**このプロセス**）。無効・停止中は null。 */
  readonly nextRunAt: Date | null;
  readonly running: boolean;
}

export interface SchedulerSnapshot {
  /** `register()` が基盤を初期化したか（テスト・未起動との区別）。 */
  readonly booted: boolean;
  readonly enabled: boolean;
  readonly jobs: readonly JobSnapshot[];
}

export interface Scheduler {
  start(): void;
  stop(): void;
  snapshot(): SchedulerSnapshot;
  /** 手で 1 回だけ実行する口（テスト・検証用）。予約はしない。 */
  tick(name: JobName): Promise<void>;
}

interface JobState {
  readonly job: JobDefinition<undefined>;
  timer: ReturnType<typeof setTimeout> | null;
  nextRunAt: Date | null;
  running: boolean;
}

/**
 * ログへ載せる失敗の理由（設計 §6.1.7）。
 *
 * `prepare()`（Plugin の起動）も `withConnection`（Provider の `connect()`）も、
 * **Plugin が差し替えた実装の例外**を受けうる。標準 Provider の秘匿を通らないので、
 * メッセージに接続文字列が入りうる。自由文なので `redactSecrets` を通す
 * （`logging.ts` の `maskSecrets` はキー名判定で、中身には効かない）。
 */
function reasonOf(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const execute = options.execute ?? runJob;
  const states: JobState[] = options.jobs.map((job) => ({
    job,
    timer: null,
    nextRunAt: null,
    running: false,
  }));
  let active = false;

  function schedule(state: JobState, delayMs: number): void {
    if (!active) {
      return;
    }
    state.nextRunAt = new Date(Date.now() + delayMs);
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      void tick(state);
    }, delayMs);
    // プロセスの終了を妨げない。
    (timer as { unref?: () => void }).unref?.();
    state.timer = timer;
  }

  async function tick(state: JobState): Promise<void> {
    state.timer = null;
    state.running = true;
    try {
      // Plugin が Database Provider を差し替える構成では、標準 Provider で集計しないよう先に起動する。
      if (options.prepare !== undefined) {
        await options.prepare();
      }
      await withConnection((connection) =>
        execute(connection, state.job, { trigger: 'scheduled', wait: false, input: undefined }),
      );
    } catch (error) {
      log.error('job tick failed', { job: state.job.name, reason: reasonOf(error) });
    } finally {
      state.running = false;
      schedule(state, state.job.intervalMs);
    }
  }

  return {
    start(): void {
      if (!options.enabled || active) {
        return;
      }
      active = true;
      for (const state of states) {
        schedule(state, state.job.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS);
      }
    },

    stop(): void {
      active = false;
      for (const state of states) {
        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }
        state.nextRunAt = null;
      }
    },

    snapshot(): SchedulerSnapshot {
      return {
        booted: true,
        enabled: options.enabled,
        jobs: states.map((state) => ({
          name: state.job.name,
          intervalMinutes: Math.round(state.job.intervalMs / MINUTE_MS),
          nextRunAt: state.nextRunAt,
          running: state.running,
        })),
      };
    },

    async tick(name: JobName): Promise<void> {
      const state = states.find((candidate) => candidate.job.name === name);
      if (state !== undefined) {
        await tick(state);
      }
    },
  };
}

interface SchedulerHolder {
  instance: Scheduler | null;
  onSignal: (() => void) | null;
}

/**
 * プロセスに 1 つ。
 *
 * `processState` は消せないので、可変なホルダを置いてリセットする
 * （`plugin/runtime.ts` の `runtime.boot` と同じ形）。
 */
function holder(): SchedulerHolder {
  return processState<SchedulerHolder>('jobs.scheduler', () => ({
    instance: null,
    onSignal: null,
  }));
}

const EMPTY_SNAPSHOT: SchedulerSnapshot = { booted: false, enabled: false, jobs: [] };

/**
 * 基盤を起動する（`instrumentation.ts` の `register()` から呼ぶ）。
 *
 * 2 回呼ばれても（`next dev` の HMR）タイマーを重ねない。
 * **Vitest（`NODE_ENV === 'test'`）では何もしない。** 単体テストは `createScheduler` を明示的に作る。
 */
export function bootScheduler(options: { prepare: () => Promise<unknown> }): void {
  if (process.env['NODE_ENV'] === 'test') {
    log.debug('scheduler is not started in the test environment');
    return;
  }

  const state = holder();
  if (state.instance !== null) {
    return;
  }

  const config = schedulerConfig();
  // 定義は既定の間隔を持ち、環境変数がそれを上書きする（§6.1.2 / §6.2）。
  const scheduler = createScheduler({
    jobs: [
      { ...ROLLUP_JOB, intervalMs: config.rollupIntervalMinutes * MINUTE_MS },
      { ...WEBHOOK_JOB, intervalMs: config.webhookIntervalMinutes * MINUTE_MS },
    ],
    prepare: options.prepare,
    enabled: config.enabled,
  });

  state.instance = scheduler;

  // ホルダへ初めて入れたときだけ登録する（2 回目の `bootScheduler` で二重登録しない）。
  const onSignal = (): void => {
    scheduler.stop();
  };
  state.onSignal = onSignal;
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  scheduler.start();
  log.info('scheduler started', {
    enabled: config.enabled,
    rollupIntervalMinutes: config.rollupIntervalMinutes,
    webhookIntervalMinutes: config.webhookIntervalMinutes,
  });
}

/** 画面と API が読む。未起動なら `{ booted: false, enabled: false, jobs: [] }`。 */
export function schedulerSnapshot(): SchedulerSnapshot {
  return holder().instance?.snapshot() ?? EMPTY_SNAPSHOT;
}

/** テスト用。停止してホルダを空にし、シグナルのハンドラを外す。 */
export function resetSchedulerForTests(): void {
  const state = holder();
  state.instance?.stop();
  state.instance = null;
  if (state.onSignal !== null) {
    process.removeListener('SIGTERM', state.onSignal);
    process.removeListener('SIGINT', state.onSignal);
    state.onSignal = null;
  }
}
