import { z } from 'zod';
import { createWebhook, listWebhooks } from '@/application/webhook/webhook-use-cases';
import { createdResponse, dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { WEBHOOK_NAME_MAX_LENGTH } from '@/domain/webhook/webhook';

/**
 * Webhook（05_API設計.md §39）。
 *
 * **Secret は発行時に一度だけ返す。** 一覧には出ない。
 */

export const GET = defineRoute({
  operationId: 'listWebhooks',
  method: 'GET',
  path: '/webhooks',
  summary: 'Webhook の一覧を取得する',
  permission: 'system.manage',
  handler: async ({ context }) => dataResponse(await listWebhooks(context, {})),
});

export const POST = defineRoute({
  operationId: 'createWebhook',
  method: 'POST',
  path: '/webhooks',
  summary: 'Webhook を登録する',
  permission: 'system.manage',
  body: z.object({
    name: z.string().min(1, '入力してください。').max(WEBHOOK_NAME_MAX_LENGTH),
    url: z.string().min(1, '入力してください。').max(2000),
    events: z.array(z.string()).default([]),
    csrfToken: z.string().optional(),
  }),
  handler: async ({ context, body }) => {
    const created = await createWebhook(context, {
      name: body.name,
      url: body.url,
      events: body.events,
    });

    return createdResponse({
      ...created.webhook,
      createdAt: created.webhook.createdAt.toISOString(),
      // ここでしか返らない。
      secret: created.secret,
    });
  },
});
