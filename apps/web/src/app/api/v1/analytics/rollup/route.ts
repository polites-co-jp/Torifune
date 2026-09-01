import { z } from 'zod';
import { pruneAccessLogs, rollupAnalytics } from '@/application/analytics/rollup';
import { requirePermission } from '@/application/authorization/authorize';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * 日次ロールアップの実行（018-analytics 設計 §4）。
 *
 * **cron から API Token で叩く前提**（`021-api-token`）。
 * CLI へ実装しなかったのは、集計のSQLを CLI と本体で二重に持ちたくないため。
 *
 * ```
 * curl -X POST -H "Authorization: Bearer $TOKEN" https://.../api/v1/analytics/rollup
 * ```
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で入力してください。');

/** ローカルの `YYYY-MM-DD` を日数だけ戻して返す。 */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export const POST = defineRoute({
  operationId: 'rollupAnalytics',
  method: 'POST',
  path: '/analytics/rollup',
  summary: 'アクセスログを日次へ集計する',
  permission: 'analytics.read',
  body: z
    .object({
      from: dateOnly.optional(),
      to: dateOnly.optional(),
      /** 指定すると、この日数より古い生ログを消す。集計値は消さない。 */
      pruneOlderThanDays: z.coerce.number().int().min(1).optional(),
      csrfToken: z.string().optional(),
    })
    .optional(),
  handler: async ({ context, body }) => {
    // 既定は「昨日と今日」。cron から引数なしで叩けるようにする。
    const from = body?.from ?? daysAgo(1);
    const to = body?.to ?? daysAgo(0);

    const result = await rollupAnalytics(context.connection, { from, to });

    let pruned = 0;
    if (body?.pruneOlderThanDays !== undefined) {
      // 生ログを消すのは戻せない操作。参照より強い権限を要求する。
      requirePermission(context, 'system.manage');
      pruned = await pruneAccessLogs(context.connection, body.pruneOlderThanDays);
    }

    return dataResponse({ from, to, ...result, pruned });
  },
});
