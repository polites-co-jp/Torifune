import { approveSocialPost } from '@/application/social/social-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { approvePostSchema, postEnvelopeSchema, toPostResponse } from '@/api/schemas/social';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * 承認待ちの SNS 投稿を承認する（048-social-post-approval 設計 §6.4）。
 *
 * サブリソースの操作（`POST /plugins/{id}/enable` と同じ形）。予約にするのはこの操作だけで、
 * `PATCH` の `status` では承認待ちから予約へ移せない。
 */
export const POST = defineRoute({
  operationId: 'approveSocialPost',
  method: 'POST',
  path: '/social/posts/{id}/approve',
  summary: '承認待ちのSNS投稿を承認して配信に回す',
  permission: 'social.approve',
  body: approvePostSchema,
  response: postEnvelopeSchema,
  additionalResponses: [
    {
      status: 404,
      description:
        '投稿が存在しない（UUID の形でない ID を含む。このトークンからは見えない（別のサイトの区画）ものを含む）',
    },
    {
      status: 409,
      description:
        '`expectedUpdatedAt` と投稿の `updatedAt` が合わない（見た後に内容が変わった）。`details.expectedUpdatedAt` に理由',
    },
  ],
  handler: async ({ context, params, body }) => {
    // 事前検査と「手動投稿しかできない配信 Plugin」の判定が publisher の登録簿を引く。
    // Bearer 認証の経路は Plugin の起動を通らないので、ここで起こす。
    await ensurePluginsStartedAnonymously();

    const output = await approveSocialPost(context, {
      id: params['id'] ?? '',
      publishTiming: body.publishTiming,
      ...(body.scheduledAt === undefined ? {} : { scheduledAt: body.scheduledAt }),
      expectedUpdatedAt: new Date(body.expectedUpdatedAt),
    });
    return dataResponse(toPostResponse(output.post));
  },
});
