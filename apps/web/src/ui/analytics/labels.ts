import type { PeriodPreset } from '@/domain/analytics/day';

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
