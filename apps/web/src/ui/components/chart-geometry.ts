/**
 * 折れ線チャートの座標計算（06_画面設計.md §32）。
 *
 * **描画（`chart.tsx`）から分けている。** JSX を含まない純粋な計算なので、
 * ここだけならテストから直接読める。
 * 「静かに壊れる」経路（NaN・0除算・線が消える）はここに集まっている。
 */

export interface ChartPoint {
  /** X軸のラベル。日付など。 */
  readonly label: string;
  readonly value: number;
}

/** 描画領域。`viewBox` の座標系なので、実寸ではない。 */
export const CHART_VIEW_WIDTH = 600;
export const CHART_VIEW_HEIGHT = 160;
const PADDING = 8;

/**
 * 点を `viewBox` の座標へ写す。
 *
 * **値がすべて同じとき（最大＝最小）は真ん中へ引く。**
 * そのまま割ると 0除算になり、線が消えるか NaN が入る。
 *
 * 最小は 0 との小さいほうを取る。正の値だけのとき、
 * 一番小さい日が必ず底に張り付いて「0まで落ちた」ように見えるのを避ける。
 */
export function chartPolyline(points: readonly ChartPoint[]): string {
  if (points.length === 0) {
    return '';
  }

  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min;

  const usableWidth = CHART_VIEW_WIDTH - PADDING * 2;
  const usableHeight = CHART_VIEW_HEIGHT - PADDING * 2;
  const step = points.length === 1 ? 0 : usableWidth / (points.length - 1);

  return points
    .map((point, index) => {
      const x = PADDING + step * index;
      const ratio = span === 0 ? 0.5 : (point.value - min) / span;
      const y = PADDING + usableHeight - ratio * usableHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
