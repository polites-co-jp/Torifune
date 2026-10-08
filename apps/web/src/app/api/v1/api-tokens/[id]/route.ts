import { z } from 'zod';
import { changeApiTokenSite, revokeApiToken } from '@/application/api-token/api-token-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  apiTokenEnvelopeSchema,
  changeApiTokenSiteSchema,
  toApiTokenResponse,
} from '@/api/schemas/api-token';

/**
 * トークンのサイトを変える（053-site-scoped-social 設計 §8.5.6。ユーザー裁定 7）。
 *
 * 発行・失効と同じく **Token 経由では許さない**（`sessionOnly`）。Token から自分のサイトを付け替えられると、
 * サイトに限定したはずのトークンが自分で区画を抜け出せてしまう。
 */
export const PATCH = defineRoute({
  operationId: 'changeApiTokenSite',
  method: 'PATCH',
  path: '/api-tokens/{id}',
  summary: 'API Token のサイトを変える',
  permission: 'token.manage',
  body: changeApiTokenSiteSchema,
  response: apiTokenEnvelopeSchema,
  sessionOnly: true,
  additionalResponses: [
    {
      status: 404,
      description: 'トークンが存在しない、または自分のトークンでない（UUID の形でない ID を含む）',
    },
  ],
  handler: async ({ context, params, body }) => {
    const changed = await changeApiTokenSite(context, {
      id: params['id'] as string,
      siteId: body.siteId,
      ...(body.scopes === undefined ? {} : { scopes: body.scopes }),
    });
    // 平文は無い（発行のときだけ返す）。
    return dataResponse(toApiTokenResponse(changed.token));
  },
});

export const DELETE = defineRoute({
  operationId: 'revokeApiToken',
  method: 'DELETE',
  path: '/api-tokens/{id}',
  summary: 'API Token を失効させる',
  permission: 'token.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  successStatus: 204,
  // 失効も Token 経由では許さない。自分自身を延命・整理できると、
  // 盗まれた Token で「別の Token を消して痕跡を減らす」ことができてしまう。
  sessionOnly: true,
  additionalResponses: [
    {
      status: 404,
      description: 'Token が存在しない、または自分の Token でない（UUID の形でない ID を含む）',
    },
  ],
  handler: async ({ context, params }) => {
    await revokeApiToken(context, { id: params['id'] as string });
    return noContentResponse();
  },
});
