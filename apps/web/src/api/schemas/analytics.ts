import { z } from 'zod';
import { BREAKDOWN_KEY_MAX_LENGTH, METRIC_NAME_MAX_LENGTH } from '@/domain/analytics/analytics';
import { pageEnvelope } from './envelope';

/**
 * Analytics API の Zod スキーマ（05_API設計.md §20）。
 *
 * **analytics は集計値の集合であり、単一リソースの id を持たない。**
 * 保存の単位は `(site_id, metric_date, source, metric, key)` の複合キーで、
 * 「1件」を指す ID が存在しない。そのため `GET /analytics/{id}` は提供せず、
 * 一覧に対する期間指定・絞り込み・Pagination で必要な範囲を取る
 * （仕様書 §20 / `改訂履歴.md` 2026-09-01）。
 */

/** `YYYY-MM-DD`。時刻は受け取らない。 */
export const analyticsDateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で入力してください。');

/** 指標名。形式だけ見る（Plugin が任意の名前を入れられるため）。 */
const metricName = z
  .string()
  .max(METRIC_NAME_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9_]*$/, '指標名の形式が不正です。');

export const analyticsListQuerySchema = z.object({
  siteId: z.string().optional(),
  from: analyticsDateOnly,
  to: analyticsDateOnly,
  source: z.string().max(100).optional(),
  /** 指標名で絞る（1 つ）。省略は全指標。 */
  metric: metricName.optional().describe('指標名で絞る。省略すると全指標。'),
  /**
   * 内訳キーで絞る。**空文字を残す。** `key=` はキー無しの行だけに絞る指定であり、
   * 省略（全 key）とは別の意味を持つ。
   */
  key: z
    .string()
    .max(BREAKDOWN_KEY_MAX_LENGTH)
    .optional()
    .describe('内訳キーで絞る。空文字（key=）でキー無しの行だけ。省略すると全 key。'),
  /**
   * 'points'（日次の値）か 'topPaths'（上位ページ）。
   *
   * **エンドポイント単位の `deprecated` は付けない。** 付けると `kind=points` を含む
   * `GET /analytics` 全体が非推奨になる。`kind` の値の置き換え先はここに書く。
   */
  kind: z
    .enum(['points', 'topPaths'])
    .default('points')
    .describe(
      "'points' は日次の値、'topPaths' は上位ページ。" +
        'topPaths は /analytics/breakdown?metric=path_pageviews で置き換えられる。互換のため残す' +
        '（集計値から引くので、日次集計を流すまで出ない）。',
    ),
  // 他の一覧 API（`/users` `/sites` `/social/accounts`）と同じ形にそろえる（§33）。
  page: z.coerce.number().int('整数を指定してください。').default(1),
  /**
   * 既定値をここで埋めない。
   *
   * 旧名 `limit` との優先順位をルート側で決めるため、
   * 「指定されなかった」ことが区別できる形にしてある。
   */
  perPage: z.coerce.number().int('整数を指定してください。').optional(),
  /**
   * `perPage` の旧名。
   *
   * **残してある。** §41 は後方互換を重んじるので、
   * 既に `limit` を送っているクライアントを黙って壊さない。
   * `perPage` を明示したときは `perPage` を採る。
   */
  limit: z.coerce.number().int('整数を指定してください。').optional(),
});

/** 日次の集計値。 */
export const analyticsPointSchema = z.object({
  siteId: z.string(),
  metricDate: z.string(),
  /** 出所。Core の集計は `core`、Plugin が取り込んだ値は Plugin ID。 */
  source: z.string(),
  metric: z.string(),
  /** 内訳キー（パス・ホスト・時間帯など）。キーを持たない指標は `''`。 */
  key: z.string(),
  value: z.number(),
});

/** 上位ページ。 */
export const topPathSchema = z.object({
  path: z.string(),
  pageviews: z.number(),
});

/**
 * 応答。`kind` によって配列の中身が変わる。
 *
 * 別のエンドポイントに分けていないのは、期間指定・絞り込みの引数が同じで、
 * 画面でも同時に使うため。
 */
export const analyticsPageSchema = pageEnvelope(z.union([analyticsPointSchema, topPathSchema]));

/**
 * 内訳（028 設計 §6.2）。期間内の値を key ごとに合算する。
 *
 * `keys`（画面が表の 1 ページ分の別指標を引くための絞り込み）は API に出さない。
 */
export const analyticsBreakdownQuerySchema = z.object({
  siteId: z.string().optional().describe('サイト ID。省略すると全サイトを合算。'),
  from: analyticsDateOnly,
  to: analyticsDateOnly,
  metric: metricName.describe('内訳を出す指標名（path_pageviews、referrer など）。'),
  source: z.string().max(100).optional().describe('出所で絞る。省略すると全出所を合算。'),
  page: z.coerce.number().int('整数を指定してください。').default(1),
  perPage: z.coerce.number().int('整数を指定してください。').optional(),
});

/** 内訳の 1 行。value 降順・key 昇順で返る。 */
export const breakdownItemSchema = z.object({
  key: z.string(),
  value: z.number(),
});

export const analyticsBreakdownPageSchema = pageEnvelope(breakdownItemSchema);
