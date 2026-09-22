import { createSocialPost, listSocialPosts } from '@/application/social/social-use-cases';
import { createdResponse, dataResponse, pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  createPostSchema,
  postEnvelopeSchema,
  postListQuerySchema,
  postPageSchema,
  toPostResponse,
} from '@/api/schemas/social';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

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
  summary: 'SNS投稿を作成する（同じ externalRef の再送は 200 で既存を返す）',
  permission: 'social.write',
  body: createPostSchema,
  response: postEnvelopeSchema,
  successStatus: 201,
  handler: async ({ context, body }) => {
    // publisher の登録簿は activate() で埋まる。Bearer 認証の経路は
    // Plugin の起動を通らないので、ここで起こす（設計 §6.7）。
    await ensurePluginsStartedAnonymously();

    const { post, created } = await createSocialPost(context, {
      socialAccountId: body.socialAccountId,
      body: body.body,
      scheduledAt: body.scheduledAt ?? null,
      status: body.status,
      deliveryMode: body.deliveryMode,
      media: body.media,
      link: body.link ?? null,
      providerOptions: body.providerOptions,
      ...(body.externalRef === undefined ? {} : { externalRef: body.externalRef }),
    });

    // **同じ登録要求の再送は 200 で既存を返す**（設計 §6.1.3）。
    // `successStatus` は 1 つしか宣言できないので、OpenAPI は 201 のまま。
    return created ? createdResponse(toPostResponse(post)) : dataResponse(toPostResponse(post));
  },
});
