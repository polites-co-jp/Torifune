import { describe, expect, it } from 'vitest';
import { rangeDays } from '@/domain/analytics/analytics';
import {
  ANALYTICS_PERIODS,
  PERIOD_LABEL,
  RANGE_SEPARATOR,
  appliedPeriodText,
  dateRangeText,
  rangeText,
  staleRangeNoticeText,
} from './labels';

/**
 * 期間の並び・表示名・文言（034-analytics-period-scope 設計 §7.1.2 / §7.3.1、
 * 受け入れ条件 B #12〜#14、C #15〜#23）。
 *
 * ```ts
 * const ANALYTICS_PERIODS: readonly AnalyticsPeriod[];   // 先頭が 'yesterday'、7 個
 * const PERIOD_LABEL: Record<AnalyticsPeriod, string>;   // yesterday: '昨日'
 *
 * // 1 日なら日付 1 つ、複数日なら「from 〜 to」。
 * function dateRangeText(from: string, to: string): string;
 *
 * // 適用中の期間の 1 行。
 * function appliedPeriodText(input: {
 *   readonly period: AnalyticsPeriod;
 *   readonly from: string;
 *   readonly to: string;
 * }): string;
 * ```
 *
 * | 期間 | `appliedPeriodText` |
 * | --- | --- |
 * | `7d`（`2026-09-02` 〜 `2026-09-08`） | `期間 2026-09-02 〜 2026-09-08（7 日間）` |
 * | `yesterday`（`2026-09-08`） | `期間 2026-09-08` |
 * | `custom` で 1 日（`2026-09-08`） | `期間 2026-09-08` |
 * | `today`（`2026-09-09`） | `期間 当日（2026-09-09）` |
 *
 * **`rangeText` は変えない**（§7.3.1）。ヘッダ行の「前期間（… 〜 …）」は
 * 030 §7.4.1 が定めた形で、E2E が固定している。当期の表示のために既存の契約を動かさない。
 */

const FROM = '2026-09-02';
const TO = '2026-09-08';
const ONE_DAY = '2026-09-08';
const TODAY = '2026-09-09';

describe('ANALYTICS_PERIODS（#12 / #14）', () => {
  /** #12。**先頭が `yesterday`**（裁定 3.1。「7日」の左）。7 個。 */
  it('yesterday を先頭に 7 個並ぶ', () => {
    expect([...ANALYTICS_PERIODS]).toEqual([
      'yesterday',
      '7d',
      '30d',
      '90d',
      'month',
      'prev-month',
      'custom',
    ]);
  });

  /** #12 */
  it('先頭は yesterday', () => {
    expect(ANALYTICS_PERIODS[0]).toBe('yesterday');
  });

  /** #12 */
  it('要素数は 7', () => {
    expect(ANALYTICS_PERIODS).toHaveLength(7);
  });

  /** #12。「昨日」は「7日」の左（並びの位置で確かめる）。 */
  it('yesterday は 7d より前', () => {
    const periods = [...ANALYTICS_PERIODS];

    expect(periods.indexOf('yesterday')).toBeLessThan(periods.indexOf('7d'));
  });

  /**
   * #14。**「当日」の `SegmentedControl` には入れない**（裁定 3.1 / 030 §7.1.3）。
   *
   * 左のグループは「確定値ではない速報値」1 つだけを持つ群であり、
   * そこに確定値を混ぜると群の意味が壊れる。
   */
  it("'today' を含まない", () => {
    expect(ANALYTICS_PERIODS as readonly string[]).not.toContain('today');
  });

  /** #12。`custom` は末尾のまま。 */
  it('末尾は custom', () => {
    expect(ANALYTICS_PERIODS[ANALYTICS_PERIODS.length - 1]).toBe('custom');
  });
});

describe('PERIOD_LABEL（#13）', () => {
  /** #13 */
  it('yesterday の表示名は「昨日」', () => {
    expect(PERIOD_LABEL['yesterday']).toBe('昨日');
  });

  /** #13。既存の表示名は変えない。 */
  it.each([
    ['today', '当日'],
    ['7d', '7日'],
    ['30d', '30日'],
    ['90d', '90日'],
    ['month', '今月'],
    ['prev-month', '前月'],
    ['custom', 'カスタム'],
  ] as const)('%s の表示名は「%s」のまま', (period, label) => {
    expect(PERIOD_LABEL[period]).toBe(label);
  });

  /** #13。画面に並ぶ 7 項目すべてに表示名がある。 */
  it.each([...ANALYTICS_PERIODS])('%s に表示名がある', (period) => {
    expect(PERIOD_LABEL[period]).toBeTruthy();
  });
});

