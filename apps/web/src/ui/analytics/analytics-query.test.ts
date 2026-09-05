import { describe, expect, it, vi } from 'vitest';
import type * as DayModule from '@/domain/analytics/day';
import { previousRange } from '@/domain/analytics/day';
import {
  analyticsHref,
  pageSlice,
  resolvePeriod,
  shouldShowStaleRangeNotice,
  type AnalyticsQuery,
} from './analytics-query';

/**
 * URL とクエリの解決（030-analytics-today 設計 §7.1.1 / §7.2 / §7.5.1、
 * 受け入れ条件 #39〜#47、#78〜#84）。
 *
 * `resolvePeriod` は `app/analytics/page.tsx` の非公開関数だったので単体で呼べなかった。
 * 設計 §14 が Presentation の単体テスト対象として挙げているため、
 * `ui/analytics/analytics-query.ts` へ移して export する（実装プラン T3 / §8 #1）。
 *
 * ```ts
 * interface ResolvedPeriod {
 *   readonly period: AnalyticsPeriod;      // '7d' | '30d' | '90d' | 'month' | 'prev-month' | 'today' | 'custom'
 *   readonly range: DateRange | null;      // null は「確定値のある期間が無い」（month の 1 日だけ）
 *   readonly warning: boolean;             // custom の期間が不正で既定に戻したとき true
 * }
 * resolvePeriod(params: Record<string, string | string[] | undefined>, today: string): ResolvedPeriod
 *
 * shouldShowStaleRangeNotice(input: {
 *   readonly period: AnalyticsPeriod;
 *   readonly notTracked: NotTrackedState | null;   // 導線が出ているか（null なら receiving）
 *   readonly currentPointCount: number;            // 当期の key = '' の点の数
 *   readonly receivedToday: boolean;
 *   readonly tab: AnalyticsTab;
 *   readonly hasConfirmedRange: boolean;           // resolvePeriod().range !== null（条件 f）
 * }): boolean
 *
 * pageSlice<T>(items: readonly T[], page: number, perPage: number):
 *   { readonly items: readonly T[]; readonly total: number }
 * ```
 *
 * `analyticsHref` の分岐は変えない（`period` を書く条件は現行のまま）。
 */

// #40。`resolvePeriod` が前期間を計算していないことを、呼び出しの有無で見る。
vi.mock('@/domain/analytics/day', async (importOriginal) => {
  const actual = await importOriginal<typeof DayModule>();
  return { ...actual, previousRange: vi.fn(actual.previousRange) };
});

/** 運用タイムゾーンの「今日」。`resolvePeriod` は引数で受ける（時計を読まない）。 */
const TODAY = '2026-09-05';
const YESTERDAY = '2026-09-04';

const BASE_QUERY: AnalyticsQuery = {
  siteId: 'a0e3a1a2-0000-4000-8000-000000000001',
  tab: 'overview',
  period: '30d',
  from: '2026-08-06',
  to: YESTERDAY,
  includeBots: false,
  page: 1,
};

function paramsOf(search: string): Record<string, string | string[] | undefined> {
  return Object.fromEntries(new URLSearchParams(search).entries());
}

describe('resolvePeriod（当日）', () => {
  /** #39 */
  it('?period=today は period: today、範囲は今日 1 日', () => {
    const resolved = resolvePeriod(paramsOf('period=today'), TODAY);

    expect(resolved.period).toBe('today');
    expect(resolved.range).toEqual({ from: TODAY, to: TODAY });
    expect(resolved.warning).toBe(false);
  });

  /**
   * #40。当日は前期間比を出さない（設計 §13-1）ので、前期間を計算する必要が無い。
   *
   * 期間の解決が前期間まで抱えると、当日でも前期間が組み上がり、
   * 「比べていない」はずの画面へ比較が紛れ込む道ができる。
   */
  it('?period=today の解決で previousRange を呼ばない', () => {
    vi.mocked(previousRange).mockClear();

    resolvePeriod(paramsOf('period=today'), TODAY);

    expect(vi.mocked(previousRange)).not.toHaveBeenCalled();
  });

  /** #40。返す値は期間そのものだけ。前期間を持たせない。 */
  it('解決の結果は period / range / warning の 3 つだけ', () => {
    const resolved = resolvePeriod(paramsOf('period=today'), TODAY);

    expect(Object.keys(resolved).sort()).toEqual(['period', 'range', 'warning']);
  });

  /** #39。`today` は `custom` に落ちない（日付欄を触ったときだけ `custom` になる。§7.1.4）。 */
  it('?period=today は custom に落ちない', () => {
    expect(resolvePeriod(paramsOf('period=today&from=2026-01-01'), TODAY).period).toBe('today');
  });
});

