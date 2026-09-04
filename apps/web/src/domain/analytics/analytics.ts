/**
 * 日次の集計値（02_データベース設計.md §5.8、018-analytics）。
 *
 * Core の集計と、Plugin が外部サービスから取り込んだ値の**両方**が入る。
 * `source` で区別する。
 */

/** Torifune 自身が集計した値の出所。 */
export const CORE_SOURCE = 'core';

/**
 * Core が出す指標（028-analytics-dashboard-redesign 設計 §5.2）。
 *
 * **固定の列にしない。** 列にすると Plugin が別の指標を持てない。
 *
 * Bot（`device = 'bot'`）はセッション化の対象外で、`bot_*` にだけ数える。
 * `key = ''` の 8 指標（`KEYLESS_CORE_METRICS`）は、その日に生ログが 1 行でもあれば 0 でも出す。
 * キー付きの指標は値 > 0 の key だけ出す。
 */
export const CORE_METRICS = [
  'pageviews',
  'visitors',
  'sessions',
  'bounces',
  'dwell_ms',
  'dwell_samples',
  'bot_pageviews',
  'bot_visitors',
  'pageviews_hour',
  'pageviews_device',
  'landing',
  'referrer',
  'referrer_visitors',
  'referrer_bounces',
  'path_pageviews',
  'path_visitors',
  'path_bounces',
  'path_dwell_ms',
  'path_dwell_samples',
] as const;
export type CoreMetric = (typeof CORE_METRICS)[number];

/**
 * key を持たない Core の指標。
 *
 * 「集計したが 0 だった」と「集計していない」を区別するため、
 * 生ログのある日にはこの 8 つを必ず出す。
 */
export const KEYLESS_CORE_METRICS = [
  'pageviews',
  'visitors',
  'sessions',
  'bounces',
  'dwell_ms',
  'dwell_samples',
  'bot_pageviews',
  'bot_visitors',
] as const satisfies readonly CoreMetric[];

/** 参照元が無いセッションを表す key。 */
export const DIRECT_REFERRER_KEY = '(direct)';

export interface AnalyticsPoint {
  readonly siteId: string;
  /** `YYYY-MM-DD`。 */
  readonly metricDate: string;
  readonly source: string;
  readonly metric: string;
  /** 内訳キー（パス・ホスト・時間帯など）。キーを持たない指標は `''`。 */
  readonly key: string;
  readonly value: number;
}

/** 内訳の 1 行（key ごとの期間合計）。 */
export interface BreakdownItem {
  readonly key: string;
  readonly value: number;
}

export const METRIC_NAME_MAX_LENGTH = 100;

/** 指標名として受け付けるか。Plugin が任意の名前を入れられるため形式だけ見る。 */
export function isValidMetricName(value: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(value) && value.length <= METRIC_NAME_MAX_LENGTH;
}

/** 内訳キーの長さの上限。`PATH_MAX_LENGTH` と同じ（パスを key に入れるため）。 */
export const BREAKDOWN_KEY_MAX_LENGTH = 500;

/**
 * 内訳キーとして受け付けるか。
 *
 * **空文字は可**（キーを持たない指標）。制御文字（0x00〜0x1f、0x7f）は
 * 画面やログで崩れるので拒む。
 */
export function isValidBreakdownKey(value: string): boolean {
  if (value.length > BREAKDOWN_KEY_MAX_LENGTH) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
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
