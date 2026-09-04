import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import type { DeviceKind } from '../domain/analytics/access-log';
import {
  CORE_SOURCE,
  DIRECT_REFERRER_KEY,
  type AnalyticsPoint,
  type BreakdownItem,
  type TrackedSite,
} from '../domain/analytics/analytics';
import { dateOnly } from '../domain/analytics/day';
import type { SiteStatus } from '../domain/site/site';

/**
 * アクセス・分析データの保存（018-analytics、028-analytics-dashboard-redesign）。
 *
 * 生ログ（`access_logs`）と集計値（`analytics`）の両方を扱う。
 *
 * **生ログに触れるのは、記録・日次集計・最終受信の書き戻し・保持期間の削除・公開キーの照合と、
 * 行数を `LIMIT` で固定した診断用の読み取り 2 つだけ。**
 * 画面・API が「期間で集計する」ために読むのは集計値（`analytics`）に限る
 * （018 設計 §4.1、028 設計 §6.3、029 設計 §6.4）。
 */

/** UUID の形をしているか。不正な値で 500 にせず、見つからない扱いにする。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `siteId` の絞り込み。UUID でなければ**どの行にも当たらない条件**にする。
 *
 * `site_id` は `uuid` 型なので、そのまま比べると PG のキャストエラーで 500 になる。
 * `findSiteLastSeen` と同じく「見つからない」扱い（空結果）にする（028 設計 §6.1 / §6.2）。
 */
function siteCondition(
  eb: ExpressionBuilder<Schema, 'analytics'>,
  siteId: string,
): Expression<SqlBool> {
  return UUID_PATTERN.test(siteId) ? eb('site_id', '=', siteId) : sql<SqlBool>`false`;
}

/**
 * 制御文字（0x00〜0x1f、0x7f）を含まないパスだけを通す条件（028 設計 §5.3.6 (b)）。
 *
 * 受け口で落とす前に記録された生ログへの防御。キー付き指標の key にだけ掛け、
 * key 無しの指標とセッション判定には掛けない（その PV 自体は数える）。
 * パターンはバインド値として渡す（`\x..` は PG の正規表現側で解釈される）。
 */
const CONTROL_CHAR_SQL_PATTERN = '[\\x00-\\x1f\\x7f]';

function withoutControlChars(column: string) {
  return sql`${sql.ref(column)} !~ ${CONTROL_CHAR_SQL_PATTERN}`;
}

/** 集計値を期間・サイト・出所・指標・key で絞る条件。 */
export interface PointsFilter {
  readonly siteId: string | null;
  readonly from: string;
  readonly to: string;
  readonly source: string | null;
  /** 指標名で絞る。省略は全指標。 */
  readonly metrics?: readonly string[];
  /** key で絞る。`''` はキー無しの行だけ。省略は全 key。 */
  readonly key?: string;
}

/**
 * 一覧と件数で使う共通の条件。
 *
 * 片方だけ直すと「1件も出ないのに total が 100」のような食い違いが起きる。
 */
function pointConditions(
  eb: ExpressionBuilder<Schema, 'analytics'>,
  filter: PointsFilter,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [
    sql<SqlBool>`metric_date >= ${filter.from}::date`,
    sql<SqlBool>`metric_date <= ${filter.to}::date`,
  ];

  if (filter.siteId !== null) {
    conditions.push(siteCondition(eb, filter.siteId));
  }
  if (filter.source !== null) {
    conditions.push(eb('source', '=', filter.source));
  }
  if (filter.metrics !== undefined) {
    // `IN ()` は SQL として成立しないので、空配列でも通る `= ANY` にする。
    conditions.push(sql<SqlBool>`metric = ANY(${[...filter.metrics]})`);
  }
  if (filter.key !== undefined) {
    conditions.push(eb('key', '=', filter.key));
  }

  return conditions;
}

/** 内訳（key ごとの期間合計）の条件。 */
export interface BreakdownFilter {
  readonly siteId: string | null;
  readonly from: string;
  readonly to: string;
  readonly metric: string;
  readonly source: string | null;
  /** 指定した key に限る。省略は全 key。 */
  readonly keys?: readonly string[];
}

function breakdownConditions(
  eb: ExpressionBuilder<Schema, 'analytics'>,
  filter: BreakdownFilter,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [
    eb('metric', '=', filter.metric),
    sql<SqlBool>`metric_date >= ${filter.from}::date`,
    sql<SqlBool>`metric_date <= ${filter.to}::date`,
  ];

  if (filter.siteId !== null) {
    conditions.push(siteCondition(eb, filter.siteId));
  }
  if (filter.source !== null) {
    conditions.push(eb('source', '=', filter.source));
  }
  if (filter.keys !== undefined) {
    conditions.push(sql<SqlBool>`key = ANY(${[...filter.keys]})`);
  }

  return conditions;
}

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

