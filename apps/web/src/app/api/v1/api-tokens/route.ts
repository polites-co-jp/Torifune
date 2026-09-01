import { createApiToken, listApiTokens } from '@/application/api-token/api-token-use-cases';
import { createdResponse, dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  createApiTokenSchema,
  toApiTokenResponse,
  type CreatedApiTokenResponse,
} from '@/api/schemas/api-token';

export const GET = defineRoute({
  operationId: 'listApiTokens',
  method: 'GET',
  path: '/api-tokens',
  summary: '自分の API Token 一覧を取得する',
  permission: 'token.manage',
  // 自分の Token を一覧するだけなら Token 認証でもよい。
  handler: async ({ context }) => {
    const tokens = await listApiTokens(context, {});
    return dataResponse(tokens.map(toApiTokenResponse));
  },
});

export const POST = defineRoute({
  operationId: 'createApiToken',
  method: 'POST',
  path: '/api-tokens',
  summary: 'API Token を発行する',
  permission: 'token.manage',
  body: createApiTokenSchema,
  // **Token から Token を作らせない。** できると、Scope を絞った Token から
  // より広い Token を発行できてしまう（021-api-token 設計 §5）。
  sessionOnly: true,
  // 05_API設計.md §36 が重点対象に挙げる「Token発行」。
  rateLimit: { windowMs: 60_000, max: 10 },
  handler: async ({ context, body }) => {
    const created = await createApiToken(context, {
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt == null ? null : new Date(body.expiresAt),
    });

    const response: CreatedApiTokenResponse = {
      ...toApiTokenResponse(created.token),
      // ここでしか返らない。
      token: created.plaintext,
    };
    return createdResponse(response);
  },
});
