import type { JobRunStatus } from '../jobs/job';
import type { SiteStatus } from '../site/site';

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

/** 月ごとの日数（平年）。閏年の 2 月だけ 29 日にする。 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * `YYYY-MM-DD` で、かつ**カレンダー上に実在する日付**か。
 *
 * **形式だけでは足りない。** `0000-00-00` / `9999-99-99` / `2026-02-30` は形式を通るが、
 * その先の `rangeDays`（`Date.parse` 依存）が `NaN` を返す。`NaN` との比較はすべて `false` なので
 * `rangeDays(...) > MAX_RANGE_DAYS` が成立せず、**期間の幅の検査が素通りする**（フェイルオープン）。
 *
 * `Date` を経由せずに数で判定する。`Date.UTC` は 0〜99 年を 1900 年代に写すため、
 * 「動かして戻す」方式では年の境目で誤判定する。
 */
function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) {
    return false;
  }

  const lastDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return day >= 1 && day <= (lastDay ?? 0);
}

/**
 * 期間として成立するか。
 *
 * 逆転を許すと、空の結果が返るだけで理由が分からない。
 *
 * **実在する日付であることまで見る。** ここが入口なので、
 * `POST /analytics/rollup` の期間検査・`listAnalytics` の `assertRange`・
 * アナリティクス画面の `custom` 期間が、まとめて同じ判定に乗る。
 */
export function isValidRange(from: string, to: string): boolean {
  return isCalendarDate(from) && isCalendarDate(to) && from <= to;
}

/** 一度に取れる日数の上限。広すぎる期間で画面と DB を止めない。 */
export const MAX_RANGE_DAYS = 400;

/**
 * 期間の日数（両端を含む）。
 *
 * **`isValidRange` を通した値だけを渡すこと。** 実在しない日付を渡すと `NaN` になり、
 * 呼ぶ側の比較（`> MAX_RANGE_DAYS`）が静かに `false` になる。
 */
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

/**
 * 計測タグを出すためのサイト。
 *
 * 計測タグを貼ったままの `archived` のサイトも含む（受信状況を見るため）。
 */
export interface TrackedSite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: SiteStatus;
  readonly publicKey: string;
  /** 最終受信。ロールアップが書き戻す。計測したことが無ければ null。 */
  readonly analyticsLastSeenAt: Date | null;
}

/**
 * サイトの受信状況（028 設計 §6.4、029 設計 §5.4）。
 *
 * 「届いているが未集計」「Bot だけ届いている」を管理画面だけで切り分けられるようにする。
 * **「最終集計」は 2 つある**（裁定 #7）。`rollup.lastSucceededAt`（`job_runs`。全体）は
 * 「集計は回っているか」に答え、`lastRollupAt`（`analytics.updated_at`。サイトごと）は
 * 「このサイトの集計値がいつ書き換わったか」に答える。役目が違うので片方に寄せない。
 */
export interface AnalyticsStatus {
  readonly siteId: string;
  /**
   * ロールアップが書き戻した最終受信（`sites.analytics_last_seen_at`）。
   *
   * 選択肢の「（未設置）」判定と同じ値。画面のヘッダには `lastReceivedAt` を出す。
   */
  readonly analyticsLastSeenAt: Date | null;
  /** このサイトの Core の集計値を最後に書いた時刻。Plugin の値は数えない。 */
  readonly lastRollupAt: Date | null;
  /** 生ログの最終受信（Bot 含む）。集計を待たずに「届いたか」が分かる。 */
  readonly lastReceivedAt: Date | null;
  /** 最終集計以降に届いた生ログ（Bot 含む）。上限で打ち切る。 */
  readonly pending: {
    readonly total: number;
    readonly bots: number;
    /** 上限で打ち切った（実際はもっと多い）。 */
    readonly capped: boolean;
    /** 数え始めの時刻（最後に成功したロールアップの開始時刻）。集計したことが無ければ null（全件）。 */
    readonly since: Date | null;
  };
  /** ロールアップの実行状況（`job_runs` と基盤のスナップショット）。 */
  readonly rollup: {
    /** 最後に成功した実行の終了時刻。「最終集計（全体）」はこれ。 */
    readonly lastSucceededAt: Date | null;
    /** 直近の実行（**結果だけ**。`error` の文字列は画面に出さない）。 */
    readonly lastRun: {
      readonly status: JobRunStatus;
      readonly startedAt: Date;
      readonly finishedAt: Date | null;
    } | null;
    /** 定期実行が有効か（このプロセス）。 */
    readonly scheduled: boolean;
    readonly intervalMinutes: number;
    /** 次回の予定（このプロセス）。無効なら null。 */
    readonly nextRunAt: Date | null;
  };
}
