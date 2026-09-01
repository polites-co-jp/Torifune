import { emit } from '@/application/events';
import type { Connection } from '@/database/provider';
import { CORE_SOURCE } from '@/domain/analytics/analytics';
import { analyticsRepository } from '@/infrastructure/analytics-repository';
import { log } from '@/infrastructure/logging';

/**
 * 生ログの日次ロールアップ（018-analytics 設計 §4.1）。
 *
 * **画面から生ログを集計しない。** 期間が延びるほど遅くなり、
 * 「1年分を見たら固まる」という壊れ方をする。
 *
 * **再実行できる。** 同じ日を何度集計しても結果が同じ（upsert）。
 * 一度きりの処理にすると、失敗したときに手で直すことになる。
 *
 * SQL は `infrastructure/analytics-repository.ts` に置く
 * （02_データベース設計.md §7）。
 */

export interface RollupResult {
  readonly days: number;
  readonly points: number;
}

/**
 * node-postgres は `date` を**ローカルタイムゾーンの0時**として `Date` にする。
 * `toISOString()` は UTC へ直すので、UTC より東では**1日前になる**。
 */
function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 期間の生ログを日次へ集計する。
 *
 * Bot は数えない。数えると、数字が実態から離れる。
 *
 * `sessions` は「訪問者 × 日」で数える。30分区切りのセッション定義は
 * 生ログに滞在時間を持たせないと出せず、**いま必要な精度ではない**。
 * 定義を変えるときは指標名も変える（過去の値と混ぜない）。
 */
export async function rollupAnalytics(
  connection: Connection,
  range: { readonly from: string; readonly to: string },
): Promise<RollupResult> {
  const aggregates = await analyticsRepository.aggregateDaily(connection, range);

  let points = 0;

  for (const row of aggregates) {
    const metricDate = toDateOnly(row.day);

    for (const [metric, value] of [
      ['pageviews', row.pageviews],
      ['visitors', row.visitors],
      // いまの定義では visitors と同じ値になる。指標として別に出しておく。
      ['sessions', row.visitors],
    ] as const) {
      await analyticsRepository.putPoint(connection, {
        siteId: row.siteId,
        metricDate,
        source: CORE_SOURCE,
        metric,
        value,
      });
      points += 1;
    }
  }

  log.info('analytics rollup finished', { from: range.from, to: range.to, points });

  // **1アクセスごとではなく、集計が済んだ単位で1回だけ知らせる**（01 §10.3）。
  // アクセスの発生ごとに発火すると、遅い Plugin が計測そのものを詰まらせる。
  await emit('analytics.rolledUp', { from: range.from, to: range.to, points });

  return { days: aggregates.length, points };
}

/**
 * 古い生ログを消す。
 *
 * **集計値は消さない。** 小さく、過去との比較に要る。
 */
export async function pruneAccessLogs(
  connection: Connection,
  olderThanDays: number,
): Promise<number> {
  const deleted = await analyticsRepository.deleteAccessLogsOlderThan(connection, olderThanDays);

  log.info('access logs pruned', { olderThanDays, deleted });
  return deleted;
}