describe('resolvePeriod（プリセット）', () => {
  /** #1〜#4 の画面側。プリセットの `to` は昨日。 */
  it.each([
    ['7d', { from: '2026-08-29', to: YESTERDAY }],
    ['30d', { from: '2026-08-06', to: YESTERDAY }],
    ['90d', { from: '2026-06-07', to: YESTERDAY }],
    ['month', { from: '2026-09-01', to: YESTERDAY }],
  ] as const)('?period=%s の範囲は末尾が昨日', (period, range) => {
    const resolved = resolvePeriod(paramsOf(`period=${period}`), TODAY);

    expect(resolved.period).toBe(period);
    expect(resolved.range).toEqual(range);
  });

  /** #41。現行どおり。共有された URL を開いた人が何も見られないのは困る。 */
  it('未知の period は 30d に落ちる（警告は出さない）', () => {
    const resolved = resolvePeriod(paramsOf('period=tommorow'), TODAY);

    expect(resolved.period).toBe('30d');
    expect(resolved.range).toEqual({ from: '2026-08-06', to: YESTERDAY });
    expect(resolved.warning).toBe(false);
  });

  /** #41。period が無ければ既定の 30d。 */
  it('period も from / to も無ければ 30d', () => {
    expect(resolvePeriod({}, TODAY).period).toBe('30d');
  });

  /**
   * #61 / #84 の土台（設計 §7.2）。今日が月の 1 日のとき `month` に確定値のある期間は無い。
   *
   * 画面はここで `null` を受けたら**集計を一切行わず**空状態を出す。
   * この `null` が `shouldShowStaleRangeNotice` の `hasConfirmedRange: false` になり、
   * 述語が自分で案内を弾く（条件 f。§7.5.1 / §12.3）。
   * **呼び出し側の分岐の順序に依らず決まる**ようにするため、判定を述語へ寄せてある。
   */
  it('今日が月の 1 日のとき ?period=month の range は null', () => {
    const resolved = resolvePeriod(paramsOf('period=month'), '2026-09-01');

    expect(resolved.period).toBe('month');
    expect(resolved.range).toBeNull();
    expect(resolved.warning).toBe(false);
  });

  /** #61。1 日でなければ `null` にならない。 */
  it('今日が月の 2 日なら ?period=month の range は null でない', () => {
    expect(resolvePeriod(paramsOf('period=month'), '2026-09-02').range).toEqual({
      from: '2026-09-01',
      to: '2026-09-01',
    });
  });

  /** #61。他のプリセットは月の 1 日でも `null` にならない。 */
  it.each(['7d', '30d', '90d', 'prev-month'])(
    '月の 1 日でも ?period=%s は null でない',
    (period) => {
      expect(resolvePeriod(paramsOf(`period=${period}`), '2026-09-01').range).not.toBeNull();
    },
  );
});

