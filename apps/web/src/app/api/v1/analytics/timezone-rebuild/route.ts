import { z } from 'zod';
import { rebuildAnalyticsTimeZone } from '@/application/analytics/timezone-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { timeZoneRebuildSchema } from '@/api/schemas/analytics';

/**
 * 洗い替えのやり直し（032-timezone-setting 設計 §6.5 / §7.3）。
 *
 * 失敗・中断した洗い替えを**人が立て直す**ための口。**自動再試行はしない**
 * （`要件.md` §7-2）。失敗が繰り返す状況で重い集計が延々と走り続けるうえ、
 * 走行中のジョブを止める手段が 029 の基盤に無い。
 *
 * **`system_settings` に触らない。** タイムゾーンは既に保存済みで、ジョブを起こすだけ。
 * **範囲も受け取らない**（生ログから導く。設計 §6.2.1）。
 *
 * **`POST /analytics/rollup`（`analytics.read`）に相乗りさせない。** そちらは
 * 閲覧者ロールも持つ権限であり、集計値を**消す**操作をその水準に置いてはいけない。
 */

export const POST = defineRoute({
  operationId: 'rebuildAnalyticsTimeZone',
  method: 'POST',
  path: '/analytics/timezone-rebuild',
  summary: '基準タイムゾーンの洗い替えをやり直す',
  permission: 'system.manage',
  body: z.object({ csrfToken: z.string().optional() }).optional(),
  response: timeZoneRebuildSchema,
  handler: async ({ context }) => dataResponse(await rebuildAnalyticsTimeZone(context, {})),
});
