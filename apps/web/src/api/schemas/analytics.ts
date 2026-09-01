import { z } from 'zod';
import { pageEnvelope } from './envelope';

/**
 * Analytics API の Zod スキーマ（05_API設計.md §20）。
 *
 * **analytics は集計値の集合であり、単一リソースの id を持たない。**
 * 保存の単位は `(site_id, metric_date, source, metric)` の複合キーで、
 * 「1件」を指す ID が存在しない。そのため `GET /analytics/{id}` は提供せず、
 * 一覧に対する期間指定・絞り込み・Pagination で必要な範囲を取る
 * （仕様書 §20 / `改訂履歴.md` 2026-09-01）。
 */

/** `YYYY-MM-DD`。時刻は受け取らない。 */
export const analyticsDateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で入力してください。');

export const analyticsListQuerySchema = z.object({
  siteId: z.string().optional(),
  from: analyticsDateOnly,
  to: analyticsDateOnly,
  source: z.string().max(100).optional(),
  /** 'points'（日次の値）か 'topPaths'（上位ページ）。 */
  kind: z.enum(['points', 'topPaths']).default('points'),
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
