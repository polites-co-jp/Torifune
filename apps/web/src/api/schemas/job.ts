import { z } from 'zod';
import type { JobStatus } from '@/application/jobs/job-use-cases';
import type { JobRun } from '@/domain/jobs/job';
import { isoDateTimeSchema, listEnvelope } from './envelope';

/**
 * 定期実行ジョブの API スキーマ（029-scheduled-jobs 設計 §6.5）。
 *
 * 日時は ISO 8601 の文字列にする。**`Date` をそのまま `Response.json` へ渡さない**
 * （形が JSON の直列化に依存する）。
 */

export const jobRunSchema = z.object({
  id: z.string(),
  jobName: z.string(),
  /** `scheduled`（本体の定期実行）か `manual`（API から）。 */
  triggeredBy: z.string(),
  /** `running` / `ok` / `error` / `skipped`。 */
  status: z.string(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  /** 例外のメッセージだけ。スタックトレース・SQL・接続情報は入らない。 */
  error: z.string().nullable(),
  /** 結果の概要（rollup: from / to / days / points、webhook: attempted / delivered / failed）。 */
  summary: z.record(z.string(), z.unknown()),
  /** 実行したプロセス（`hostname:pid`）。 */
  runner: z.string().nullable(),
});

export const jobStatusSchema = z.object({
  name: z.string(),
  /** 応答を返したプロセスで定期実行が有効か。 */
  scheduled: z.boolean(),
  intervalMinutes: z.number().int(),
  /** 応答を返したプロセスの次回の予定。 */
  nextRunAt: isoDateTimeSchema.nullable(),
  running: z.boolean(),
  lastRun: jobRunSchema.nullable(),
  lastSuccess: jobRunSchema.nullable(),
  recentErrors: z.array(jobRunSchema),
});

export const jobStatusListSchema = listEnvelope(jobStatusSchema);

export function toJobRunResponse(run: JobRun): z.infer<typeof jobRunSchema> {
  return {
    id: run.id,
    jobName: run.jobName,
    triggeredBy: run.triggeredBy,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    error: run.error,
    summary: run.summary,
    runner: run.runner,
  };
}

export function toJobStatusResponse(status: JobStatus): z.infer<typeof jobStatusSchema> {
  return {
    name: status.name,
    scheduled: status.scheduled,
    intervalMinutes: status.intervalMinutes,
    nextRunAt: status.nextRunAt?.toISOString() ?? null,
    running: status.running,
    lastRun: status.lastRun === null ? null : toJobRunResponse(status.lastRun),
    lastSuccess: status.lastSuccess === null ? null : toJobRunResponse(status.lastSuccess),
    recentErrors: status.recentErrors.map(toJobRunResponse),
  };
}
