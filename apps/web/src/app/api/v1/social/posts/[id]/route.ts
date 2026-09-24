import { z } from 'zod';
import {
  deleteSocialPost,
  getSocialPost,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { postEnvelopeSchema, toPostResponse, updatePostSchema } from '@/api/schemas/social';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/** `{id}` の投稿が無いときの応答（042-social-api-input-fixes 設計 §6.4）。 */
const POST_NOT_FOUND = {
  status: 404,
  description: '投稿が存在しない（UUID の形でない ID を含む）',
} as const;

export const GET = defineRoute({
  operationId: 'getSocialPost',
  method: 'GET',
  path: '/social/posts/{id}',
  summary: 'SNS投稿を取得する',
  permission: 'social.read',
  response: postEnvelopeSchema,
  additionalResponses: [POST_NOT_FOUND],
  handler: async ({ context, params }) => {
    const post = await getSocialPost(context, { id: params['id'] ?? '' });
    return dataResponse(toPostResponse(post));
  },
});

export const PATCH = defineRoute({
  operationId: 'updateSocialPost',
  method: 'PATCH',
  path: '/social/posts/{id}',
  summary: 'SNS投稿を更新する',
  permission: 'social.write',
  body: updatePostSchema,
  response: postEnvelopeSchema,
  additionalResponses: [POST_NOT_FOUND],
  handler: async ({ context, params, body }) => {
    // 事前検査が publisher の登録簿を引く（設計 §6.7）。
    await ensurePluginsStartedAnonymously();

    const post = await updateSocialPost(context, {
      id: params['id'] ?? '',
      ...(body.body === undefined ? {} : { body: body.body }),
      ...(body.scheduledAt === undefined ? {} : { scheduledAt: body.scheduledAt }),
      ...(body.status === undefined ? {} : { status: body.status }),
      // null は「理由を消す」。undefined（変えない）と区別する。
      ...(body.failureReason === undefined ? {} : { failureReason: body.failureReason }),
      ...(body.deliveryMode === undefined ? {} : { deliveryMode: body.deliveryMode }),
      ...(body.media === undefined ? {} : { media: body.media }),
      ...(body.link === undefined ? {} : { link: body.link }),
      ...(body.providerOptions === undefined ? {} : { providerOptions: body.providerOptions }),
      ...(body.externalId === undefined ? {} : { externalId: body.externalId }),
      ...(body.externalUrl === undefined ? {} : { externalUrl: body.externalUrl }),
    });
    return dataResponse(toPostResponse(post));
  },
});

export const DELETE = defineRoute({
  operationId: 'deleteSocialPost',
  method: 'DELETE',
  path: '/social/posts/{id}',
  summary: 'SNS投稿を削除する',
  permission: 'social.delete',
  body: z.object({ csrfToken: z.string().optional() }),
  successStatus: 204,
  additionalResponses: [POST_NOT_FOUND],
  handler: async ({ context, params }) => {
    await deleteSocialPost(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
