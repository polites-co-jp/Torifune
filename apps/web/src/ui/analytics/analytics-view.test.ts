import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  EmptyPeriodNotice,
  PeriodBar,
  StaleRangeNotice,
  shouldShowPeriodBar,
} from './analytics-view';

/**
 * 確定期間が空で本日に受信がある状態の案内（030-analytics-today 設計 §7.5.1、
 * 受け入れ条件 #76 / #77）。
 *
 * 定期ロールアップが走った直後は未集計が 0 件になり `diagnoseReception` は `receiving` を返す。
 * 導線（`not-tracked.tsx`）は出ず、当期（末尾が昨日）には 1 行も無いので
 * **0 が並ぶだけの概要タブ**が出る。計測タグを貼った初日の利用者はちょうどここを踏む。
 *
 * **これは受信状況の診断ではなく、`receiving` のときの表示の追加である。**
 * `diagnoseReception` の 4 状態と優先順位は変えない。
 *
 * `AnalyticsView` に 1 つ、タブの上に置く。全体を描くとタブ 5 種のデータと `useRouter` が要るので、
 * 単体で描けるように named export する（実装プラン §8 #17）：
 *
 * ```ts
 * export function StaleRangeNotice(props: {
 *   readonly from: string;         // 当期（YYYY-MM-DD）
 *   readonly to: string;
 *   readonly todayHref: string;    // 「当日」（?period=today）への導線
 * }): ReactNode
 * ```
 *
 * 導線は `Link` + `Button` にして、router 無しで href を検査できるようにする。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const FROM = '2026-08-29';
const TO = '2026-09-04';
const TODAY_HREF = '/analytics?siteId=site-1&period=today';

function render(overrides: { readonly todayHref?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(StaleRangeNotice, {
      from: FROM,
      to: TO,
      todayHref: overrides.todayHref ?? TODAY_HREF,
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

describe('StaleRangeNotice', () => {
  /** #76。「この期間の確定値はまだありません」。 */
  it('当期に確定値が無いことを、期間つきで言う', () => {
    const text = textOf(render());

    expect(text).toContain('確定値はまだありません');
    expect(text).toContain(FROM);
    expect(text).toContain(TO);
  });

  /**
   * #76。**「集計待ち」と誤って説明しない。**
   *
   * 次の集計が走っても今日の分は当期（末尾が昨日）に入らないので、
   * 「次回の集計のあとに数字が出ます」は嘘になる。
   */
  it('アクセスが今日届いていること・集計は前日までであることを言う', () => {
    const text = textOf(render());

    expect(text).toContain('アクセスは今日届いています');
    expect(text).toContain('集計は前日まで');
  });

  /** #76。「次回の集計のあとに数字が出ます」を書かない。 */
  it('「次回の集計」を待たせる文言を出さない', () => {
    const text = textOf(render());

    expect(text).not.toContain('次回の集計');
  });

  /** #76。「当日」で見られることと、その導線。 */
  it('「当日を見る」の導線が ?period=today を指す', () => {
    const html = render();

    expect(textOf(html)).toContain('当日を見る');
    expect(html).toContain('period=today');
    // 属性値の `&` は `&amp;` になる。
    expect(html).toContain(`href="${TODAY_HREF.replace(/&/g, '&amp;')}"`);
  });

  /** #76。導線は Link + Button（router 無しで href を検査できる形）。 */
  it('導線がリンクとして描かれる', () => {
    expect(render()).toMatch(/<a[^>]*href="[^"]*period=today[^"]*"/);
  });

  /**
   * #77。`Alert` の `tone` は `info`。`AlertTone` に `neutral` は無い
   * （`'info' | 'success' | 'warning' | 'danger'` の 4 つ）。
   *
   * `Alert` は `danger` だけ `role="alert"`、他はすべて `role="status"` なので、
   * `role` からは `info` / `success` / `warning` を見分けられない。
   * ここでは「`danger` ではない」ことまでを見て、`tone="info"` の宣言は静的検査で固定する
   * （`application/analytics/static-checks.test.ts`）。
   */
  it('role が status（danger ではない）', () => {
    const html = render();

    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  /** #77。案内は 1 つだけ描く（タブごとに書かない）。 */
  it('role="status" の要素は 1 つだけ', () => {
    expect(render().match(/role="status"/g)).toHaveLength(1);
  });
});

/**
 * 確定値のある期間が 1 日も無いときの空状態（設計 §7.2、受け入れ条件 #61）。
 *
 * `to` を昨日にすると、今日が月の 1 日のとき `month` は
 * `from = 今月 1 日 > to = 前月末日` となって範囲が逆転する。
 * そのまま `listAnalytics` に渡すと `ValidationError` で画面が 500 で落ちるので、
 * `presetRange` が `null` を返し、画面は**集計を一切行わず**この空状態を出す。
 *
 * * **前月へ倒さない。**「今月」というラベルで前月を見せるのは嘘になる
 * * **`to = from`（今日 1 日）に丸めない。** その日は未確定で、確定値の期間としては空
 *
 * `StaleRangeNotice` と同じく named export し、単体で描いて確かめる（実装プラン §8 #17）：
 *
 * ```ts
 * export function EmptyPeriodNotice(props: {
 *   readonly todayHref: string;          // ?period=today
 *   readonly previousMonthHref: string;  // ?period=prev-month
 * }): JSX.Element
 * ```
 *
 * **実行日に依らず通ること**が要点。画面全体を組み上げるテストでは
 * 実行日が月の 1 日のときしか通らない（検証レポート §3.1 #61）。
 */
