import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TODAY_BOUNCE_RATE_NOTE, TODAY_DWELL_AVG_NOTE } from './labels';
import { OverviewTab, type OverviewData } from './overview-tab';

/**
 * 概要タブの当日向けの出し分け（030-analytics-today 設計 §7.3 / §13-1 / §13-2、
 * 受け入れ条件 #54 / #55 / #57）。
 *
 * `OverviewData` を当日でも使えるように広げる（実装プラン T9）：
 *
 * ```ts
 * interface CountStat { readonly value: number; readonly delta?: StatDelta }   // delta を任意に
 * interface RatioStat { readonly value: number | null; readonly delta?: StatDelta }
 *
 * interface OverviewData {
 *   // …既存…
 *   readonly daily: readonly DailyRow[] | null;   // null で「日次の推移」カードごと描かない
 *   readonly bounceRateNote?: ReactNode;          // 当日の偏りの注記（§13-2）
 *   readonly dwellAvgNote?: ReactNode;
 * }
 * ```
 *
 * 当日は「比べていない」のであって「比べたが出せない」ではないので、
 * `—`（`NO_VALUE`）も出さない。`delta` を渡さないことで矢印も `—` も出さない（§13-1）。
 */

const ROW = { date: '2026-09-04', pageviews: 3, visitors: 2 } as const;

/** 10 時台に 10 PV。空状態ではなく値のある区画として描かせる。 */
const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => (hour === 10 ? 10 : 0));

/** 前期間比つきの確定期間（現行の使い方）。 */
const WITH_DELTA: OverviewData = {
  pageviews: { value: 10, delta: { text: '+10.0%', tone: 'success' } },
  visitors: { value: 5, delta: { text: '+5.0%', tone: 'success' } },
  sessions: { value: 4, delta: { text: '−1.0%', tone: 'danger' } },
  bounceRate: { value: 0.25, delta: { text: '−1.0pt', tone: 'success' } },
  dwellAvg: { value: 2000, delta: { text: '—', tone: 'muted' } },
  daily: [ROW],
  topPages: [{ key: '/', value: 10 }],
  topReferrers: [{ key: '(direct)', value: 4 }],
  hours: HOURS,
  devices: [{ key: 'desktop', value: 10, share: 1 }],
  botPageviews: 0,
};

/** 当日（前期間比なし・日次なし・注記あり）。 */
const TODAY_DATA: OverviewData = {
  pageviews: { value: 10 },
  visitors: { value: 5 },
  sessions: { value: 4 },
  bounceRate: { value: 0.25 },
  dwellAvg: { value: 2000 },
  daily: null,
  topPages: [{ key: '/', value: 10 }],
  topReferrers: [{ key: '(direct)', value: 4 }],
  hours: HOURS,
  devices: [{ key: 'desktop', value: 10, share: 1 }],
  botPageviews: 0,
  bounceRateNote: TODAY_BOUNCE_RATE_NOTE,
  dwellAvgNote: TODAY_DWELL_AVG_NOTE,
};

/**
 * 適用中の期間（034-analytics-period-scope 設計 §7.3.3 / §7.3.4）。
 *
 * `OverviewTab` の `from` / `to` は **`periodCaption: string` に置き換わる**。
 * **タブは文字列を組み立てない。** `AnalyticsView` が `appliedPeriodText` を 1 回呼び、
 * 出来上がった文字列を配る（028 §7.3.6「数を計算しない・並べるだけ」を保つ）。
 */
const PERIOD_CAPTION = '期間 2026-09-02 〜 2026-09-08（7 日間）';

/** 034 §7.3.1。旧「日次の推移」の `aside`（`rangeText`）の形。**もう出てはならない。** */
const OLD_ASIDE_RANGE = '2026-09-05 〜 2026-09-05';

