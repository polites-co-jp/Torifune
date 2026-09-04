import type { ReactNode } from 'react';
import { CHART_VIEW_HEIGHT, CHART_VIEW_WIDTH } from './chart-geometry';

/**
 * 棒グラフ（06_画面設計.md §32、028 設計 §7.4.2）。
 *
 * 時間帯別のページビューのように、並びに意味のある少数の値を比べる。
 * `Chart` と同じく**SVG だけにしない**。同じ値を表としても出す（`fallback`）。
 *
 * **最大値が 0 でも NaN を出さない。** 0 で割ると高さが NaN になり、棒が全部消える。
 */

export interface BarChartBar {
  readonly label: string;
  readonly value: number;
}

export interface BarChartProps {
  readonly bars: readonly BarChartBar[];
  /** 何のグラフかを読み上げへ伝える。 */
  readonly title: string;
  /** SVG の代わりに読まれる表など。常に描く。 */
  readonly fallback: ReactNode;
  /** 値が最大の棒を強調する。その棒に `data-peak` が付く。 */
  readonly highlightMax?: boolean;
  /** 横軸に出す文字。左から等間隔に置く（例：'0' '6' '12' '18'）。 */
  readonly axisLabels?: readonly string[];
}

/** 棒と棒の隙間。1 本の幅に対する割合。 */
const GAP_RATIO = 0.35;

function peakIndex(bars: readonly BarChartBar[]): number {
  let index = -1;
  let max = 0;
  bars.forEach((bar, current) => {
    if (Number.isFinite(bar.value) && bar.value > max) {
      max = bar.value;
      index = current;
    }
  });
  return index;
}

export function BarChart({
  bars,
  title,
  fallback,
  highlightMax = false,
  axisLabels,
}: BarChartProps) {
  if (bars.length === 0) {
    return <>{fallback}</>;
  }

  const values = bars.map((bar) => (Number.isFinite(bar.value) ? Math.max(bar.value, 0) : 0));
  const max = Math.max(0, ...values);
  const peak = highlightMax ? peakIndex(bars) : -1;

  const slot = CHART_VIEW_WIDTH / bars.length;
  const barWidth = slot * (1 - GAP_RATIO);

  return (
    <figure style={{ margin: 0 }}>
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: 'var(--tf-size-chart-sm)', display: 'block' }}
      >
        <line
          x1={0}
          x2={CHART_VIEW_WIDTH}
          y1={CHART_VIEW_HEIGHT}
          y2={CHART_VIEW_HEIGHT}
          stroke="var(--tf-color-border)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {bars.map((bar, index) => {
          const height = max === 0 ? 0 : ((values[index] ?? 0) / max) * CHART_VIEW_HEIGHT;
          const isPeak = index === peak;
          return (
            <rect
              key={`${index}-${bar.label}`}
              data-peak={isPeak ? '' : undefined}
              x={(slot * index + (slot - barWidth) / 2).toFixed(1)}
              y={(CHART_VIEW_HEIGHT - height).toFixed(1)}
              width={barWidth.toFixed(1)}
              height={height.toFixed(1)}
              fill={isPeak ? 'var(--tf-color-chart-1)' : 'var(--tf-color-chart-2)'}
            />
          );
        })}
      </svg>

      {axisLabels !== undefined && axisLabels.length > 0 && (
        <div
          aria-hidden="true"
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${axisLabels.length}, 1fr)`,
            marginTop: 'var(--tf-space-1)',
            fontFamily: 'var(--tf-font-mono)',
            fontSize: 'var(--tf-text-label)',
            color: 'var(--tf-color-text-subtle)',
          }}
        >
          {axisLabels.map((label, index) => (
            <span key={`${index}-${label}`}>{label}</span>
          ))}
        </div>
      )}

      {/* SVG は読み上げも拡大も効かない。同じ値を表としても出す。 */}
      <figcaption>{fallback}</figcaption>
    </figure>
  );
}