describe('dateRangeText（#15 / #16）', () => {
  /** #15。複数日は `from 〜 to`。 */
  it('複数日は「from 〜 to」', () => {
    expect(dateRangeText(FROM, TO)).toBe('2026-09-02 〜 2026-09-08');
  });

  /**
   * #16。**1 日のときは日付を 1 つだけ出す**（設計 §7.3.1）。
   *
   * `2026-09-08 〜 2026-09-08` は同じ日付が 2 回並ぶだけで、読み手に何も足さない。
   */
  it('1 日は日付 1 つ', () => {
    expect(dateRangeText(ONE_DAY, ONE_DAY)).toBe('2026-09-08');
  });

  /** #16。`〜` を含まない。 */
  it('1 日のときは区切りの「〜」を含まない', () => {
    expect(dateRangeText(ONE_DAY, ONE_DAY)).not.toContain(RANGE_SEPARATOR);
  });

  /** #15。2 日なら区切りが出る（1 日の分岐が広すぎないこと）。 */
  it('2 日なら「〜」が出る', () => {
    expect(dateRangeText('2026-09-07', '2026-09-08')).toBe('2026-09-07 〜 2026-09-08');
  });
});

describe('appliedPeriodText（#17〜#21）', () => {
  /** #17。複数日には日数を添える（`7日` というラベルと実際の日数を画面で照合できる）。 */
  it('7d（7 日間）は「期間 from 〜 to（7 日間）」', () => {
    expect(appliedPeriodText({ period: '7d', from: FROM, to: TO })).toBe(
      '期間 2026-09-02 〜 2026-09-08（7 日間）',
    );
  });

  /** #18。1 日は日付 1 つで、**日数を添えない**（日付 1 つで自明）。 */
  it('yesterday は「期間 2026-09-08」（日数を添えない）', () => {
    expect(appliedPeriodText({ period: 'yesterday', from: ONE_DAY, to: ONE_DAY })).toBe(
      '期間 2026-09-08',
    );
  });

  /** #18。`（1 日間）` を出さない。 */
  it('1 日の期間に「（1 日間）」を出さない', () => {
    expect(appliedPeriodText({ period: 'yesterday', from: ONE_DAY, to: ONE_DAY })).not.toContain(
      '1 日間',
    );
  });

  /**
   * #19。**当日だけは「当日（日付）」と書く**（設計 §7.3.1）。
   *
   * 当日（生ログの速報値）と 1 日のカスタム（集計値）は同じ日付を指すのに値が違いうる。
   * 日付だけを出すと、この 2 つが画面上で見分けられなくなる。
   */
  it('today は「期間 当日（2026-09-09）」', () => {
    expect(appliedPeriodText({ period: 'today', from: TODAY, to: TODAY })).toBe(
      '期間 当日（2026-09-09）',
    );
  });

  /** #20。**当日と同じ日付でも `custom` には「当日」と書かない。** */
  it('custom で今日 1 日でも「当日」と書かない', () => {
    const text = appliedPeriodText({ period: 'custom', from: TODAY, to: TODAY });

    expect(text).toBe('期間 2026-09-09');
    expect(text).not.toContain('当日');
  });

  /** #20 / #19。当日と 1 日のカスタムが同じ文字列にならない（画面で見分けられる）。 */
  it('today と custom（同じ日付 1 日）で文字列が違う', () => {
    expect(appliedPeriodText({ period: 'today', from: TODAY, to: TODAY })).not.toBe(
      appliedPeriodText({ period: 'custom', from: TODAY, to: TODAY }),
    );
  });

  /** #18。1 日のカスタムも「期間 日付」だけ。 */
  it('custom で 1 日は「期間 2026-09-08」', () => {
    expect(appliedPeriodText({ period: 'custom', from: ONE_DAY, to: ONE_DAY })).toBe(
      '期間 2026-09-08',
    );
  });

  /** #17。複数日のプリセットはどれも同じ形（プリセットごとに書き分けない）。 */
  it.each(['7d', '30d', '90d', 'month', 'prev-month', 'custom'] as const)(
    '%s（複数日）は「期間 from 〜 to（N 日間）」',
    (period) => {
      expect(appliedPeriodText({ period, from: FROM, to: TO })).toBe(
        '期間 2026-09-02 〜 2026-09-08（7 日間）',
      );
    },
  );

  /** #17。先頭は「期間 」。 */
  it('「期間 」で始まる', () => {
    expect(appliedPeriodText({ period: '7d', from: FROM, to: TO }).startsWith('期間 ')).toBe(true);
  });

  /**
   * #21。**日数は両端を含む**。`rangeDays` と一致する（独自に数えない）。
   */
  it.each([
    ['2026-09-08', '2026-09-08', 1],
    ['2026-09-07', '2026-09-08', 2],
    [FROM, TO, 7],
    ['2026-08-10', '2026-09-08', 30],
  ] as const)('%s 〜 %s は %i 日間（rangeDays と一致）', (from, to, days) => {
    expect(rangeDays(from, to)).toBe(days);

    const text = appliedPeriodText({ period: 'custom', from, to });
    if (days === 1) {
      expect(text).not.toContain('日間');
    } else {
      expect(text).toContain(`（${days} 日間）`);
    }
  });

  /** #21。月をまたぐ期間でも日数が合う。 */
  it('月をまたぐ期間の日数が rangeDays と一致する', () => {
    const from = '2026-08-30';
    const to = '2026-09-02';

    expect(appliedPeriodText({ period: 'custom', from, to })).toContain(
      `（${rangeDays(from, to)} 日間）`,
    );
  });

  /** #17 / #18。1 日のときと複数日のときで、日付の出方が `dateRangeText` と揃っている。 */
  it.each([
    ['2026-09-08', '2026-09-08'],
    [FROM, TO],
  ] as const)('日付の部分が dateRangeText と揃う（%s 〜 %s）', (from, to) => {
    expect(appliedPeriodText({ period: 'custom', from, to })).toContain(dateRangeText(from, to));
  });
});