describe('resolvePeriod（カスタム）', () => {
  /** #42。現行どおり。 */
  it('period が無く from / to があれば custom', () => {
    const resolved = resolvePeriod(paramsOf('from=2026-08-01&to=2026-08-10'), TODAY);

    expect(resolved.period).toBe('custom');
    expect(resolved.range).toEqual({ from: '2026-08-01', to: '2026-08-10' });
    expect(resolved.warning).toBe(false);
  });

  /**
   * #43。**今日を明示的に指定する逃げ道を塞がない**（裁定 3.3）。
   *
   * このときの値は集計値（最大 15 分遅れ）で、`period=today` の生ログとは違いうる。
   * 違いは §7.4.3 の注記で説明する。
   */
  it('?period=custom&from=今日&to=今日 は custom のまま今日を含む', () => {
    const resolved = resolvePeriod(paramsOf(`period=custom&from=${TODAY}&to=${TODAY}`), TODAY);

    expect(resolved.period).toBe('custom');
    expect(resolved.range).toEqual({ from: TODAY, to: TODAY });
    expect(resolved.warning).toBe(false);
  });

  /** #43。今日をまたぐ custom もそのまま通る。 */
  it('?period=custom で今日をまたぐ期間もそのまま通る', () => {
    const resolved = resolvePeriod(paramsOf(`period=custom&from=2026-09-01&to=${TODAY}`), TODAY);

    expect(resolved.range).toEqual({ from: '2026-09-01', to: TODAY });
  });

  /** #44。形式が読めない（変更なし）。 */
  it('日付として読めない from は警告 + 30d', () => {
    const resolved = resolvePeriod(paramsOf('period=custom&from=not-a-date&to=2026-08-10'), TODAY);

    expect(resolved.period).toBe('30d');
    expect(resolved.range).toEqual({ from: '2026-08-06', to: YESTERDAY });
    expect(resolved.warning).toBe(true);
  });

  /** #44。暦に無い日付（形式だけでは落ちない）。 */
  it('実在しない日付は警告 + 30d', () => {
    const resolved = resolvePeriod(paramsOf('period=custom&from=2026-02-30&to=2026-03-10'), TODAY);

    expect(resolved.period).toBe('30d');
    expect(resolved.warning).toBe(true);
  });

  /** #44。逆転（変更なし）。 */
  it('期間が逆転していれば警告 + 30d', () => {
    const resolved = resolvePeriod(paramsOf('period=custom&from=2026-05-01&to=2026-04-01'), TODAY);

    expect(resolved.period).toBe('30d');
    expect(resolved.warning).toBe(true);
  });

  /** #44。400 日超（変更なし）。 */
  it('400 日を超える期間は警告 + 30d', () => {
    const resolved = resolvePeriod(paramsOf('period=custom&from=2020-01-01&to=2026-01-01'), TODAY);

    expect(resolved.period).toBe('30d');
    expect(resolved.warning).toBe(true);
  });

  /** #44。`custom` なのに `from` / `to` が無い。 */
  it('period=custom だけなら警告 + 30d', () => {
    const resolved = resolvePeriod(paramsOf('period=custom'), TODAY);

    expect(resolved.period).toBe('30d');
    expect(resolved.warning).toBe(true);
  });

  /** #44。`custom` に落ちたときも `range` は必ずある（`null` は `month` の 1 日だけ）。 */
  it('custom は常に range を持つ', () => {
    expect(
      resolvePeriod(paramsOf('period=custom&from=2026-08-01&to=2026-08-02'), TODAY).range,
    ).not.toBeNull();
  });
});

