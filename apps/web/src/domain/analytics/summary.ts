import type { AnalyticsPoint, BreakdownItem } from './analytics';
import { rangeDays } from './analytics';

/**
 * 期間合計・Bot 合算・前期間比較・KPI 計算（028-analytics-dashboard-redesign 設計 §7.2 / §7.3.4 / §7.3.5）。
 *
 * **Domain 層の純関数。** `AnalyticsPoint` / `BreakdownItem` を受け取って数を返すだけで、
 * DB も HTTP も知らない。画面（ダッシュボード・アナリティクス）が同じ規則で数を出すために
 * ここへ寄せる。
 *
 * 集計そのものはロールアップ（`application/analytics/rollup.ts`）が済ませている。
 * ここが持つのは「返ってきた点をどう畳むか」だけ。
 */

/** 負号。ハイフンではなく U+2212 を使う（数字と並べたときに幅が揃う）。 */
const MINUS_SIGN = '−';
/** 分母 0 など、比を出せないときの表示。 */
export const NO_VALUE = '—';
/** 表示の区切り。 */
const MIDDLE_DOT = '·';

/** `key = ''` の合計に使う指標。これ以外は知らない指標として無視する。 */
interface KeylessTotals {
  pageviews: number;
  visitors: number;
  sessions: number;
  bounces: number;
  dwell_ms: number;
  dwell_samples: number;
  bot_pageviews: number;
  bot_visitors: number;
}

function emptyTotals(): KeylessTotals {
  return {
    pageviews: 0,
    visitors: 0,
    sessions: 0,
    bounces: 0,
    dwell_ms: 0,
    dwell_samples: 0,
    bot_pageviews: 0,
    bot_visitors: 0,
  };
}

function isKeylessMetric(metric: string, totals: KeylessTotals): metric is keyof KeylessTotals {
  return Object.hasOwn(totals, metric);
}

/**
 * `key === ''` の点だけを、日と出所をまたいで足す。
 *
 * **key 付きの点（パス別など）は混ぜない。** 同じ指標名でも意味の違う数になる。
 * 出所はまたいで足す（Plugin が同名の指標を取り込んだ値も表示に入る。現行どおり）。
 */
function addKeyless(totals: KeylessTotals, point: AnalyticsPoint): void {
  if (point.key !== '') {
    return;
  }
  if (isKeylessMetric(point.metric, totals)) {
    totals[point.metric] += point.value;
  }
}

function sumKeyless(points: readonly AnalyticsPoint[]): KeylessTotals {
  const totals = emptyTotals();
  for (const point of points) {
    addKeyless(totals, point);
  }
  return totals;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface SummaryOptions {
  /** 「Bot を集計に含める」。Bot は「1 アクセス = 1 セッション = 直帰」として数える。 */
  readonly includeBots: boolean;
}

export interface Summary {
  /** オフ: `pageviews` / オン: `pageviews + bot_pageviews`。 */
  readonly pageviews: number;
  /** オフ: `visitors` / オン: `visitors + bot_visitors`。 */
  readonly visitors: number;
  /** オフ: `sessions` / オン: `sessions + bot_pageviews`。 */
  readonly sessions: number;
  /** オフ: `bounces` / オン: `bounces + bot_pageviews`。 */
  readonly bounces: number;
  /** `bounces / sessions`（0〜1）。分母 0 は null。 */
  readonly bounceRate: number | null;
  /** `dwell_ms / dwell_samples`（ms）。分母 0 は null。Bot は標本に入らない。 */
  readonly dwellAvg: number | null;
  /** `pageviews / visitors`。分母 0 は null。 */
  readonly perVisitor: number | null;
}

function toSummary(totals: KeylessTotals, options: SummaryOptions): Summary {
  const bots = options.includeBots ? totals.bot_pageviews : 0;
  const pageviews = totals.pageviews + bots;
  const visitors = totals.visitors + (options.includeBots ? totals.bot_visitors : 0);
  const sessions = totals.sessions + bots;
  const bounces = totals.bounces + bots;

  return {
    pageviews,
    visitors,
    sessions,
    bounces,
    bounceRate: ratio(bounces, sessions),
    dwellAvg: ratio(totals.dwell_ms, totals.dwell_samples),
    perVisitor: ratio(pageviews, visitors),
  };
}

/** 期間全体の合計（§7.3.4 の表）。 */
export function summarize(points: readonly AnalyticsPoint[], options: SummaryOptions): Summary {
  return toSummary(sumKeyless(points), options);
}

export interface DailySummary extends Summary {
  /** `YYYY-MM-DD`。 */
  readonly date: string;
}

/**
 * 日ごとの合計（日次の推移）。日付昇順。
 *
 * 点が無い日は出ない。画面で日付の欠けを埋めたければ、期間から作った日付列で引く。
 */
export function summarizeDaily(
  points: readonly AnalyticsPoint[],
  options: SummaryOptions,
): readonly DailySummary[] {
  const byDate = new Map<string, KeylessTotals>();
  for (const point of points) {
    let totals = byDate.get(point.metricDate);
    if (totals === undefined) {
      totals = emptyTotals();
      byDate.set(point.metricDate, totals);
    }
    addKeyless(totals, point);
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, totals]) => ({ date, ...toSummary(totals, options) }));
}

