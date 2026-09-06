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
 *
 * **式を変えるなら `chartHoverPoints` も同時に直すこと。** あちらはマーカーを線に重ねるため、
 * ここと同じ `min` / `span` / `step` / 全点同値の 0.5 寄せを複製している（031 設計 §5.5）。
 * 片方だけ直すとマーカーが線から静かにずれる（ずれは 031 §10-B4 が検出する）。
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

/**
 * ホバーで指せる 1 点（031 設計 §5.2）。
 *
 * **割合（パーセント）で持つ。** `<svg>` は `preserveAspectRatio="none"` で
 * `viewBox` を要素の箱へ非等比に引き伸ばすので、実寸はコンテナ幅と `height` で毎回変わる。
 * X と Y はそれぞれ独立に線形写像されるため、`x / 600 * 100` と `y / 160 * 100` が
 * 要素の箱の中での位置に厳密に一致する（余白 `CHART_VIEW_PADDING` も織り込み済み）。
 *
 * 文字列と数値しか持たない。**Server Component から Client Component へ渡せる**（設計 §13.2）。
 */
export interface ChartHoverPoint {
  /** 系列の識別子。1 系列（`points`）の経路では ''。 */
  readonly seriesKey: string;
  /** 凡例に出る系列名。1 系列の経路では ''（出す相手がいない）。 */
  readonly seriesLabel: string;
  /** マーカーの色。1 系列の経路では 'chart-1'（線は --tf-color-primary で、値は同じ）。 */
  readonly tone: ChartTone;
  /** 系列内の添字。 */
  readonly index: number;
  /** X 軸の値。`ChartPoint.label` をそのまま持つ。 */
  readonly label: string;
  /** Y 軸の値。**描かれている値**。 */
  readonly value: number;
  /** SVG 要素の左端を 0、右端を 100 とした位置。 */
  readonly xPercent: number;
  /** SVG 要素の上端を 0、下端を 100 とした位置。 */
  readonly yPercent: number;
}

export interface ChartLayout {
  readonly series: readonly ChartLayoutSeries[];
  /** Y 軸の上限。全系列で共通。 */
  readonly yMax: number;
  readonly yMid: number;
  /** 上から順に max / mid / 0。 */
  readonly yLabels: readonly number[];
  readonly ticks: readonly ChartTick[];
  /**
   * ホバーで指せる点（031 設計 §5.3）。
   *
   * **`series` の座標と同じ `x` / `y` から作る。** 別の関数で座標を作り直すと、
   * 片方だけ直したときにマーカーが線から静かにずれる。
   */
  readonly hover: readonly ChartHoverPoint[];
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

  // **`hover` は `points` 文字列と同じループ・同じ x / y から作る**（031 設計 §5.3）。
  // 別の関数で座標を作り直すと、片方だけ直したときにマーカーが線から静かにずれる。
  // 丸める前の値から割合にするので、`toFixed(1)` との差は最大 0.05 viewBox 単位。
  const hover: ChartHoverPoint[] = [];

