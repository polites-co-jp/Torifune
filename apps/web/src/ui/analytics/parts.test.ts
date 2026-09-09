import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeviceBreakdown, HourlyPageviews, SectionHeader } from './parts';

/**
 * カードの見出しの `caption` スロットと、共通部品への期間の受け渡し
 * （034-analytics-period-scope 設計 §7.3.3、受け入れ条件 F #45 / #46 / #51）。
 *
 * ```ts
 * function SectionHeader(props: {
 *   readonly title: string;
 *   readonly caption?: ReactNode;   // 見出しの下に出す小さな補足。期間を出す（§7.3.3）
 *   readonly aside?: ReactNode;     // 見出しの右。導線・件数など（既存）
 * }): JSX.Element
 *
 * function HourlyPageviews(props: { …既存…; readonly periodCaption?: ReactNode }): JSX.Element
 * function DeviceBreakdown(props: { …既存…; readonly periodCaption?: ReactNode }): JSX.Element
 * ```
 *
 * **`aside` を上書きしない**（設計 §7.3.3）。「すべて →」「N ページ · ページビュー順」等は
 * いまのまま右に残る。`caption` が無ければ行を作らない（現行の見た目を保つ）。
 */

const PERIOD = '期間 2026-09-08';
const ASIDE = 'すべて →';

/** 10 時台に 10 PV。空状態ではなく値のある区画として描かせる。 */
const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 10 : 0));

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function renderHeader(props: {
  readonly title: string;
  readonly caption?: string;
  readonly aside?: string;
}): string {
  return renderToStaticMarkup(createElement(SectionHeader, props));
}

describe('SectionHeader の caption（#45 / #46）', () => {
  /**
   * #45。**両方出る。** `caption` を足しても `aside` が消えない。
   *
   * 消えると「すべて →」「N ページ · ページビュー順」といった導線が画面から失われる。
   */
  it('caption と aside を両方渡すと両方出る', () => {
    const text = textOf(renderHeader({ title: '上位ページ', caption: PERIOD, aside: ASIDE }));

    expect(text).toContain('上位ページ');
    expect(text).toContain(PERIOD);
    expect(text).toContain(ASIDE);
  });

  /** #45。`caption` だけでも出る。 */
  it('caption だけ渡すと caption が出る', () => {
    const text = textOf(renderHeader({ title: 'デバイス', caption: PERIOD }));

    expect(text).toContain('デバイス');
    expect(text).toContain(PERIOD);
  });

  /** #45。`aside` だけの現行の使い方は変わらない。 */
  it('aside だけ渡す現行の使い方は変わらない', () => {
    const text = textOf(renderHeader({ title: '上位ページ', aside: ASIDE }));

    expect(text).toContain(ASIDE);
    expect(text).not.toContain(PERIOD);
  });

  /** #45。`caption` は**タイトルの下**（DOM 順でタイトルより後）。 */
  it('caption はタイトルより後に出る', () => {
    const text = textOf(renderHeader({ title: '上位ページ', caption: PERIOD, aside: ASIDE }));

    expect(text.indexOf(PERIOD)).toBeGreaterThan(text.indexOf('上位ページ'));
  });

  /** #45。`caption` は `CAPTION` 様式（小さく淡い）。繰り返しが読みの邪魔にならないように。 */
  it('caption は CAPTION 様式で描かれる', () => {
    const html = renderHeader({ title: 'デバイス', caption: PERIOD });

    expect(html).toContain('--tf-text-caption');
    expect(html).toContain('--tf-color-text-subtle');
  });

  /**
   * #46。**`caption` が無ければ行を作らない**（現行の見た目を保つ）。
   *
   * 空の要素が増えると、既存の 9 箇所の呼び出しの見た目が変わる。
   */
  it('caption も aside も渡さなければ、見出しの箱以外に要素が増えない', () => {
    const html = renderHeader({ title: '計測タグ' });

    expect(textOf(html)).toBe('計測タグ');
    // 外枠の div が 1 つだけ（caption / aside の行を作っていない）。
    expect((html.match(/<div/g) ?? []).length).toBe(1);
  });

  /** #46。`aside` だけのときも行は 1 つ増えるだけ（現行どおり）。 */
  it('aside だけのときは div が 2 つ（現行どおり）', () => {
    expect((renderHeader({ title: '上位ページ', aside: ASIDE }).match(/<div/g) ?? []).length).toBe(
      2,
    );
  });

  /** #46。`caption` を渡さない見出しの HTML は、現行と同じ（`h2` が 1 つだけ）。 */
  it('caption を渡さない見出しに h2 が 1 つだけある', () => {
    const html = renderHeader({ title: '受信状況' });

    expect((html.match(/<h2/g) ?? []).length).toBe(1);
    expect(html).toContain('受信状況');
  });
});

describe('HourlyPageviews の periodCaption（#51）', () => {
  function render(periodCaption?: string): string {
    return renderToStaticMarkup(
      createElement(HourlyPageviews, { hours: HOURS, includeBots: false, periodCaption }),
    );
  }

  /** #51。渡した期間が見出しの下に出る。 */
  it('periodCaption を渡すと期間が出る', () => {
    const text = textOf(render(PERIOD));

    expect(text).toContain('時間帯別のページビュー');
    expect(text).toContain(PERIOD);
  });

  /** #51。渡さなければ出ない（設定タブなど、期間に依存しない場所のため）。 */
  it('periodCaption を渡さなければ期間が出ない', () => {
    const text = textOf(render());

    expect(text).toContain('時間帯別のページビュー');
    expect(text).not.toContain(PERIOD);
  });

  /** #51。中身（棒グラフ・注記）は変わらない。 */
  it('periodCaption を渡しても中身は変わらない', () => {
    const text = textOf(render(PERIOD));

    expect(text).toContain('最も多い時間帯は 10 時台');
  });
});

describe('DeviceBreakdown の periodCaption（#51）', () => {
  function render(periodCaption?: string): string {
    return renderToStaticMarkup(
      createElement(DeviceBreakdown, {
        rows: [{ key: 'desktop', value: 10, share: 1 }],
        botPageviews: 0,
        includeBots: false,
        periodCaption,
      }),
    );
  }

  /** #51 */
  it('periodCaption を渡すと期間が出る', () => {
    const text = textOf(render(PERIOD));

    expect(text).toContain('デバイス');
    expect(text).toContain(PERIOD);
  });

  /** #51 */
  it('periodCaption を渡さなければ期間が出ない', () => {
    expect(textOf(render())).not.toContain(PERIOD);
  });

  /** #51。中身（行と注記）は変わらない。 */
  it('periodCaption を渡しても中身は変わらない', () => {
    const text = textOf(render(PERIOD));

    expect(text).toContain('デスクトップ');
    expect(text).toContain('Bot と判定したアクセス');
  });
});
