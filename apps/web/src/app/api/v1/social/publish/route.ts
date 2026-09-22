import { z } from 'zod';
import { SOCIAL_PUBLISH_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { JobBusyError } from '@/domain/jobs/job';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { publishSummaryEnvelopeSchema } from '@/api/schemas/social';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * 期限の来た SNS 投稿を配信する（035-social-publishing 設計 §6.5.9）。
 *
 * **本体が既定で 1 分ごとに回す**（`TORIFUNE_SCHEDULER`）。この API は、
 * `off` にして外部スケジューラから叩く運用と、手で流したいときのためのもの。
 * `POST /api/v1/webhooks/deliver` と同じ形（029-scheduled-jobs 設計 §6.3）。
 *
 * ```
 * curl -X POST -H "Authorization: Bearer $TOKEN" https://.../api/v1/social/publish
 * ```
 *
 * 定期実行と同じロック・同じ記録に載せる。他の実行が 10 秒以上続いていれば 409 `CONFLICT`。
 */
export const POST = defineRoute({
  operationId: 'publishSocialPosts',
  method: 'POST',
  path: '/social/publish',
  summary: '期限の来たSNS投稿を配信する',
  permission: 'system.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  response: publishSummaryEnvelopeSchema,
  handler: async ({ context }) => {
    // publisher の登録簿は activate() で埋まる。Bearer 認証の経路は
    // Plugin の起動を通らないので、ここで起こす（設計 §6.7 / §6.5.1 の `prepare`）。
    await ensurePluginsStartedAnonymously();

    const outcome = await runJob(context.connection, SOCIAL_PUBLISH_JOB, {
      trigger: 'manual',
      wait: true,
      input: undefined,
    });

    if (outcome.outcome === 'skipped') {
      throw new JobBusyError(SOCIAL_PUBLISH_JOB.name);
    }
    if (outcome.outcome === 'error') {
      throw outcome.error;
    }

    const summary = outcome.run.summary;
    return dataResponse({
      interrupted: Number(summary['interrupted'] ?? 0),
      due: Number(summary['due'] ?? 0),
      skipped: Number(summary['skipped'] ?? 0),
      attempted: Number(summary['attempted'] ?? 0),
      published: Number(summary['published'] ?? 0),
      retried: Number(summary['retried'] ?? 0),
      failed: Number(summary['failed'] ?? 0),
      unrecorded: Number(summary['unrecorded'] ?? 0),
    });
  },
});
