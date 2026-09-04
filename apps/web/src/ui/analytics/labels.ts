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

/** 期間の選び方。プリセットに加えて `from` / `to` を直接指定する `custom`。 */
export type AnalyticsPeriod = PeriodPreset | 'custom';

export const ANALYTICS_PERIODS: readonly AnalyticsPeriod[] = [
  '7d',
  '30d',
  '90d',
  'month',
  'prev-month',
  'custom',
];

export const PERIOD_LABEL: Record<AnalyticsPeriod, string> = {
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
