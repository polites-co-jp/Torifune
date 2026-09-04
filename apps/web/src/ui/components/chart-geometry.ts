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

export type ChartTone = 'chart-1' | 'chart-2';

/** 複数系列で描くときの 1 系列（028 設計 §7.4.1）。 */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly points: readonly ChartPoint[];
  readonly tone?: ChartTone;
}

/** 描画領域。`viewBox` の座標系なので、実寸ではない。 */
export const CHART_VIEW_WIDTH = 600;
export const CHART_VIEW_HEIGHT = 160;
/** 線が枠に接しないための内側の余白（`viewBox` 座標）。 */
export const CHART_VIEW_PADDING = 8;
const PADDING = CHART_VIEW_PADDING;

/**
 * 点を `viewBox` の座標へ写す。
 *
 * **値がすべて同じとき（最大＝最小）は真ん中へ引く。**
 * そのまま割ると 0除算になり、線が消えるか NaN が入る。
 *
 * 最小は 0 との小さいほうを取る。正の値だけのとき、
 * 一番小さい日が必ず底に張り付いて「0まで落ちた」ように見えるのを避ける。
 *
 * **1 系列の従来契約。** `series` を使う複数系列とは別の計算で、
 * ここの出力は変えない（Plugin から使われる公開契約）。
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

/**
 * Y 軸の上限。最上位桁で切り上げる（1234 → 2000、15 → 20、7 → 7）。
 *
 * 最大値をそのまま上限にすると、一番高い日が必ず天井に張り付き、
 * 中間のラベルも半端な数になる。
 *
 * **0 以下・NaN・無限大は 1 にする。** 上限 0 で割ると NaN が座標に入り、線が消える。
 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  // 10 の冪を対数で求めると丸め誤差で 1 桁ずれることがある。掛け算で寄せる。
  let magnitude = 1;
  while (magnitude * 10 <= value) {
    magnitude *= 10;
  }
  while (magnitude > value) {
    magnitude /= 10;
  }

  return Math.ceil(value / magnitude - Number.EPSILON) * magnitude;
}

/**
 * X 軸に目盛りを置く点の添字。
 *
 * 間隔は点数で決める（≤8 毎点 / ≤16 2 / ≤35 3 / ≤70 7 / それ以上 14）。
 * **末尾の点から遡って置く。** 先頭から置くと、一番見たい「今日」に目盛りが付かない。
 */
export function xTickIndexes(count: number): number[] {
  if (!Number.isInteger(count) || count <= 0) {
    return [];
  }

  const step = count <= 8 ? 1 : count <= 16 ? 2 : count <= 35 ? 3 : count <= 70 ? 7 : 14;

  const indexes: number[] = [];
  for (let index = count - 1; index >= 0; index -= step) {
    indexes.push(index);
  }
  return indexes.reverse();
}

export interface ChartLayoutSeries {
  readonly key: string;
  readonly label: string;
  readonly tone: ChartTone;
  /** `<polyline points>` に渡す文字列。 */
  readonly points: string;
}

export interface ChartTick {
  /** 描画領域の左端を 0、右端を 100 とした位置。 */
  readonly xPercent: number;
  readonly label: string;
}

export interface ChartLayout {
  readonly series: readonly ChartLayoutSeries[];
  /** Y 軸の上限。全系列で共通。 */
  readonly yMax: number;
  readonly yMid: number;
  /** 上から順に max / mid / 0。 */
  readonly yLabels: readonly number[];
  readonly ticks: readonly ChartTick[];
}

const TONES: readonly ChartTone[] = ['chart-1', 'chart-2'];

/**
 * 複数系列の座標・軸・目盛りをまとめて計算する（028 設計 §7.4.1）。
 *
 * * **Y は 0 起点。** 上限は全系列の最大値を `niceMax` したもので、全系列が同じスケールを使う。
 *   系列ごとに正規化すると、訪問者の線がページビューの線と同じ高さに見えてしまう
 * * X は点数の一番多い系列に合わせる。目盛りのラベルもその系列から取る
 * * 空配列・1 点・全点同値・NaN を通しても NaN を出さない
 */
export function chartLayout(series: readonly ChartSeries[]): ChartLayout {
  const count = Math.max(0, ...series.map((item) => item.points.length));
  const longest = series.find((item) => item.points.length === count);

  const values = series.flatMap((item) =>
    item.points.map((point) => (Number.isFinite(point.value) ? point.value : 0)),
  );
  const yMax = niceMax(Math.max(0, ...values));
  const yMid = yMax / 2;

  const usableWidth = CHART_VIEW_WIDTH - PADDING * 2;
  const usableHeight = CHART_VIEW_HEIGHT - PADDING * 2;
  const step = count <= 1 ? 0 : usableWidth / (count - 1);

  const laidOut = series.map((item, seriesIndex) => ({
    key: item.key,
    label: item.label,
    tone: item.tone ?? (TONES[seriesIndex % TONES.length] as ChartTone),
    points: item.points
      .map((point, index) => {
        const value = Number.isFinite(point.value) ? point.value : 0;
        const x = PADDING + step * index;
        const y = PADDING + usableHeight - (value / yMax) * usableHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' '),
  }));

  const ticks = xTickIndexes(count).map((index) => ({
    xPercent: count <= 1 ? 0 : (index / (count - 1)) * 100,
    label: longest?.points[index]?.label ?? '',
  }));

  return { series: laidOut, yMax, yMid, yLabels: [yMax, yMid, 0], ticks };
}
