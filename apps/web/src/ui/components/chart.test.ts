import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chart, type ChartSeries } from './chart';
import { chartLayout, chartPolyline, niceMax, type ChartPoint } from './chart-geometry';
// 031-chart-tooltip で足すもの（設計 §5.2 / §5.5 / §7.2）。既存の import 行は変えない。
import {
  CHART_VIEW_HEIGHT,
  CHART_VIEW_WIDTH,
  chartHitTest,
  chartHoverPoints,
  type ChartHoverPoint,
} from './chart-geometry';

/**
 * Chart の座標計算（06_画面設計.md §32、014-dashboard 設計 §3.1）。
 *
 * 見た目そのものは目で見るしかないが、**壊れ方は検査できる**。
 * NaN の座標、線が消える、といった「静かに壊れる」経路を止める。
 *
 * 描画（代替表・aria-label）は E2E で見る。
 *
 * ---
 *
 * 028-analytics-dashboard-redesign 設計 §7.4.1 で複数系列・軸・凡例を足した。
 * 以下を想定する（設計書に細部の無い箇所は最小形）：
 *
 * ```ts
 * // chart-geometry.ts
 * interface ChartSeries { key: string; label: string; points: readonly ChartPoint[]; tone?: 'chart-1' | 'chart-2' }
 * niceMax(v: number): number                 // 最上位桁で切り上げ。v <= 0 → 1
 * chartLayout(series: readonly ChartSeries[]): {
 *   series: { key: string; label: string; tone: ...; points: string }[];   // points は polyline 用 "x,y x,y"
 *   yMax: number;                                                         // = niceMax(全系列の最大値)。Y は 0 起点
 *   yMid: number;
 *   ticks: { xPercent: number; label: string }[];                         // X 軸目盛り
 * }
 * // chart.tsx（`ChartSeries` 型もここから import できる）
 * ChartProps { points?; series?; title; fallback; height?: number | 'sm' | 'md' | 'lg'; yAxis?; xTicks?; legend? }
 * ```
 *
 * 描画の検査は `react-dom/server` の `renderToStaticMarkup` で静的 HTML を見る（実装プラン §2）。
 */

function coords(points: readonly ChartPoint[]): string[] {
  const line = chartPolyline(points);
  return line === '' ? [] : line.split(' ');
}

/** "x,y x,y ..." を数値の組に戻す。 */
function parseCoords(line: string): Array<{ x: number; y: number }> {
  if (line === '') {
    return [];
  }
  return line.split(' ').map((pair) => {
    const [x, y] = pair.split(',');
    return { x: Number(x), y: Number(y) };
  });
}

function series(key: string, values: readonly number[], labels?: readonly string[]): ChartSeries {
  return {
    key,
    label: key,
    points: values.map((value, index) => ({ label: labels?.[index] ?? `${index}`, value })),
  };
}

/** 受け入れ条件 #65：既存の `chartPolyline` のテストは変更しない（出力が変わらないことの担保）。 */
describe('chartPolyline', () => {
  it('点の数だけ座標を作る', () => {
    expect(
      coords([
        { label: 'a', value: 1 },
        { label: 'b', value: 5 },
        { label: 'c', value: 3 },
      ]),
    ).toHaveLength(3);
  });

  /** NaN が混ざると線が消える。壊れたことに気づきにくい。 */
  it.each([
    ['値がすべて0', [0, 0]],
    ['値がすべて同じ', [7, 7]],
    ['点が1つ', [3]],
    ['負の値を含む', [-5, 5]],
    ['大きな値', [1_000_000, 1]],
  ])('座標に NaN を出さない: %s', (_label, values) => {
    const line = chartPolyline(values.map((value, index) => ({ label: `${index}`, value })));
    expect(line).not.toContain('NaN');
    expect(line).not.toContain('Infinity');
  });

  /** 0除算で線が消えないこと。値が同じでも点は並ぶ。 */
  it('値がすべて同じでも点が並ぶ', () => {
    expect(
      coords([
        { label: 'a', value: 7 },
        { label: 'b', value: 7 },
      ]),
    ).toHaveLength(2);
  });

  it('点が無ければ空を返す', () => {
    expect(chartPolyline([])).toBe('');
  });

  it('値が大きいほど上に描く（Y は下向きなので小さくなる）', () => {
    const [low, high] = coords([
      { label: 'a', value: 0 },
      { label: 'b', value: 100 },
    ]);
    const yOf = (point: string | undefined): number => Number(point?.split(',')[1]);

    expect(yOf(high)).toBeLessThan(yOf(low));
  });

  it('点は左から右へ並ぶ', () => {
    const points = coords([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
      { label: 'c', value: 3 },
    ]);
    const xs = points.map((point) => Number(point.split(',')[0]));

    expect(xs[0]).toBeLessThan(xs[1] as number);
    expect(xs[1]).toBeLessThan(xs[2] as number);
  });
});

describe('niceMax', () => {
  /** 受け入れ条件 #63：Y 上限は最上位桁で切り上げる。 */
  it.each([
    [1234, 2000],
    [15, 20],
    [7, 7],
    [1000, 1000],
    [1001, 2000],
  ])('%d → %d（最上位桁で切り上げ）', (value, expected) => {
    expect(niceMax(value)).toBe(expected);
  });

  it.each([
    ['0', 0],
    ['負の値', -5],
    ['NaN', Number.NaN],
  ])('%s は 1 にする（0 除算と NaN を作らない）', (_label, value) => {
    expect(niceMax(value)).toBe(1);
  });
});

