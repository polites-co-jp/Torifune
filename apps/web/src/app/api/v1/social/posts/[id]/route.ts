import { z } from 'zod';
import {
  deleteSocialPost,
  getSocialPost,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { postEnvelopeSchema, toPostResponse, updatePostSchema } from '@/api/schemas/social';

export const GET = defineRoute({
  operationId: 'getSocialPost',
  method: 'GET',
  path: '/social/posts/{id}',
  summary: 'SNS投稿を取得する',
  permission: 'social.read',
  response: postEnvelopeSchema,
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
  handler: async ({ context, params, body }) => {
    const post = await updateSocialPost(context, {
      id: params['id'] ?? '',
      ...(body.body === undefined ? {} : { body: body.body }),
      ...(body.scheduledAt === undefined ? {} : { scheduledAt: body.scheduledAt }),
      ...(body.status === undefined ? {} : { status: body.status }),
      // null は「理由を消す」。undefined（変えない）と区別する。
      ...(body.failureReason === undefined ? {} : { failureReason: body.failureReason }),
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
  handler: async ({ context, params }) => {
    await deleteSocialPost(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
