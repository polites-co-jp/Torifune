import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReferrersTab, type ReferrersData } from './referrers-tab';

/**
 * 参照元タブの期間表示（034-analytics-period-scope 設計 §7.3.3、受け入れ条件 F #49）。
 *
 * ```ts
 * function ReferrersTab(props: {
 *   readonly data: ReferrersData;
 *   readonly periodCaption: string;   // 追加。SectionHeader の caption へ渡すだけ
 *   readonly includeBots: boolean;
 *   readonly onPageChange: (page: number) => void;
 * }): JSX.Element
 * ```
 *
 * **`aside` を上書きしない**（設計 §7.3.3）。説明文
 * 「セッションの最初のページビューの参照元ホスト」は右に残る。
 */

const PERIOD_CAPTION = '期間 2026-09-08';

/** `aside` の説明文（現行のまま残ること）。 */
const ASIDE = 'セッションの最初のページビューの参照元ホスト';

const DATA: ReferrersData = {
  rows: [
    { host: '(direct)', sessions: 4, visitors: 3, bounceRate: 0.5, share: 0.8 },
    { host: 'example.com', sessions: 1, visitors: 1, bounceRate: null, share: 0.2 },
  ],
  total: 2,
  page: 1,
  perPage: 50,
};

function render(data: ReferrersData = DATA, periodCaption = PERIOD_CAPTION): string {
  return renderToStaticMarkup(
    createElement(ReferrersTab, {
      data,
      periodCaption,
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

describe('参照元タブの期間（#49）', () => {
  /** #49。`aside`（説明文）が残ったまま期間が出る。 */
  it('aside の説明文が残ったまま期間が出る', () => {
    const text = textOf(render());

    expect(text).toContain(ASIDE);
    expect(text).toContain(PERIOD_CAPTION);
  });

  /** #49。期間は 1 回だけ出る（カードは 1 枚）。 */
  it('期間は 1 回だけ出る', () => {
    expect(textOf(render()).split(PERIOD_CAPTION).length - 1).toBe(1);
  });

  /** #49。行が 0 件でも期間は出る。 */
  it('行が 0 件でも期間が出る', () => {
    const text = textOf(render({ ...DATA, rows: [], total: 0 }));

    expect(text).toContain('この期間のセッションはありません。');
    expect(text).toContain(PERIOD_CAPTION);
    expect(text).toContain(ASIDE);
  });

  /** #49。表の中身は変わらない。 */
  it('表の列と行は変わらない', () => {
    const text = textOf(render());

    for (const column of ['参照元', 'セッション', '訪問者', '直帰率', '割合']) {
      expect(text, column).toContain(column);
    }
    expect(text).toContain('(direct)');
    expect(text).toContain('example.com');
  });

  /** #49。注記も変わらない。 */
  it('注記が変わらない', () => {
    expect(textOf(render())).toContain('参照元はホスト名だけを保存しています');
  });

  /** #49。渡された文字列をそのまま出す（タブの中で組み立て直さない）。 */
  it('渡された文字列をそのまま出す', () => {
    expect(textOf(render(DATA, '期間 当日（2026-09-09）'))).toContain('期間 当日（2026-09-09）');
  });
});
