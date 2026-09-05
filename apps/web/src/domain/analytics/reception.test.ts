import { describe, expect, it } from 'vitest';
import { botsOnlyInPeriod, diagnoseReception, type ReceptionInput } from './reception';

/**
 * 受信状況の 4 状態（029-scheduled-jobs 設計 §5.5、受け入れ条件 #6〜#11）。
 *
 * **030-analytics-today 設計 §9.1 で入力 1 フィールドを改名した**（受け入れ条件 #18〜#20）。
 * 出力（4 状態）と判定の優先順位は 1 つも変えていない。
 *
 * ```
 * ReceptionInput.periodIncludesToday   →   ReceptionInput.periodMayLackRollup
 * ```
 *
 * | 項目 | 現行 | 本設計 |
 * | --- | --- | --- |
 * | 意味 | 当期の `to` が今日以降か | 当期の末尾が、まだ集計が追いついていない可能性のある日に掛かるか |
 * | 呼び出し側が渡す値 | `resolved.to >= today` | `resolved.to >= yesterday` |
 *
 * プリセットの `to` が昨日になると `to >= today` はプリセットでは常に偽になり、
 * 「昨日届いたがまだ集計されていない」状態で `pending-rollup` が二度と出なくなる。
 * それを避けるために判定の入力を `to >= 昨日` に広げるので、
 * `periodIncludesToday` という名前が嘘になる。**名前だけを意図に合わせる。**
 *
 * 判定は上から順に最初に当たったもの：
 *
 * | 条件 | 状態 |
 * | --- | --- |
 * | `lastReceivedAt === null` | `not-received` |
 * | `hasPointsInPeriod` | `receiving` |
 * | `!periodMayLackRollup` | `receiving` |
 * | `pending.total === 0` | `receiving` |
 * | `pending.bots === pending.total` | `bots-only` |
 * | それ以外 | `pending-rollup` |
 */

const RECEIVED_AT = new Date('2026-09-04T01:00:00Z');

/** 「届いている・当期に集計値が無い・当期の末尾は未集計がありうる日」を既定にした入力。 */
function input(overrides: Partial<ReceptionInput> = {}): ReceptionInput {
  return {
    lastReceivedAt: RECEIVED_AT,
    pending: { total: 0, bots: 0 },
    hasPointsInPeriod: false,
    periodMayLackRollup: true,
    ...overrides,
  };
}

describe('diagnoseReception', () => {
  /** #6 / #19 */
  it('一度も届いていなければ、未集計があっても not-received', () => {
    expect(diagnoseReception(input({ lastReceivedAt: null, pending: { total: 5, bots: 1 } }))).toBe(
      'not-received',
    );
  });

  /** #6 / #19。他の値に関わらず。 */
  it('一度も届いていなければ、当期に集計値があっても not-received', () => {
    expect(
      diagnoseReception(
        input({ lastReceivedAt: null, hasPointsInPeriod: true, periodMayLackRollup: false }),
      ),
    ).toBe('not-received');
  });

  /** #7 / #19 */
  it('届いていて当期に集計値が無く、未集計に人のアクセスがあれば pending-rollup', () => {
    expect(diagnoseReception(input({ pending: { total: 3, bots: 1 } }))).toBe('pending-rollup');
  });

  /** #8 / #19 */
  it('未集計がすべて Bot なら bots-only', () => {
    expect(diagnoseReception(input({ pending: { total: 2, bots: 2 } }))).toBe('bots-only');
  });

  /** #8 / #19 */
  it('未集計が 0 件なら receiving', () => {
    expect(diagnoseReception(input({ pending: { total: 0, bots: 0 } }))).toBe('receiving');
  });

  /** #9 / #19 / #20。過去の期間に「集計待ち」は出さない。 */
  it('当期に集計が追いつく余地が無ければ、未集計に人のアクセスがあっても receiving', () => {
    expect(
      diagnoseReception(input({ periodMayLackRollup: false, pending: { total: 3, bots: 0 } })),
    ).toBe('receiving');
  });

  /** #20。未集計がすべて Bot でも、追いつく余地が無ければ bots-only にしない。 */
  it('追いつく余地が無ければ、未集計がすべて Bot でも receiving', () => {
    expect(
      diagnoseReception(input({ periodMayLackRollup: false, pending: { total: 2, bots: 2 } })),
    ).toBe('receiving');
  });

  /** #10 / #19。集計済みなら常にタブを出す（Bot だけの期間は概要タブの警告で示す）。 */
  it('当期に集計値があれば、未集計がすべて Bot でも receiving', () => {
    expect(
      diagnoseReception(input({ hasPointsInPeriod: true, pending: { total: 5, bots: 5 } })),
    ).toBe('receiving');
  });

  /**
   * #18。**旧名を読んでいないこと**を実行時に確かめる。
   *
   * 型を変えただけで判定が旧名を読み続けていると、`periodMayLackRollup` を渡す側の値が
   * 無視され、`pending-rollup` の出方が静かに変わる。旧名だけを載せた入力を渡したとき、
   * `periodMayLackRollup` が未定義（＝偽）として扱われることで見分ける。
   */
  it('periodIncludesToday という名前ではもう判定しない', () => {
    const legacy = {
      lastReceivedAt: RECEIVED_AT,
      pending: { total: 3, bots: 0 },
      hasPointsInPeriod: false,
      periodIncludesToday: true,
    } as unknown as ReceptionInput;

    // 旧名を読んでいれば pending-rollup になる。読んでいなければ「追いつく余地なし」で receiving。
    expect(diagnoseReception(legacy)).toBe('receiving');
  });
});

/** #11 */
describe('botsOnlyInPeriod', () => {
  it('人の PV が 0 で Bot の PV が 1 以上なら true', () => {
    expect(botsOnlyInPeriod({ pageviews: 0, botPageviews: 3 })).toBe(true);
  });

  it('人の PV があれば false', () => {
    expect(botsOnlyInPeriod({ pageviews: 1, botPageviews: 3 })).toBe(false);
  });

  it('どちらも 0 なら false（集計値が無いだけ）', () => {
    expect(botsOnlyInPeriod({ pageviews: 0, botPageviews: 0 })).toBe(false);
  });
});