describe('chartLayout', () => {
  /** 受け入れ条件 #63：壊れやすい入力で NaN を出さない。 */
  it('空配列でも NaN や例外を出さない', () => {
    const layout = chartLayout([]);
    expect(layout.series).toEqual([]);
    expect(layout.ticks).toEqual([]);
    expect(Number.isFinite(layout.yMax)).toBe(true);
    expect(Number.isFinite(layout.yMid)).toBe(true);
  });

  it('点の無い系列でも NaN を出さない', () => {
    const layout = chartLayout([series('a', [])]);
    expect(layout.series[0]?.points ?? '').not.toContain('NaN');
    expect(Number.isFinite(layout.yMax)).toBe(true);
  });

  it('1 点だけでも座標が 1 つ出て NaN を含まない', () => {
    const layout = chartLayout([series('a', [3])]);
    const line = layout.series[0]?.points ?? '';
    expect(line).not.toContain('NaN');
    expect(line).not.toContain('Infinity');
    expect(parseCoords(line)).toHaveLength(1);
    expect(layout.ticks.every((tick) => Number.isFinite(tick.xPercent))).toBe(true);
  });

  it('全点が同じ値でも NaN を出さず、点の数だけ座標が並ぶ', () => {
    const layout = chartLayout([series('a', [7, 7, 7])]);
    const line = layout.series[0]?.points ?? '';
    expect(line).not.toContain('NaN');
    expect(parseCoords(line)).toHaveLength(3);
  });

  it('全点が 0 でも NaN を出さず、Y 上限は 1 になる', () => {
    const layout = chartLayout([series('a', [0, 0])]);
    expect(layout.series[0]?.points ?? '').not.toContain('NaN');
    expect(layout.yMax).toBe(1);
  });

  it('Y 上限は全系列の最大値を niceMax したもの（1234 → 2000）', () => {
    const layout = chartLayout([series('a', [5, 1234, 40]), series('b', [900, 2, 0])]);
    expect(layout.yMax).toBe(2000);
    expect(layout.yMid).toBe(1000);
  });

  it('Y は 0 起点で、値 0 の点が最下、値 = yMax の点が最上に来る', () => {
    // `series` のときは `chartPolyline` と違い、最小値ではなく 0 を底にする（設計 §7.4.1）。
    const layout = chartLayout([series('a', [0, 20, 10])]);
    const [zero, top, mid] = parseCoords(layout.series[0]?.points ?? '');
    expect(layout.yMax).toBe(20);
    // SVG の Y は下向き：底ほど大きい。
    expect(zero?.y).toBeGreaterThan(mid?.y as number);
    expect(mid?.y).toBeGreaterThan(top?.y as number);
  });

  it('全系列が同じスケールを使う（同じ値は同じ高さに描かれる）', () => {
    // 系列ごとに最大値で正規化すると、訪問者の線がページビューの線と同じ高さに
    // 見えてしまう。値 50 は系列 a でも b でも同じ Y でなければならない。
    const layout = chartLayout([series('a', [0, 1234, 50]), series('b', [50, 0, 0])]);
    const a = parseCoords(layout.series[0]?.points ?? '');
    const b = parseCoords(layout.series[1]?.points ?? '');
    expect(a[2]?.y).toBeCloseTo(b[0]?.y as number, 5);
    expect(a[0]?.y).toBeCloseTo(b[1]?.y as number, 5);
  });

  it('系列の key と label を持ち回る', () => {
    const layout = chartLayout([series('pageviews', [1]), series('visitors', [1])]);
    expect(layout.series.map((item) => item.key)).toEqual(['pageviews', 'visitors']);
    expect(layout.series.map((item) => item.label)).toEqual(['pageviews', 'visitors']);
  });

  /** 受け入れ条件 #64：X 軸目盛りの間隔は点数で決まり、最後の点を必ず含む。 */
  describe('X 軸目盛り', () => {
    const labelsOf = (n: number): string[] =>
      Array.from({ length: n }, (_, index) => `d${String(index).padStart(3, '0')}`);

    it.each([
      [1, 1],
      [8, 1],
      [9, 2],
      [16, 2],
      [17, 3],
      [35, 3],
      [36, 7],
      [70, 7],
      [71, 14],
      [100, 14],
    ])('点数 %d では %d 点おきに目盛りを置き、末尾から遡る', (n, step) => {
      const labels = labelsOf(n);
      const layout = chartLayout([
        series(
          'a',
          labels.map((_, index) => index),
          labels,
        ),
      ]);

      // 末尾の点から step ずつ遡った点が目盛りになる。
      const expected = new Set<string>();
      for (let index = n - 1; index >= 0; index -= step) {
        expected.add(labels[index] as string);
      }
      expect(new Set(layout.ticks.map((tick) => tick.label))).toEqual(expected);
    });

    it.each([1, 2, 8, 9, 30, 31, 90, 400])('点数 %d でも最後の点を含む', (n) => {
      const labels = labelsOf(n);
      const layout = chartLayout([
        series(
          'a',
          labels.map(() => 1),
          labels,
        ),
      ]);
      expect(layout.ticks.map((tick) => tick.label)).toContain(labels[n - 1]);
    });

    it('目盛りの xPercent は 0〜100 の範囲で、末尾の点が 100 になる', () => {
      const labels = labelsOf(30);
      const layout = chartLayout([
        series(
          'a',
          labels.map(() => 1),
          labels,
        ),
      ]);
      const last = layout.ticks.find((tick) => tick.label === labels[29]);
      expect(last?.xPercent).toBeCloseTo(100, 5);
      for (const tick of layout.ticks) {
        expect(tick.xPercent).toBeGreaterThanOrEqual(0);
        expect(tick.xPercent).toBeLessThanOrEqual(100);
      }
    });

    it('点が無ければ目盛りも無い', () => {
      expect(chartLayout([series('a', [])]).ticks).toEqual([]);
    });
  });
});

describe('Chart の描画', () => {
  const twoSeries: readonly ChartSeries[] = [
    {
      key: 'pageviews',
      label: 'ページビュー',
      points: [
        { label: 'd1', value: 10 },
        { label: 'd2', value: 40 },
        { label: 'd3', value: 25 },
      ],
      tone: 'chart-1',
    },
    {
      key: 'visitors',
      label: '訪問者',
      points: [
        { label: 'd1', value: 5 },
        { label: 'd2', value: 12 },
        { label: 'd3', value: 8 },
      ],
      tone: 'chart-2',
    },
  ];

  function render(props: Parameters<typeof Chart>[0]): string {
    return renderToStaticMarkup(createElement(Chart, props));
  }

  function polylinePoints(html: string): string[] {
    return [...html.matchAll(/<polyline\b[^>]*\bpoints="([^"]*)"/g)].map((match) => match[1] ?? '');
  }

  /** タグを落として、文字として見える語だけにする。 */
  function textTokens(html: string): string[] {
    return html
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter((token) => token !== '');
  }

  /** 受け入れ条件 #94：`points` だけの呼び出しは現行と同じ SVG を出す（公開契約）。 */
  it('points だけを渡したときの polyline は chartPolyline(points) と同じ', () => {
    const points: readonly ChartPoint[] = [
      { label: 'a', value: 1 },
      { label: 'b', value: 5 },
      { label: 'c', value: 3 },
    ];
    const html = render({ points, title: '推移', fallback: 'FALLBACK' });
    expect(polylinePoints(html)).toEqual([chartPolyline(points)]);
  });

  it('points だけの呼び出しでは height を数値で受け付け続ける', () => {
    const html = render({
      points: [{ label: 'a', value: 1 }],
      title: '推移',
      fallback: 'FALLBACK',
      height: 120,
    });
    expect(html).toContain('<svg');
    expect(html).toContain('FALLBACK');
  });

  it('points だけの呼び出しは role="img" と aria-label を保つ', () => {
    const html = render({ points: [{ label: 'a', value: 1 }], title: '推移', fallback: 'FB' });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="推移"');
  });

  /** 受け入れ条件 #95：複数系列・凡例・軸・目盛り。 */
  it('2 系列を渡すと polyline が 2 本になる', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK' });
    expect(polylinePoints(html)).toHaveLength(2);
  });

  it('2 系列の polyline は chartLayout(series) の座標と一致する', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK' });
    expect(polylinePoints(html)).toEqual(chartLayout(twoSeries).series.map((item) => item.points));
  });

  it('legend で系列名が 2 つ出る', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', legend: true });
    const tokens = textTokens(html);
    expect(tokens).toContain('ページビュー');
    expect(tokens).toContain('訪問者');
  });

  it('legend が false なら系列名は出ない', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', legend: false });
    const tokens = textTokens(html);
    expect(tokens).not.toContain('ページビュー');
    expect(tokens).not.toContain('訪問者');
  });

  it('yAxis で max / mid / 0 の 3 つのラベルが出る', () => {
    // 最大 40 → niceMax は 40、中間は 20。桁区切りの影響を受けない値を選んでいる。
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', yAxis: true });
    const numeric = textTokens(html).filter((token) => /^\d+$/.test(token));
    expect(numeric).toHaveLength(3);
    expect(numeric).toContain('40');
    expect(numeric).toContain('20');
    expect(numeric).toContain('0');
  });

  it('yAxis が false なら軸ラベルは出ない', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', yAxis: false });
    expect(textTokens(html).filter((token) => /^\d+$/.test(token))).toEqual([]);
  });

  it('xTicks で目盛りラベルが出る', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', xTicks: true });
    const tokens = textTokens(html);
    // 3 点なので毎点（#64）。
    expect(tokens).toContain('d1');
    expect(tokens).toContain('d2');
    expect(tokens).toContain('d3');
  });

  it('xTicks が false なら目盛りラベルは出ない', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', xTicks: false });
    expect(textTokens(html)).not.toContain('d1');
  });

  it('fallback は series でも常に描かれる', () => {
    const html = render({
      series: twoSeries,
      title: '推移',
      fallback: 'FALLBACK',
      legend: true,
      yAxis: true,
      xTicks: true,
    });
    expect(html).toContain('FALLBACK');
  });

  it('fallback は系列に点が無くても描かれる', () => {
    const html = render({
      series: [{ key: 'a', label: 'A', points: [] }],
      title: '推移',
      fallback: 'FALLBACK',
    });
    expect(html).toContain('FALLBACK');
  });

  it('fallback は series が空でも描かれる', () => {
    expect(render({ series: [], title: '推移', fallback: 'FALLBACK' })).toContain('FALLBACK');
  });

  it('線の色はトークン --tf-color-chart-1 / --tf-color-chart-2 で指定する', () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK' });
    expect(html).toContain('var(--tf-color-chart-1)');
    expect(html).toContain('var(--tf-color-chart-2)');
  });

  it("height に 'sm' | 'md' | 'lg' を渡すとトークン --tf-size-chart-* を使う", () => {
    const html = render({ series: twoSeries, title: '推移', fallback: 'FALLBACK', height: 'lg' });
    expect(html).toContain('var(--tf-size-chart-lg)');
  });
});

