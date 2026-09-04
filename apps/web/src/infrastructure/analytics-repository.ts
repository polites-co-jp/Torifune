import { sql } from 'kysely';
import type { Connection } from '../database/provider';
import type { DeviceKind } from '../domain/analytics/access-log';
import {
  CORE_SOURCE,
  DIRECT_REFERRER_KEY,
  type AnalyticsPoint,
  type TopPath,
  type TrackedSite,
} from '../domain/analytics/analytics';
import { dateOnly } from '../domain/analytics/day';

/**
 * アクセス・分析データの保存（018-analytics、028-analytics-dashboard-redesign）。
 *
 * 生ログ（`access_logs`）と集計値（`analytics`）の両方を扱う。
 */

/** 生ログを「サイト × 日 × 指標 × key」へ畳んだ1行（ロールアップの中間結果）。 */
export interface DailyBreakdownRow {
  readonly siteId: string;
  /** `YYYY-MM-DD`。 */
  readonly metricDate: string;
  readonly metric: string;
  readonly key: string;
  readonly value: number;
}

/** サイトごとの、範囲内で最も新しい生ログの時刻。 */
export interface SiteLastSeen {
  readonly siteId: string;
  readonly lastSeenAt: Date;
}

/** 1 回の多行 INSERT に載せる行数。パラメータ数の上限に当たらない大きさにしておく。 */
const INSERT_CHUNK_SIZE = 500;

export interface NewAccessLog {
  readonly id: string;
  readonly siteId: string;
  readonly path: string;
  readonly referrerHost: string | null;
  readonly visitorHash: string;
  readonly device: DeviceKind;
}

/**
 * 生ログの期間を絞る条件。
 *
 * **`occurred_at >= '2026-09-03'::date` と書かない。**
 * `timestamptz` と `date` を比べると、PostgreSQL は接続の TimeZone 設定で
 * 日付を時刻へ直す。設定は環境に左右されるため、同じ SQL が環境ごとに
 * 別の範囲を指してしまう。境目に使うタイムゾーンを必ず明示する。
 */