/**
 * #22。**`rangeText` は変えない**（設計 §7.3.1）。
 *
 * ヘッダ行の「前期間（… 〜 …）」は 030 §7.4.1 の契約で、E2E が文言を固定している。
 * 当期の表示のために既存の契約を動かさない。ここが先に落ちる形にしておく。
 */
describe('rangeText は変わらない（#22）', () => {
  /** #22。1 日でも `from 〜 to` のまま（`dateRangeText` と違う）。 */
  it('1 日でも「2026-09-08 〜 2026-09-08」のまま', () => {
    expect(rangeText(ONE_DAY, ONE_DAY)).toBe('2026-09-08 〜 2026-09-08');
  });

  /** #22。複数日も現行どおり。 */
  it('複数日は「from 〜 to」', () => {
    expect(rangeText(FROM, TO)).toBe('2026-09-02 〜 2026-09-08');
  });

  /** #22。1 日のとき `dateRangeText` と `rangeText` は別物である（取り違えの検出）。 */
  it('1 日のとき dateRangeText とは違う結果になる', () => {
    expect(rangeText(ONE_DAY, ONE_DAY)).not.toBe(dateRangeText(ONE_DAY, ONE_DAY));
  });

  /** #22。複数日では両者が一致する（`dateRangeText` が複数日で形を変えていない）。 */
  it('複数日では dateRangeText と一致する', () => {
    expect(rangeText(FROM, TO)).toBe(dateRangeText(FROM, TO));
  });
});

/**
 * #23。§7.5.1 の案内の「この期間（…）」は `dateRangeText` を使う形へ直す（設計 §7.3.1）。
 *
 * 1 日の期間で案内が出たとき、そこだけ `〜` を挟んだ形になるのを避ける。
 */
describe('staleRangeNoticeText（#23）', () => {
  /** #23 */
  it('1 日の期間では「この期間（2026-09-08）」を含む', () => {
    expect(staleRangeNoticeText(ONE_DAY, ONE_DAY)).toContain('この期間（2026-09-08）');
  });

  /** #23。1 日のとき `〜` を挟まない。 */
  it('1 日の期間では「〜」を含まない', () => {
    expect(staleRangeNoticeText(ONE_DAY, ONE_DAY)).not.toContain(RANGE_SEPARATOR);
  });

  /** #23。複数日では現行どおり `from 〜 to`。 */
  it('複数日では「この期間（from 〜 to）」のまま', () => {
    expect(staleRangeNoticeText(FROM, TO)).toContain('この期間（2026-09-02 〜 2026-09-08）');
  });

  /** #23。案内の他の文言は変えない（030 §7.5.1 の契約）。 */
  it('案内の他の文言は変わらない', () => {
    const text = staleRangeNoticeText(ONE_DAY, ONE_DAY);

    expect(text).toContain('確定値はまだありません');
    expect(text).toContain('アクセスは今日届いています');
    expect(text).toContain('集計は前日まで');
    expect(text).not.toContain('次回の集計');
  });
});