function render(data: OverviewData): string {
  return renderToStaticMarkup(
    createElement(OverviewTab, {
      data,
      periodCaption: PERIOD_CAPTION,
      includeBots: false,
      pagesHref: '/analytics?siteId=s1&tab=pages',
      referrersHref: '/analytics?siteId=s1&tab=referrers',
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

describe('前期間比（#54）', () => {
  /** #54。`Stat` の `delta` は `<span data-tone>` で描かれる。渡さなければ 1 つも出ない。 */
  it('delta を渡さなければ data-tone が 1 つも出ない', () => {
    expect(render(TODAY_DATA)).not.toContain('data-tone');
  });

  /** #54。`—`（比を出せない）も出さない。当日は「比べていない」。 */
  it('delta を渡さなければ「—」を出さない', () => {
    expect(textOf(render(TODAY_DATA))).not.toContain('—');
  });

  /** #54 の対。確定期間では従来どおり出る（既存の振る舞いを壊さない）。 */
  it('delta を渡せば data-tone が出る（確定期間は現行どおり）', () => {
    const html = render(WITH_DELTA);

    expect(html).toContain('data-tone="success"');
    expect(html).toContain('data-tone="danger"');
  });

  /** #54。値そのものは当日でも出る（Stat × 5）。 */
  it('delta が無くても 5 つの指標の値は出る', () => {
    const text = textOf(render(TODAY_DATA));

    for (const label of ['ページビュー', '訪問者', 'セッション', '直帰率', '平均滞在時間']) {
      expect(text, label).toContain(label);
    }
    expect(text).toContain('25.0%');
  });
});

describe('「日次の推移」カード（#55）', () => {
  /** #55。1 日の折れ線に意味が無い。カードごと描かない。 */
  it('daily が null なら「日次の推移」を描かない', () => {
    const text = textOf(render(TODAY_DATA));

    expect(text).not.toContain('日次の推移');
  });

  /** #55。空状態も出さない（「記録がありません」は確定期間の話）。 */
  it('daily が null なら「この期間のアクセスの記録はありません。」も出さない', () => {
    expect(textOf(render(TODAY_DATA))).not.toContain('この期間のアクセスの記録はありません');
  });

  /** #55 の対。確定期間では従来どおり出る。 */
  it('daily が配列なら「日次の推移」を描く', () => {
    expect(textOf(render(WITH_DELTA))).toContain('日次の推移');
  });

  /** #55 の対。空配列は「記録が 1 つも無い」で、カードは出したまま空状態にする（現行どおり）。 */
  it('daily が空配列ならカードは出して空状態を描く', () => {
    const text = textOf(render({ ...WITH_DELTA, daily: [] }));

    expect(text).toContain('日次の推移');
    expect(text).toContain('この期間のアクセスの記録はありません');
  });

  /** #55。時間帯別 PV は当日でも出す（当日はここが「推移」の役割を担う）。 */
  it('daily が null でも時間帯別のページビューは出る', () => {
    expect(textOf(render(TODAY_DATA))).toContain('時間帯');
  });
});

describe('当日の偏りの注記（#57）', () => {
  /** #57。進行中のセッションを含むので直帰率が高めに出る（§13-2）。 */
  it('bounceRateNote を渡すと直帰率に注記が出る', () => {
    expect(textOf(render(TODAY_DATA))).toContain('確定後より高めに出ます');
  });

  /** #57。セッション最後のページを測れないので平均滞在が短めに出る（§13-2）。 */
  it('dwellAvgNote を渡すと平均滞在時間に注記が出る', () => {
    const text = textOf(render(TODAY_DATA));

    expect(text).toContain('実際より短めに出ます');
    expect(text).toContain('進行中のセッションを含む当日はその差が大きく出ます');
  });

  /** #57。文言は `labels.ts` に置く（画面ごとに書き散らさない）。 */
  it('注記の文言が labels.ts の定数と一致する', () => {
    expect(TODAY_BOUNCE_RATE_NOTE).toContain('進行中のセッションを含むため');
    expect(TODAY_BOUNCE_RATE_NOTE).toContain('確定後より高めに出ます');
    expect(TODAY_DWELL_AVG_NOTE).toContain('セッション最後のページは測れないため');
  });

  /** #57 の対。確定期間では注記を渡さないので出ない。 */
  it('注記を渡さなければ出ない', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).not.toContain('確定後より高めに出ます');
    expect(text).not.toContain('進行中のセッションを含む当日は');
  });
});

/**
 * 期間に依存する各カードに期間を出す（034-analytics-period-scope 設計 §7.3.3、
 * 受け入れ条件 F #47 / #51 / #52）。
 *
 * 概要タブで `caption` に期間を出すのは 5 枚：
 * 「日次の推移」「上位ページ」「参照元」「時間帯別のページビュー」「デバイス」。
 *
 * **`aside` を上書きしない。** 上位ページ・参照元の「すべて →」はいまのまま右に残る。
 * 例外は「日次の推移」の `aside`（期間）だけで、これは `caption` へ**移す**（#52）。
 */
describe('カードの期間（#47 / #51 / #52）', () => {
  /** 期間の文字列が HTML に現れた回数。 */
  function countPeriod(html: string): number {
    return textOf(html).split(PERIOD_CAPTION).length - 1;
  }

  /**
   * #47。「上位ページ」「参照元」で `aside`（「すべて →」）が残ったまま期間が出る。
   *
   * 消えると概要タブから各タブへの導線が失われる。
   */
  it('上位ページ・参照元で「すべて →」が残ったまま期間が出る', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).toContain('上位ページ');
    expect(text).toContain('参照元');
    // 「すべて →」は 2 つ（上位ページ・参照元）。
    expect(text.split('すべて →').length - 1).toBe(2);
    expect(text).toContain(PERIOD_CAPTION);
  });

  /** #47。導線の行き先も変わらない。 */
  it('「すべて →」の行き先が変わらない', () => {
    const html = render(WITH_DELTA);

    expect(html).toContain('tab=pages');
    expect(html).toContain('tab=referrers');
  });

  /** #51。時間帯別・デバイスのカードにも期間が出る（部品へ `periodCaption` を渡している）。 */
  it('時間帯別とデバイスのカードにも期間が出る', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).toContain('時間帯別のページビュー');
    expect(text).toContain('デバイス');
    // 5 枚（日次の推移 / 上位ページ / 参照元 / 時間帯別 / デバイス）。
    expect(countPeriod(render(WITH_DELTA))).toBe(5);
    expect(text).toContain(PERIOD_CAPTION);
  });

  /** #51。「日次の推移」が無い（1 日の期間）ときは 4 枚。 */
  it('「日次の推移」が無いときは 4 枚に期間が出る', () => {
    expect(countPeriod(render(TODAY_DATA))).toBe(4);
  });

  /** #52。「日次の推移」カードにも期間が出る（`caption` 側）。 */
  it('「日次の推移」カードに期間が出る', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).toContain('日次の推移');
    expect(text.indexOf(PERIOD_CAPTION)).toBeGreaterThanOrEqual(0);
  });

  /**
   * #52。**`aside` に期間が出ない。** 同じ期間が同じカードに 2 か所出るのを避ける。
   *
   * 旧実装は `SectionHeader aside={rangeText(from, to)}` で期間を右に出していた。
   */
  it('「日次の推移」の aside に rangeText の期間が出ない', () => {
    const text = textOf(render(WITH_DELTA));

    expect(text).not.toContain(OLD_ASIDE_RANGE);
    // `〜` を挟んだ日付だけの並びが、期間の 1 行以外に現れない。
    expect(text.split('〜').length - 1).toBe(countPeriod(render(WITH_DELTA)));
  });

  /** #52。タブは文字列を組み立てない（渡された文字列だけが出る）。 */
  it('渡された文字列以外の期間表記を作らない', () => {
    const text = textOf(render({ ...WITH_DELTA, daily: [ROW] }));

    // 日付そのもの（`2026-09-04`）は表（`<details>` の中）に出るが、
    // 見出しの期間としては渡された文字列だけ。
    expect(text).toContain(PERIOD_CAPTION);
    expect(text).not.toContain('期間 2026-09-05');
  });

  /** #51。`periodCaption` は `CAPTION` 様式（小さく淡い）で出す。 */
  it('期間は CAPTION 様式で出す', () => {
    const html = render(WITH_DELTA);

    expect(html).toContain('--tf-color-text-subtle');
  });
});
