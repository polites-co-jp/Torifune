import type { CSSProperties, ReactNode } from 'react';
import {
  CHART_VIEW_HEIGHT,
  CHART_VIEW_PADDING,
  CHART_VIEW_WIDTH,
  chartLayout,
  chartPolyline,
  type ChartPoint,
  type ChartSeries,
  type ChartTone,
} from './chart-geometry';

/**
 * 折れ線チャート（06_画面設計.md §32、028 設計 §7.4.1）。
 *
 * **ライブラリを入れない**（`CLAUDE.md`「UIライブラリは導入しない」）。
 * 折れ線・軸ラベル・目盛り・凡例だけであり、そのために数百KBの依存を足す理由が無い。
 *
 * **SVG だけにしない。** 読み上げも拡大も効かないため、
 * 同じ値を表としても出す（`fallback`）。凡例・軸ラベルは装飾であり、表が唯一の読み上げ経路。
 *
 * `points` だけを渡す従来の呼び出しは、見た目も座標計算も変えない（Plugin から使われる公開契約）。
 */

export type { ChartSeries };

export type ChartHeight = number | 'sm' | 'md' | 'lg';

export interface ChartProps {
  /** 1 系列（従来）。`series` と排他。 */
  readonly points?: readonly ChartPoint[];
  /** 複数系列。全系列が同じ Y スケールを使う。 */
  readonly series?: readonly ChartSeries[];
  /** 何のグラフかを読み上げへ伝える。 */
  readonly title: string;
  /** SVG の代わりに読まれる表など。 */
  readonly fallback: ReactNode;
  readonly height?: ChartHeight;
  /** 左に max / mid / 0 のラベル。 */
  readonly yAxis?: boolean;
  /** 下に目盛りラベル。間隔は点数で決まる。 */
  readonly xTicks?: boolean;
  /** 系列名と線色。 */
  readonly legend?: boolean;
}

const HEIGHT_TOKENS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'var(--tf-size-chart-sm)',
  md: 'var(--tf-size-chart-md)',
  lg: 'var(--tf-size-chart-lg)',
};

const TONE_COLORS: Record<ChartTone, string> = {
  'chart-1': 'var(--tf-color-chart-1)',
  'chart-2': 'var(--tf-color-chart-2)',
};

/** 上下の余白を実寸の割合に直したもの。軸ラベルを線の高さに合わせるため。 */
const PADDING_PERCENT = (CHART_VIEW_PADDING / CHART_VIEW_HEIGHT) * 100;

const AXIS_TEXT: CSSProperties = {
  fontFamily: 'var(--tf-font-mono)',
  fontSize: 'var(--tf-text-label)',
  color: 'var(--tf-color-text-subtle)',
  lineHeight: 1,
  whiteSpace: 'nowrap',
};

function heightOf(height: ChartHeight): number | string {
  return typeof height === 'number' ? height : HEIGHT_TOKENS[height];
}

function formatAxis(value: number): string {
  return value.toLocaleString('ja-JP');
}

