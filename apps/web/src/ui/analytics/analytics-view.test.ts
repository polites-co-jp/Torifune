import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EmptyPeriodNotice, StaleRangeNotice } from './analytics-view';

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
