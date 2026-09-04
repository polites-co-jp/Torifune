import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChart } from './bar-chart';

/**
 * BarChart（028-analytics-dashboard-redesign 設計 §7.4.2、受け入れ条件 #96）。
 *
 * 想定するシグネチャ：
 *
 * ```ts
 * BarChart({
 *   bars: { label: string; value: number }[];
 *   title: string;              // SVG の aria-label
 *   fallback: ReactNode;        // 代替表。常に描く
 *   highlightMax?: boolean;     // true なら値が最大の棒に `data-peak` 属性を付ける
 *   axisLabels?: string[];      // 横軸に出す文字（例：'0' '6' '12' '18'）
 * })
 * ```
 */

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));

/** 13 時が最大になる時間帯別の値。 */
const hourly = HOURS.map((label, hour) => ({ label, value: hour === 13 ? 90 : hour * 2 }));

function render(props: Parameters<typeof BarChart>[0]): string {
  return renderToStaticMarkup(createElement(BarChart, props));
}

function peakCount(html: string): number {
  return (html.match(/\bdata-peak\b/g) ?? []).length;
}

describe('BarChart', () => {
  it('値が最大の棒に data-peak 属性が 1 つだけ付く', () => {
    const html = render({
      bars: hourly,
      title: '時間帯別',
      fallback: 'FALLBACK',
      highlightMax: true,
    });
    expect(peakCount(html)).toBe(1);
  });

  it('highlightMax が false なら data-peak は付かない', () => {
    const html = render({
      bars: hourly,
      title: '時間帯別',
      fallback: 'FALLBACK',
      highlightMax: false,
    });
    expect(peakCount(html)).toBe(0);
  });

  it('fallback（代替表）が描かれる', () => {
    const html = render({
      bars: hourly,
      title: '時間帯別',
      fallback: 'FALLBACK',
      highlightMax: true,
    });
    expect(html).toContain('FALLBACK');
  });

  it('title が aria-label に出る', () => {
    const html = render({ bars: hourly, title: '時間帯別のページビュー', fallback: 'FALLBACK' });
    expect(html).toContain('aria-label="時間帯別のページビュー"');
    expect(html).toContain('role="img"');
  });

  it('axisLabels が横軸の文字として出る', () => {
    const html = render({
      bars: hourly,
      title: '時間帯別',
      fallback: 'FALLBACK',
      axisLabels: ['0時', '6時', '12時', '18時'],
    });
    for (const label of ['0時', '6時', '12時', '18時']) {
      expect(html).toContain(label);
    }
  });

  it('値がすべて 0 でも NaN を出さない', () => {
    const html = render({
      bars: HOURS.map((label) => ({ label, value: 0 })),
      title: '時間帯別',
      fallback: 'FALLBACK',
      highlightMax: true,
    });
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
    expect(html).toContain('FALLBACK');
  });

  it('棒が無くても落ちず、fallback を描く', () => {
    const html = render({ bars: [], title: '時間帯別', fallback: 'FALLBACK', highlightMax: true });
    expect(html).toContain('FALLBACK');
    expect(html).not.toContain('NaN');
  });
});
