import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PagesTab, type PagesData } from './pages-tab';

/**
 * ページタブの期間表示（034-analytics-period-scope 設計 §7.3.3、受け入れ条件 F #48）。
 *
 * ```ts
 * function PagesTab(props: {
 *   readonly data: PagesData;
 *   readonly periodCaption: string;   // 追加。SectionHeader の caption へ渡すだけ
 *   readonly includeBots: boolean;
 *   readonly onPageChange: (page: number) => void;
 * }): JSX.Element
 * ```
 *
 * **`aside` を上書きしない**（設計 §7.3.3）。「N ページ · ページビュー順」は右に残る。
 * **タブは文字列を組み立てない**（§7.3.4）。渡された文字列を並べるだけ。
 *
 * `pages-tab.tsx` は `useRouter` を使わない（`onPageChange` は props）ので、
 * `next/navigation` の差し替えなしで描ける。
 */

const PERIOD_CAPTION = '期間 2026-09-08';

const DATA: PagesData = {
  rows: [
    {
      path: '/',
      pageviews: 10,
      visitors: 5,
      landing: 4,
      bounceRate: 0.25,
      dwellAvg: 2000,
    },
    {
      path: '/pricing',
      pageviews: 3,
      visitors: 2,
      landing: 1,
      bounceRate: null,
      dwellAvg: null,
    },
  ],
  total: 2,
  page: 1,
  perPage: 50,
};

function render(data: PagesData = DATA): string {
  return renderToStaticMarkup(
    createElement(PagesTab, {
      data,
      periodCaption: PERIOD_CAPTION,
      includeBots: false,
      onPageChange: () => undefined,
    }),
  );
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('ページタブの期間（#48）', () => {
  /** #48。`aside`（「N ページ · ページビュー順」）が残ったまま期間が出る。 */
  it('aside が残ったまま期間が出る', () => {
    const text = textOf(render());

    expect(text).toContain('2 ページ · ページビュー順');
    expect(text).toContain(PERIOD_CAPTION);
  });

  /** #48。見出しは「ページ」のまま。 */
  it('見出しは「ページ」のまま', () => {
    expect(textOf(render())).toContain('ページ');
  });

  /** #48。期間は 1 回だけ出る（カードは 1 枚）。 */
  it('期間は 1 回だけ出る', () => {
    expect(textOf(render()).split(PERIOD_CAPTION).length - 1).toBe(1);
  });

  /** #48。行が 0 件でも期間は出る（「どの期間に記録が無いのか」が分かる）。 */
  it('行が 0 件でも期間が出る', () => {
    const text = textOf(render({ ...DATA, rows: [], total: 0 }));

    expect(text).toContain('この期間のページビューはありません。');
    expect(text).toContain(PERIOD_CAPTION);
    expect(text).toContain('0 ページ · ページビュー順');
  });

  /** #48。表の中身は変わらない（期間を足しても列も行も減らない）。 */
  it('表の列と行は変わらない', () => {
    const text = textOf(render());

    for (const column of ['ページビュー', '訪問者', 'ランディング', '直帰率', '平均滞在']) {
      expect(text, column).toContain(column);
    }
    expect(text).toContain('/pricing');
  });

  /** #48。注記も変わらない。 */
  it('注記が変わらない', () => {
    expect(textOf(render())).toContain('セッション最後のページは測れないため');
  });

  /** #48。渡された文字列をそのまま出す（タブの中で組み立て直さない）。 */
  it('渡された文字列をそのまま出す', () => {
    const html = renderToStaticMarkup(
      createElement(PagesTab, {
        data: DATA,
        periodCaption: '期間 当日（2026-09-09）',
        includeBots: false,
        onPageChange: () => undefined,
      }),
    );

    expect(textOf(html)).toContain('期間 当日（2026-09-09）');
  });
});