describe('analyticsHref', () => {
  /** #45 */
  it('period: today なら period=today を書く', () => {
    const href = analyticsHref({ ...BASE_QUERY, period: 'today', from: TODAY, to: TODAY });

    expect(new URL(href, 'http://x').searchParams.get('period')).toBe('today');
  });

  /** #45。当日は `from` / `to` を URL へ書かない（`custom` と見分けがつかなくなる）。 */
  it('period: today では from / to を書かない', () => {
    const params = new URL(
      analyticsHref({ ...BASE_QUERY, period: 'today', from: TODAY, to: TODAY }),
      'http://x',
    ).searchParams;

    expect(params.get('from')).toBeNull();
    expect(params.get('to')).toBeNull();
  });

  /** #46。既定の短い URL を保つ（現行どおり）。 */
  it('period: 30d では period を書かない', () => {
    expect(new URL(analyticsHref(BASE_QUERY), 'http://x').searchParams.get('period')).toBeNull();
  });

  /** #46。プリセットはそのまま書く（現行どおり）。 */
  it('period: 7d は period=7d を書く', () => {
    expect(
      new URL(analyticsHref({ ...BASE_QUERY, period: '7d' }), 'http://x').searchParams.get(
        'period',
      ),
    ).toBe('7d');
  });

  /** #46。custom は from / to も書く（現行どおり）。 */
  it('period: custom は from / to も書く', () => {
    const params = new URL(
      analyticsHref({ ...BASE_QUERY, period: 'custom', from: '2026-08-01', to: '2026-08-10' }),
      'http://x',
    ).searchParams;

    expect(params.get('period')).toBe('custom');
    expect(params.get('from')).toBe('2026-08-01');
    expect(params.get('to')).toBe('2026-08-10');
  });

  /**
   * #47。期間セグメントを押せば「当日」から抜ける（裁定 3.2）。
   *
   * 期間セグメントのリンクは今の `query` を引き継いで `period` だけを差し替える。
   * `period=today` が残ると、押しても当日のままになる。
   */
  it('当日から期間セグメントを押した URL に period=today が残らない', () => {
    const current: AnalyticsQuery = { ...BASE_QUERY, period: 'today', from: TODAY, to: TODAY };

    for (const period of ['7d', '30d', '90d', 'month', 'prev-month'] as const) {
      const href = analyticsHref({ ...current, period, page: 1 });

      expect(href, period).not.toContain('period=today');
    }
  });

  /** #47。カスタムへ移っても残らない。 */
  it('当日からカスタムを押した URL にも period=today が残らない', () => {
    const href = analyticsHref({
      ...BASE_QUERY,
      period: 'custom',
      from: TODAY,
      to: TODAY,
      page: 1,
    });

    expect(href).not.toContain('period=today');
    expect(href).toContain('period=custom');
  });
});

/**
 * 確定期間が空で本日に受信がある状態の案内（設計 §7.5.1、受け入れ条件 #76〜#84）。
 *
 * 定期ロールアップが走った直後は `pending.total === 0` になり `diagnoseReception` は
 * `receiving` を返す。計測タグを貼った初日の利用者はちょうどここを踏み、
 * 導線も出ないまま **0 が並ぶだけの概要タブ**を見る。それを塞ぐ案内の出し分け。
 *
 * **6 条件をすべて満たすときだけ出す**（a〜f）。判定は純関数に閉じるので I/O を持てない（#85）。
 *
 * | # | 条件 |
 * | --- | --- |
 * | a | `period !== 'today'` |
 * | b | `notTracked === null`（導線が出ていない） |
 * | c | `currentPointCount === 0` |
 * | d | `receivedToday` |
 * | e | `tab !== 'settings'` |
 * | f | `hasConfirmedRange`（`resolvePeriod().range !== null`） |
 *
 * **6 条件をすべて述語が持つ**（設計 §12.3）。`app/analytics/page.tsx` の分岐に散らさない。
 * 散らすと、どれか 1 つを取り違えても画面全体を組み上げるテストでしか気づけない
 * （検証レポート §3.1 #84）。
 */