describe('EmptyPeriodNotice', () => {
  const TODAY_HREF = '/analytics?siteId=site-1&period=today';
  const PREV_MONTH_HREF = '/analytics?siteId=site-1&period=prev-month';

  function renderEmpty(
    overrides: { readonly todayHref?: string; readonly previousMonthHref?: string } = {},
  ): string {
    return renderToStaticMarkup(
      createElement(EmptyPeriodNotice, {
        todayHref: overrides.todayHref ?? TODAY_HREF,
        previousMonthHref: overrides.previousMonthHref ?? PREV_MONTH_HREF,
      }),
    );
  }

  /** #61。「今月の確定値はまだありません」。 */
  it('今月に確定値が 1 日も無いことを言う', () => {
    const text = textOf(renderEmpty());

    expect(text).toContain('今月の確定値はまだありません');
    expect(text).toContain('前日までの集計が 1 日分もありません');
  });

  /** #61。「当日を見る」の遷移先が `?period=today`。 */
  it('「当日を見る」が ?period=today を指す', () => {
    const html = renderEmpty();

    expect(textOf(html)).toContain('当日を見る');
    expect(html).toContain(`href="${TODAY_HREF.replace(/&/g, '&amp;')}"`);
  });

  /** #61。「前月を見る」の遷移先が `?period=prev-month`。 */
  it('「前月を見る」が ?period=prev-month を指す', () => {
    const html = renderEmpty();

    expect(textOf(html)).toContain('前月を見る');
    expect(html).toContain(`href="${PREV_MONTH_HREF.replace(/&/g, '&amp;')}"`);
  });

  /** #61。2 つの導線は別々の行き先（同じ href を 2 回描かない）。 */
  it('2 つの導線の行き先が違う', () => {
    const html = renderEmpty();

    expect(html).toContain('period=today');
    expect(html).toContain('period=prev-month');
  });

  /** #61。**前月へ倒さない。**「今月」と言いながら前月の数字を見せていないこと。 */
  it('前月の数字を出さず、前月へは導線だけを置く', () => {
    const text = textOf(renderEmpty());

    // 「前月を見る」というリンクはあるが、期間としては何も表示していない。
    expect(text).toContain('前月を見る');
    expect(text).not.toContain('前期間');
    expect(text).not.toContain('と比較');
  });

  /** #61。導線はリンクとして描く（router 無しで href を検査できる形）。 */
  it('導線がリンクとして描かれる', () => {
    const html = renderEmpty();

    expect(html).toMatch(/<a[^>]*href="[^"]*period=today[^"]*"/);
    expect(html).toMatch(/<a[^>]*href="[^"]*period=prev-month[^"]*"/);
  });

  /** #61。href は渡されたものをそのまま使う（内部で組み立て直さない）。 */
  it('渡された href をそのまま使う', () => {
    const html = renderEmpty({
      todayHref: '/analytics?siteId=other&period=today&bots=1',
      previousMonthHref: '/analytics?siteId=other&period=prev-month&bots=1',
    });

    expect(html).toContain('siteId=other&amp;period=today&amp;bots=1');
    expect(html).toContain('siteId=other&amp;period=prev-month&amp;bots=1');
  });

  /** #84 の対。この空状態には「当日を見る」が 1 つしかない（§7.5.1 の案内と並べない）。 */
  it('「当日を見る」を 1 つだけ描く', () => {
    expect(renderEmpty().match(/period=today/g)).toHaveLength(1);
  });
});

/**
 * 適用中の期間（034-analytics-period-scope 設計 §7.3.2、受け入れ条件 F #38 / #40 / #41 / #42）。
 *
 * **選んだ期間がどの区画にも効いていることを、画面から読み取れるようにする**（裁定 3.2）。
 * タブの直下に 1 行だけ置く。
 *
 * ```ts
 * export function PeriodBar(props: {
 *   readonly text: string;   // appliedPeriodText の結果
 *   readonly from: string;   // data 属性用（E2E が文言に依存しないため）
 *   readonly to: string;
 * }): JSX.Element
 *
 * // 出す条件（§7.3.2 の表）。画面の中に散らさない。
 * export function shouldShowPeriodBar(kind: TabData['kind']): boolean
 * ```
 *
 * `StaleRangeNotice` / `EmptyPeriodNotice` と同じく named export にする。
 * `empty-period` は実行日が月の 1 日でないと E2E で作れないので、
 * 述語のユニットで決定的に担保する（030 §7.2 と同じ理由）。
 */
