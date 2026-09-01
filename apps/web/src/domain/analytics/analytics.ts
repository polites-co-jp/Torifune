/**
 * 日次の集計値（02_データベース設計.md §5.8、018-analytics）。
 *
 * Core の集計と、Plugin が外部サービスから取り込んだ値の**両方**が入る。
 * `source` で区別する。
 */

/** Torifune 自身が集計した値の出所。 */
export const CORE_SOURCE = 'core';

/**
 * Core が出す指標。
 *
 * **固定の列にしない。** 列にすると Plugin が別の指標を持てない。
 */
export const CORE_METRICS = ['pageviews', 'visitors', 'sessions'] as const;
export type CoreMetric = (typeof CORE_METRICS)[number];

export interface AnalyticsPoint {
  readonly siteId: string;
  /** `YYYY-MM-DD`。 */
  readonly metricDate: string;
  readonly source: string;
  readonly metric: string;
  readonly value: number;
}

export const METRIC_NAME_MAX_LENGTH = 100;

/** 指標名として受け付けるか。Plugin が任意の名前を入れられるため形式だけ見る。 */
export function isValidMetricName(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value) && value.length <= METRIC_NAME_MAX_LENGTH;
}

/**
 * 出所として受け付けるか。
 *
 * `core` は Torifune 自身の予約。**Plugin に名乗らせない。**
 * 名乗れると、Plugin の値が本体の集計として表示されてしまう。
 */
export function isValidSource(value: string): boolean {
  return value.trim() !== '' && value.length <= 100;
}

export function isReservedSource(value: string): boolean {
  return value === CORE_SOURCE;
}

/**
 * 期間として成立するか。
 *
 * 逆転を許すと、空の結果が返るだけで理由が分からない。
 */
export function isValidRange(from: string, to: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
}

/** 一度に取れる日数の上限。広すぎる期間で画面と DB を止めない。 */
export const MAX_RANGE_DAYS = 400;

export function rangeDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

/**
 * 参照用の読み取りモデル。
 *
 * **Infrastructure ではなく Domain に置く。** 画面が使う型なので、
 * Infrastructure に置くと UI から Infrastructure を import することになり、
 * レイヤの向きが崩れる（06_画面設計.md §3）。
 */

/** よく見られている経路。 */
export interface TopPath {
  readonly path: string;
  readonly pageviews: number;
}

/** 計測タグを出すためのサイト。 */
export interface TrackedSite {
  readonly id: string;
  readonly name: string;
  readonly publicKey: string;
}