describe('shouldShowStaleRangeNotice', () => {
  /** 6 条件をすべて満たす入力。各テストで 1 つずつ崩す。 */
  const SHOWN = {
    period: '7d',
    notTracked: null,
    currentPointCount: 0,
    receivedToday: true,
    tab: 'overview',
    hasConfirmedRange: true,
  } as const;

  /** #76。6 条件がそろえば出す。 */
  it('6 条件がすべてそろえば true', () => {
    expect(shouldShowStaleRangeNotice(SHOWN)).toBe(true);
  });

  /**
   * #76 / #84。**1 つ落とすだけで false になる**ことを 6 条件すべてで確かめる。
   *
   * どれか 1 つを述語が見落としていても、他の条件のテストは通ってしまう。
   * 6 条件を同じ形で並べておけば、抜けがそのまま 1 件の失敗になる。
   */
  it.each([
    ['a: period が today', { period: 'today' }],
    ['b: 導線が出ている', { notTracked: 'pending-rollup' }],
    ['c: 当期に点がある', { currentPointCount: 1 }],
    ['d: 今日は受信していない', { receivedToday: false }],
    ['e: 設定タブ', { tab: 'settings' }],
    ['f: 確定期間が求まらない', { hasConfirmedRange: false }],
  ] as const)('%s なら false', (_label, broken) => {
    expect(shouldShowStaleRangeNotice({ ...SHOWN, ...broken })).toBe(false);
  });

  /** #76。プリセット以外でも同じ（今日を含まないカスタム期間）。 */
  it.each(['7d', '30d', '90d', 'month', 'prev-month', 'custom'] as const)(
    'period が %s でも条件がそろえば true',
    (period) => {
      expect(shouldShowStaleRangeNotice({ ...SHOWN, period })).toBe(true);
    },
  );

  /** #76。設定タブ以外のどのタブでも出す（`AnalyticsView` に 1 つ置くため）。 */
  it.each(['overview', 'pages', 'referrers', 'visitors'] as const)(
    'tab が %s でも条件がそろえば true',
    (tab) => {
      expect(shouldShowStaleRangeNotice({ ...SHOWN, tab })).toBe(true);
    },
  );

  /**
   * #78（条件 d）。最終受信が昨日以前なら、当期が空なのは単に記録が無いから。
   * 「今日届いています」と書いたら嘘になる。
   */
  it('最終受信が今日でなければ false', () => {
    expect(shouldShowStaleRangeNotice({ ...SHOWN, receivedToday: false })).toBe(false);
  });

  /**
   * #79（条件 b / d）。一度も受信していなければ `not-received` の導線が出る。
   * `receivedToday` も偽になるので、二重に落ちる。
   */
  it('一度も受信していなければ false（not-received の導線が出る）', () => {
    expect(
      shouldShowStaleRangeNotice({
        ...SHOWN,
        notTracked: 'not-received',
        receivedToday: false,
      }),
    ).toBe(false);
  });

  /** #80（条件 c）。数字が出ているときに「確定値はまだありません」と書かない。 */
  it('当期に集計値が 1 件でもあれば false', () => {
    expect(shouldShowStaleRangeNotice({ ...SHOWN, currentPointCount: 1 })).toBe(false);
  });

  /** #81（条件 a）。当日を見ているのに当日への導線は出さない。 */
  it('period が today なら false', () => {
    expect(shouldShowStaleRangeNotice({ ...SHOWN, period: 'today' })).toBe(false);
  });

  /**
   * #82（条件 b）。導線が出ているときはタブの中身ごと差し替わっている。
   * 案内と導線で「当日を見る」が 2 つ並ぶのを避ける。
   */
  it.each(['not-received', 'pending-rollup', 'bots-only'] as const)(
    '導線（%s）が出ていれば false',
    (notTracked) => {
      expect(shouldShowStaleRangeNotice({ ...SHOWN, notTracked })).toBe(false);
    },
  );

  /** #83（条件 e）。設定タブは期間に依存しない。 */
  it('設定タブでは false', () => {
    expect(shouldShowStaleRangeNotice({ ...SHOWN, tab: 'settings' })).toBe(false);
  });

  /**
   * #84（条件 f）。**今日が月の 1 日で `?period=month` のとき**。
   *
   * §7.2 の空状態（`EmptyPeriodNotice`）だけを出し、この案内は出さない。
   * 並べると「当日を見る」導線が 2 つ出る。
   *
   * **他の 5 条件をすべて満たしていても `false` になる**ことが要点。
   * 実行日が月の 1 日かどうかに依らず決まる。
   */
  it('確定期間が求まらなければ、他の 5 条件をすべて満たしていても false', () => {
    const monthOnFirstDay = { ...SHOWN, period: 'month', hasConfirmedRange: false } as const;

    // 他の 5 条件は満たしている（f だけが falsy）ことを、対にして示す。
    expect(shouldShowStaleRangeNotice({ ...monthOnFirstDay, hasConfirmedRange: true })).toBe(true);
    expect(shouldShowStaleRangeNotice(monthOnFirstDay)).toBe(false);
  });

  /** #84。`month` に限らない（`range === null` は月の 1 日の `month` だけだが、述語は期間を問わない）。 */
  it.each(['7d', '30d', '90d', 'month', 'prev-month', 'custom'] as const)(
    'period が %s でも、確定期間が求まらなければ false',
    (period) => {
      expect(shouldShowStaleRangeNotice({ ...SHOWN, period, hasConfirmedRange: false })).toBe(
        false,
      );
    },
  );

  /** #85。判定は同期関数（I/O を持てない ＝ 問い合わせが増えない）。 */
  it('同期関数である（Promise を返さない）', () => {
    expect(shouldShowStaleRangeNotice(SHOWN)).not.toBeInstanceOf(Promise);
    expect(typeof shouldShowStaleRangeNotice(SHOWN)).toBe('boolean');
  });
});

