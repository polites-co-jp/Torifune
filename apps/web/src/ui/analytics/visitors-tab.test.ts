import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VisitorsTab, type VisitorsData } from './visitors-tab';

/**
 * 訪問者タブの当日向けの出し分け（030-analytics-today 設計 §7.3、受け入れ条件 #56）。
 *
 * ```ts
 * interface VisitorsData {
 *   // …既存…
 *   readonly perDay: { readonly value: number; readonly delta?: StatDelta } | null;
 * }
 * ```
 *
 * 当日は 1 日しかないので「1日あたり訪問者」は「訪問者」と同じ数になる。
 * **同じ数のタイルを 2 枚並べない。** `null` のとき Tile ごと描かない。
 */

const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 10 : 0));

/** 確定期間（現行の使い方）。 */
const WITH_DELTA: VisitorsData = {
  visitors: { value: 5, delta: { text: '+5.0%', tone: 'success' } },
  sessions: { value: 4, delta: { text: '+1.0%', tone: 'success' } },
  perVisitor: { value: 2, delta: { text: '−1.0%', tone: 'danger' } },
  perDay: { value: 1.25, delta: { text: '+2.0%', tone: 'success' } },
  hours: HOURS,
  devices: [{ key: 'desktop', value: 10, share: 1 }],
  bot: { botPageviews: 1, humanPageviews: 10, share: 1 / 11, peakDay: '2026-09-05' },
};

/** 当日（前期間比なし・1 日あたり訪問者なし）。 */
const TODAY_DATA: VisitorsData = {
  visitors: { value: 5 },
  sessions: { value: 4 },
  perVisitor: { value: 2 },
  perDay: null,
  hours: HOURS,
  devices: [{ key: 'desktop', value: 10, share: 1 }],
  bot: { botPageviews: 1, humanPageviews: 10, share: 1 / 11, peakDay: '2026-09-05' },
};

/**
 * 適用中の期間（034-analytics-period-scope 設計 §7.3.3 / §7.3.4）。
 *
 * `VisitorsTab` は `periodCaption: string` を受け、「Bot のアクセス」・時間帯別・デバイスへ
 * 渡すだけ。**タブは文字列を組み立てない。**
 */
const PERIOD_CAPTION = '期間 2026-09-08';

function render(data: VisitorsData, includeBots = false): string {
  return renderToStaticMarkup(
    createElement(VisitorsTab, { data, periodCaption: PERIOD_CAPTION, includeBots }),
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

describe('「1日あたり訪問者」（#56）', () => {
  /** #56。1 日しかないので「訪問者」と同じ数になる。 */
  it('perDay が null なら「1日あたり訪問者」を描かない', () => {
    expect(textOf(render(TODAY_DATA))).not.toContain('1日あたり訪問者');
  });

  /** #56 の対。確定期間では従来どおり出る。 */
  it('perDay があれば「1日あたり訪問者」を描く', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).toContain('1日あたり訪問者');
    expect(text).toContain('1.3');
  });

  /** #56。残りの 3 指標は当日でも出る。 */
  it('perDay が null でも 訪問者 / セッション / 訪問者あたりページビュー は出る', () => {
    const text = textOf(render(TODAY_DATA));

    for (const label of ['訪問者', 'セッション', '訪問者あたりページビュー']) {
      expect(text, label).toContain(label);
    }
  });
});

describe('前期間比（#54 の訪問者タブ側）', () => {
  /** #54。当日は `delta` を渡さない。 */
  it('delta を渡さなければ data-tone が 1 つも出ない', () => {
    expect(render(TODAY_DATA)).not.toContain('data-tone');
  });

  /** #54 の対。確定期間では現行どおり出る。 */
  it('delta を渡せば data-tone が出る', () => {
    expect(render(WITH_DELTA)).toContain('data-tone="success"');
  });
});

/**
 * 未決事項 #3（設計 §15）。「Bot のアクセス」は当日でもそのまま出す。
 *
 * 「最も多かった日」は当日 1 日なので今日になるが、値としては正しい。
 * 欄ごと消すと確定期間と当日で区画の数が変わる。
 */
describe('「Bot のアクセス」は当日でも出す', () => {
  it('perDay が null でも「Bot のアクセス」の 4 つの値が出る', () => {
    const text = textOf(render(TODAY_DATA));

    expect(text).toContain('Bot のアクセス');
    expect(text).toContain('Bot のページビュー');
    expect(text).toContain('人のページビュー');
    expect(text).toContain('Bot が最も多かった日');
    expect(text).toContain('2026-09-05');
  });
});

/**
 * 訪問者タブの期間表示（034-analytics-period-scope 設計 §7.3.3、受け入れ条件 F #50 / #51）。
 *
 * `caption` に期間を出すのは 3 枚：「デバイス」「時間帯別のページビュー」「Bot のアクセス」。
 * 上部の 4 タイル（`StatGrid`）には見出しが無く、**タイル群のために見出しを新設しない**
 * （028 §7.3.6 の並びを変えることになる）。直上の `PeriodBar` が期間を示す（§7.3.2）。
 *
 * **`aside` を上書きしない。**「Bot のアクセス」のスイッチの状態はいまのまま右に残る。
 */
describe('訪問者タブの期間（#50 / #51）', () => {
  function countPeriod(html: string): number {
    return textOf(html).split(PERIOD_CAPTION).length - 1;
  }

  /**
   * #50。「Bot のアクセス」の `aside`（スイッチの状態）が残ったまま期間が出る。
   *
   * この欄は「Bot を集計に含める」スイッチに左右されないことを示す表示であり、消せない。
   */
  it('「Bot のアクセス」の aside が残ったまま期間が出る', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).toContain('Bot のアクセス');
    expect(text).toContain('現在、他の指標から Bot を除いています');
    expect(text).toContain(PERIOD_CAPTION);
  });

  /** #50。スイッチがオンのときの `aside` も残る。 */
  it('bots=1 のときの aside も残ったまま期間が出る', () => {
    const text = textOf(render(WITH_DELTA, true));

    expect(text).toContain('現在、他の指標にも Bot を含めています');
    expect(text).toContain(PERIOD_CAPTION);
  });

  /** #51。時間帯別・デバイスのカードにも期間が出る（部品へ `periodCaption` を渡している）。 */
  it('デバイスと時間帯別のカードにも期間が出る', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).toContain('デバイス');
    expect(text).toContain('時間帯別のページビュー');
    // 3 枚（デバイス / 時間帯別 / Bot のアクセス）。
    expect(countPeriod(render(WITH_DELTA))).toBe(3);
  });

  /** #51。「1日あたり訪問者」が無い（1 日の期間）ときも 3 枚のまま（タイル群には出さない）。 */
  it('perDay が null でも期間は 3 枚に出る', () => {
    expect(countPeriod(render(TODAY_DATA))).toBe(3);
  });

  /** #51。上部のタイルには見出しを作らない（`h2` は 3 枚のカードのぶんだけ）。 */
  it('タイル群のために見出しを新設しない', () => {
    expect((render(WITH_DELTA).match(/<h2/g) ?? []).length).toBe(3);
  });

  /** #50。渡された文字列をそのまま出す（タブの中で組み立て直さない）。 */
  it('渡された文字列をそのまま出す', () => {
    const html = renderToStaticMarkup(
      createElement(VisitorsTab, {
        data: WITH_DELTA,
        periodCaption: '期間 当日（2026-09-09）',
        includeBots: false,
      }),
    );

    expect(textOf(html)).toContain('期間 当日（2026-09-09）');
  });
});
