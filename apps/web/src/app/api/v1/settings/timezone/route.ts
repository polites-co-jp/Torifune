import { z } from 'zod';
import {
  previewTimeZoneChange,
  updateAnalyticsTimeZone,
} from '@/application/analytics/timezone-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { timeZonePreviewSchema, timeZoneUpdateSchema } from '@/api/schemas/analytics';

/**
 * 基準タイムゾーンの設定（032-timezone-setting 設計 §6.5）。
 *
 * **`PUT /api/v1/settings`（既存）には足さない**（設計 §4.1）。
 * 表示名の保存は「保存する」を押すだけだが、タイムゾーンの変更は
 * **確認を挟む不可逆な操作**であり、同じ口に乗せてはいけない。
 *
 * `GET` を分けてあるのは、**確認ダイアログを出す前に数える**必要があるため。
 * 数えるのは「消える行」であり、`PUT` の中で数えて返しても手遅れになる。
 *
 * **`system.manage` の消費先。** 参照（`analytics.read`）より強い権限を要求する
 * ——集計値を消しうる操作であり、消える件数を数えること自体も変更の前段である。
 */

export const GET = defineRoute({
  operationId: 'previewAnalyticsTimeZone',
  method: 'GET',
  path: '/settings/timezone',
  summary: '基準タイムゾーンを変えたときに失われるものを数える',
  permission: 'system.manage',
  query: z.object({
    // **必須。** 「不正だから UTC で数えました」という応答を返さない（422 にする）。
    timeZone: z.string().min(1, 'タイムゾーンを指定してください。'),
  }),
  response: timeZonePreviewSchema,
  handler: async ({ context, query }) =>
    dataResponse(await previewTimeZoneChange(context, { timeZone: query.timeZone })),
});

export const PUT = defineRoute({
  operationId: 'updateAnalyticsTimeZone',
  method: 'PUT',
  path: '/settings/timezone',
  summary: '基準タイムゾーンを保存し、集計を洗い替える',
  permission: 'system.manage',
  body: z.object({
    timeZone: z.string().min(1, 'タイムゾーンを指定してください。'),
    csrfToken: z.string().optional(),
  }),
  response: timeZoneUpdateSchema,
  // **ジョブの完了を待たない。** 進捗は `GET /api/v1/jobs` と設定画面から見る。
  handler: async ({ context, body }) =>
    dataResponse(await updateAnalyticsTimeZone(context, { timeZone: body.timeZone })),
});
