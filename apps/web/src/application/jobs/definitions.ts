import { rollupAnalytics } from '@/application/analytics/rollup';
import { analyticsTimeZone } from '@/application/analytics/timezone';
import type { JobDefinition } from '@/application/jobs/scheduler';
import { deliverPendingWebhooks } from '@/application/webhook/deliver';
import type { Connection } from '@/database/provider';
import { dateInTimeZone, todayInTimeZone } from '@/domain/analytics/day';
import { scheduledRollupFrom } from '@/domain/jobs/job';
import { jobRunRepository } from '@/infrastructure/job-run-repository';

/**
 * 本体が回すジョブ（029-scheduled-jobs 設計 §6.2）。
 *
 * | 名前 | 間隔（既定） | summary |
 * | --- | --- | --- |
 * | `analytics.rollup` | 15 分 | `{ from, to, days, points }` |
 * | `webhook.deliver` | 1 分 | `{ attempted, delivered, failed }` |
 *
 * `intervalMs` は既定値。環境変数での上書きは `bootScheduler` が行う（§6.1.2）。
 * **Plugin からのジョブ登録は無い**（§9 / §11）。
 */

const MINUTE_MS = 60_000;

/** 集計する期間。手動 API は常にこれを渡す。 */
export interface RollupRange {
  readonly from: string;
  readonly to: string;
}

/**
 * 定期ロールアップの対象期間（裁定 #5）。
 *
 * `to` は常に今日。`from` は最後に成功した実行の開始日（運用タイムゾーンの日付）で、
 * ただし今日 − 7 日より前にはしない。成功の記録が無ければ昨日。
 *
 * 短い停止（数日）はこれで人手なしに埋まる。7 日を超える停止は API で流し直す。
 */
async function scheduledRange(connection: Connection): Promise<RollupRange> {
  const timeZone = analyticsTimeZone();
  const today = todayInTimeZone(timeZone);
  const latest = await jobRunRepository.findLatestSucceeded(connection, 'analytics.rollup');

  return {
    from: scheduledRollupFrom({
      lastSucceededStartedAt: latest === null ? null : dateInTimeZone(latest.startedAt, timeZone),
      today,
    }),
    to: today,
  };
}

/**
 * アクセス解析の日次集計。
 *
 * `input` を渡すとその範囲だけを集計する（手動 API の互換：既定は「昨日と今日」でルート側が決める）。
 * `input` が無いときだけ「最後の成功から最大 7 日」の計算を通る。
 */
export const ROLLUP_JOB: JobDefinition<RollupRange | undefined> = {
  name: 'analytics.rollup',
  intervalMs: 15 * MINUTE_MS,
  async run(connection, input) {
    const range = input ?? (await scheduledRange(connection));
    const result = await rollupAnalytics(connection, range);
    return { from: range.from, to: range.to, days: result.days, points: result.points };
  },
};

/**
 * 予約された Webhook 配信。
 *
 * 間隔 1 分の根拠：`retryDelayMs` は 1 → 2 → 4 → 8 分で、最短の再試行間隔が 1 分。
 * 周期が 1 分なら予約どおりの時刻に送れる。配信が無いときのコストは索引 1 回。
 */
export const WEBHOOK_JOB: JobDefinition = {
  name: 'webhook.deliver',
  intervalMs: 1 * MINUTE_MS,
  async run(connection) {
    const result = await deliverPendingWebhooks(connection);
    return { attempted: result.attempted, delivered: result.delivered, failed: result.failed };
  },
};
