import { bulkPublishSocialPostsNow } from '@/application/social/bulk-post-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  bulkPublishNowSchema,
  bulkResultEnvelopeSchema,
  toBulkResultResponse,
} from '@/api/schemas/social-bulk';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * 未来の予約の SNS 投稿をまとめて今すぐ送る（054-bulk-post-actions 設計 §5.4・§8.3）。
 *
 * 予約日時を「いま」に早め、実際の送信は次の定期実行に任せる。承認は外さない。項目ごとに処理し、結果を項目ごとに
 * 返す（全項目が失敗でも 200）。**画面（セッション）専用**：1 回で 100 件動かせる口を API トークンには開けない（設計 §5.1）。
 * 1 回で多くを動かすので Rate Limit を既定より厳しくする。
 */
export const POST = defineRoute({
  operationId: 'bulkPublishSocialPostsNow',
  method: 'POST',
  path: '/social/posts/bulk/publish-now',
  summary: '予約済みのSNS投稿をまとめて今すぐ送る',
  description:
    '画面（セッション）専用。API トークンでは 401。予約日時が未来か未設定の予約だけを、次の定期実行で配信されるよう予約日時をいまに早める（承認は外さない）。項目ごとに処理し、結果を項目ごとに返す（全項目が失敗でも 200）。',
  permission: 'social.write',
  body: bulkPublishNowSchema,
  response: bulkResultEnvelopeSchema,
  sessionOnly: true,
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ context, body }) => {
    // 事前検査（配信 Plugin の規則と validate()）が publisher の登録簿を引く。
    await ensurePluginsStartedAnonymously();

    const output = await bulkPublishSocialPostsNow(context, {
      items: body.items.map((item) => ({
        id: item.id,
        expectedUpdatedAt: new Date(item.expectedUpdatedAt),
      })),
    });
    return dataResponse(toBulkResultResponse(output));
  },
});
