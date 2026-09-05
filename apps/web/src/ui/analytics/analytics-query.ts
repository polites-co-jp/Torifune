import { isValidRange, MAX_RANGE_DAYS, rangeDays } from '@/domain/analytics/analytics';
import { isPeriodPreset, presetRange, shiftDays, type DateRange } from '@/domain/analytics/day';
import { TODAY_PERIOD, type AnalyticsPeriod, type AnalyticsTab } from './labels';
import type { NotTrackedState } from './not-tracked';

/**
 * アナリティクス画面の状態（028-analytics-dashboard-redesign 設計 §7.3.1、
 * 030-analytics-today 設計 §7.1.1 / §7.5.1）。
 *
 * **状態はすべて URL に持つ。** リロードしても、リンクを共有しても同じ画面になる。
 * 画面側の操作（期間・サイト・Bot・タブ・ページ送り）は、ここから新しい URL を組み立てて
 * `router.push` するだけで、自分では状態を持たない。
 *
 * **ここは I/O を持たない。** URL とクエリの解決・案内の出し分けは純関数に閉じる
 * （`@/application` / `@/infrastructure` を import しない。設計 §7.5.1「追加の問い合わせを増やさない」）。
 */
export interface AnalyticsQuery {
  readonly siteId: string;
  readonly tab: AnalyticsTab;
  readonly period: AnalyticsPeriod;
  /** 実際に集計した期間（`YYYY-MM-DD`）。プリセットならそこから求めた値。 */
  readonly from: string;
  readonly to: string;
  /** 「Bot を集計に含める」。 */
  readonly includeBots: boolean;
  /** ページ / 参照元タブのページ番号（1 以上）。 */
  readonly page: number;
}

/** 期間の既定。`period` が無い・読めないときに使う。 */
export const DEFAULT_PERIOD = '30d';

/**
 * 画面の状態から URL を組み立てる。
 *
 * 既定値（概要タブ・30 日・Bot を含めない・1 ページ目）は書かない。
 * 共有しやすい短い URL にするためで、読む側（`resolvePeriod`）は
 * 無いときに同じ既定を使う。
 *
 * **`today` は `period=today` だけを書く。** `from` / `to` を書くと `custom` と
 * 見分けがつかなくなる（当日は生ログ、custom は集計値で、値が違いうる）。
 */
export function analyticsHref(query: AnalyticsQuery): string {
  const params = new URLSearchParams();
  params.set('siteId', query.siteId);

  if (query.tab !== 'overview') {
    params.set('tab', query.tab);
  }

  if (query.period === 'custom') {
    params.set('period', 'custom');
    params.set('from', query.from);
    params.set('to', query.to);
  } else if (query.period !== DEFAULT_PERIOD) {
    params.set('period', query.period);
  }

  if (query.includeBots) {
    params.set('bots', '1');
  }

  if (query.page > 1) {
    params.set('page', String(query.page));
  }

  return `/analytics?${params.toString()}`;
}

function asString(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 暦として実在する `YYYY-MM-DD` か。
 *
 * `isValidRange` は形式しか見ないので、`2026-02-30` のような日付はここで落とす
 * （日付を動かして戻したとき同じ文字列にならない）。
 */
export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && shiftDays(value, 0) === value;
}

export interface ResolvedPeriod {
  readonly period: AnalyticsPeriod;
  /**
   * 集計する期間。
   *
   * `null` は「このプリセットに、確定値のある期間が存在しない」。
   * **`month` で今日が月の 1 日のときだけ**返る（設計 §7.2）。画面は集計を一切行わず空状態を出す。
   */
  readonly range: DateRange | null;
  /** `custom` の期間が不正で既定に戻したとき true。 */
  readonly warning: boolean;
}

/**
 * URL の `period` / `from` / `to` から期間を決める（028 設計 §7.3.1、030 設計 §7.1.1）。
 *
 * `custom` の不正（読めない・逆転・400 日超）は**画面を落とさず**警告を出して既定へ戻す。
 * API と違って 422 にしない。共有された URL を開いた人が何も見られないのは困る。
 *
 * **前期間を計算しない。** 当日は前期間比を出さない（設計 §13-1）ので、
 * ここが前期間まで抱えると「比べていない」はずの画面へ比較が紛れ込む道ができる。
 */