/** サイトごとの合計（ダッシュボードのサイト別行、キャンペーンの対象サイト PV）。 */
export function summarizeBySite(
  points: readonly AnalyticsPoint[],
  options: SummaryOptions,
): ReadonlyMap<string, Summary> {
  const bySite = new Map<string, KeylessTotals>();
  for (const point of points) {
    let totals = bySite.get(point.siteId);
    if (totals === undefined) {
      totals = emptyTotals();
      bySite.set(point.siteId, totals);
    }
    addKeyless(totals, point);
  }

  return new Map(
    [...bySite.entries()].map(([siteId, totals]) => [siteId, toSummary(totals, options)]),
  );
}

export type DeltaTone = 'success' | 'danger' | 'muted';

export interface Delta {
  readonly text: string;
  readonly tone: DeltaTone;
}

function signed(value: number, digits: number, unit: string): string {
  const sign = value >= 0 ? '+' : MINUS_SIGN;
  return `${sign}${Math.abs(value).toFixed(digits)}${unit}`;
}

function toneOf(direction: number, threshold: number, lowerIsBetter: boolean): DeltaTone {
  if (Math.abs(direction) < threshold) {
    return 'muted';
  }
  const improved = lowerIsBetter ? direction < 0 : direction > 0;
  return improved ? 'success' : 'danger';
}

/**
 * 前期間比（件数・平均など）。
 *
 * * `prev === 0` → `—` muted（比を出せない）
 * * `d = (cur − prev) / prev`。`|d| < 0.0005` は muted
 * * 既定は「上がると良い」。直帰率のように「下がると良い」指標は `lowerIsBetter`
 */
export function delta(cur: number, prev: number, lowerIsBetter = false): Delta {
  if (prev === 0) {
    return { text: NO_VALUE, tone: 'muted' };
  }
  const d = (cur - prev) / prev;
  return { text: signed(d * 100, 1, '%'), tone: toneOf(d, 0.0005, lowerIsBetter) };
}

/**
 * 率の前期間比（ポイント差）。`cur` / `prev` は 0〜1。
 *
 * どちらかが null（分母 0）なら `—` muted。`|d| < 0.05pt` は muted。
 * 既定は「下がると良い」（直帰率）。
 */
export function deltaPt(cur: number | null, prev: number | null, lowerIsBetter = true): Delta {
  if (cur === null || prev === null) {
    return { text: NO_VALUE, tone: 'muted' };
  }
  const d = (cur - prev) * 100;
  return { text: signed(d, 1, 'pt'), tone: toneOf(d, 0.05, lowerIsBetter) };
}

export interface BotShare {
  /** `bot_pageviews`。 */
  readonly botPageviews: number;
  /** `pageviews`（人）。 */
  readonly humanPageviews: number;
  /** `bot_pageviews / (pageviews + bot_pageviews)`。分母 0 は null。 */
  readonly share: number | null;
  /** 日次 `bot_pageviews` が最大の日（同数なら早い日）。Bot が無ければ null。 */
  readonly peakDay: string | null;
}

/**
 * 「Bot のアクセス」（訪問者タブ）。
 *
 * **「Bot を集計に含める」スイッチに左右されない。** 人の PV に Bot を足さない。
 */
