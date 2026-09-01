import { sql } from 'kysely';
import type { Connection } from '../database/provider';
import type { DeviceKind } from '../domain/analytics/access-log';
import type { AnalyticsPoint, TopPath, TrackedSite } from '../domain/analytics/analytics';

/**
 * アクセス・分析データの保存（018-analytics）。
 *
 * 生ログ（`access_logs`）と集計値（`analytics`）の両方を扱う。
 */

/** 生ログを日次へ畳んだ1行（ロールアップの中間結果）。 */
export interface DailyAggregate {
  readonly siteId: string;
  readonly day: Date | string;
  readonly pageviews: number;
  readonly visitors: number;
}

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
   *
   * `limit` / `offset` を渡すとその範囲だけを返す（05_API設計.md §33 の Pagination）。
   * 省略すると期間内の全件を返す。画面と Plugin Data API は全件を使う。
   */
  async listPoints(
    connection: Connection,
    query: {
      readonly siteId: string | null;
      readonly from: string;
      readonly to: string;
      readonly source: string | null;
      readonly limit?: number;
      readonly offset?: number;
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

    // **並び順を一意にする。** 同じ日に複数の指標・出所があるので、
    // metric_date だけでは順序が定まらず、ページの境目で取りこぼしが出る。
    rows = rows.orderBy('metric_date', 'asc').orderBy('source', 'asc').orderBy('metric', 'asc');

    if (query.limit !== undefined) {
      rows = rows.limit(query.limit);
    }
    if (query.offset !== undefined) {
      rows = rows.offset(query.offset);
    }

    const result = await rows.execute();

    return result.map((row) => ({
      siteId: row.site_id,
      metricDate: toDateOnly(row.metric_date),
      source: row.source,
      metric: row.metric,
      value: Number(row.value),
    }));
  },

  /** 条件に合う集計値の全件数（Pagination の `meta.total`）。 */
  async countPoints(
    connection: Connection,
    query: {
      readonly siteId: string | null;
      readonly from: string;
      readonly to: string;
      readonly source: string | null;
    },
  ): Promise<number> {
    let rows = connection.db
      .selectFrom('analytics')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where(sql<boolean>`metric_date >= ${query.from}::date`)
      .where(sql<boolean>`metric_date <= ${query.to}::date`);

    if (query.siteId !== null) {
      rows = rows.where('site_id', '=', query.siteId);
    }
    if (query.source !== null) {
      rows = rows.where('source', '=', query.source);
    }

    const row = await rows.executeTakeFirst();
    return Number(row?.total ?? 0);
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
      readonly offset?: number;
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

    let grouped = rows
      .groupBy('path')
      .orderBy('pageviews', 'desc')
      .orderBy('path', 'asc')
      .limit(query.limit);

    if (query.offset !== undefined) {
      grouped = grouped.offset(query.offset);
    }

    const result = await grouped.execute();

    return result.map((row) => ({ path: row.path, pageviews: Number(row.pageviews) }));
  },

  /**
   * 上位ページの全件数（Pagination の `meta.total`）。
   *
   * 数えるのは**行数ではなくパスの種類**。`GROUP BY path` の結果の件数と一致させる。
   */
  async countTopPaths(
    connection: Connection,
    query: {
      readonly siteId: string | null;
      readonly from: string;
      readonly to: string;
    },
  ): Promise<number> {
    let rows = connection.db
      .selectFrom('access_logs')
      .select((eb) => eb.fn.count<string>(eb.ref('path')).distinct().as('total'))
      .where('device', '!=', 'bot')
      .where(sql<boolean>`occurred_at >= ${query.from}::date`)
      .where(sql<boolean>`occurred_at < (${query.to}::date + interval '1 day')`);

    if (query.siteId !== null) {
      rows = rows.where('site_id', '=', query.siteId);
    }

    const row = await rows.executeTakeFirst();
    return Number(row?.total ?? 0);
  },
  /**
   * 計測タグを出すためのサイト一覧。
   *
   * **公開キーは Site の一覧 API では返していない。** 画面でしか使わない値を
   * 通常のレスポンスへ載せないため、参照口をここに分けている。
   */
  async listTrackedSites(connection: Connection, limit: number): Promise<readonly TrackedSite[]> {
    const rows = await connection.db
      .selectFrom('sites')
      .select(['id', 'name', 'public_key'])
      .orderBy('name')
      .limit(limit)
      .execute();

    return rows.map((row) => ({ id: row.id, name: row.name, publicKey: row.public_key }));
  },
  /**
   * 生ログを日ごと・サイトごとに畳む（018-analytics 設計 §4.1）。
   *
   * **Bot は数えない。** 数えると、数字が実態から離れる。
   */
  async aggregateDaily(
    connection: Connection,
    range: { readonly from: string; readonly to: string },
  ): Promise<readonly DailyAggregate[]> {
    const result = await sql<{
      site_id: string;
      day: Date | string;
      pageviews: string | number;
      visitors: string | number;
    }>`
      SELECT
        site_id,
        (occurred_at AT TIME ZONE 'UTC')::date AS day,
        count(*) AS pageviews,
        count(DISTINCT visitor_hash) AS visitors
      FROM access_logs
      WHERE device <> 'bot'
        AND occurred_at >= ${range.from}::date
        AND occurred_at < (${range.to}::date + interval '1 day')
      GROUP BY site_id, day
    `.execute(connection.db);

    return result.rows.map((row) => ({
      siteId: row.site_id,
      day: row.day,
      pageviews: Number(row.pageviews),
      visitors: Number(row.visitors),
    }));
  },

  /**
   * 古い生ログを消す。消せた件数を返す。
   *
   * **集計値は消さない。** 小さく、過去との比較に要る。
   */
  async deleteAccessLogsOlderThan(connection: Connection, days: number): Promise<number> {
    const result = await connection.db
      .deleteFrom('access_logs')
      .where(sql<boolean>`occurred_at < now() - (${days} || ' days')::interval`)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0);
  },

  /** 計測タグの公開キーからサイトを引く。無ければ null。 */
  async findSiteByPublicKey(
    connection: Connection,
    publicKey: string,
  ): Promise<{ readonly id: string; readonly status: string } | null> {
    const row = await connection.db
      .selectFrom('sites')
      .select(['id', 'status'])
      .where('public_key', '=', publicKey)
      .executeTakeFirst();

    return row === undefined ? null : { id: row.id, status: row.status };
  },
};
