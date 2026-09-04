import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from './segmented-control';

/**
 * SegmentedControl（028-analytics-dashboard-redesign 設計 §7.4.2、受け入れ条件 #97）。
 *
 * 想定するシグネチャ：
 *
 * ```ts
 * SegmentedControl({
 *   items: { key: string; label: string; href: string }[];
 *   current: string;     // 選択中の key。Tabs と同じく URL で選択を持つ
 *   label: string;       // nav の aria-label
 * })
 * ```
 *
 * 選択中の項目には `aria-current="page"` が付き、他には付かない。
 * `next/link` は `renderToStaticMarkup` でそのまま `<a href>` に描ける
 * （既存 `Tabs` で確認済み）。描けなくなったら `vi.mock('next/link', …)` で差し替える。
 */

const items = [
  { key: '7d', label: '7日', href: '/analytics?period=7d' },
  { key: '30d', label: '30日', href: '/analytics?period=30d' },
  { key: '90d', label: '90日', href: '/analytics?period=90d' },
] as const;

function render(current: string): string {
  return renderToStaticMarkup(
    createElement(SegmentedControl, { items: [...items], current, label: '期間' }),
  );
}

/** `<a …>` 開始タグの一覧。 */
function anchors(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>/g)].map((match) => match[0]);
}

describe('SegmentedControl', () => {
  it('選択中の項目に aria-current="page" が付く', () => {
    const selected = anchors(render('30d')).filter((tag) => tag.includes('aria-current="page"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('href="/analytics?period=30d"');
  });

  it('選択中でない項目には aria-current が付かない', () => {
    const others = anchors(render('30d')).filter((tag) => !tag.includes('period=30d'));
    expect(others).toHaveLength(2);
    for (const tag of others) {
      expect(tag).not.toContain('aria-current');
    }
  });

  it('current を変えると aria-current の付く項目が変わる', () => {
    const selected = anchors(render('90d')).filter((tag) => tag.includes('aria-current="page"'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('href="/analytics?period=90d"');
  });

  it('各項目が href 付きのリンクとして描かれる', () => {
    const html = render('7d');
    for (const item of items) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(item.label);
    }
  });

  it('label が aria-label として付く', () => {
    expect(render('7d')).toContain('aria-label="期間"');
  });
});