export function resolvePeriod(
  params: Record<string, string | string[] | undefined>,
  today: string,
): ResolvedPeriod {
  const periodParam = asString(params['period']);
  const from = asString(params['from']);
  const to = asString(params['to']);

  const period: AnalyticsPeriod =
    periodParam === null
      ? from !== null || to !== null
        ? 'custom'
        : DEFAULT_PERIOD
      : periodParam === TODAY_PERIOD
        ? TODAY_PERIOD
        : periodParam === 'custom'
          ? 'custom'
          : isPeriodPreset(periodParam)
            ? periodParam
            : DEFAULT_PERIOD;

  if (period === TODAY_PERIOD) {
    // 当日は今日 1 日。値は集計値ではなく生ログから出す（設計 §7.1.1）。
    return { period, range: { from: today, to: today }, warning: false };
  }

  if (period !== 'custom') {
    return { period, range: presetRange(period, today), warning: false };
  }

  if (
    from !== null &&
    to !== null &&
    isCalendarDate(from) &&
    isCalendarDate(to) &&
    isValidRange(from, to) &&
    rangeDays(from, to) <= MAX_RANGE_DAYS
  ) {
    // **今日を明示的に指定する逃げ道を塞がない**（裁定 3.3）。
    return { period: 'custom', range: { from, to }, warning: false };
  }

  return { period: DEFAULT_PERIOD, range: presetRange(DEFAULT_PERIOD, today), warning: true };
}

/**
 * 内訳の 1 ページを切り出す（設計 §12.3）。
 *
 * 当日は `listAnalyticsBreakdown` を呼ばず、`breakdownFromPoints` の結果を
 * **メモリ上で切る**（§11.3 / §13-3）。その切り出しをここに置く。
 *
 * * `page` は **1 起点**。`total` は**スライス前の全件数**
 *   （`listAnalyticsBreakdown` の `meta.total` と同じ意味。総ページ数がここから出る）
 * * 取り出す範囲は `[(page − 1) × perPage, page × perPage)`
 * * 範囲外のページは `items` が空、`total` はそのまま（画面が「全 N 件」を出し続けられる）
 * * 防御：`page < 1` は 1 として扱う（負のオフセットで末尾から切らない）。
 *   `perPage <= 0` は `items` を空にする（`slice(0, 0)` で全件を返さない）
 *
 * **並べ替えない・元の配列を壊さない。** 並び順は `breakdownFromPoints` が
 * Repository の `sumByKey` と揃えてあり、ここで触ると当日と確定期間で行の順番が変わる。
 *
 * **`domain/` に置かない。** ページ送りは画面の都合（1 ページ 50 件）であって
 * 分析データの意味ではない。合算と並び順（`breakdownFromPoints`）とは層を分ける。
 */
export function pageSlice<T>(
  items: readonly T[],
  page: number,
  perPage: number,
): { readonly items: readonly T[]; readonly total: number } {
  const total = items.length;
  if (perPage <= 0) {
    return { items: [], total };
  }

  const safePage = page < 1 ? 1 : Math.floor(page);
  const offset = (safePage - 1) * perPage;
  return { items: items.slice(offset, offset + perPage), total };
}

/**
 * 確定期間が空で、本日に受信がある状態の案内を出すか（設計 §7.5.1）。
 *
 * 定期ロールアップが走った直後は未集計が 0 件になり `diagnoseReception` は `receiving` を返す。
 * 導線（`not-tracked.tsx`）は出ず、当期（末尾が昨日）には 1 行も無いので
 * **0 が並ぶだけの概要タブ**が出る。計測タグを貼った初日の利用者はちょうどここを踏む。
 *
 * **これは受信状況の診断ではない。** `diagnoseReception` の 4 状態と優先順位は変えない。
 *
 * | # | 条件 | 理由 |
 * | --- | --- | --- |
 * | a | `period !== 'today'` | 当日を見ているのに当日への導線は出さない |
 * | b | 導線が出ていない（`notTracked === null`） | 導線と案内で「当日を見る」を 2 つ並べない |
 * | c | 当期の点が 0 件 | 数字が出ているときに「確定値はまだありません」と書かない |
 * | d | 最終受信が今日 | 昨日以前なら「今日届いています」は嘘になる |
 * | e | 設定タブでない | 設定タブは期間に依存しない |
 * | f | 確定期間が求まる（`range !== null`） | 月の 1 日の `month` では §7.2 の空状態だけを出す（導線が 2 つ並ばない） |
 *
 * **6 条件をすべてここが持つ。** 呼び出し側の分岐に散らさない。散らすと、
 * どれか 1 つを取り違えても画面全体を組み上げるテストでしか気づけない。
 * 条件 f を述語の中に置くので、**呼び出し側の分岐の順序に依らず決まる**
 * （§7.2 を優先するという結論は変わらない）。
 *
 * **同期関数にしておく。** I/O を持てない形にすることで、
 * 判定のために問い合わせが増えないことを構造で保証する（受け入れ条件 #85）。
 */
export function shouldShowStaleRangeNotice(input: {
  readonly period: AnalyticsPeriod;
  readonly notTracked: NotTrackedState | null;
  readonly currentPointCount: number;
  readonly receivedToday: boolean;
  readonly tab: AnalyticsTab;
  /** `resolvePeriod().range !== null`（条件 f）。 */
  readonly hasConfirmedRange: boolean;
}): boolean {
  return (
    input.period !== TODAY_PERIOD &&
    input.notTracked === null &&
    input.currentPointCount === 0 &&
    input.receivedToday &&
    input.tab !== 'settings' &&
    input.hasConfirmedRange
  );
}