/**
 * 未集計件数を数えるときの打ち切り（029 設計 §5.4 / §6.4）。
 *
 * **「何件あるか」ではなく「人のアクセスが混じっているか」を見るための数**なので、
 * ここで止めてよい。止めないと、集計を長く回していない環境で生ログを全部数えることになる。
 */
export const PENDING_COUNT_LIMIT = 1000;

/** 最終集計以降に届いた生ログの内訳（Bot 含む）。 */
export interface PendingAccessCount {
  readonly total: number;
  readonly bots: number;
}

export interface NewAccessLog {
  readonly id: string;
  readonly siteId: string;
  readonly path: string;
  readonly referrerHost: string | null;
  readonly visitorHash: string;
  readonly device: DeviceKind;
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
   *
   * `metrics` / `key` で絞れる（028 設計 §6.1）。画面は `key: ''` と `metrics` を必ず渡す。
   * 渡さないとパス別の行を全部読むことになる。
   */
  async listPoints(
    connection: Connection,
    query: PointsFilter & { readonly limit?: number; readonly offset?: number },
  ): Promise<readonly AnalyticsPoint[]> {
    let rows = connection.db
      .selectFrom('analytics')
      .select(['site_id', 'metric_date', 'source', 'metric', 'key', 'value'])
      .where((eb) => eb.and(pointConditions(eb, query)))
      // **並び順を一意にする。** 同じ日に複数の指標・出所・key があるので、
      // metric_date だけでは順序が定まらず、ページの境目で取りこぼしが出る。
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
  async countPoints(connection: Connection, query: PointsFilter): Promise<number> {
    const row = await connection.db
      .selectFrom('analytics')
      .select((eb) => eb.fn.countAll<string>().as('total'))
      .where((eb) => eb.and(pointConditions(eb, query)))
      .executeTakeFirst();

    return Number(row?.total ?? 0);
  },

  /**
   * 内訳：期間内の値を key ごとに合算する（028 設計 §6.2）。
   *
   * value 降順・key 昇順。`analytics_site_metric_idx`（site_id, metric, metric_date）で引く。
   */
  async sumByKey(
    connection: Connection,
    query: BreakdownFilter & { readonly limit: number; readonly offset: number },
  ): Promise<readonly BreakdownItem[]> {
    const rows = await connection.db
      .selectFrom('analytics')
      .select(['key'])
      .select((eb) => eb.fn.sum<string>('value').as('value'))
      .where((eb) => eb.and(breakdownConditions(eb, query)))
      .groupBy('key')
      .orderBy(sql`sum(value)`, 'desc')
      .orderBy('key', 'asc')
      .limit(query.limit)
      .offset(query.offset)
      .execute();

    return rows.map((row) => ({ key: row.key, value: Number(row.value) }));
  },

  /**
   * 内訳の全件数（Pagination の `meta.total`）。
   *
   * 数えるのは**行数ではなく key の種類**。`GROUP BY key` の結果の件数と一致させる。
   */
  async countKeys(connection: Connection, query: BreakdownFilter): Promise<number> {
    const row = await connection.db
      .selectFrom('analytics')
      .select((eb) => eb.fn.count<string>('key').distinct().as('total'))
      .where((eb) => eb.and(breakdownConditions(eb, query)))
      .executeTakeFirst();

    return Number(row?.total ?? 0);
  },

  /**
   * サイトの最終受信（`sites.analytics_last_seen_at`）。サイトが無ければ null。
   *
   * 「最終受信が無い」と「サイトが無い」を区別するため、行の有無で返し分ける。
   */
  async findSiteLastSeen(
    connection: Connection,
    siteId: string,
  ): Promise<{ readonly analyticsLastSeenAt: Date | null } | null> {
    if (!UUID_PATTERN.test(siteId)) {
      return null;
    }
    const row = await connection.db
      .selectFrom('sites')
      .select(['analytics_last_seen_at'])
      .where('id', '=', siteId)
      .executeTakeFirst();

    return row === undefined ? null : { analyticsLastSeenAt: row.analytics_last_seen_at };
  },

  /**
   * Core の集計値を最後に書いた時刻（028 設計 §6.4）。
   *
   * **`source = 'core'` に限る。** Plugin の `record` で `updated_at` が動いても、
   * ロールアップを流した時刻とは別の話。
   */
  async findLastRollupAt(connection: Connection, siteId: string): Promise<Date | null> {
    if (!UUID_PATTERN.test(siteId)) {
      return null;
    }
    const row = await connection.db
      .selectFrom('analytics')
      .select((eb) => eb.fn.max('updated_at').as('last_rollup_at'))
      .where('site_id', '=', siteId)
      .where('source', '=', CORE_SOURCE)
      .executeTakeFirst();

    return row?.last_rollup_at ?? null;
  },

  /**
   * 生ログの最終受信（029 設計 §6.4）。**Bot を含める。**
   *
   * `sites.analytics_last_seen_at` はロールアップが書き戻す値なので、集計を待たないと動かない。
   * 「タグを貼ったら届いたか」を集計前に見せるため、生ログを 1 行だけ読む。
   * `access_logs_site_time_idx (site_id, occurred_at DESC)` の先頭 1 行で止まる。
   */
  async findLatestAccessAt(connection: Connection, siteId: string): Promise<Date | null> {
    if (!UUID_PATTERN.test(siteId)) {
      return null;
    }
    const row = await connection.db
      .selectFrom('access_logs')
      .select('occurred_at')
      .where('site_id', '=', siteId)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    return row?.occurred_at ?? null;
  },

  /**
   * 最終集計以降に届いた生ログの件数（029 設計 §6.4）。**Bot を含め、内訳も返す。**
   *
   * **期間で集計するものではない。** 新しい順に最大 `limit` 件だけ見て数え、そこで打ち切る
   * （呼ぶ側が `total === PENDING_COUNT_LIMIT` を「1000 件以上」として扱う）。
   * 同じ索引を新しい順にたどるので、生ログが何年ぶんあっても読む行数は変わらない。
   *
   * `since` が null なら全件（打ち切りは効く）。
   */
  async countAccessSince(
    connection: Connection,
    siteId: string,
    since: Date | null,
    limit: number = PENDING_COUNT_LIMIT,
  ): Promise<PendingAccessCount> {
    if (!UUID_PATTERN.test(siteId)) {
      return { total: 0, bots: 0 };
    }

    let recent = connection.db
      .selectFrom('access_logs')
      .select('device')
      .where('site_id', '=', siteId)
      .orderBy('occurred_at', 'desc')
      .limit(limit);

    if (since !== null) {
      recent = recent.where('occurred_at', '>=', since);
    }

    const row = await connection.db
      .selectFrom(recent.as('recent'))
      .select((eb) => [
        eb.fn.countAll<string>().as('total'),
        sql<string>`count(*) FILTER (WHERE device = 'bot')`.as('bots'),
      ])
      .executeTakeFirst();

    return { total: Number(row?.total ?? 0), bots: Number(row?.bots ?? 0) };
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
   * 計測タグを出すためのサイト一覧。
   *
   * **公開キーは Site の一覧 API では返していない。** 画面でしか使わない値を
   * 通常のレスポンスへ載せないため、参照口をここに分けている。
   *
   * 状態で絞らない。計測タグを貼ったままの `archived` のサイトも受信状況を見られるようにする。
   */
  async listTrackedSites(connection: Connection, limit: number): Promise<readonly TrackedSite[]> {
    const rows = await connection.db
      .selectFrom('sites')
      .select(['id', 'name', 'url', 'status', 'public_key', 'analytics_last_seen_at'])
      .orderBy('name')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      status: row.status as SiteStatus,
      publicKey: row.public_key,
      analyticsLastSeenAt: row.analytics_last_seen_at,
    }));
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
   * * **制御文字を含むパス**は `path_*` / `landing` の key に出さない（§5.3.6 (b)）。
   *   その PV 自体は `pageviews` 等とセッション判定には数える
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
        FROM visits WHERE ${withoutControlChars('landing_path')} GROUP BY site_id, day, landing_path
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
        FROM human WHERE ${withoutControlChars('path')} GROUP BY site_id, day, path
        UNION ALL
        SELECT site_id, day, 'path_visitors', path, count(DISTINCT visitor_hash)
        FROM human WHERE ${withoutControlChars('path')} GROUP BY site_id, day, path
        UNION ALL
        SELECT site_id, day, 'path_bounces', landing_path, count(*) FILTER (WHERE pv = 1)
        FROM visits WHERE ${withoutControlChars('landing_path')} GROUP BY site_id, day, landing_path
        UNION ALL
        SELECT site_id, day, 'path_dwell_ms', path, sum(dwell_ms)
        FROM dwell WHERE ${withoutControlChars('path')} GROUP BY site_id, day, path
        UNION ALL
        SELECT site_id, day, 'path_dwell_samples', path, count(*)
        FROM dwell WHERE ${withoutControlChars('path')} GROUP BY site_id, day, path
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
