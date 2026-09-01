import { sql } from 'kysely';
import type { Connection } from '../database/provider';
import type { DeviceKind } from '../domain/analytics/access-log';
import type { AnalyticsPoint } from '../domain/analytics/analytics';

/**
 * アクセス・分析データの保存（018-analytics）。
 *
 * 生ログ（`access_logs`）と集計値（`analytics`）の両方を扱う。
 */

export interface NewAccessLog {
  readonly id: string;
  readonly siteId: string;
  readonly path: string;
  readonly referrerHost: string | null;
  readonly visitorHash: string;
  readonly device: DeviceKind;
}

/** `date` をローカルの `YYYY-MM-DD` に直す。`toISOString()` は1日ずれる。 */
function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface TopPath {
  readonly path: string;
  readonly pageviews: number;
}

export const analyticsRepository = {
  /** 生ログを1件記録する。**受け口は認証しない**ので、呼ぶ前に検証を済ませること。 */
  async recordAccess(connection: Connection, entry: NewAccessLog): Promise<void> {
    await connection.db
      .insertInto('access_logs')
      .values({
        id: entry.id,
        site_id: entry.siteId,
        path: entry.path,
        referrer_host: entry.referrerHost,
        visitor_hash: entry.visitorHash,
        device: entry.device,
      })
      .execute();
  },

  /**
   * 日次の集計値を読む。
   *
   * 画面はここだけを見る。**生ログを画面から集計しない**（設計 §4.1）。
   */
  async listPoints(
    connection: Connection,
    query: {
      readonly siteId: string | null;
      readonly from: string;
      readonly to: string;
      readonly source: string | null;
    },
  ): Promise<readonly AnalyticsPoint[]> {
    let rows = connection.db
      .selectFrom('analytics')
      .select(['site_id', 'metric_date', 'source', 'metric', 'value'])
      .where(sql<boolean>`metric_date >= ${query.from}::date`)
      .where(sql<boolean>`metric_date <= ${query.to}::date`);

    if (query.siteId !== null) {
      rows = rows.where('site_id', '=', query.siteId);
    }
    if (query.source !== null) {
      rows = rows.where('source', '=', query.source);
    }

    const result = await rows.orderBy('metric_date', 'asc').orderBy('metric', 'asc').execute();

    return result.map((row) => ({
      siteId: row.site_id,
      metricDate: toDateOnly(row.metric_date),
      source: row.source,
      metric: row.metric,
      value: Number(row.value),
    }));
  },

  /**
   * 集計値を入れる（upsert）。
   *
   * **再実行できる。** 同じ日を何度集計しても結果が同じになる。
   * 一度きりの処理にすると、失敗したときに手で直すことになる。
   */
  async putPoint(connection: Connection, point: AnalyticsPoint): Promise<void> {
    await connection.db
      .insertInto('analytics')
      .values({
        site_id: point.siteId,
        metric_date: point.metricDate,
        source: point.source,
        metric: point.metric,
        value: point.value,
      })
      .onConflict((oc) =>
        oc
          .columns(['site_id', 'metric_date', 'source', 'metric'])
          .doUpdateSet({ value: point.value, updated_at: new Date() }),
      )
      .execute();
  },

  /**
   * 上位ページ。
   *
   * 生ログから直接引く。**期間を区切る**ので重くならない。
   * Bot は数えない。
   */
  async topPaths(
    connection: Connection,
    query: {
      readonly siteId: string | null;
      readonly from: string;
      readonly to: string;
      readonly limit: number;
    },
  ): Promise<readonly TopPath[]> {
    let rows = connection.db
      .selectFrom('access_logs')
      .select(['path'])
      .select((eb) => eb.fn.countAll<string>().as('pageviews'))
      .where('device', '!=', 'bot')
      .where(sql<boolean>`occurred_at >= ${query.from}::date`)
      .where(sql<boolean>`occurred_at < (${query.to}::date + interval '1 day')`);

    if (query.siteId !== null) {
      rows = rows.where('site_id', '=', query.siteId);
    }

    const result = await rows
      .groupBy('path')
      .orderBy('pageviews', 'desc')
      .orderBy('path', 'asc')
      .limit(query.limit)
      .execute();

    return result.map((row) => ({ path: row.path, pageviews: Number(row.pageviews) }));
  },
};
