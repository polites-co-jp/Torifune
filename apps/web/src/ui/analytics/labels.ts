import type { PeriodPreset } from '@/domain/analytics/day';
import type { ReceptionState } from '@/domain/analytics/reception';
import type { JobName, JobRunStatus } from '@/domain/jobs/job';

/**
 * アナリティクス画面の文言と表示形式（028-analytics-dashboard-redesign 設計 §7.1 / §7.3）。
 *
 * タブ・期間・デバイスの名前と、数値の出し方をここに集める。
 * 画面ごとに書き散らすと、同じ数が場所によって違う形で出る。
 */

export type AnalyticsTab = 'overview' | 'pages' | 'referrers' | 'visitors' | 'settings';

export const ANALYTICS_TABS: readonly AnalyticsTab[] = [
  'overview',
  'pages',
  'referrers',
  'visitors',
  'settings',
];

export function isAnalyticsTab(value: string): value is AnalyticsTab {
  return (ANALYTICS_TABS as readonly string[]).includes(value);
}

export const TAB_LABEL: Record<AnalyticsTab, string> = {
  overview: '概要',
  pages: 'ページ',
  referrers: '参照元',
  visitors: '訪問者',
  settings: '設定',
};

/**
 * 「当日」（030-analytics-today 設計 §7.1.2）。
 *
 * **`PeriodPreset` には入れない。** `PeriodPreset` は
 * 「`presetRange(preset, today)` で確定値のある `DateRange` が求まるもの」という契約を持つ。
 * 当日は確定値ではない別経路（生ログ）のデータなので、そこに入れると契約が崩れる。
 */
export const TODAY_PERIOD = 'today' as const;

/**
 * 期間の選び方。プリセットに加えて、`from` / `to` を直接指定する `custom` と、
 * 生ログから出す `today`（当日）。
 */
export type AnalyticsPeriod = PeriodPreset | typeof TODAY_PERIOD | 'custom';

export const ANALYTICS_PERIODS: readonly AnalyticsPeriod[] = [
  '7d',
  '30d',
  '90d',
  'month',
  'prev-month',
  'custom',
];

export const PERIOD_LABEL: Record<AnalyticsPeriod, string> = {
  today: '当日',
  '7d': '7日',
  '30d': '30日',
  '90d': '90日',
  month: '今月',
  'prev-month': '前月',
  custom: 'カスタム',
};

export const DEVICE_LABEL: Record<'desktop' | 'mobile' | 'tablet' | 'bot', string> = {
  desktop: 'デスクトップ',
  mobile: 'モバイル',
  tablet: 'タブレット',
  bot: 'Bot',
};

/** 分母 0 など、比を出せないときの表示。 */
export const NO_VALUE = '—';

/** 表示の区切り。 */
export const MIDDLE_DOT = '·';

/** 期間の「〜」。全角のチルダではなく波ダッシュ（U+301C）。 */
export const RANGE_SEPARATOR = '〜';

/** 数値は `ja-JP` の桁区切り（設計 §7.1）。 */
export function formatCount(value: number): string {
  return value.toLocaleString('ja-JP');
}