/* ============================================================================
 * 031-chart-tooltip（折れ線グラフのプロット点のポップアップ）
 *
 * 設計 §10 の受け入れ条件 A2〜A6 / B1〜B12 / C1〜C10 / D1〜D6 に 1 対 1 で対応する。
 * D7 / D8（`'use client'` の位置）は実行時には見えないので
 * `static-checks.test.ts` に置いた（実装プラン §8 #1）。
 * E1〜E14（操作）は Playwright（`e2e/analytics.spec.ts` / `e2e/dashboard.spec.ts`）。
 *
 * **上の既存テストは 1 行も書き換えていない**（A1）。ここから下は追加だけである。
 * ========================================================================== */

/** "x,y x,y ..." の index 番目の座標。無ければ null。 */
function coordAt(line: string, index: number): { x: number; y: number } | null {
  const pair = line === '' ? undefined : line.split(' ')[index];
  if (pair === undefined) {
    return null;
  }
  const [x, y] = pair.split(',');
  return { x: Number(x), y: Number(y) };
}

/**
 * 許容差（実装プラン §8 #7）。
 *
 * `polyline` の文字列は `toFixed(1)`（`viewBox` 単位）で丸めるが、
 * `hover` は丸める前の値から作る（設計 §5.3 末尾）。差は最大 0.05 `viewBox` 単位。
 */
const X_TOLERANCE = (0.05 / CHART_VIEW_WIDTH) * 100;
const Y_TOLERANCE = (0.05 / CHART_VIEW_HEIGHT) * 100;

