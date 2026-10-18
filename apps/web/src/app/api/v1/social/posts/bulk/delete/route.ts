import { bulkDeleteSocialPosts } from '@/application/social/bulk-post-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  bulkDeleteSchema,
  bulkResultEnvelopeSchema,
  toBulkResultResponse,
} from '@/api/schemas/social-bulk';

/**
 * 出す前の SNS 投稿をまとめて取り消す（削除する）（054-bulk-post-actions 設計 §5.5・§8.4）。
 *
 * 消せるのは下書き・承認待ち・配信中でない予約だけ（配信済み・失敗は 1 件ずつの削除で）。項目ごとに処理し、結果を
 * 項目ごとに返す（全項目が失敗でも 200）。**画面（セッション）専用**：1 回で 100 件消せる口を API トークンには開けない
 * （設計 §5.1）。1 回で多くを動かすので Rate Limit を既定より厳しくする。
 */
export const POST = defineRoute({
  operationId: 'bulkDeleteSocialPosts',
  method: 'POST',
  path: '/social/posts/bulk/delete',
  summary: '出す前のSNS投稿をまとめて取り消す（削除する）',
  description:
    '画面（セッション）専用。API トークンでは 401。下書き・承認待ち・配信中でない予約だけを消す（配信済み・失敗は対象外）。項目ごとに処理し、結果を項目ごとに返す（全項目が失敗でも 200）。',
  permission: 'social.delete',
  body: bulkDeleteSchema,
  response: bulkResultEnvelopeSchema,
  sessionOnly: true,
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ context, body }) => {
    // 配信 Plugin を呼ばないので、Plugin の起動は待たない。
    const output = await bulkDeleteSocialPosts(context, { ids: body.ids });
    return dataResponse(toBulkResultResponse(output));
  },
});
