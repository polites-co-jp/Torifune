import { z } from 'zod';
import {
  deleteSocialPost,
  getSocialPost,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { toPostResponse, updatePostSchema } from '@/api/schemas/social';

export const GET = defineRoute({
  operationId: 'getSocialPost',
  method: 'GET',
  path: '/social/posts/{id}',
  summary: 'SNS投稿を取得する',
  permission: 'social.read',
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
  handler: async ({ context, params, body }) => {
    const post = await updateSocialPost(context, {
      id: params['id'] ?? '',
      ...(body.body === undefined ? {} : { body: body.body }),
      ...(body.scheduledAt === undefined ? {} : { scheduledAt: body.scheduledAt }),
      ...(body.status === undefined ? {} : { status: body.status }),
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
  handler: async ({ context, params }) => {
    await deleteSocialPost(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
