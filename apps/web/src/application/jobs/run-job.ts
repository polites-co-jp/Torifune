import { uuidv7 } from 'uuidv7';
import { runnerName } from '@/application/jobs/config';
import type { JobTask } from '@/application/jobs/scheduler';
import { withConnection } from '@/application/transaction';
import type { Connection } from '@/database/provider';
import {
  JOB_RUN_RETENTION,
  truncateError,
  type JobName,
  type JobRun,
  type JobTrigger,
} from '@/domain/jobs/job';
import { jobLock, type LockOutcome } from '@/infrastructure/job-lock';
import { jobRunRepository } from '@/infrastructure/job-run-repository';
import { log } from '@/infrastructure/logging';
import { redactSecrets } from '@/infrastructure/secret-text';

/**
 * ジョブを 1 回だけ実行する（029-scheduled-jobs 設計 §6.1.5）。
 *
 * ロック → `job_runs` に `running` → 実行 → `ok` / `error` に更新 → 解放 → 保持件数の切り詰め。
 *
 * **定期実行と手動 API の両方がここを通る。** 同じロックに載せることで、
 * 同じ日を同時に流して `replaceCorePoints` の DELETE → INSERT がぶつかることが起きなくなる。
 *
 * * **例外は握って返す（投げない）。** 定期実行の基盤を落とさないため
 * * **ロックの競合（`skipped`）と失敗（`error`）を分ける。** 丸めると DB 停止が
 *   「他が実行中」として記録され、監視できるようにするという目的が崩れる（§6.1.6）
 * * **記録に失敗してもジョブの結果は変えない。** 記録できないことと集計できないことは別
 */

/** 手動（API）がロックを待つ時間。定期実行は待たずにスキップする（周期がずれていくため）。 */
export const MANUAL_LOCK_WAIT_MS = 10_000;

export type RunOutcome =
  | { readonly outcome: 'ok'; readonly run: JobRun }
  /** ロック競合（他が実行中／待機枠が埋まっている）。ジョブ関数は呼ばれていない。 */
  | { readonly outcome: 'skipped'; readonly run: JobRun | null }
  /** ジョブの失敗、またはロック取得そのものの失敗。 */
  | { readonly outcome: 'error'; readonly run: JobRun | null; readonly error: unknown };

export interface RunJobOptions<TInput> {
  readonly trigger: JobTrigger;
  /** ロックが取れないときに待つか。API は待ち、定期実行は待たない。 */
  readonly wait: boolean;
  readonly input: TInput;
}

/**
 * `job_runs.error` とログの `reason` に載せる文字列（設計 §6.1.7）。
 *
 * **伏せてから切る。** 逆にすると、途中で切れた接続文字列が完全一致の秘匿に掛からず残る。
 */
function jobErrorText(error: unknown): string {
  return truncateError(redactSecrets(error instanceof Error ? error.message : String(error)));
}

/** 記録できなかったときに返す、DB に無い実行記録。結果を呼ぶ側へ伝えるためだけに使う。 */
function unrecorded(input: {
  readonly id: string;
  readonly jobName: JobName;
  readonly triggeredBy: JobTrigger;
  readonly startedAt: Date;
  readonly summary: Readonly<Record<string, unknown>>;
  readonly runner: string;
}): JobRun {
  return {
    id: input.id,
    jobName: input.jobName,
    triggeredBy: input.triggeredBy,
    status: 'ok',
    startedAt: input.startedAt,
    finishedAt: new Date(),
    error: null,
    summary: input.summary,
    runner: input.runner,
  };
}

/**
 * 記録の失敗を握る。
 *
 * ログには出すが、ジョブの結果は変えない（設計 §6.1.5 手順 6）。
 */
async function record<T>(
  jobName: JobName,
  step: string,
  action: () => Promise<T>,
): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    log.error('job run could not be recorded', {
      job: jobName,
      step,
      reason: jobErrorText(error),
    });
    return null;
  }
}

/**
 * 保持件数の切り詰め。
 *
 * **`skipped` とロック失敗の記録の直後にも呼ぶ**（設計 §6.1.5 手順 1）。
 * `ok` / `error` の経路にしか無いと、ロック競合を繰り返すだけで `job_runs` が上限なく伸びる。
 */
async function trim(connection: Connection, jobName: JobName): Promise<void> {
  await record(jobName, 'trim', () =>
    jobRunRepository.trimHistory(connection, jobName, JOB_RUN_RETENTION),
  );
}

