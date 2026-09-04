import { z } from 'zod';
import { analyticsTimeZone } from '@/application/analytics/timezone';
import { daysAgoInTimeZone } from '@/domain/analytics/day';
import { pruneAccessLogs } from '@/application/analytics/rollup';
import { ROLLUP_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { requirePermission } from '@/application/authorization/authorize';
import { isValidRange, MAX_RANGE_DAYS, rangeDays } from '@/domain/analytics/analytics';
import { JobBusyError } from '@/domain/jobs/job';
import { ValidationError } from '@/domain/repository';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * 日次ロールアップの実行（018-analytics 設計 §4、029-scheduled-jobs 設計 §6.3）。
 *
 * **本体が既定で 15 分ごとに集計する**（`TORIFUNE_SCHEDULER`）。この API は残してある。
 * 外部スケジューラから叩く運用、過去の期間の流し直し、定期実行を止めている構成のためのもの。
 *
 * ```
 * curl -X POST -H "Authorization: Bearer $TOKEN" https://.../api/v1/analytics/rollup
 * ```
 *
 * 定期実行と**同じロック・同じ記録**に載せる（`runJob`）。同じ日を同時に流して
 * 保存値が壊れることが起きなくなる。他の実行が 10 秒以上続いていれば 409 `CONFLICT`。
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で入力してください。');

/** 集計と同じ境目で日付を戻す。 */
function daysAgo(days: number): string {
  return daysAgoInTimeZone(days, analyticsTimeZone());
}

/**
 * 集計する期間の幅を検査する（設計 §6.3）。
 *
 * **形式だけでは足りない。** `{"from":"1000-01-01","to":"9999-12-31"}` で生ログの全期間を走査でき、
 * その間ロックを握って定期集計まで止まる。上限は画面（`listAnalytics` / `listAnalyticsBreakdown`）と
 * 同じ 400 日にそろえる。400 日ちょうどは通す。
 *
 * **ロックを取る前に投げる。** `job_runs` に行を増やさない。
 */
function assertRollupRange(from: string, to: string): void {
  if (!isValidRange(from, to)) {
    throw new ValidationError('Analytics', 'to', '期間を確認してください（開始日以降にする）。');
  }
  if (rangeDays(from, to) > MAX_RANGE_DAYS) {
    throw new ValidationError(
      'Analytics',
      'from',
      `期間が長すぎます（${MAX_RANGE_DAYS}日以内にしてください）。`,
    );
  }
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
    // 既定は「昨日と今日」。**API の互換をそのまま保つ。**
    // 「最後の成功から最大 7 日」は定期実行（`input` 無し）だけの規則で、ここは常に `input` を渡す。
    const from = body?.from ?? daysAgo(1);
    const to = body?.to ?? daysAgo(0);

    assertRollupRange(from, to);

    const outcome = await runJob(context.connection, ROLLUP_JOB, {
      trigger: 'manual',
      wait: true,
      input: { from, to },
    });

    // **ロック競合だけが 409。** ロックのセッション自体の失敗は 500（設計 §6.3）。
    // DB 停止や Pool 枯渇を「他が実行中」と表示しない。
    if (outcome.outcome === 'skipped') {
      throw new JobBusyError(ROLLUP_JOB.name);
    }
    if (outcome.outcome === 'error') {
      // ジョブの失敗もロックの失敗も 500。内容は応答に出さない（`api/route.ts` が握る）。
      throw outcome.error;
    }

    let pruned = 0;
    if (body?.pruneOlderThanDays !== undefined) {
      // 生ログを消すのは戻せない操作。参照より強い権限を要求する。
      // **ロックの外で行う**（集計の排他に prune を巻き込まない）。
      requirePermission(context, 'system.manage');
      pruned = await pruneAccessLogs(context.connection, body.pruneOlderThanDays);
    }

    return dataResponse({
      from,
      to,
      days: Number(outcome.run.summary['days'] ?? 0),
      points: Number(outcome.run.summary['points'] ?? 0),
      pruned,
    });
  },
});