/** 小数を含む数（1 日あたり訪問者など）。桁区切りつき、小数は最大 1 桁。 */
export function formatAverage(value: number): string {
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

/** 率（0〜1）は小数 1 桁の `%`（設計 §7.1）。分母 0 は `—`。 */
export function formatRate(value: number | null): string {
  return value === null ? NO_VALUE : `${(value * 100).toFixed(1)}%`;
}

/** 滞在時間（ms）は `m:ss`（設計 §7.1）。標本が無ければ `—`。 */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) {
    return NO_VALUE;
  }
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` → `M/D`。チャートの目盛りに使う。 */
export function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** 期間の表示 `YYYY-MM-DD 〜 YYYY-MM-DD`。 */
export function rangeText(from: string, to: string): string {
  return `${from} ${RANGE_SEPARATOR} ${to}`;
}

/**
 * 受信状況の 4 状態（029-scheduled-jobs 設計 §7.1.2）。
 *
 * 「受信中」と「受信中（集計待ち）」を見分けられる語にする。
 */
export const RECEPTION_STATE_LABEL: Record<ReceptionState, string> = {
  'not-received': '未受信',
  'pending-rollup': '受信中（集計待ち）',
  'bots-only': 'Bot のみ受信',
  receiving: '受信中',
};

/** 定期実行ジョブの表示名（設計 §7.2）。 */
export const JOB_LABEL: Record<JobName, string> = {
  'analytics.rollup': 'アクセス解析の集計',
  'webhook.deliver': 'Webhook 配信',
};

/**
 * 実行結果の表示。
 *
 * `ok` / `error` はそのまま出す（監視・ログと同じ語で照らし合わせられる）。
 */
export const JOB_STATUS_LABEL: Record<JobRunStatus, string> = {
  running: '実行中',
  ok: 'ok',
  error: 'error',
  skipped: 'スキップ',
};

/** 定期実行を止めているときの表示。環境変数の名前ごと出す（画面からは変えられない）。 */
export const SCHEDULER_OFF_TEXT = '無効（TORIFUNE_SCHEDULER=off）';

/** 定期実行が有効なときの表示「有効 · N 分ごと · 次回 YYYY-MM-DD HH:mm」。 */
export function schedulerText(intervalMinutes: number, nextRunAt: string | null): string {
  const parts = [`有効 ${MIDDLE_DOT} ${intervalMinutes} 分ごと`];
  if (nextRunAt !== null) {
    parts.push(`次回 ${nextRunAt}`);
  }
  return parts.join(` ${MIDDLE_DOT} `);
}

/**
 * 未集計の受信の表示（設計 §7.1.2）。0 件なら null（画面は `—` を出す）。
 *
 * 上限で打ち切っているときは「1,000 件以上」。
 * 一度も集計していないときは、全件が未集計であることを添える。
 */
export function pendingText(pending: {
  readonly total: number;
  readonly bots: number;
  readonly capped: boolean;
  readonly since: Date | string | null;
}): string | null {
  if (pending.total === 0) {
    return null;
  }

  const suffix = pending.since === null ? '（集計したことがありません）' : '';
  if (pending.capped) {
    return `${formatCount(pending.total)} 件以上（うち Bot ${formatCount(pending.bots)} 件以上）${suffix}`;
  }
  return `${formatCount(pending.total)} 件（うち Bot ${formatCount(pending.bots)} 件）${suffix}`;
}

/**
 * 「当日」の文言（030-analytics-today 設計 §7.4 / §7.5.1 / §13-2）。
 *
 * 画面ごとに書き散らすと、同じ状態の説明が場所によって食い違う。
 */

/** 当日の直帰率の偏り（§13-2）。補正も除外もしない代わりに、偏りを注記で担保する。 */
export const TODAY_BOUNCE_RATE_NOTE = '進行中のセッションを含むため、確定後より高めに出ます。';

/** 当日の平均滞在の偏り（§13-2）。後段は 028 §7.3.6 の既存の注記と同じ趣旨。 */
export const TODAY_DWELL_AVG_NOTE =
  'セッション最後のページは測れないため、実際より短めに出ます。進行中のセッションを含む当日はその差が大きく出ます。';

/** 当日のバナー（§7.4.2）。確定値ではないこと。 */
export const TODAY_PROVISIONAL_TEXT = 'この画面は確定値ではありません。';

/** 当日のバナー（§7.4.2）。いつ確定するか。 */
export function todayRollupIntervalText(intervalMinutes: number): string {
  return `集計は約 ${intervalMinutes} 分ごとに確定します。`;
}

/** 当日のバナー（§7.4.2 / §13-1）。前期間比の代わりに前日の確定値を並記する。 */
export function previousDayTotalsText(date: string, pageviews: number, visitors: number): string {
  return `前日（${date}）の確定値：ページビュー ${formatCount(pageviews)} ${MIDDLE_DOT} 訪問者 ${formatCount(visitors)}`;
}

/** 当日のバナー（§7.4.2）。今日の生ログが 1 件も無いとき。 */
export function noAccessTodayText(lastReceivedAt: string | null): string {
  return lastReceivedAt === null
    ? '今日のアクセスはまだありません。'
    : `今日のアクセスはまだありません（最終受信 ${lastReceivedAt}）。`;
}

/** 当日のバナー（§9）。Plugin が取り込んだ値は当日には出ない。 */
export const TODAY_CORE_ONLY_NOTE = '当日は Torifune 自身の計測だけを表示します。';

/** 当日の集計を時間内に終えられなかったとき（§11.2）。確定値は別経路で必ず見られる。 */
export const TODAY_UNAVAILABLE_TEXT =
  '当日の集計に時間がかかっています。前日までの確定値をご覧ください。';

/** 今日を含むカスタム期間の注記（§7.4.3）。値が古く見える理由を画面で説明する。 */
export function customIncludesTodayText(lastRollupAt: string | null): string {
  const at = lastRollupAt === null ? '最後の集計' : `最後の集計（${lastRollupAt}）`;
  return `今日を含む期間です。今日の値は${at}までの分です。いまの値は「当日」で見られます。`;
}

/** 「当日」への導線の文言。 */
export const VIEW_TODAY_LABEL = '当日を見る';

/**
 * 確定期間が空で、本日に受信がある状態の案内（§7.5.1）。
 *
 * **「集計待ち」と誤って説明しない。** 次の集計が走っても今日の分は
 * 末尾が昨日の期間には入らないので、「次回の集計のあとに数字が出ます」は嘘になる。
 */
export function staleRangeNoticeText(from: string, to: string): string {
  return `この期間（${rangeText(from, to)}）の確定値はまだありません。アクセスは今日届いています。今日の分は「当日」で見られます。集計は前日までが対象です。`;
}

/** 今日が月の 1 日で「今月」に確定値のある日が 1 日も無いとき（§7.2）。 */
export const EMPTY_PERIOD_TEXT =
  '今月の確定値はまだありません。前日までの集計が 1 日分もありません。';

/**
 * ヘッダ行（§7.4.1）。期間ごとに出し分ける。
 *
 * | 期間 | 出すもの |
 * | --- | --- |
 * | `today` | 「当日 · {日時} 時点の速報値 · 日付の区切りは {tz}」 |
 * | プリセット / 今日を含まない `custom` | 「前期間（…）と比較 · 集計は前日まで · 日付の区切りは {tz}」 |
 * | 今日を含む `custom` | 「前期間（…）と比較 · 日付の区切りは {tz}」 |
 */
export function analyticsHeaderText(input: {
  readonly period: AnalyticsPeriod;
  /** 前期間（`YYYY-MM-DD`）。当日と、期間が空のときは null。 */
  readonly previousFrom: string | null;
  readonly previousTo: string | null;
  /** 当日の集計時刻（`YYYY-MM-DD HH:mm`）。当日以外は null。 */
  readonly generatedAt: string | null;
  /** 当期が今日を含むか（今日を含む `custom` では「集計は前日まで」を出さない）。 */
  readonly rangeIncludesToday: boolean;
  readonly timeZone: string;
}): string {
  const timeZonePart = `日付の区切りは ${input.timeZone}`;

  if (input.period === TODAY_PERIOD) {
    const at = input.generatedAt === null ? '' : `${input.generatedAt} 時点の速報値`;
    return [`当日`, at, timeZonePart].filter((part) => part !== '').join(` ${MIDDLE_DOT} `);
  }

  const parts: string[] = [];
  if (input.previousFrom !== null && input.previousTo !== null) {
    parts.push(`前期間（${rangeText(input.previousFrom, input.previousTo)}）と比較`);
  }
  if (!input.rangeIncludesToday) {
    // 裁定 3.3。「集計は前日まで。本日は『当日』で見る」と分かるようにする。
    parts.push('集計は前日まで');
  }
  parts.push(timeZonePart);
  return parts.join(` ${MIDDLE_DOT} `);
}
