import { recordManualOutcome } from '@/application/social/social-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  manualOutcomeRequestSchema,
  postEnvelopeSchema,
  toPostResponse,
} from '@/api/schemas/social';

/**
 * 手動投稿の結果（投稿した／投稿しなかった）を記録する（055-social-pending-tab 設計 §5.6・§8.2）。
 *
 * 画面で見た内容のまま（`expectedUpdatedAt`）の手動の予約だけを、配信済み（`posted`）か失敗（`not_posted`）で確定する。
 * **画面（セッション）専用**：外部アプリは今までどおり `PATCH /social/posts/{id}` を使う（設計 §5.6）。
 */
export const POST = defineRoute({
  operationId: 'recordSocialPostManualOutcome',
  method: 'POST',
  path: '/social/posts/{id}/manual-outcome',
  summary: '手動投稿の結果を記録する',
  description:
    '画面（セッション）専用。API トークンでは 401。外部アプリは PATCH /social/posts/{id} を使う。手動投稿の予約（予約時刻の前後を問わない）を、投稿した（posted）なら配信済み、投稿しなかった（not_posted）なら失敗で確定する。予約日時と承認の記録は変えない。',
  permission: 'social.write',
  body: manualOutcomeRequestSchema,
  response: postEnvelopeSchema,
  sessionOnly: true,
  additionalResponses: [
    {
      status: 404,
      description: '投稿が存在しない（UUID の形でない ID を含む）',
    },
    {
      status: 409,
      description:
        '`expectedUpdatedAt` と投稿の `updatedAt` が合わない（見た後に内容が変わった）、または読んだ後に状態・配信方法が変わった',
    },
  ],
  handler: async ({ context, params, body }) => {
    const output = await recordManualOutcome(context, {
      id: params['id'] ?? '',
      outcome: body.outcome,
      expectedUpdatedAt: new Date(body.expectedUpdatedAt),
      ...(body.externalUrl === undefined ? {} : { externalUrl: body.externalUrl }),
    });
    return dataResponse(toPostResponse(output.post));
  },
});
