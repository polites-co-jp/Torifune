import type { AnalyticsPoint } from '../analytics/analytics';
import { MAX_RANGE_DAYS } from '../analytics/analytics';
import { POST_STATUSES, type PostStatus } from '../social/social';

/**
 * キャンペーン分析の組み立て（06_画面設計.md §14、026-screen-completion 設計 §3.2）。
 *
 * **集計そのものはここでやらない。** 期間内のアクセスは
 * `application/analytics` の `listAnalytics` が、投稿の状態は
 * `application/social` が返す。ここが持つのは
 * 「どの期間を訊くか」と「返ってきたものをどう畳むか」だけ。
 *
 * **Domain 層。** DB 製品も HTTP も知らない。
 * 画面が使う型だが Infrastructure には置かない（レイヤの向きが崩れる）。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` を日数だけ動かす。UTC で計算するのでタイムゾーンでずれない。 */
function shiftDays(dateOnly: string, days: number): string {
  const shifted = new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

export interface AnalysisRange {
  readonly from: string;
  readonly to: string;
  /** 上限に合わせて開始を切り上げたか。切り上げたことは画面に出す。 */
  readonly truncated: boolean;
}

/**
 * 分析する期間を決める。
 *
 * **既定を「直近30日」にしない。** キャンペーンは期間で定義される取り組みなので、
 * 終わったキャンペーンを開いたときに 0 が並ぶだけになる。
 *
 * * 終わりを決めていない／未来なら、今日で止める（未来を訊いても値は無い）
 * * まだ始まっていなければ、開始日だけの期間にする（期間として成立させる）
 * * `listAnalytics` は `MAX_RANGE_DAYS` を超えると 422 を投げる。
 *   **ここで切り上げる。** 長く続くキャンペーンの分析が「理由の分からない
 *   エラー」で開けなくなるのを避ける
 */
export function analysisRange(
  startsOn: string,
  endsOn: string | null,
  today: string,
): AnalysisRange {
  const end = endsOn === null || endsOn > today ? today : endsOn;
  const to = end < startsOn ? startsOn : end;

  const days =
    Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / MS_PER_DAY) +
    1;

  if (days > MAX_RANGE_DAYS) {
    return { from: shiftDays(to, -(MAX_RANGE_DAYS - 1)), to, truncated: true };
  }
  return { from: startsOn, to, truncated: false };
}

export interface SiteTotals {
  readonly pageviews: number;
  readonly visitors: number;
}

/**
 * 日次の点をサイトごとに畳む。
 *
 * **知らない指標は数えない。** `analytics` には Plugin が入れた任意の指標も
 * 混ざる（`018-analytics`）。合計に混ぜると意味の違う数を足すことになる。
 *
 * 使うのは `siteId` / `metric` / `value` だけなので、引数の型もそこに絞る。
 * 呼ぶ側は `key: ''` で絞った点を渡す（パス別などの内訳を合計に混ぜない）。
 */
export function summarizeBySite(
  points: readonly Pick<AnalyticsPoint, 'siteId' | 'metric' | 'value'>[],
): Map<string, SiteTotals> {
  const totals = new Map<string, { pageviews: number; visitors: number }>();

  for (const point of points) {
    if (point.metric !== 'pageviews' && point.metric !== 'visitors') {
      continue;
    }
    const current = totals.get(point.siteId) ?? { pageviews: 0, visitors: 0 };
    current[point.metric] += point.value;
    totals.set(point.siteId, current);
  }

  return totals;
}

/**
 * 投稿を状態ごとに数える。
 *
 * **0件の状態も欄を残す。** 消すと「無い」のか「見えない」のか分からない。
 */
export function countPostsByStatus(
  posts: readonly { readonly status: PostStatus }[],
): Record<PostStatus, number> {
  const counts = Object.fromEntries(POST_STATUSES.map((status) => [status, 0])) as Record<
    PostStatus,
    number
  >;

  for (const post of posts) {
    counts[post.status] += 1;
  }
  return counts;
}