export async function runJob<TInput>(
  connection: Connection,
  job: JobTask<TInput>,
  options: RunJobOptions<TInput>,
): Promise<RunOutcome> {
  const runner = runnerName();
  const id = uuidv7();

  // **`jobLock.acquire(...)` の形で呼ぶ**（分解代入するとテストの差し替えが効かない）。
  //
  // **`try` で包む。** `connection.db.connection()` を持たない Provider（差し替えた Plugin）だと
  // 例外が `await` の前に同期で飛び、下の `try` の外を素通りしてルートまで抜ける。
  // `job_runs` に記録が残らず、API も 500 の理由を失う。
  let acquired: LockOutcome;
  try {
    // **鍵は `lockName`、記録は `job.name`。** 同じ資源を触る別名のジョブを
    // 同じ待ち行列に載せるため（032-timezone-setting 設計 §6.2.3）。
    // 省略されていれば `job.name` に落ち、029 の挙動と変わらない。
    acquired = await jobLock.acquire(connection, job.lockName ?? job.name, {
      waitMs: options.wait ? MANUAL_LOCK_WAIT_MS : 0,
    });
  } catch (error) {
    acquired = { ok: false, reason: 'failed', error };
  }

  if (!acquired.ok && acquired.reason === 'busy') {
    const at = new Date();
    const run = await record(job.name, 'skipped', () =>
      jobRunRepository.insertSkipped(connection, {
        id,
        jobName: job.name,
        triggeredBy: options.trigger,
        runner,
        at,
      }),
    );
    log.info('job skipped', { job: job.name, trigger: options.trigger, runId: id });
    await trim(connection, job.name);
    return { outcome: 'skipped', run };
  }

  if (!acquired.ok) {
    // ロックのセッション自体の失敗。**競合ではない**ので `skipped` にしない（手動 API は 500）。
    const at = new Date();
    const reason = jobErrorText(acquired.error);
    const run = await record(job.name, 'lock-failed', () =>
      jobRunRepository.insertError(connection, {
        id,
        jobName: job.name,
        triggeredBy: options.trigger,
        runner,
        at,
        error: reason,
      }),
    );
    log.error('job lock failed', {
      job: job.name,
      trigger: options.trigger,
      runId: id,
      reason,
    });
    await trim(connection, job.name);
    return { outcome: 'error', run, error: acquired.error };
  }

  const lock = acquired.lock;

  try {
    const started = await record(job.name, 'running', () =>
      jobRunRepository.insertRunning(connection, {
        id,
        jobName: job.name,
        triggeredBy: options.trigger,
        runner,
      }),
    );
    const startedAt = started?.startedAt ?? new Date();
    log.info('job started', { job: job.name, trigger: options.trigger, runId: id, runner });

    const beganAt = Date.now();
    try {
      // 途中経過を書く口（設計 §6.2.5）。**失敗は握って続ける。**
      // 最後に `finishOk` がもう一度 `summary` を書くので、2 系統の書き方をしない。
      const report = async (progress: Readonly<Record<string, unknown>>): Promise<void> => {
        await record(job.name, 'report', () =>
          jobRunRepository.updateSummary(connection, id, progress),
        );
      };

      // **ロックの接続とは別の（通常の）接続で走らせる。** ジョブの中のトランザクションは従来どおり。
      const summary = await job.run(connection, options.input, { runId: id, report });
      const finished = await record(job.name, 'ok', () =>
        jobRunRepository.finishOk(connection, id, summary),
      );

      log.info('job finished', {
        job: job.name,
        trigger: options.trigger,
        runId: id,
        durationMs: Date.now() - beganAt,
        summary,
      });

      return {
        outcome: 'ok',
        run:
          finished ??
          unrecorded({
            id,
            jobName: job.name,
            triggeredBy: options.trigger,
            startedAt,
            summary,
            runner,
          }),
      };
    } catch (error) {
      const reason = jobErrorText(error);
      const failed = await record(job.name, 'error', () =>
        jobRunRepository.finishError(connection, id, reason),
      );

      log.error('job failed', {
        job: job.name,
        trigger: options.trigger,
        runId: id,
        durationMs: Date.now() - beganAt,
        reason,
      });

      return { outcome: 'error', run: failed, error };
    }
  } finally {
    // **`release()` は握る。** セッション本体が既に失敗していると投げうるので、
    // 包まないと「例外は握って返す」契約が破れる（設計 §6.1.5 手順 5）。
    try {
      await lock.release();
    } catch (error) {
      log.warn('job lock release failed', { job: job.name, reason: jobErrorText(error) });
    }
    await trim(connection, job.name);
  }
}

/**
 * 応答を待たせずにジョブを起こす（032-timezone-setting 設計 §6.4 末尾）。
 *
 * **要求の接続を使わない。** 自分で `withConnection` を張るので、
 * 応答を返したあとに要求のスコープが閉じても影響を受けない。
 *
 * **これは fire and forget である。** 戻り値を持たず、待てず、
 * プロセスが落ちれば止まる。Torifune は `instrumentation.ts` で定期実行を持つ
 * 常駐サーバーとして動く前提なので採る（029 設計 §6.1.1）。
 * 止まったときの立て直しは、設定画面の再実行ボタンから人が行う（設計 §7.3）。
 *
 * 例外は握ってログに出す（`runJob` 自体も例外を投げないが、接続の取得は投げうる）。
 */
export function startJobInBackground<TInput>(job: JobTask<TInput>, input: TInput): void {
  void withConnection((connection) =>
    runJob(connection, job, { trigger: 'manual', wait: true, input }),
  ).catch((error: unknown) => {
    log.error('background job could not be started', {
      job: job.name,
      reason: jobErrorText(error),
    });
  });
}