describe('PeriodBar（#38）', () => {
  const TEXT = '期間 2026-09-08';
  const BAR_FROM = '2026-09-08';
  const BAR_TO = '2026-09-08';

  function renderBar(
    overrides: { readonly text?: string; readonly from?: string; readonly to?: string } = {},
  ): string {
    return renderToStaticMarkup(
      createElement(PeriodBar, {
        text: overrides.text ?? TEXT,
        from: overrides.from ?? BAR_FROM,
        to: overrides.to ?? BAR_TO,
      }),
    );
  }

  /** #38。**渡された文字列をそのまま描く。** 部品の中で組み立て直さない（§7.3.4）。 */
  it('渡された文字列をそのまま描く', () => {
    expect(textOf(renderBar())).toBe(TEXT);
  });

  /** #38。当日の文言もそのまま通す（組み立ては `labels.ts` の 1 関数に閉じる）。 */
  it('当日の文言もそのまま描く', () => {
    expect(textOf(renderBar({ text: '期間 当日（2026-09-09）' }))).toBe('期間 当日（2026-09-09）');
  });

  /**
   * #38。`data-analytics-period` は `${from}/${to}`。
   *
   * ヘッダ行の `data-analytics-timezone`（既存）と同じ理由で置く。
   * E2E が文言の言い回しに依存せずに期間を読める。
   */
  it('data-analytics-period が `${from}/${to}`', () => {
    expect(renderBar()).toContain('data-analytics-period="2026-09-08/2026-09-08"');
  });

  /** #38。複数日でも同じ形。 */
  it('複数日でも data-analytics-period は `${from}/${to}`', () => {
    const html = renderBar({
      text: '期間 2026-09-02 〜 2026-09-08（7 日間）',
      from: '2026-09-02',
      to: '2026-09-08',
    });

    expect(html).toContain('data-analytics-period="2026-09-02/2026-09-08"');
  });

  /** #38。**囲みを作らない**（カードが増えたように見せない）。1 行の段落だけ。 */
  it('段落 1 つだけを描く（囲みを作らない）', () => {
    const html = renderBar();

    expect((html.match(/<p/g) ?? []).length).toBe(1);
    expect(html).not.toContain('<div');
  });

  /** #38。`PeriodBar` は本文サイズで出す（`caption` 側だけが小さく淡い。§11 #3）。 */
  it('本文の色と太さで描く（caption の淡い色にしない）', () => {
    const html = renderBar();

    expect(html).toContain('var(--tf-color-text)');
    expect(html).not.toContain('var(--tf-color-text-subtle)');
  });
});

/**
 * `PeriodBar` を出す条件（設計 §7.3.2 の表、受け入れ条件 F #40 / #41 / #42）。
 *
 * | 状態 | 出すか | 理由 |
 * | --- | --- | --- |
 * | 概要 / ページ / 参照元 / 訪問者 | 出す | 中身が期間に依存する |
 * | `not-tracked` | 出す | 「どの期間に記録が無いのか」が分かる |
 * | 設定タブ | 出さない | 期間に依存しない |
 * | `empty-period` | 出さない | 確定期間が存在しない（画面に出すと嘘になる） |
 *
 * **条件を画面の中に散らさない**（実装プラン §8 #2）。散らすと `empty-period` の分岐を
 * 決定的に確かめられなくなる（実行日が月の 1 日でないと E2E で作れない）。
 */
describe('shouldShowPeriodBar（#40 / #41 / #42）', () => {
  /** #42 / §7.3.2。中身が期間に依存する 4 タブと `not-tracked` では出す。 */
  it.each(['overview', 'pages', 'referrers', 'visitors', 'not-tracked'] as const)(
    '%s では出す',
    (kind) => {
      expect(shouldShowPeriodBar(kind)).toBe(true);
    },
  );

  /** #40。設定タブは期間に依存しない（030 §7.3 のとおり）。 */
  it('settings では出さない', () => {
    expect(shouldShowPeriodBar('settings')).toBe(false);
  });

  /**
   * #41。`empty-period`（今日が月の 1 日の `month`）では出さない。
   *
   * `page.tsx` の代替値（`{ today, today }`）は**問い合わせに 1 度も使っていない値**であり、
   * 画面に出すと嘘になる。
   */
  it('empty-period では出さない', () => {
    expect(shouldShowPeriodBar('empty-period')).toBe(false);
  });

  /** #40 / #41。出さないのはこの 2 つだけ。 */
  it('出さないのは settings と empty-period の 2 つだけ', () => {
    const kinds = [
      'overview',
      'pages',
      'referrers',
      'visitors',
      'settings',
      'not-tracked',
      'empty-period',
    ] as const;

    expect(kinds.filter((kind) => !shouldShowPeriodBar(kind))).toEqual([
      'settings',
      'empty-period',
    ]);
  });
});