  const laidOut = series.map((item, seriesIndex) => {
    const tone = item.tone ?? (TONES[seriesIndex % TONES.length] as ChartTone);
    return {
      key: item.key,
      label: item.label,
      tone,
      points: item.points
        .map((point, index) => {
          const value = Number.isFinite(point.value) ? point.value : 0;
          const x = PADDING + step * index;
          const y = PADDING + usableHeight - (value / yMax) * usableHeight;

          // **有限性の規約は 2 つの経路で同じ**（031 設計 §5.4.2）。
          // 「`hover` に載せてよいのは xPercent / yPercent がどちらも有限な点だけ」を
          // `chartHoverPoints` と揃える。**ここではいま 1 点も落ちない**
          // （`value` は 0 に潰れ、`niceMax` は必ず正の有限値を返す）。
          // それでも置くのは、`yMax` の式が将来変わったときに片方の経路だけが静かに壊れるのを
          // 止めるため、そして `chartHitTest` が「全要素が有限」だけを前提にできるようにするため。
          if (Number.isFinite(x) && Number.isFinite(y)) {
            hover.push({
              seriesKey: item.key,
              seriesLabel: item.label,
              tone,
              index,
              label: point.label,
              // **描かれている値**（031 設計 §5.4）。線の高さと食い違わせない。
              value,
              xPercent: (x / CHART_VIEW_WIDTH) * 100,
              yPercent: (y / CHART_VIEW_HEIGHT) * 100,
            });
          }

          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' '),
    };
  });

  const ticks = xTickIndexes(count).map((index) => ({
    xPercent: count <= 1 ? 0 : (index / (count - 1)) * 100,
    label: longest?.points[index]?.label ?? '',
  }));

  return { series: laidOut, yMax, yMid, yLabels: [yMax, yMid, 0], ticks, hover };
}

/**
 * 1 系列（`points`）の経路でホバーできる点（031 設計 §5.5）。
 *
 * **`chartLayout` から作ってはならない。** 2 つの経路は Y のスケールが違う
 * （`chartPolyline` の底は `Math.min(...values, 0)`、`chartLayout` は常に 0）。
 * 流用すると 1 系列のときだけマーカーが線から浮く。
 * ここでは `chartPolyline` と**同じ式**で x / y を求め、割合に直す。
 *
 * **`chartPolyline` が非有限な座標を出した点は配列から落とす**（設計 §5.4 / §5.4.1）。
 * 判定の対象は入力値ではなく**出力座標**である。`span` は全点で 1 つだけ求めるので、
 * `NaN` / `-Infinity` が 1 つでもあれば全点が落ち、`+Infinity` ならその点だけが落ちる。
 * 描かれていない点を指せてしまうと、ポップアップだけが「NaN」と言うことになる。
 *
 * 残った要素の `index` は**元の添字**を保つ（落ちた点があると配列の添字とはずれる）。
 */
export function chartHoverPoints(points: readonly ChartPoint[]): readonly ChartHoverPoint[] {
  if (points.length === 0) {
    return [];
  }

  const values = points.map((point) => point.value);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min;

  const usableWidth = CHART_VIEW_WIDTH - PADDING * 2;
  const usableHeight = CHART_VIEW_HEIGHT - PADDING * 2;
  const step = points.length === 1 ? 0 : usableWidth / (points.length - 1);

  const hover: ChartHoverPoint[] = [];
  points.forEach((point, index) => {
    const x = PADDING + step * index;
    const ratio = span === 0 ? 0.5 : (point.value - min) / span;
    const y = PADDING + usableHeight - ratio * usableHeight;

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    hover.push({
      seriesKey: '',
      seriesLabel: '',
      tone: 'chart-1',
      index,
      label: point.label,
      value: point.value,
      xPercent: (x / CHART_VIEW_WIDTH) * 100,
      yPercent: (y / CHART_VIEW_HEIGHT) * 100,
    });
  });

  return hover;
}

/**
 * カーソル位置に**最も近い 1 点**（031 設計 §7.2）。
 *
 * 規則はこの順で決まる。
 *
 * 1. `points` が空、または `xPercent` / `yPercent` が非有限なら `null`
 * 2. **X で列を決める。** `|p.xPercent - xPercent|` が最小の点を選ぶ
 * 3. 同点なら `xPercent` が大きいほう（右＝新しい日）の列を採る
 * 4. その列の中で、`|p.yPercent - yPercent|` が最小の系列を選ぶ
 * 5. 同点なら配列の先に現れるほう（＝ `series` に渡した順＝凡例の並び順）を採る
 *
 * **2 次元距離を採らない。** 割合空間の距離は要素の実寸に依存し、
 * 実寸で補正すると判定結果がコンテナ幅と `height` で変わって純関数でなくなる。
 *
 * **当たり判定の半径を設けない。** 90 日では列の間隔が要素幅の約 1.1% しかなく、
 * 半径を設けると列と列の間に不感帯ができてポップアップが明滅する。
 *
 * **配列の要素をそのまま返す**（新しいオブジェクトを作らない）。
 * 「同じ点か」を参照比較 1 回で判定でき、同じ列の中を動く間は再描画が起きない（設計 §11.3）。
 */
export function chartHitTest(
  points: readonly ChartHoverPoint[],
  xPercent: number,
  yPercent: number,
): ChartHoverPoint | null {
  if (points.length === 0 || !Number.isFinite(xPercent) || !Number.isFinite(yPercent)) {
    return null;
  }

  let best: ChartHoverPoint | null = null;
  let bestDx = Number.POSITIVE_INFINITY;
  let bestDy = Number.POSITIVE_INFINITY;

  for (const point of points) {
    const dx = Math.abs(point.xPercent - xPercent);
    const dy = Math.abs(point.yPercent - yPercent);

    if (best === null || dx < bestDx) {
      best = point;
      bestDx = dx;
      bestDy = dy;
      continue;
    }
    if (dx > bestDx) {
      continue;
    }

    // X が同点。別の列なら右（新しい日）を採り、同じ列なら Y が近いほうを採る。
    if (point.xPercent > best.xPercent) {
      best = point;
      bestDx = dx;
      bestDy = dy;
      continue;
    }
    if (point.xPercent === best.xPercent && dy < bestDy) {
      best = point;
      bestDy = dy;
    }
  }

  return best;
}