export function Chart({
  points,
  series,
  title,
  fallback,
  height = 'md',
  yAxis = false,
  xTicks = false,
  legend = false,
}: ChartProps) {
  if (series === undefined) {
    return (
      <SingleSeriesChart points={points ?? []} title={title} fallback={fallback} height={height} />
    );
  }

  const layout = chartLayout(series);
  if (series.every((item) => item.points.length === 0)) {
    return <>{fallback}</>;
  }

  // 軸ラベルの列幅。一番長い上限の桁数ぶんを等幅で確保する。
  const axisWidth = `${formatAxis(layout.yMax).length}ch`;

  const gridLine = (y: number, stroke: string) => (
    <line
      x1={CHART_VIEW_PADDING}
      x2={CHART_VIEW_WIDTH - CHART_VIEW_PADDING}
      y1={y}
      y2={y}
      stroke={stroke}
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
    />
  );

  return (
    <figure style={{ margin: 0 }}>
      {legend && (
        <ul
          aria-hidden="true"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--tf-space-4)',
            listStyle: 'none',
            margin: '0 0 var(--tf-space-3)',
            padding: 0,
            fontSize: 'var(--tf-text-caption)',
            color: 'var(--tf-color-text-muted)',
          }}
        >
          {layout.series.map((item) => (
            <li
              key={item.key}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--tf-space-2)' }}
            >
              <span
                style={{
                  display: 'inline-block',
                  width: 'var(--tf-space-3)',
                  height: 'var(--tf-border-emphasis)',
                  borderRadius: 'var(--tf-radius-pill)',
                  background: TONE_COLORS[item.tone],
                }}
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: yAxis ? 'auto 1fr' : '1fr',
          columnGap: 'var(--tf-space-2)',
        }}
      >
        {yAxis && (
          <div
            aria-hidden="true"
            style={{ position: 'relative', height: heightOf(height), minWidth: axisWidth }}
          >
            {/* 上限・中間・0 を線の高さに合わせて置く。 */}
            {[
              { value: layout.yMax, top: `${PADDING_PERCENT}%` },
              { value: layout.yMid, top: '50%' },
              { value: 0, top: `${100 - PADDING_PERCENT}%` },
            ].map((label) => (
              <span
                key={label.top}
                style={{
                  ...AXIS_TEXT,
                  position: 'absolute',
                  right: 0,
                  top: label.top,
                  transform: 'translateY(-50%)',
                }}
              >
                {formatAxis(label.value)}
              </span>
            ))}
          </div>
        )}

        <svg
          role="img"
          aria-label={title}
          viewBox={`0 0 ${CHART_VIEW_WIDTH} ${CHART_VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: heightOf(height), display: 'block' }}
        >
          {gridLine(CHART_VIEW_PADDING, 'var(--tf-color-border-weak)')}
          {gridLine(CHART_VIEW_HEIGHT / 2, 'var(--tf-color-border-weak)')}
          {gridLine(CHART_VIEW_HEIGHT - CHART_VIEW_PADDING, 'var(--tf-color-border)')}
          {layout.series.map((item) => (
            <polyline
              key={item.key}
              points={item.points}
              fill="none"
              stroke={TONE_COLORS[item.tone]}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      </div>

      {xTicks && layout.ticks.length > 0 && (
        <div
          aria-hidden="true"
          style={{
            display: 'grid',
            gridTemplateColumns: yAxis ? 'auto 1fr' : '1fr',
            columnGap: 'var(--tf-space-2)',
            marginTop: 'var(--tf-space-2)',
          }}
        >
          {yAxis && <span style={{ minWidth: axisWidth }} />}
          <div style={{ position: 'relative', height: '1em' }}>
            {layout.ticks.map((tick) => (
              <span
                key={`${tick.xPercent}-${tick.label}`}
                style={{
                  ...AXIS_TEXT,
                  position: 'absolute',
                  left: `${tick.xPercent}%`,
                  // 両端のラベルが枠からはみ出さないよう、端では内側へ寄せる。
                  transform:
                    tick.xPercent <= 0
                      ? 'none'
                      : tick.xPercent >= 100
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                }}
              >
                {tick.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {/*
        SVG は読み上げも拡大も効かない。同じ値を表としても出す。
        「見えている人にだけ伝わる」画面にしない（06_画面設計.md §2）。
      */}
      <figcaption>{fallback}</figcaption>
    </figure>
  );
}

/** 従来の 1 系列。座標は `chartPolyline`、線色は `--tf-color-primary` のまま。 */
function SingleSeriesChart({
  points,
  title,
  fallback,
  height,
}: {
  readonly points: readonly ChartPoint[];
  readonly title: string;
  readonly fallback: ReactNode;
  readonly height: ChartHeight;
}) {
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
        style={{ width: '100%', height: heightOf(height), display: 'block' }}
      >
        <polyline
          points={chartPolyline(points)}
          fill="none"
          stroke="var(--tf-color-primary)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <figcaption>{fallback}</figcaption>
    </figure>
  );
}
