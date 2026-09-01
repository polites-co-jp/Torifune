import { z } from 'zod';
import { revokeApiToken } from '@/application/api-token/api-token-use-cases';
import { noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

export const DELETE = defineRoute({
  operationId: 'revokeApiToken',
  method: 'DELETE',
  path: '/api-tokens/{id}',
  summary: 'API Token を失効させる',
  permission: 'token.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  // 失効も Token 経由では許さない。自分自身を延命・整理できると、
  // 盗まれた Token で「別の Token を消して痕跡を減らす」ことができてしまう。
  sessionOnly: true,
  handler: async ({ context, params }) => {
    await revokeApiToken(context, { id: params['id'] as string });
    return noContentResponse();
  },
});
