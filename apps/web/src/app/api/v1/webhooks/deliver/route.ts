import { z } from 'zod';
import { WEBHOOK_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { JobBusyError } from '@/domain/jobs/job';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * 予約された配信を送る（023-webhook 設計 §3.4、029-scheduled-jobs 設計 §6.3）。
 *
 * **本体が既定で 1 分ごとに送る**（`TORIFUNE_SCHEDULER`）。この API は残してある。
 * 外部スケジューラから叩く運用と、手で流したいときのためのもの。
 *
 * ```
 * curl -X POST -H "Authorization: Bearer $TOKEN" https://.../api/v1/webhooks/deliver
 * ```
 *
 * 定期実行と同じロック・同じ記録に載せる。他の実行が 10 秒以上続いていれば 409 `CONFLICT`。
 */
export const POST = defineRoute({
  operationId: 'deliverWebhooks',
  method: 'POST',
  path: '/webhooks/deliver',
  summary: '予約された Webhook 配信を送る',
  permission: 'system.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  handler: async ({ context }) => {
    const outcome = await runJob(context.connection, WEBHOOK_JOB, {
      trigger: 'manual',
      wait: true,
      input: undefined,
    });

    if (outcome.outcome === 'skipped') {
      throw new JobBusyError(WEBHOOK_JOB.name);
    }
    if (outcome.outcome === 'error') {
      throw outcome.error;
    }

    return dataResponse({
      attempted: Number(outcome.run.summary['attempted'] ?? 0),
      delivered: Number(outcome.run.summary['delivered'] ?? 0),
      failed: Number(outcome.run.summary['failed'] ?? 0),
    });
  },
});
