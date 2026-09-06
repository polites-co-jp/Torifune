import { emit } from '@/application/events';
import type { Connection } from '@/database/provider';
import { analyticsRepository, type DailyBreakdownRow } from '@/infrastructure/analytics-repository';
import { resolveAnalyticsTimeZone } from './timezone';
import { log } from '@/infrastructure/logging';

/**
 * 生ログの日次ロールアップ（018-analytics 設計 §4.1、028-analytics-dashboard-redesign 設計 §5.3）。
 *
 * **画面から生ログを集計しない。** 期間が延びるほど遅くなり、
 * 「1年分を見たら固まる」という壊れ方をする。
 *
 * **例外は「当日」だけ**（030-analytics-today 設計 §4.1）。
 * `application/analytics/analytics-use-cases.ts` の `getTodayAnalytics` は、
 * **常に 1 日 × 常に 1 サイト**に有界な範囲でだけ生ログを直接集計する。
 * 上の原則の根拠（期間が延びるほど遅くなる）に当たらないため、原則を捨てずに例外として扱う。
 * 例外の範囲が広がらないよう、当日は期間を引数で受けず、API にも Plugin にも露出させず、
 * **集計結果を `analytics` へ書かない**（画面の表示が DB 書き込みを起こす作りにしない）。
 *
 * **再実行できる。** (site, day) ごとに Core の行を丸ごと差し替えるので、
 * 同じ生ログに対して何度流しても結果が同じになる。upsert だけでは、
 * 前回あって今回無くなった key の行（パスの正規化を変えた、生ログを一部消した）が残る。
 *
 * SQL は `infrastructure/analytics-repository.ts` に置く
 * （02_データベース設計.md §7）。
 */

export interface RollupResult {
  /** 書いた (site, day) の数。 */
  readonly days: number;
  /** 書いた行数。 */
  readonly points: number;
}

/** (site, day) ごとに行をまとめる。差し替えの単位。 */
function groupBySiteDay(
  rows: readonly DailyBreakdownRow[],
): ReadonlyMap<string, { siteId: string; metricDate: string; points: DailyBreakdownRow[] }> {
  const groups = new Map<
    string,
    { siteId: string; metricDate: string; points: DailyBreakdownRow[] }
  >();

  for (const row of rows) {
    // 区切りは NUL。UUID にも日付にも現れない。生のバイトではなくエスケープ表記で書き、
    // ファイルをテキストのまま保つ（生で書くと diff がバイナリ扱いになる）。
    const id = `${row.siteId}\u0000${row.metricDate}`;
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, { siteId: row.siteId, metricDate: row.metricDate, points: [row] });
    } else {
      group.points.push(row);
    }
  }

  return groups;
}

/**
 * 期間の生ログを日次へ集計する。
 *
 * * セッションは 30 分区切り（`sessions` / `bounces` / 滞在 / ランディング / 参照元）
 * * Bot は `bot_pageviews` / `bot_visitors` にだけ数える
 * * 生ログが 1 行も無い (site, day) には何も書かない（消された生ログの日を 0 で上書きしない）
 * * 集計した範囲の最終受信（Bot 含む）をサイトへ書き戻す。過去を流し直しても巻き戻らない
 */
export async function rollupAnalytics(
  connection: Connection,
  range: { readonly from: string; readonly to: string },
  options?: {
    /**
     * 境目に使うタイムゾーン。**省略時は従来どおり解決する**（既存の呼び出しは変わらない）。
     *
     * 洗い替え（032-timezone-setting 設計 §6.2.2）はここへ明示的に渡す。
     * チャンクごとに解決し直すと、走行中にもう一度変えられた場合に
     * チャンクごとに違う境目で畳んでしまう。
     */
    readonly timeZone?: string;
  },
): Promise<RollupResult> {
  // 1日の境目は運用側のタイムゾーンで決める（`timezone.ts`）。
  const window = { ...range, timeZone: options?.timeZone ?? (await resolveAnalyticsTimeZone()) };

  const rows = await analyticsRepository.aggregateDailyBreakdown(connection, window);
  const groups = groupBySiteDay(rows);

  let points = 0;

  for (const group of groups.values()) {
    // DELETE と INSERT の間で読まれると値が消えて見えるので、(site, day) ごとに 1 トランザクション。
    points += await connection.transaction((tx) =>
      analyticsRepository.replaceCorePoints(tx, group.siteId, group.metricDate, group.points),
    );
  }

  const lastSeen = await analyticsRepository.maxOccurredAtBySite(connection, window);
  for (const entry of lastSeen) {
    await analyticsRepository.touchLastSeen(connection, entry.siteId, entry.lastSeenAt);
  }

  log.info('analytics rollup finished', {
    from: range.from,
    to: range.to,
    days: groups.size,
    points,
  });

  // **1アクセスごとではなく、集計が済んだ単位で1回だけ知らせる**（01 §10.3）。
  // アクセスの発生ごとに発火すると、遅い Plugin が計測そのものを詰まらせる。
  await emit('analytics.rolledUp', { from: range.from, to: range.to, points });

  return { days: groups.size, points };
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
