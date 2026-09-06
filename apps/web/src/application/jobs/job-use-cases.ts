import { defineUseCase } from '@/application/authorization/use-case';
import { schedulerConfig } from '@/application/jobs/config';
import { schedulerSnapshot } from '@/application/jobs/scheduler';
import { JOB_NAMES, type JobName, type JobRun } from '@/domain/jobs/job';
import { jobRunRepository } from '@/infrastructure/job-run-repository';

/**
 * 定期実行ジョブの状態（029-scheduled-jobs 設計 §6.5）。
 *
 * 監視から `GET /api/v1/jobs` で叩く用途（「最後の成功が N 分より古ければ警告」）と、
 * 設定画面「一般」タブの区画が使う。
 *
 * **`JOB_NAMES` の順で常に 3 件返す。** 未登録・未実行でも `lastRun: null` で返す
 * （「ジョブが無い」と「まだ走っていない」を画面で区別できるようにする）。
 *
 * `scheduled` / `nextRunAt` / `running` は**このプロセス**の予定。
 * 複数プロセス構成ではプロセスごとに違う（画面に注記する）。
 */

/** 画面と API に出す直近のエラーの件数。全文は `GET /api/v1/jobs`。 */
const RECENT_ERROR_LIMIT = 5;

export interface JobStatus {
  readonly name: JobName;
  /** このプロセスで定期実行が有効か。 */
  readonly scheduled: boolean;
  /**
   * 周期（分）。**`null` は「周期を持たない」**（032-timezone-setting 設計 §6.6）。
   *
   * 要求されたときだけ走るジョブ（`analytics.timezoneRebuild`）は `bootScheduler` に
   * 載せないので、このプロセスの予定も既定の間隔も持たない。
   */
  readonly intervalMinutes: number | null;
  /** このプロセスの次回の予定。無効・未起動なら null。 */
  readonly nextRunAt: Date | null;
  /** このプロセスで実行中か。 */
  readonly running: boolean;
  /** 直近の実行（`skipped` を含む）。 */
  readonly lastRun: JobRun | null;
  /** `status = 'ok'` の直近。 */
  readonly lastSuccess: JobRun | null;
  /** `status = 'error'` の直近 5 件（新しい順）。 */
  readonly recentErrors: readonly JobRun[];
}

export const listJobStatuses = defineUseCase<Record<string, never>, readonly JobStatus[]>({
  name: 'jobs.status',
  permission: 'system.manage',
  handler: async (context) => {
    const snapshot = schedulerSnapshot();
    const config = schedulerConfig();
    // 基盤が未起動・無効なら、間隔は環境変数の解釈後の値を出す（実装プラン §8 #1）。
    const configuredMinutes: Record<JobName, number | null> = {
      'analytics.rollup': config.rollupIntervalMinutes,
      'webhook.deliver': config.webhookIntervalMinutes,
      // **周期を持たない。** `bootScheduler` に載せないので `scheduled` が undefined になり、
      // ここがそのまま `null` として出る（分岐を足さない）。
      'analytics.timezoneRebuild': null,
    };

    return Promise.all(
      JOB_NAMES.map(async (name): Promise<JobStatus> => {
        const scheduled = snapshot.jobs.find((entry) => entry.name === name);
        const [lastRun, lastSuccess, recentErrors] = await Promise.all([
          jobRunRepository.findLatest(context.connection, name),
          jobRunRepository.findLatestSucceeded(context.connection, name),
          jobRunRepository.listRecentErrors(context.connection, name, RECENT_ERROR_LIMIT),
        ]);

        return {
          name,
          scheduled: snapshot.enabled && scheduled !== undefined,
          intervalMinutes: scheduled?.intervalMinutes ?? configuredMinutes[name],
          nextRunAt: scheduled?.nextRunAt ?? null,
          running: scheduled?.running ?? false,
          lastRun,
          lastSuccess,
          recentErrors,
        };
      }),
    );
  },
});
