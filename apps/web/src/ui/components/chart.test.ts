import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chart, type ChartSeries } from './chart';
import { chartLayout, chartPolyline, niceMax, type ChartPoint } from './chart-geometry';

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
