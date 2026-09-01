import { createSocialPost, listSocialPosts } from '@/application/social/social-use-cases';
import { createdResponse, pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  createPostSchema,
  postEnvelopeSchema,
  postListQuerySchema,
  postPageSchema,
  toPostResponse,
} from '@/api/schemas/social';

export const GET = defineRoute({
  operationId: 'listSocialPosts',
  method: 'GET',
  path: '/social/posts',
  summary: 'SNS投稿の一覧を取得する',
  permission: 'social.read',
  query: postListQuerySchema,
  response: postPageSchema,
  handler: async ({ context, query }) => {
    const page = await listSocialPosts(context, {
      page: query.page,
      perPage: query.perPage,
      socialAccountId: query.accountId ?? null,
      status: query.status ?? null,
    });
    return pageResponse(page.items.map(toPostResponse), {
      page: query.page,
      perPage: query.perPage,
      total: page.total,
    });
  },
});

export const POST = defineRoute({
  operationId: 'createSocialPost',
  method: 'POST',
  path: '/social/posts',
  summary: 'SNS投稿を作成する',
  permission: 'social.write',
  body: createPostSchema,
  response: postEnvelopeSchema,
  successStatus: 201,
  handler: async ({ context, body }) => {
    const post = await createSocialPost(context, {
      socialAccountId: body.socialAccountId,
      body: body.body,
      scheduledAt: body.scheduledAt ?? null,
      status: body.status,
    });
    return createdResponse(toPostResponse(post));
  },
});