function withinDays(from: string, to: string, timeZone: string) {
  return {
    start: sql<boolean>`occurred_at >= (${from}::date::timestamp AT TIME ZONE ${timeZone})`,
    end: sql<boolean>`occurred_at < ((${to}::date + interval '1 day')::timestamp AT TIME ZONE ${timeZone})`,
  };
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
      .select(['site_id', 'metric_date', 'source', 'metric', 'key', 'value'])
      .where(sql<boolean>`metric_date >= ${query.from}::date`)
      .where(sql<boolean>`metric_date <= ${query.to}::date`);

    if (query.siteId !== null) {
      rows = rows.where('site_id', '=', query.siteId);
    }
    if (query.source !== null) {
      rows = rows.where('source', '=', query.source);
    }

    // **並び順を一意にする。** 同じ日に複数の指標・出所・key があるので、
    // metric_date だけでは順序が定まらず、ページの境目で取りこぼしが出る。
    rows = rows
      .orderBy('metric_date', 'asc')
      .orderBy('source', 'asc')
      .orderBy('metric', 'asc')
      .orderBy('key', 'asc');

    if (query.limit !== undefined) {
      rows = rows.limit(query.limit);
    }
    if (query.offset !== undefined) {
      rows = rows.offset(query.offset);
    }

    const result = await rows.execute();

    return result.map((row) => ({
      siteId: row.site_id,
      metricDate: dateOnly(row.metric_date),
      source: row.source,
      metric: row.metric,
      key: row.key,
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
   * 集計値を 1 点入れる（upsert）。
   *
   * Plugin が外部サービスから取り込んだ値を入れる口（`recordAnalytics`）。
   * Core のロールアップは `replaceCorePoints` を使う（前回あって今回無い key の行を残さないため）。
   */
  async putPoint(connection: Connection, point: AnalyticsPoint): Promise<void> {
    await connection.db
      .insertInto('analytics')
      .values({
        site_id: point.siteId,
        metric_date: point.metricDate,
        source: point.source,
        metric: point.metric,
        key: point.key,
        value: point.value,
      })
      .onConflict((oc) =>
        oc
          .columns(['site_id', 'metric_date', 'source', 'metric', 'key'])
          .doUpdateSet({ value: point.value, updated_at: new Date() }),
      )
      .execute();
  },

  /**
   * (site, day) の Core の集計値をまとめて差し替える（028 設計 §5.3.3）。
   *
   * **upsert ではなく DELETE → INSERT。** upsert だけでは、前回あって今回無くなった key の行
   * （パスの正規化を変えた、生ログを一部消した）が残る。同じ生ログに対して何度流しても結果が同じになる。
   *
   * `source <> 'core'`（Plugin の値）には触らない。
   * **呼ぶ側がトランザクションを張る。** DELETE と INSERT の間で読まれると値が消えて見える。
   *
   * 書いた行数を返す。
   */
  async replaceCorePoints(
    connection: Connection,
    siteId: string,
    metricDate: string,
    points: readonly DailyBreakdownRow[],
  ): Promise<number> {
    await connection.db
      .deleteFrom('analytics')
      .where('site_id', '=', siteId)
      .where(sql<boolean>`metric_date = ${metricDate}::date`)
      .where('source', '=', CORE_SOURCE)
      .execute();

    for (let start = 0; start < points.length; start += INSERT_CHUNK_SIZE) {
      const chunk = points.slice(start, start + INSERT_CHUNK_SIZE);
      await connection.db
        .insertInto('analytics')
        .values(
          chunk.map((point) => ({
            site_id: siteId,
            metric_date: metricDate,
            source: CORE_SOURCE,
            metric: point.metric,
            key: point.key,
            value: point.value,
          })),
        )
        .execute();
    }

    return points.length;
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
      /** 1日の境目に使うタイムゾーン。 */
      readonly timeZone: string;
      readonly limit: number;
      readonly offset?: number;
    },
  ): Promise<readonly TopPath[]> {
    const days = withinDays(query.from, query.to, query.timeZone);

    let rows = connection.db
      .selectFrom('access_logs')
      .select(['path'])
      .select((eb) => eb.fn.countAll<string>().as('pageviews'))
      .where('device', '!=', 'bot')
      .where(days.start)
      .where(days.end);

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
      readonly timeZone: string;
    },
  ): Promise<number> {
    const days = withinDays(query.from, query.to, query.timeZone);

    let rows = connection.db
      .selectFrom('access_logs')
      .select((eb) => eb.fn.count<string>(eb.ref('path')).distinct().as('total'))
      .where('device', '!=', 'bot')
      .where(days.start)
      .where(days.end);

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
   * 生ログを「サイト × 日 × 指標 × key」へ畳む（028 設計 §5.2 / §5.3.2）。
   *
   * 1 本の SQL で全指標を返す。Kysely の型付きビルダでは書きにくいので `sql` テンプレートで書く。
   *
   * * **タイムゾーン**は 1 箇所（`tz`）で束ね、日付境界・`day`・`hour` に同じ値を使う。
   *   `occurred_at >= :date::date` のような接続 TimeZone 依存の比較は書かない
   * * **セッション**：同一 (site, 集計日, visitor_hash) の PV を時刻順に並べ、
   *   直前から 30 分を超えて空いたら新しいセッション。ちょうど 30 分は同じセッション。
   *   集計日をパーティションに含めるので日をまたがない
   * * **滞在**：同じセッション内の次の PV までの間隔。セッション最後の PV は標本に入らない
   * * **Bot**（`device = 'bot'`）はセッション化の対象外。`bot_pageviews` / `bot_visitors` にだけ数える
   * * **出力の規則**：key 無しの 8 指標は、その (site, day) に生ログが 1 行でもあれば 0 でも出す
   *   （`days` を土台にした LEFT JOIN）。キー付きの指標は値 > 0 の key だけ出す。
   *   生ログが 1 行も無い (site, day) には何も返さない
   */
  async aggregateDailyBreakdown(
    connection: Connection,
    range: { readonly from: string; readonly to: string; readonly timeZone: string },
  ): Promise<readonly DailyBreakdownRow[]> {
    const tz = range.timeZone;
    const direct = DIRECT_REFERRER_KEY;

    const result = await sql<{
      site_id: string;
      day: string;
      metric: string;
      key: string;
      value: string | number;
    }>`
      WITH logs AS (
        SELECT id, site_id, occurred_at, path, referrer_host, visitor_hash, device,
               (occurred_at AT TIME ZONE ${tz})::date AS day,
               to_char(occurred_at AT TIME ZONE ${tz}, 'HH24') AS hour
        FROM access_logs
        WHERE occurred_at >= (${range.from}::date::timestamp AT TIME ZONE ${tz})
          AND occurred_at <  ((${range.to}::date + interval '1 day')::timestamp AT TIME ZONE ${tz})
      ),
      -- 生ログが 1 行でもある (site, day)。key 無しの指標はこれを土台に 0 でも出す。
      days AS (
        SELECT DISTINCT site_id, day FROM logs
      ),
      human AS (
        SELECT * FROM logs WHERE device <> 'bot'
      ),
      bots AS (
        SELECT * FROM logs WHERE device = 'bot'
      ),
      ordered AS (
        SELECT *,
               lag(occurred_at)  OVER w AS prev_at,
               lead(occurred_at) OVER w AS next_at
        FROM human
        WINDOW w AS (PARTITION BY site_id, day, visitor_hash ORDER BY occurred_at, id)
      ),
      marked AS (
        SELECT *,
               CASE WHEN prev_at IS NULL OR occurred_at - prev_at > interval '30 minutes'
                    THEN 1 ELSE 0 END AS starts,
               CASE WHEN next_at IS NOT NULL AND next_at - occurred_at <= interval '30 minutes'
                    THEN floor(extract(epoch FROM (next_at - occurred_at)) * 1000)::bigint END AS dwell_ms
        FROM ordered
      ),
      numbered AS (
        SELECT *,
               sum(starts) OVER (PARTITION BY site_id, day, visitor_hash
                                 ORDER BY occurred_at, id ROWS UNBOUNDED PRECEDING) AS session_no
        FROM marked
      ),
      -- 1 行 = 1 セッション。名前は本体の sessions テーブルと紛れないよう visits にする。
      visits AS (
        SELECT site_id, day, visitor_hash, session_no,
               count(*) AS pv,
               (array_agg(path ORDER BY occurred_at, id))[1] AS landing_path,
               coalesce((array_agg(referrer_host ORDER BY occurred_at, id))[1], ${direct}) AS referrer
        FROM numbered
        GROUP BY site_id, day, visitor_hash, session_no
      ),
      dwell AS (
        SELECT site_id, day, path, dwell_ms FROM numbered WHERE dwell_ms IS NOT NULL
      ),
      human_daily AS (
        SELECT site_id, day, count(*) AS pageviews, count(DISTINCT visitor_hash) AS visitors
        FROM human GROUP BY site_id, day
      ),
      session_daily AS (
        SELECT site_id, day, count(*) AS sessions, count(*) FILTER (WHERE pv = 1) AS bounces
        FROM visits GROUP BY site_id, day
      ),
      dwell_daily AS (
        SELECT site_id, day, sum(dwell_ms) AS dwell_ms, count(*) AS dwell_samples
        FROM dwell GROUP BY site_id, day
      ),
      bot_daily AS (
        SELECT site_id, day, count(*) AS bot_pageviews, count(DISTINCT visitor_hash) AS bot_visitors
        FROM bots GROUP BY site_id, day
      ),
      keyless AS (
        SELECT d.site_id, d.day,
               coalesce(h.pageviews, 0)     AS pageviews,
               coalesce(h.visitors, 0)      AS visitors,
               coalesce(s.sessions, 0)      AS sessions,
               coalesce(s.bounces, 0)       AS bounces,
               coalesce(w.dwell_ms, 0)      AS dwell_ms,
               coalesce(w.dwell_samples, 0) AS dwell_samples,
               coalesce(b.bot_pageviews, 0) AS bot_pageviews,
               coalesce(b.bot_visitors, 0)  AS bot_visitors
        FROM days d
        LEFT JOIN human_daily   h ON h.site_id = d.site_id AND h.day = d.day
        LEFT JOIN session_daily s ON s.site_id = d.site_id AND s.day = d.day
        LEFT JOIN dwell_daily   w ON w.site_id = d.site_id AND w.day = d.day
        LEFT JOIN bot_daily     b ON b.site_id = d.site_id AND b.day = d.day
      ),
      keyed AS (
        SELECT site_id, day, 'pageviews_hour' AS metric, hour AS key, count(*) AS value
        FROM human GROUP BY site_id, day, hour
        UNION ALL
        SELECT site_id, day, 'pageviews_device', device, count(*)
        FROM human GROUP BY site_id, day, device
        UNION ALL
        SELECT site_id, day, 'landing', landing_path, count(*)
        FROM visits GROUP BY site_id, day, landing_path
        UNION ALL
        SELECT site_id, day, 'referrer', referrer, count(*)
        FROM visits GROUP BY site_id, day, referrer
        UNION ALL
        SELECT site_id, day, 'referrer_visitors', referrer, count(DISTINCT visitor_hash)
        FROM visits GROUP BY site_id, day, referrer
        UNION ALL
        SELECT site_id, day, 'referrer_bounces', referrer, count(*) FILTER (WHERE pv = 1)
        FROM visits GROUP BY site_id, day, referrer
        UNION ALL
        SELECT site_id, day, 'path_pageviews', path, count(*)
        FROM human GROUP BY site_id, day, path
        UNION ALL
        SELECT site_id, day, 'path_visitors', path, count(DISTINCT visitor_hash)
        FROM human GROUP BY site_id, day, path
        UNION ALL
        SELECT site_id, day, 'path_bounces', landing_path, count(*) FILTER (WHERE pv = 1)
        FROM visits GROUP BY site_id, day, landing_path
        UNION ALL
        SELECT site_id, day, 'path_dwell_ms', path, sum(dwell_ms)
        FROM dwell GROUP BY site_id, day, path
        UNION ALL
        SELECT site_id, day, 'path_dwell_samples', path, count(*)
        FROM dwell GROUP BY site_id, day, path
      )
      SELECT site_id, to_char(day, 'YYYY-MM-DD') AS day, metric, key, value
      FROM (
        SELECT site_id, day, 'pageviews' AS metric, '' AS key, pageviews AS value FROM keyless
        UNION ALL SELECT site_id, day, 'visitors',      '', visitors      FROM keyless
        UNION ALL SELECT site_id, day, 'sessions',      '', sessions      FROM keyless
        UNION ALL SELECT site_id, day, 'bounces',       '', bounces       FROM keyless
        UNION ALL SELECT site_id, day, 'dwell_ms',      '', dwell_ms      FROM keyless
        UNION ALL SELECT site_id, day, 'dwell_samples', '', dwell_samples FROM keyless
        UNION ALL SELECT site_id, day, 'bot_pageviews', '', bot_pageviews FROM keyless
        UNION ALL SELECT site_id, day, 'bot_visitors',  '', bot_visitors  FROM keyless
        UNION ALL SELECT site_id, day, metric, key, value FROM keyed WHERE value > 0
      ) points
      ORDER BY site_id, day, metric, key
    `.execute(connection.db);

    return result.rows.map((row) => ({
      siteId: row.site_id,
      metricDate: row.day,
      metric: row.metric,
      key: row.key,
      value: Number(row.value),
    }));
  },

  /**
   * 範囲内の生ログの、サイトごとの `max(occurred_at)`（028 設計 §5.3.4）。
   *
   * **Bot を含める。** 届いているかの確認が目的で、Bot でも届いたことに変わりはない。
   */
  async maxOccurredAtBySite(
    connection: Connection,
    range: { readonly from: string; readonly to: string; readonly timeZone: string },
  ): Promise<readonly SiteLastSeen[]> {
    const tz = range.timeZone;

    const result = await sql<{ site_id: string; last_seen_at: Date }>`
      SELECT site_id, max(occurred_at) AS last_seen_at
      FROM access_logs
      WHERE occurred_at >= (${range.from}::date::timestamp AT TIME ZONE ${tz})
        AND occurred_at <  ((${range.to}::date + interval '1 day')::timestamp AT TIME ZONE ${tz})
      GROUP BY site_id
    `.execute(connection.db);

    return result.rows.map((row) => ({ siteId: row.site_id, lastSeenAt: row.last_seen_at }));
  },

  /**
   * 最終受信を書き戻す。
   *
   * **`GREATEST` で更新する。** 過去の期間を流し直しても値が巻き戻らない。
   */
  async touchLastSeen(connection: Connection, siteId: string, seenAt: Date): Promise<void> {
    await connection.db
      .updateTable('sites')
      .set({
        analytics_last_seen_at: sql<Date>`GREATEST(coalesce(analytics_last_seen_at, '-infinity'::timestamptz), ${seenAt}::timestamptz)`,
      })
      .where('id', '=', siteId)
      .execute();
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