export function botShare(points: readonly AnalyticsPoint[]): BotShare {
  const totals = sumKeyless(points);

  const botByDate = new Map<string, number>();
  for (const point of points) {
    if (point.key !== '' || point.metric !== 'bot_pageviews') {
      continue;
    }
    botByDate.set(point.metricDate, (botByDate.get(point.metricDate) ?? 0) + point.value);
  }

  let peakDay: string | null = null;
  let peak = 0;
  for (const [date, value] of [...botByDate.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    // 同数なら早い日を残すため、超えたときだけ入れ替える。
    if (value > peak) {
      peak = value;
      peakDay = date;
    }
  }

  return {
    botPageviews: totals.bot_pageviews,
    humanPageviews: totals.pageviews,
    share: ratio(totals.bot_pageviews, totals.pageviews + totals.bot_pageviews),
    peakDay,
  };
}

export interface CampaignProgress {
  /** `(today − startsOn + 1) / (endsOn − startsOn + 1) × 100`。100 で頭打ち。`endsOn` 無しは null。 */
  readonly percent: number | null;
  /** 「経過 / 総日数 日 · 残り N 日」。`endsOn` 無しは「N 日目 · 終了日未定」。 */
  readonly text: string;
}

/**
 * キャンペーンの進行（ダッシュボード「実施中のキャンペーン」）。
 *
 * 初日を 1 日目と数える。残りは `endsOn − today` 日（最終日は残り 0、過ぎても負にしない）。
 */
export function campaignProgress(
  startsOn: string,
  endsOn: string | null,
  today: string,
): CampaignProgress {
  const elapsed = Math.max(0, rangeDays(startsOn, today));

  if (endsOn === null) {
    return { percent: null, text: `${elapsed} 日目 ${MIDDLE_DOT} 終了日未定` };
  }

  const total = rangeDays(startsOn, endsOn);
  const remain = Math.max(0, rangeDays(today, endsOn) - 1);
  const percent = Math.min(100, Math.max(0, (elapsed / total) * 100));
  return { percent, text: `${elapsed} / ${total} 日 ${MIDDLE_DOT} 残り ${remain} 日` };
}

/** デバイスの内訳の 1 行。 */
export interface DeviceRow {
  readonly key: 'desktop' | 'mobile' | 'tablet' | 'bot';
  readonly value: number;
  /** 全体に占める割合（0〜1）。全体 0 は null。 */
  readonly share: number | null;
}

const DEVICE_KEYS = ['desktop', 'mobile', 'tablet'] as const;

/**
 * デバイス別の行（§7.3.4）。
 *
 * 3 行は常に出す（無いデバイスは 0）。「Bot を含める」なら「Bot」行を足し、割合の分母も Bot 込みにする。
 */
export function deviceRows(
  devices: readonly BreakdownItem[],
  options: SummaryOptions & { readonly botPageviews: number },
): readonly DeviceRow[] {
  const values = new Map(devices.map((item) => [item.key, item.value]));
  const rows: { key: DeviceRow['key']; value: number }[] = DEVICE_KEYS.map((key) => ({
    key,
    value: values.get(key) ?? 0,
  }));
  if (options.includeBots) {
    rows.push({ key: 'bot', value: options.botPageviews });
  }

  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return rows.map((row) => ({ ...row, share: ratio(row.value, total) }));
}

/**
 * 点の集合から内訳（key ごとの合計）を作る（030-analytics-today 設計 §12.2）。
 *
 * 当日タブは確定値（`analytics`）を読まず、生ログから作った点だけを見る（§13-3）ので、
 * 内訳も同じ点から組む必要がある。
 *
 * * 指定した `metric` の点を `key` ごとに合算する（`key === ''` は含めない。
 *   そちらは期間合計であって内訳の 1 行ではない）
 * * 並び順は **`value` 降順、同値なら `key` 昇順**。Repository の `sumByKey`
 *   （`ORDER BY sum(value) DESC, key ASC`）と一致させる。
 *   当日と確定期間で行の順番が変わらないようにするため
 * * 出所（`source`）はまたいで合算する（現行の内訳と同じ規則）
 * * 値が 0 の key も落とさない。落とすと確定期間と当日で行の数が変わる
 */
export function breakdownFromPoints(
  points: readonly AnalyticsPoint[],
  metric: string,
): readonly BreakdownItem[] {
  const byKey = new Map<string, number>();
  for (const point of points) {
    if (point.metric !== metric || point.key === '') {
      continue;
    }
    byKey.set(point.key, (byKey.get(point.key) ?? 0) + point.value);
  }

  return [...byKey.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) =>
      a.value === b.value ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : b.value - a.value,
    );
}
