import { bulkApproveSocialPosts } from '@/application/social/bulk-post-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  bulkApproveSchema,
  bulkResultEnvelopeSchema,
  toBulkResultResponse,
} from '@/api/schemas/social-bulk';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * 承認待ちの SNS 投稿をまとめて承認する（054-bulk-post-actions 設計 §8.2）。
 *
 * 項目ごとに 1 件の承認を呼び、結果を項目ごとに返す（全項目が失敗でも 200）。**画面（セッション）専用**：
 * 1 回で 100 件動かせる口を API トークンには開けない（設計 §5.1）。1 回で多くを動かすので Rate Limit を既定より厳しくする。
 */
export const POST = defineRoute({
  operationId: 'bulkApproveSocialPosts',
  method: 'POST',
  path: '/social/posts/bulk/approve',
  summary: '承認待ちのSNS投稿をまとめて承認する',
  description:
    '画面（セッション）専用。API トークンでは 401。項目ごとに処理し、結果を項目ごとに返す（全項目が失敗でも 200）。',
  permission: 'social.approve',
  body: bulkApproveSchema,
  response: bulkResultEnvelopeSchema,
  sessionOnly: true,
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ context, body }) => {
    // 事前検査と「手動投稿しかできない配信 Plugin」の判定が publisher の登録簿を引く。
    await ensurePluginsStartedAnonymously();

    const output = await bulkApproveSocialPosts(context, {
      publishTiming: body.publishTiming,
      items: body.items.map((item) => ({
        id: item.id,
        expectedUpdatedAt: new Date(item.expectedUpdatedAt),
      })),
    });
    return dataResponse(toBulkResultResponse(output));
  },
});
