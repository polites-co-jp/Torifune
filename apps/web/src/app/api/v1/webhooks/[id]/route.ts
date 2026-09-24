import { z } from 'zod';
import { deleteWebhook } from '@/application/webhook/webhook-use-cases';
import { noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

export const DELETE = defineRoute({
  operationId: 'deleteWebhook',
  method: 'DELETE',
  path: '/webhooks/{id}',
  summary: 'Webhook を削除する',
  permission: 'system.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  successStatus: 204,
  additionalResponses: [
    {
      status: 404,
      description: 'Webhook が存在しない（UUID の形でない ID を含む）',
    },
  ],
  handler: async ({ context, params }) => {
    await deleteWebhook(context, { id: params['id'] as string });
    return noContentResponse();
  },
});
