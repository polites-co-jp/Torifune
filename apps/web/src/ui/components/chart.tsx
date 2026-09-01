import type { ReactNode } from 'react';
import {
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  chartPolyline,
  type ChartPoint,
} from './chart-geometry';

/**
 * 折れ線チャート（06_画面設計.md §32）。
 *
 * **ライブラリを入れない**（`CLAUDE.md`「UIライブラリは導入しない」）。
 * 必要なのは折れ線1本であり、そのために数百KBの依存を足す理由が無い。
 * 軸・凡例・目盛りを持つ汎用チャートは作らない。要るときに作る。
 *
 * **SVG だけにしない。** 読み上げも拡大も効かないため、
 * 同じ値を表としても出す（`fallback`）。
 */

export interface ChartProps {
  readonly points: readonly ChartPoint[];
  /** 何のグラフかを読み上げへ伝える。 */
  readonly title: string;
  /** SVG の代わりに読まれる表など。 */
  readonly fallback: ReactNode;
  readonly height?: number;
}

export function Chart({ points, title, fallback, height = 160 }: ChartProps) {
  if (points.length === 0) {
    return <>{fallback}</>;
  }

  return (
    <figure style={{ margin: 0 }}>
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height, display: 'block' }}
      >
        <polyline
          points={chartPolyline(points)}
          fill="none"
          stroke="var(--tf-color-primary)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/*
        SVG は読み上げも拡大も効かない。同じ値を表としても出す。
        「見えている人にだけ伝わる」画面にしない（06_画面設計.md §2）。
      */}
      <figcaption>{fallback}</figcaption>
    </figure>
  );
}