/**
 * 内訳のページ送り（設計 §12.3、受け入れ条件 #58）。
 *
 * 当日は `listAnalyticsBreakdown` を呼ばず、`breakdownFromPoints` の結果を
 * **メモリ上で切る**（§11.3 / §13-3）。その切り出しを純関数にする。
 *
 * ```ts
 * pageSlice<T>(items: readonly T[], page: number, perPage: number):
 *   { readonly items: readonly T[]; readonly total: number }
 * ```
 *
 * * `page` は **1 起点**
 * * `total` は**スライス前の全件数**（`listAnalyticsBreakdown` の `meta.total` と同じ意味。
 *   ページ送りの総ページ数がここから出る）
 * * 取り出す範囲は `[(page − 1) × perPage, page × perPage)`
 * * 範囲外のページは `items` が空、`total` はそのまま
 * * 防御：`page < 1` は 1 として扱う。`perPage <= 0` は `items` を空にする
 *
 * **切り出す理由**：現状のスライスは `page.tsx` のクロージャの中の算術で、
 * オフセットを取り違えても全テストが通る（検証レポート §3.1 #58）。
 * 純関数にすれば「51 件目が 2 ページ目の先頭に来る」を単体で固定できる。
 */
describe('pageSlice', () => {
  /** 1 起点の連番。値と位置の対応が一目で分かるようにする（`items[0]` が 1）。 */
  function numbered(count: number): readonly number[] {
    return Array.from({ length: count }, (_, index) => index + 1);
  }

  /** 画面の 1 ページの行数（`TABLE_PER_PAGE`）。 */
  const PER_PAGE = 50;

  /**
   * #58。**オフセットを 1 つ取り違えたら落ちる**中心のテスト。
   *
   * 51 件を 50 件ずつに切ると、1 ページ目は 1〜50 件目、2 ページ目は 51 件目だけ。
   * `offset` を `page * perPage` や `(page - 1) * perPage + 1` と書き間違えると、
   * ここで必ず落ちる。
   */
  it('51 件を 50 件ずつに切ると、1 ページ目が 1〜50 件目、2 ページ目の先頭が 51 件目', () => {
    const items = numbered(51);

    const first = pageSlice(items, 1, PER_PAGE);
    const second = pageSlice(items, 2, PER_PAGE);

    expect(first.items).toEqual(numbered(50));
    expect(second.items).toEqual([51]);
  });

  /** #58。1 ページ目の末尾と 2 ページ目の先頭が隣り合う（重複も抜けもない）。 */
  it('1 ページ目の末尾の次が 2 ページ目の先頭になる', () => {
    const items = numbered(51);

    const first = pageSlice(items, 1, PER_PAGE);
    const second = pageSlice(items, 2, PER_PAGE);

    expect(first.items.at(-1)).toBe(50);
    expect(second.items[0]).toBe(51);
  });

  /** #58。`total` はスライス前の全件数。ページ送りの総ページ数がここから出る。 */
  it('total はスライス前の全件数（どのページでも変わらない）', () => {
    const items = numbered(51);

    expect(pageSlice(items, 1, PER_PAGE).total).toBe(51);
    expect(pageSlice(items, 2, PER_PAGE).total).toBe(51);
    expect(pageSlice(items, 99, PER_PAGE).total).toBe(51);
  });

  /** #58。境界：ちょうど割り切れるとき、次のページは空になる。 */
  it('50 件を 50 件ずつに切ると、2 ページ目は空', () => {
    const items = numbered(50);

    expect(pageSlice(items, 1, PER_PAGE).items).toEqual(numbered(50));
    expect(pageSlice(items, 2, PER_PAGE).items).toEqual([]);
    expect(pageSlice(items, 2, PER_PAGE).total).toBe(50);
  });

  /** #58。境界：最終ページの端数。 */
  it('最終ページには端数だけが出る', () => {
    const items = numbered(123);

    const last = pageSlice(items, 3, PER_PAGE);

    expect(last.items).toEqual([
      101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
      120, 121, 122, 123,
    ]);
    expect(last.items).toHaveLength(23);
    expect(last.total).toBe(123);
  });

  /** #58。範囲外のページは空。**`total` はそのまま**（画面が「全 N 件」を出し続けられる）。 */
  it('範囲外のページは items が空で、total はそのまま', () => {
    const result = pageSlice(numbered(51), 3, PER_PAGE);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(51);
  });

  /** #58。小さい perPage でも境界がずれない。 */
  it.each([
    [1, [1, 2, 3]],
    [2, [4, 5, 6]],
    [3, [7]],
    [4, []],
  ] as const)('7 件を 3 件ずつに切ると %i ページ目は %j', (page, expected) => {
    expect(pageSlice(numbered(7), page, 3).items).toEqual(expected);
  });

  /** #58。防御：`page < 1` は 1 ページ目として扱う（負のオフセットで末尾から切らない）。 */
  it.each([0, -1, -50])('page が %i でも 1 ページ目を返す', (page) => {
    const result = pageSlice(numbered(51), page, PER_PAGE);

    expect(result.items).toEqual(numbered(50));
    expect(result.total).toBe(51);
  });

  /** #58。防御：`perPage <= 0` は空（`slice(0, 0)` で全件を返さない）。 */
  it.each([0, -1])('perPage が %i なら items は空で total はそのまま', (perPage) => {
    const result = pageSlice(numbered(51), 1, perPage);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(51);
  });

  /** #58。空の入力でも落ちない。 */
  it('空配列なら items も空で total は 0', () => {
    expect(pageSlice([], 1, PER_PAGE)).toEqual({ items: [], total: 0 });
  });

  /** #58。元の配列を壊さない（`splice` などで切っていない）。 */
  it('元の配列を変更しない', () => {
    const items = numbered(51);

    pageSlice(items, 2, PER_PAGE);

    expect(items).toHaveLength(51);
    expect(items[0]).toBe(1);
  });

  /**
   * #58。**並び順を変えない。**
   *
   * 並び順は `breakdownFromPoints` が Repository の `sumByKey` と揃えてある。
   * ここで並べ替えると、当日と確定期間で行の順番が変わる。
   */
  it('渡された順序のまま切り出す', () => {
    const items = ['/c', '/a', '/b'];

    expect(pageSlice(items, 1, 2).items).toEqual(['/c', '/a']);
    expect(pageSlice(items, 2, 2).items).toEqual(['/b']);
  });
});
