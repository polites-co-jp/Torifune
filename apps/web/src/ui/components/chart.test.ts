import { describe, expect, it } from 'vitest';
import { chartPolyline, type ChartPoint } from './chart-geometry';

/**
 * Chart の座標計算（06_画面設計.md §32、014-dashboard 設計 §3.1）。
 *
 * 見た目そのものは目で見るしかないが、**壊れ方は検査できる**。
 * NaN の座標、線が消える、といった「静かに壊れる」経路を止める。
 *
 * 描画（代替表・aria-label）は E2E で見る。
 */

function coords(points: readonly ChartPoint[]): string[] {
  const line = chartPolyline(points);
  return line === '' ? [] : line.split(' ');
}

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
