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

function render(data: OverviewData): string {
  return renderToStaticMarkup(
    createElement(OverviewTab, {
      data,
      from: '2026-09-05',
      to: '2026-09-05',
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
