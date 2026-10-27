import { resolveManualHandoff } from '@/application/social/social-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { manualHandoffResponseSchema } from '@/api/schemas/social';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * 手動投稿の予約の投稿画面の URL を配信 Plugin に作らせる（057-social-bulk-post 設計 §5.3・§6）。
 *
 * 一括投稿で承認した手動投稿の URL を、承認の直後（窓を開くクリックより前）に取るための口。
 * 既存の `resolveManualHandoff` をそのまま HTTP に出すだけで、予約でない（承認待ちなど）投稿には
 * URL を作らず `not_scheduled` を返す（承認を経ずに URL を得る口にしない）。
 * **画面（セッション）専用**：外部アプリ向けの公開の操作ではない（`manual-outcome` と同じ扱い）。
 */
export const GET = defineRoute({
  operationId: 'getSocialPostManualHandoff',
  method: 'GET',
  path: '/social/posts/{id}/manual-handoff',
  summary: '手動投稿の投稿画面の URL を取得する',
  description:
    '画面（セッション）専用。API トークンでは 401。手動投稿の予約の投稿画面の URL を配信 Plugin に作らせる。予約でない（承認待ち・下書き・配信済み・失敗）ときは URL を作らず `not_scheduled` を返す。',
  permission: 'social.read',
  response: manualHandoffResponseSchema,
  sessionOnly: true,
  // 422（自動配信の投稿。キー `deliveryMode`）は生成器が既定で出す応答に入っている（057 実装プラン §7 の 10・§8 の 26）。
  additionalResponses: [
    {
      status: 404,
      description: '投稿が存在しない（UUID の形でない ID を含む。区画の外の投稿を含む）',
    },
  ],
  handler: async ({ context, params }) => {
    // 投稿画面の URL は配信 Plugin の `manual()` が作る（publisher の登録簿を引く）。
    await ensurePluginsStartedAnonymously();

    // 1 件の要求なので描画の予算（`deadline`）は渡さない。行ごとの上限は `MANUAL_TIMEOUT_MS`（設計 §6）。
    const outcome = await resolveManualHandoff(context, { id: params['id'] ?? '' });
    return dataResponse(outcome);
  },
});