function expectClose(actual: number, expected: number, tolerance: number, message: string): void {
  expect(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`).toBe(
    true,
  );
}

function pointsOf(values: readonly number[], labels?: readonly string[]): readonly ChartPoint[] {
  return values.map((value, index) => ({ label: labels?.[index] ?? `${index}`, value }));
}

/* --------------------------------------------------------------------------
 * A. 既存の描画を壊さない
 * ------------------------------------------------------------------------ */

/**
 * A2。`chartPolyline` の出力を**現行の文字列そのもの**で凍結する。
 *
 * 設計 §5.1：`points` だけを渡したときの `<polyline points>` は 1 文字も変わらない。
 * 期待値は実装プラン §2 の golden 表（現行実装の実測値）。
 */
describe('chartPolyline の出力を凍結する（A2）', () => {
  it.each([
    ['[1, 5, 3]', [1, 5, 3], '8.0,123.2 300.0,8.0 592.0,65.6'],
    ['全点 0', [0, 0], '8.0,80.0 592.0,80.0'],
    ['全点同値', [7, 7], '8.0,8.0 592.0,8.0'],
    ['1 点', [3], '8.0,8.0'],
    ['負を含む', [-5, 5], '8.0,152.0 592.0,8.0'],
    ['大きな値', [1_000_000, 1], '8.0,8.0 592.0,152.0'],
  ] as const)('%s の出力が現行と 1 文字も変わらない', (_label, values, expected) => {
    expect(chartPolyline(pointsOf(values))).toBe(expected);
  });
});

/**
 * A3。`chartLayout` の既存フィールドを凍結する。
 *
 * **戻り値を丸ごと `toEqual` しない。** `hover` の追加で落ちるため、
 * `series` / `yMax` / `yMid` / `yLabels` / `ticks` を**フィールドごとに**見る。
 * 期待値は現行実装の実測値。
 */
describe('chartLayout の既存フィールドを凍結する（A3）', () => {
  it('空配列', () => {
    const layout = chartLayout([]);
    expect(layout.series).toEqual([]);
    expect(layout.yMax).toBe(1);
    expect(layout.yMid).toBe(0.5);
    expect(layout.yLabels).toEqual([1, 0.5, 0]);
    expect(layout.ticks).toEqual([]);
  });

  it('1 系列 1 点', () => {
    const layout = chartLayout([series('a', [3])]);
    expect(layout.series).toEqual([{ key: 'a', label: 'a', tone: 'chart-1', points: '8.0,8.0' }]);
    expect(layout.yMax).toBe(3);
    expect(layout.yMid).toBe(1.5);
    expect(layout.yLabels).toEqual([3, 1.5, 0]);
    expect(layout.ticks).toEqual([{ xPercent: 0, label: '0' }]);
  });

  it('2 系列 3 点', () => {
    const layout = chartLayout([
      series('pv', [10, 40, 25], ['d1', 'd2', 'd3']),
      series('vi', [5, 12, 8], ['d1', 'd2', 'd3']),
    ]);
    expect(layout.series).toEqual([
      { key: 'pv', label: 'pv', tone: 'chart-1', points: '8.0,116.0 300.0,8.0 592.0,62.0' },
      { key: 'vi', label: 'vi', tone: 'chart-2', points: '8.0,134.0 300.0,108.8 592.0,123.2' },
    ]);
    expect(layout.yMax).toBe(40);
    expect(layout.yMid).toBe(20);
    expect(layout.yLabels).toEqual([40, 20, 0]);
    expect(layout.ticks).toEqual([
      { xPercent: 0, label: 'd1' },
      { xPercent: 50, label: 'd2' },
      { xPercent: 100, label: 'd3' },
    ]);
  });

  it('全点 0', () => {
    const layout = chartLayout([series('a', [0, 0])]);
    expect(layout.series).toEqual([
      { key: 'a', label: 'a', tone: 'chart-1', points: '8.0,152.0 592.0,152.0' },
    ]);
    expect(layout.yMax).toBe(1);
    expect(layout.yMid).toBe(0.5);
    expect(layout.yLabels).toEqual([1, 0.5, 0]);
    expect(layout.ticks).toEqual([
      { xPercent: 0, label: '0' },
      { xPercent: 100, label: '1' },
    ]);
  });

  it('点数の違う 2 系列', () => {
    const layout = chartLayout([series('a', [1, 2, 3, 4]), series('b', [5, 6])]);
    expect(layout.series).toEqual([
      {
        key: 'a',
        label: 'a',
        tone: 'chart-1',
        points: '8.0,128.0 202.7,104.0 397.3,80.0 592.0,56.0',
      },
      { key: 'b', label: 'b', tone: 'chart-2', points: '8.0,32.0 202.7,8.0' },
    ]);
    expect(layout.yMax).toBe(6);
    expect(layout.yMid).toBe(3);
    expect(layout.yLabels).toEqual([6, 3, 0]);
    expect(layout.ticks).toEqual([
      { xPercent: 0, label: '0' },
      { xPercent: 33.33333333333333, label: '1' },
      { xPercent: 66.66666666666666, label: '2' },
      { xPercent: 100, label: '3' },
    ]);
  });

  it('NaN を含む系列（非有限は 0 として描く）', () => {
    const layout = chartLayout([series('a', [1, Number.NaN, 3])]);
    expect(layout.series).toEqual([
      { key: 'a', label: 'a', tone: 'chart-1', points: '8.0,104.0 300.0,152.0 592.0,8.0' },
    ]);
    expect(layout.yMax).toBe(3);
    expect(layout.yMid).toBe(1.5);
    expect(layout.yLabels).toEqual([3, 1.5, 0]);
    expect(layout.ticks).toEqual([
      { xPercent: 0, label: '0' },
      { xPercent: 50, label: '1' },
      { xPercent: 100, label: '2' },
    ]);
  });
});

/* --------------------------------------------------------------------------
 * B. `chartLayout(...).hover` と `chartHoverPoints`
 * ------------------------------------------------------------------------ */

/** 2 系列 × 3 点。B と D で共有する。 */
const HOVER_TWO_SERIES: readonly ChartSeries[] = [
  {
    key: 'pageviews',
    label: 'ページビュー',
    tone: 'chart-1',
    points: [
      { label: 'd1', value: 10 },
      { label: 'd2', value: 40 },
      { label: 'd3', value: 25 },
    ],
  },
  {
    key: 'visitors',
    label: '訪問者',
    tone: 'chart-2',
    points: [
      { label: 'd1', value: 5 },
      { label: 'd2', value: 12 },
      { label: 'd3', value: 8 },
    ],
  },
];

/** B1・B2・B3・B6・B8・B9・B10・B11。 */
describe('chartLayout の hover', () => {
  /** B1 */
  it('2 系列 × 3 点で hover の長さが 6 になる', () => {
    expect(chartLayout(HOVER_TWO_SERIES).hover).toHaveLength(6);
  });

  /**
   * B2。**マーカーが線からずれない**ことの担保（設計 §5.3）。
   * `hover` の割合が、同じ `chartLayout` が出した `polyline` の座標と一致する。
   */
  it('hover の xPercent / yPercent が series[].points の座標を 600 / 160 で割った値と一致する', () => {
    const layout = chartLayout(HOVER_TWO_SERIES);

    expect(layout.hover.length).toBeGreaterThan(0);
    for (const hover of layout.hover) {
      const line = layout.series.find((item) => item.key === hover.seriesKey)?.points ?? '';
      const coord = coordAt(line, hover.index);

      expect(coord, `${hover.seriesKey}[${hover.index}] の座標が polyline に無い`).not.toBeNull();
      expectClose(
        hover.xPercent,
        ((coord?.x ?? Number.NaN) / CHART_VIEW_WIDTH) * 100,
        X_TOLERANCE,
        `${hover.seriesKey}[${hover.index}] の xPercent`,
      );
      expectClose(
        hover.yPercent,
        ((coord?.y ?? Number.NaN) / CHART_VIEW_HEIGHT) * 100,
        Y_TOLERANCE,
        `${hover.seriesKey}[${hover.index}] の yPercent`,
      );
    }
  });

  /** B3 */
  it('seriesKey / seriesLabel / tone / index / label が渡した内容と一致する', () => {
    const hover = chartLayout(HOVER_TWO_SERIES).hover;

    expect(
      hover.map((point) => ({
        seriesKey: point.seriesKey,
        seriesLabel: point.seriesLabel,
        tone: point.tone,
        index: point.index,
        label: point.label,
        value: point.value,
      })),
    ).toEqual([
      {
        seriesKey: 'pageviews',
        seriesLabel: 'ページビュー',
        tone: 'chart-1',
        index: 0,
        label: 'd1',
        value: 10,
      },
      {
        seriesKey: 'pageviews',
        seriesLabel: 'ページビュー',
        tone: 'chart-1',
        index: 1,
        label: 'd2',
        value: 40,
      },
      {
        seriesKey: 'pageviews',
        seriesLabel: 'ページビュー',
        tone: 'chart-1',
        index: 2,
        label: 'd3',
        value: 25,
      },
      {
        seriesKey: 'visitors',
        seriesLabel: '訪問者',
        tone: 'chart-2',
        index: 0,
        label: 'd1',
        value: 5,
      },
      {
        seriesKey: 'visitors',
        seriesLabel: '訪問者',
        tone: 'chart-2',
        index: 1,
        label: 'd2',
        value: 12,
      },
      {
        seriesKey: 'visitors',
        seriesLabel: '訪問者',
        tone: 'chart-2',
        index: 2,
        label: 'd3',
        value: 8,
      },
    ]);
  });

  /**
   * B6。**描かれている値**を出す（設計 §5.4）。
   * `chartLayout` は非有限を 0 として描くので、`hover.value` も同じ 0 になる。
   */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('値が %s の点でも hover.value は 0（線の高さと食い違わない）', (_label, value) => {
    const hover = chartLayout([series('a', [1, value, 3])]).hover;

    expect(hover).toHaveLength(3);
    expect(hover[1]?.value).toBe(0);
    expect(hover[0]?.value).toBe(1);
    expect(hover[2]?.value).toBe(3);
  });

  /** B8（hover 側）。非有限の入力でも割合に NaN / Infinity を出さない。 */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('値が %s を含んでも xPercent / yPercent は有限', (_label, value) => {
    const hover = chartLayout([series('a', [1, value, 3])]).hover;

    expect(hover.length).toBeGreaterThan(0);
    for (const point of hover) {
      expect(Number.isFinite(point.xPercent), `xPercent=${point.xPercent}`).toBe(true);
      expect(Number.isFinite(point.yPercent), `yPercent=${point.yPercent}`).toBe(true);
    }
  });

  /** B9（前半） */
  it('空配列では hover が空になる', () => {
    expect(chartLayout([]).hover).toEqual([]);
    expect(chartLayout([series('a', [])]).hover).toEqual([]);
  });

  /** B10 */
  it('1 点だけの系列で hover の長さが 1 になり、xPercent が有限', () => {
    const hover = chartLayout([series('a', [3])]).hover;

    expect(hover).toHaveLength(1);
    expect(Number.isFinite(hover[0]?.xPercent ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(hover[0]?.yPercent ?? Number.NaN)).toBe(true);
  });

  /**
   * B11。X は点数の一番多い系列に合わせる（`chartLayout` の既存の規則）。
   * 短い系列の点は、同じ添字の列にそのまま乗る。
   */
  it('点数の違う系列でも、同じ添字の点は同じ xPercent になる', () => {
    const hover = chartLayout([series('a', [1, 2, 3, 4]), series('b', [5, 6])]).hover;
    const xOf = (key: string, index: number): number | undefined =>
      hover.find((point) => point.seriesKey === key && point.index === index)?.xPercent;

    expect(xOf('b', 0)).toBeDefined();
    expect(xOf('b', 1)).toBeDefined();
    expect(xOf('b', 0)).toBe(xOf('a', 0));
    expect(xOf('b', 1)).toBe(xOf('a', 1));
  });
});

/** B4・B5・B7・B8・B9・B12。 */
describe('chartHoverPoints', () => {
  /**
   * B4。**式が二重に存在することを縛る**（設計 §5.5 / §12-1）。
   * `chartHoverPoints` の座標は `chartPolyline` の座標と一致しなければならない。
   *
   * **配列の添字ではなく `ChartHoverPoint.index` で引く。**
   * 非有限の座標になる点は配列から落ちるので（B7）、添字はずれる。
   */
  it.each([
    ['[1, 5, 3]', [1, 5, 3]],
    ['全点 0', [0, 0]],
    ['全点同値', [7, 7]],
    ['1 点', [3]],
    ['負を含む', [-5, 5]],
    ['大きな値', [1_000_000, 1]],
    ['+Infinity を含む', [1, Number.POSITIVE_INFINITY, 3]],
  ] as const)('%s で chartPolyline と同じ座標を出す', (_label, values) => {
    const points = pointsOf(values);
    const line = chartPolyline(points);
    const hover = chartHoverPoints(points);

    expect(hover.length).toBeGreaterThan(0);
    for (const point of hover) {
      const coord = coordAt(line, point.index);

      expect(coord, `index ${point.index} の座標が polyline に無い`).not.toBeNull();
      expectClose(
        point.xPercent,
        ((coord?.x ?? Number.NaN) / CHART_VIEW_WIDTH) * 100,
        X_TOLERANCE,
        `index ${point.index} の xPercent`,
      );
      expectClose(
        point.yPercent,
        ((coord?.y ?? Number.NaN) / CHART_VIEW_HEIGHT) * 100,
        Y_TOLERANCE,
        `index ${point.index} の yPercent`,
      );
    }
  });

  /** B5。1 系列の経路には区別すべき相手がいない（設計 §7.3）。 */
  it('seriesKey と seriesLabel が空文字、tone が chart-1 になる', () => {
    const hover = chartHoverPoints(pointsOf([1, 5, 3], ['a', 'b', 'c']));

    expect(hover).toHaveLength(3);
    for (const point of hover) {
      expect(point.seriesKey).toBe('');
      expect(point.seriesLabel).toBe('');
      expect(point.tone).toBe('chart-1');
    }
    expect(hover.map((point) => point.label)).toEqual(['a', 'b', 'c']);
    expect(hover.map((point) => point.index)).toEqual([0, 1, 2]);
    expect(hover.map((point) => point.value)).toEqual([1, 5, 3]);
  });

  /**
   * B7（前半）。**判定の対象は入力値ではなく出力座標**（設計 §5.4.1）。
   *
   * `chartPolyline` は `span` を全点で 1 つだけ求めるので、
   * `NaN` / `-Infinity` が 1 つでもあると `span` が壊れ、**全点**の y が非有限になる。
   * 描かれていない点は 1 つも指せないので、配列は空になる。
   */
  it.each([
    ['NaN を含む', [1, Number.NaN, 3]],
    ['-Infinity を含む', [1, Number.NEGATIVE_INFINITY, 3]],
  ] as const)('%s と全点の y が非有限になり、配列が空になる', (_label, values) => {
    // 前提（`chartPolyline` の現行の挙動）。ここが変わったら B7 の読み方も変わる。
    expect(chartPolyline(pointsOf(values))).toBe('8.0,NaN 300.0,NaN 592.0,NaN');

    expect(chartHoverPoints(pointsOf(values))).toEqual([]);
  });

  /**
   * B7（後半）。**`+Infinity` はその点だけが落ちる。**
   *
   * `min` は `Math.min(...values, 0)` なので 0 のまま、`span` が `Infinity` になり、
   * 有限の点は `有限 / Infinity = 0` で y = 152.0（底）になる。
   * 落ちるのは `Infinity` の点だけで、**残った要素の `index` は元の添字を保つ**。
   */
  it('+Infinity を含む入力ではその点だけが落ち、index は元の添字を保つ', () => {
    const values = [1, Number.POSITIVE_INFINITY, 3];

    // 前提（`chartPolyline` の現行の挙動）。真ん中だけが NaN。
    expect(chartPolyline(pointsOf(values))).toBe('8.0,152.0 300.0,NaN 592.0,152.0');

    const hover = chartHoverPoints(pointsOf(values));

    expect(hover).toHaveLength(2);
    expect(hover.map((point) => point.index)).toEqual([0, 2]);
    expect(hover.map((point) => point.value)).toEqual([1, 3]);
  });

  /** B8（chartHoverPoints 側）。 */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('値が %s を含んでも、残った点の xPercent / yPercent は有限', (_label, value) => {
    for (const point of chartHoverPoints(pointsOf([1, value, 3]))) {
      expect(Number.isFinite(point.xPercent), `xPercent=${point.xPercent}`).toBe(true);
      expect(Number.isFinite(point.yPercent), `yPercent=${point.yPercent}`).toBe(true);
    }
  });

  /** B9（後半） */
  it('空配列を渡すと空配列を返す', () => {
    expect(chartHoverPoints([])).toEqual([]);
  });

  /**
   * B12。全点が同じ値なら高さも同じ。
   *
   * `min` は 0 との小さいほうなので、**`span === 0`（0.5 寄せ）に入るのは全点 0 のときだけ**。
   * `[7, 7]` は `span = 7` / `ratio = 1` で天井、`[0, 0]` は真ん中になる。
   * **どちらも「すべて等しい」を満たす**ので、両方を入力にして規則を固定する。
   */
  it.each([
    ['全点同値（span が 0 でない）', [7, 7]],
    ['全点 0（span が 0 で 0.5 寄せ）', [0, 0]],
  ] as const)('%s では yPercent がすべて等しい', (_label, values) => {
    const hover = chartHoverPoints(pointsOf(values));

    expect(hover).toHaveLength(values.length);
    expect(new Set(hover.map((point) => point.yPercent)).size).toBe(1);
  });
});

/* --------------------------------------------------------------------------
 * C. `chartHitTest`（当たり判定。設計 §7.2）
 * ------------------------------------------------------------------------ */

describe('chartHitTest', () => {
  function hoverPoint(overrides: Partial<ChartHoverPoint>): ChartHoverPoint {
    return {
      seriesKey: 'a',
      seriesLabel: 'A',
      tone: 'chart-1',
      index: 0,
      label: 'd',
      value: 0,
      xPercent: 0,
      yPercent: 0,
      ...overrides,
    };
  }

  /** 3 点 × 1 系列。列は 0 / 50 / 100。 */
  const threePoints: readonly ChartHoverPoint[] = [
    hoverPoint({ index: 0, label: 'd1', value: 1, xPercent: 0, yPercent: 90 }),
    hoverPoint({ index: 1, label: 'd2', value: 5, xPercent: 50, yPercent: 10 }),
    hoverPoint({ index: 2, label: 'd3', value: 3, xPercent: 100, yPercent: 50 }),
  ];

  /** C1 */
  it('空配列を渡すと null', () => {
    expect(chartHitTest([], 50, 50)).toBeNull();
  });

  /** C2。例外を投げない（要素の実寸が 0 のときなどに NaN が渡っても壊れない）。 */
  it.each([
    ['xPercent が NaN', Number.NaN, 50],
    ['yPercent が NaN', 50, Number.NaN],
    ['yPercent が Infinity', 50, Number.POSITIVE_INFINITY],
    ['xPercent が Infinity', Number.POSITIVE_INFINITY, 50],
    ['yPercent が -Infinity', 50, Number.NEGATIVE_INFINITY],
  ])('%s なら null を返す（例外を投げない）', (_label, xPercent, yPercent) => {
    expect(chartHitTest(threePoints, xPercent, yPercent)).toBeNull();
  });

  /** C3 */
  it('ある点の座標をそのまま渡すと、その点が返る', () => {
    for (const point of threePoints) {
      expect(chartHitTest(threePoints, point.xPercent, point.yPercent)).toBe(point);
    }
  });

  /** C4 */
  it('左端寄りを指すと添字 0、右端寄りを指すと添字 2 が返る', () => {
    expect(chartHitTest(threePoints, 0, 50)?.index).toBe(0);
    expect(chartHitTest(threePoints, 100, 50)?.index).toBe(2);
  });

  /**
   * C5。**同点なら右（新しい日）**（設計 §7.2-3）。
   * 25 は列 0 と列 50 のちょうど中間である。
   */
  it('X が同点なら xPercent が大きいほうの列が返る', () => {
    expect(chartHitTest(threePoints, 25, 50)?.index).toBe(1);
    // 列 50 と列 100 の中間も同じ規則。
    expect(chartHitTest(threePoints, 75, 50)?.index).toBe(2);
  });

  /**
   * C6。**同じ列で Y も同点なら、配列の先に現れるほう**（設計 §7.2-5）。
   * ＝ `series` に渡した順＝凡例の並び順。
   */
  it('同じ列で Y も同点なら、配列の先に現れる系列が返る', () => {
    const first = hoverPoint({ seriesKey: 'pv', index: 0, xPercent: 50, yPercent: 40, value: 9 });
    const second = hoverPoint({ seriesKey: 'vi', index: 0, xPercent: 50, yPercent: 40, value: 9 });

    expect(chartHitTest([first, second], 50, 40)).toBe(first);
    expect(chartHitTest([second, first], 50, 40)).toBe(second);
  });

  /** C7。同じ日の 2 系列。値が大きい系列ほど上（yPercent が小さい）にある。 */
  it('値の違う日で、上を指すと値の大きい系列・下を指すと小さい系列が返る', () => {
    const big = hoverPoint({ seriesKey: 'pv', xPercent: 50, yPercent: 10, value: 100 });
    const small = hoverPoint({ seriesKey: 'vi', xPercent: 50, yPercent: 90, value: 10 });
    const points = [big, small];

    expect(chartHitTest(points, 50, 12)).toBe(big);
    expect(chartHitTest(points, 50, 88)).toBe(small);
  });

  /** C8。**半径を設けない**（設計 §7.2）。膜の内側であれば必ず 1 点が決まる。 */
  it.each([0, 100])('yPercent が %d でも null を返さず、その列の点が返る', (yPercent) => {
    const hit = chartHitTest(threePoints, 50, yPercent);

    expect(hit).not.toBeNull();
    expect(hit?.xPercent).toBe(50);
  });

  /** C9。90 点 × 2 系列で、どの列を指してもその添字の点が返る（全 90 通り）。 */
  it('90 点 × 2 系列で、i 番目の列を指すと添字 i の点が返る', () => {
    const count = 90;
    const upper: ChartHoverPoint[] = [];
    const lower: ChartHoverPoint[] = [];
    for (let index = 0; index < count; index += 1) {
      const xPercent = (index / (count - 1)) * 100;
      upper.push(hoverPoint({ seriesKey: 'pv', index, xPercent, yPercent: 20, value: 100 }));
      lower.push(hoverPoint({ seriesKey: 'vi', index, xPercent, yPercent: 80, value: 10 }));
    }
    const points = [...upper, ...lower];

    for (let index = 0; index < count; index += 1) {
      const xPercent = (index / (count - 1)) * 100;

      const top = chartHitTest(points, xPercent, 20);
      expect(top?.index, `上側 ${index} 番目`).toBe(index);
      expect(top?.seriesKey, `上側 ${index} 番目の系列`).toBe('pv');

      const bottom = chartHitTest(points, xPercent, 80);
      expect(bottom?.index, `下側 ${index} 番目`).toBe(index);
      expect(bottom?.seriesKey, `下側 ${index} 番目の系列`).toBe('vi');
    }
  });

  /**
   * C10。**配列の要素をそのまま返す**（設計 §11.3）。
   *
   * 「同じ点か」を参照比較 1 回で判定できることが、再描画を抑える前提になっている。
   * `toEqual` では作り直していても通ってしまうので `toBe` で見る。
   */
  it('同じ引数を 2 度渡すと同一の参照が返る', () => {
    const first = chartHitTest(threePoints, 30, 40);
    const second = chartHitTest(threePoints, 30, 40);

    expect(first).not.toBeNull();
    expect(first).toBe(second);
    // 配列の中の要素そのものであること（作り直していない）。
    expect(threePoints).toContain(first);
  });
});

/* --------------------------------------------------------------------------
 * D1〜D6. ポップアップの初期描画（`renderToStaticMarkup`）
 *
 * **Vitest は `environment: 'node'` で DOM が無い**（設計 §4 末尾）。
 * `pointermove` を起こして状態遷移を確かめることはできないので、
 * ここで見るのは「操作前の静的 HTML」だけである。操作は E2E（E1〜E14）。
 * ------------------------------------------------------------------------ */

describe('ポップアップの初期描画', () => {
  const singlePoints: readonly ChartPoint[] = [
    { label: 'a', value: 1 },
    { label: 'b', value: 5 },
    { label: 'c', value: 3 },
  ];

  const bothPaths = [
    ['series の経路', { series: HOVER_TWO_SERIES, title: '推移', fallback: 'FALLBACK' }],
    ['points の経路', { points: singlePoints, title: '推移', fallback: 'FALLBACK' }],
  ] as const;

  function render(props: Parameters<typeof Chart>[0]): string {
    return renderToStaticMarkup(createElement(Chart, props));
  }

  function countOf(html: string, needle: string): number {
    return html.split(needle).length - 1;
  }

  /** 属性を持つ開始タグを 1 つ取り出す。無ければ空文字。 */
  function tagWith(html: string, attribute: string): string {
    return new RegExp(`<[a-zA-Z]+[^>]*\\b${attribute}\\b[^>]*>`).exec(html)?.[0] ?? '';
  }

  /** `<svg …>` から最初の `</svg>` まで（SVG は入れ子にならない）。 */
  function svgMarkup(html: string): string {
    const start = html.indexOf('<svg');
    const end = html.indexOf('</svg>');
    return start < 0 || end < 0 ? '' : html.slice(start, end + '</svg>'.length);
  }

  /** D1。操作前は何も出ない（裁定 §3.3。常時のマーカーを描かない）。 */
  it.each(bothPaths)('%s の初期 HTML にポップアップもマーカーも出ていない', (_label, props) => {
    const html = render(props);

    expect(html).not.toContain('data-chart-tooltip');
    expect(html).not.toContain('data-chart-marker');
  });

  /** D2。当たり判定の膜は、どちらの経路でもちょうど 1 つ。 */
  it.each(bothPaths)('%s で膜が 1 つ出る', (_label, props) => {
    expect(countOf(render(props), 'data-chart-hover-area')).toBe(1);
  });

  /** D3。膜・マーカー・ポップアップは装飾。読み上げの経路は表のまま（設計 §7.7）。 */
  it.each(bothPaths)('%s の膜に aria-hidden="true" が付いている', (_label, props) => {
    const tag = tagWith(render(props), 'data-chart-hover-area');

    expect(tag, '膜が見つからない').not.toBe('');
    expect(tag).toContain('aria-hidden="true"');
  });

  /** D4。読み上げの木を変えない。膜は `<svg role="img">` の**兄弟**である。 */
  it.each(bothPaths)('%s で膜が <svg role="img"> の子ではない', (_label, props) => {
    const html = render(props);
    const svg = svgMarkup(html);

    expect(svg, '<svg> が見つからない').not.toBe('');
    expect(svg).toContain('role="img"');
    expect(svg).not.toContain('data-chart-hover-area');
  });

  /** D5。点が 1 つも無ければ、指せる点も無い。膜を出さない。 */
  it.each([
    ['series が空', { series: [], title: '推移', fallback: 'FALLBACK' }],
    [
      '系列に点が無い',
      { series: [{ key: 'a', label: 'A', points: [] }], title: '推移', fallback: 'FALLBACK' },
    ],
    ['points が空', { points: [], title: '推移', fallback: 'FALLBACK' }],
  ] as const)('%s のとき膜が出ない', (_label, props) => {
    const html = render(props);

    expect(html).not.toContain('data-chart-hover-area');
    expect(html).toContain('FALLBACK');
  });

  /**
   * D6。**`fallback` の中身は膜の有無にかかわらず必ず描かれる**（要件 §4 / 設計 §7.7）。
   *
   * チャートが描かれる経路では `<figure>` の中の `<figcaption>` に入る。
   */
  it.each(bothPaths)('%s では fallback が <figcaption> の中に描かれる', (_label, props) => {
    const html = render(props);

    expect(html).toContain('<figure');
    expect(html).toMatch(/<figcaption[^>]*>[\s\S]*FALLBACK[\s\S]*<\/figcaption>/);
  });

  /**
   * D6（続き）。点が 1 つも無いときは `Chart` が `<figure>` を出さず
   * `fallback` だけを返す（**現行の挙動。本設計は変えない**。実装プラン §8 #4）。
   * 値を読む経路が常に `fallback` として存在することは、それでも成り立つ。
   */
  it.each([
    ['series が空', { series: [], title: '推移', fallback: 'FALLBACK' }],
    ['points が空', { points: [], title: '推移', fallback: 'FALLBACK' }],
  ] as const)('%s でも fallback は描かれる（figcaption は出ない）', (_label, props) => {
    const html = render(props);

    expect(html).toContain('FALLBACK');
    expect(html).not.toContain('<figcaption');
  });
});

/* --------------------------------------------------------------------------
 * A4〜A6. 膜を足しても、現行の描画が変わらない
 * ------------------------------------------------------------------------ */

describe('膜を足しても描画が変わらない（A4 / A5 / A6）', () => {
  function render(props: Parameters<typeof Chart>[0]): string {
    return renderToStaticMarkup(createElement(Chart, props));
  }

  function polylinePoints(html: string): string[] {
    return [...html.matchAll(/<polyline\b[^>]*\bpoints="([^"]*)"/g)].map((match) => match[1] ?? '');
  }

  function textTokens(html: string): string[] {
    return html
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter((token) => token !== '');
  }

  /** A4 */
  it('points だけを渡した静的 HTML の role / aria-label / polyline / fallback が現行と同じ', () => {
    const points: readonly ChartPoint[] = [
      { label: 'a', value: 1 },
      { label: 'b', value: 5 },
      { label: 'c', value: 3 },
    ];
    const html = render({ points, title: '推移', fallback: 'FALLBACK' });

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="推移"');
    expect(polylinePoints(html)).toEqual(['8.0,123.2 300.0,8.0 592.0,65.6']);
    expect(html).toContain('FALLBACK');
  });

  /** A5 */
  it('series の polyline が系列数ぶん出て、chartLayout の座標と一致する', () => {
    const html = render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FALLBACK' });

    expect(polylinePoints(html)).toHaveLength(2);
    expect(polylinePoints(html)).toEqual(
      chartLayout(HOVER_TWO_SERIES).series.map((item) => item.points),
    );
  });

  /** A6。`legend` / `yAxis` / `xTicks` の出し分けが現行と同じ。 */
  it('legend の true / false で系列名の出方が変わらない', () => {
    const on = textTokens(
      render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FB', legend: true }),
    );
    const off = textTokens(
      render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FB', legend: false }),
    );

    expect(on).toContain('ページビュー');
    expect(on).toContain('訪問者');
    expect(off).not.toContain('ページビュー');
    expect(off).not.toContain('訪問者');
  });

  it('yAxis の true / false で軸ラベルの出方が変わらない', () => {
    const on = textTokens(
      render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FB', yAxis: true }),
    ).filter((token) => /^\d+$/.test(token));
    const off = textTokens(
      render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FB', yAxis: false }),
    ).filter((token) => /^\d+$/.test(token));

    expect(on).toEqual(['40', '20', '0']);
    expect(off).toEqual([]);
  });

  it('xTicks の true / false で目盛りラベルの出方が変わらない', () => {
    const on = textTokens(
      render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FB', xTicks: true }),
    );
    const off = textTokens(
      render({ series: HOVER_TWO_SERIES, title: '推移', fallback: 'FB', xTicks: false }),
    );

    for (const label of ['d1', 'd2', 'd3']) {
      expect(on).toContain(label);
      expect(off).not.toContain(label);
    }
  });
});

/* ============================================================================
 * F. 検証で見つかった穴を塞ぐ条件（設計 §10-F。2026-09-06 に追加）
 *
 * A1〜E14 の番号と文言は動かさない。ここは**末尾への追加**である。
 * どれも実装の振る舞いを変えない。**いま通ることを固定する**ための条件で、
 * 「実装は正しいが、それを縛るテストが 1 件も無い」経路を埋める。
 * ========================================================================== */

/** `"x,y x,y ..."` のうち、x と y の**どちらも有限**な座標の数。 */
function finiteCoordCount(line: string): number {
  return parseCoords(line).filter((coord) => Number.isFinite(coord.x) && Number.isFinite(coord.y))
    .length;
}

/**
 * F1。**`ChartHoverLayer` 自身の空ガードを通す。**
 *
 * D5 の 3 入力（`series: []` / 点の無い系列 / `points: []`）はいずれも
 * `chart.tsx` の早期 return で `<figure>` ごと出ないため、
 * `ChartHoverLayer` の `points.length === 0 → null` の分岐を**通っていない**。
 *
 * 値が `NaN` の点を 1 つだけ渡すと、`chart.tsx` の早期 return（`points.length === 0`）には
 * 掛からないので `<figure>` と `<polyline>` は描かれる。それでも
 * `chartHoverPoints` は座標が非有限になった点を落として `[]` を返すので、
 * **膜が出ないのは `ChartHoverLayer` 自身のガードのおかげ**である。この入力だけがそこを通す。
 */
describe('ChartHoverLayer 自身の空ガード（F1）', () => {
  const nanPoints: readonly ChartPoint[] = [{ label: 'a', value: Number.NaN }];

  /** 前提。この入力で `chartHoverPoints` は空を返す（D5 の 3 入力とは別の経路）。 */
  it('値が NaN の 1 点では chartHoverPoints が空になる', () => {
    expect(nanPoints).toHaveLength(1);
    expect(chartHoverPoints(nanPoints)).toEqual([]);
  });

  it('値が NaN の 1 点では polyline は出るが、膜もマーカーもポップアップも出ない', () => {
    const html = renderToStaticMarkup(
      createElement(Chart, { points: nanPoints, title: '推移', fallback: 'FALLBACK' }),
    );

    // `chart.tsx` の早期 return には掛からない。図そのものは描かれる。
    expect(html).toContain('<figure');
    expect(html).toMatch(/<polyline\b/);
    // 座標は NaN なので線は見えないが、要素としては出ている（現行の挙動）。
    expect(html).toContain('points="8.0,NaN"');

    // 指せる点が 1 つも無いので膜が出ない（`ChartHoverLayer` の `points.length === 0 → null`）。
    expect(html).not.toContain('data-chart-hover-area');
    expect(html).not.toContain('data-chart-marker');
    expect(html).not.toContain('data-chart-tooltip');

    // 値を読む経路（`fallback`）は変わらず描かれる。
    expect(html).toContain('FALLBACK');
  });
});

/**
 * F2。**`label` に markup を入れても、そのまま HTML に出ない**（XSS の回帰）。
 *
 * `Chart` は `ui/components/index.ts` から Plugin へ公開されており（設計 §9.2）、
 * `ChartPoint.label` / `ChartSeries.label` / `title` には**任意の文字列が入りうる**。
 * 現状の実装は JSX の子・属性として描いており React のエスケープが効くが、
 * **それを縛る条件が 1 件も無い**。`dangerouslySetInnerHTML` / `innerHTML` を使う
 * 実装への変更が、この条件で止まる。
 */
describe('label に markup を入れてもエスケープされる（F2）', () => {
  const XSS = '<script>alert(1)</script>';

  function render(props: Parameters<typeof Chart>[0]): string {
    return renderToStaticMarkup(createElement(Chart, props));
  }

  /** `series` の経路。`legend` と `xTicks` を有効にして、凡例と目盛りに `label` を出す。 */
  it('series の経路（凡例・目盛りに label が出る状態）でエスケープされる', () => {
    const html = render({
      series: [
        {
          key: 'a',
          label: XSS,
          tone: 'chart-1',
          points: [
            { label: XSS, value: 1 },
            { label: `${XSS}2`, value: 2 },
          ],
        },
      ],
      title: '推移',
      fallback: 'FALLBACK',
      legend: true,
      yAxis: true,
      xTicks: true,
    });

    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
    // 空振り防止：凡例（系列名）と目盛り（点のラベル）の両方に出ているはず。
    expect(
      html.split('&lt;script&gt;').length - 1,
      'label が 1 つも描かれていない',
    ).toBeGreaterThanOrEqual(2);
  });

  /**
   * `points` の経路。ここでは点のラベルが静的 HTML に出ない
   * （凡例も目盛りも無く、ラベルはポップアップの中にしか出ない）ので、
   * **属性へ入る `title`** も markup にして、空振りしない形にする。
   */
  it('points の経路（title と label）でエスケープされる', () => {
    const html = render({
      points: [
        { label: XSS, value: 1 },
        { label: 'b', value: 5 },
      ],
      title: XSS,
      fallback: 'FALLBACK',
    });

    expect(html).not.toContain('<script');
    expect(html).not.toContain('</script>');
    // 空振り防止：`aria-label` 属性の中にエスケープされた形で出ている。
    expect(html).toContain('&lt;script&gt;');
    // 描画そのものは成立している。
    expect(html).toMatch(/<polyline\b/);
  });

  /**
   * **純関数はエスケープしない。** エスケープは描画側の責務であり、
   * 純関数がエスケープ済み文字列を返すと**二重エスケープ**になる（設計 §10-F2）。
   */
  it('純関数（chartHoverPoints / chartLayout）は label を素のまま持ち回る', () => {
    expect(chartHoverPoints([{ label: XSS, value: 1 }])[0]?.label).toBe(XSS);

    const hover = chartLayout([
      { key: 'a', label: XSS, tone: 'chart-1', points: [{ label: XSS, value: 1 }] },
    ]).hover;
    expect(hover[0]?.label).toBe(XSS);
    expect(hover[0]?.seriesLabel).toBe(XSS);
  });
});

/**
 * F3。**`hover` の有限性の規約が 2 経路で同じ**（設計 §5.4.2）。
 *
 * > `hover` に載せてよいのは、`xPercent` と `yPercent` がどちらも有限な点だけである。
 *
 * `chartLayout` 側では**いま 1 点も落とさない**（`value` は 0 に潰れ、`niceMax` は必ず正）。
 * 落ちないことも含めて固定する。将来 `yMax` の式が変わったときに、
 * 片方の経路だけが静かに壊れることを止めるための条件である。
 *
 * 「同じ判定が置かれていること」自体は実行時に見えない（いま何も落とさないため）ので、
 * 構造の側は `static-checks.test.ts` で見る。
 */
describe('hover の有限性の規約が 2 経路で同じ（F3）', () => {
  /** 極端な値を含む共通の入力群（設計 §10-F3）。 */
  const inputs = [
    ['全点 0', [0, 0, 0]],
    ['全点同値', [7, 7, 7]],
    ['NaN を含む', [1, Number.NaN, 3]],
    ['+Infinity を含む', [1, Number.POSITIVE_INFINITY, 3]],
    ['-Infinity を含む', [1, Number.NEGATIVE_INFINITY, 3]],
    ['Number.MAX_VALUE を含む', [1, Number.MAX_VALUE, 3]],
  ] as const;

  /** 1 系列の経路。落ちる点があるので、長さは「座標が有限になった点の数」になる。 */
  it.each(inputs)(
    '%s：chartHoverPoints は全要素が有限で、長さが座標の有限な点の数と一致する',
    (_label, values) => {
      const points = pointsOf(values);
      const hover = chartHoverPoints(points);

      for (const point of hover) {
        expect(Number.isFinite(point.xPercent), `xPercent=${point.xPercent}`).toBe(true);
        expect(Number.isFinite(point.yPercent), `yPercent=${point.yPercent}`).toBe(true);
      }
      expect(hover).toHaveLength(finiteCoordCount(chartPolyline(points)));
    },
  );

  /** 複数系列の経路。**同じ規約**が掛かる。 */
  it.each(inputs)(
    '%s：chartLayout の hover も全要素が有限で、長さが座標の有限な点の数と一致する',
    (_label, values) => {
      const layout = chartLayout([series('a', values), series('b', [...values].reverse())]);

      for (const point of layout.hover) {
        expect(Number.isFinite(point.xPercent), `xPercent=${point.xPercent}`).toBe(true);
        expect(Number.isFinite(point.yPercent), `yPercent=${point.yPercent}`).toBe(true);
      }
      const finite = layout.series.reduce(
        (total, item) => total + finiteCoordCount(item.points),
        0,
      );
      expect(layout.hover).toHaveLength(finite);
    },
  );

  /**
   * **`chartLayout` 側はいま 1 点も落とさない。**
   * B1 / B6 / B10 / B11 の結果が変わらないことを、ここでも明示的に固定する。
   */
  it.each(inputs)(
    '%s：chartLayout は 1 点も落とさない（規約は掛かるが該当が無い）',
    (_label, values) => {
      const layout = chartLayout([series('a', values), series('b', [...values].reverse())]);

      expect(layout.hover).toHaveLength(values.length * 2);
    },
  );
});
