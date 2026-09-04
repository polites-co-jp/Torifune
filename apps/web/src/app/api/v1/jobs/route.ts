import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { jobStatusListSchema, toJobStatusResponse } from '@/api/schemas/job';
import { listJobStatuses } from '@/application/jobs/job-use-cases';

/**
 * 定期実行ジョブの状態（029-scheduled-jobs 設計 §6.5）。
 *
 * **監視から叩く用途。**「最後の成功が N 分より古ければ警告」を外から組める。
 *
 * `scheduled` / `nextRunAt` / `running` は**応答を返したプロセス**の予定で、
 * 複数プロセス構成ではプロセスごとに違う。実行そのものはジョブごとのロックで
 * 1 プロセスだけが行う（§6.1.6）。
 *
 * 画面の受信状況（`getAnalyticsStatus`）は API に出さない。要るのは運用者であり、ここで足りる。
 */
export const GET = defineRoute({
  operationId: 'listJobStatuses',
  method: 'GET',
  path: '/jobs',
  summary: '定期実行ジョブの状態を返す',
  permission: 'system.manage',
  response: jobStatusListSchema,
  handler: async ({ context }) => {
    const statuses = await listJobStatuses(context, {});
    return dataResponse(statuses.map(toJobStatusResponse));
  },
});
