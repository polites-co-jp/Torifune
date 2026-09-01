import { z } from 'zod';
import { deliverPendingWebhooks } from '@/application/webhook/deliver';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * 予約された配信を送る（023-webhook 設計 §3.4）。
 *
 * **cron から API Token で叩く前提**（`021-api-token`）。
 * analytics のロールアップと同じ形にそろえている。
 *
 * ```
 * curl -X POST -H "Authorization: Bearer $TOKEN" https://.../api/v1/webhooks/deliver
 * ```
 */
export const POST = defineRoute({
  operationId: 'deliverWebhooks',
  method: 'POST',
  path: '/webhooks/deliver',
  summary: '予約された Webhook 配信を送る',
  permission: 'system.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  handler: async ({ context }) => dataResponse(await deliverPendingWebhooks(context.connection)),
});
