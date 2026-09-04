import { describe, expect, it } from 'vitest';
import { botsOnlyInPeriod, diagnoseReception, type ReceptionInput } from './reception';

/**
 * 受信状況の 4 状態（029-scheduled-jobs 設計 §5.5、受け入れ条件 #6〜#11）。
 *
 * 判定は上から順に最初に当たったもの：
 *
 * | 条件 | 状態 |
 * | --- | --- |
 * | `lastReceivedAt === null` | `not-received` |
 * | `hasPointsInPeriod` | `receiving` |
 * | `!periodIncludesToday` | `receiving` |
 * | `pending.total === 0` | `receiving` |
 * | `pending.bots === pending.total` | `bots-only` |
 * | それ以外 | `pending-rollup` |
 */

const RECEIVED_AT = new Date('2026-09-04T01:00:00Z');

/** 「届いている・当期に集計値が無い・当期は今日を含む」を既定にした入力。 */
function input(overrides: Partial<ReceptionInput> = {}): ReceptionInput {
  return {
    lastReceivedAt: RECEIVED_AT,
    pending: { total: 0, bots: 0 },
    hasPointsInPeriod: false,
    periodIncludesToday: true,
    ...overrides,
  };
}

describe('diagnoseReception', () => {
  /** #6 */
  it('一度も届いていなければ、未集計があっても not-received', () => {
    expect(diagnoseReception(input({ lastReceivedAt: null, pending: { total: 5, bots: 1 } }))).toBe(
      'not-received',
    );
  });

  /** #6。他の値に関わらず。 */
  it('一度も届いていなければ、当期に集計値があっても not-received', () => {
    expect(
      diagnoseReception(
        input({ lastReceivedAt: null, hasPointsInPeriod: true, periodIncludesToday: false }),
      ),
    ).toBe('not-received');
  });

  /** #7 */
  it('届いていて当期に集計値が無く、未集計に人のアクセスがあれば pending-rollup', () => {
    expect(diagnoseReception(input({ pending: { total: 3, bots: 1 } }))).toBe('pending-rollup');
  });

  /** #8 */
  it('未集計がすべて Bot なら bots-only', () => {
    expect(diagnoseReception(input({ pending: { total: 2, bots: 2 } }))).toBe('bots-only');
  });

  /** #8 */
  it('未集計が 0 件なら receiving', () => {
    expect(diagnoseReception(input({ pending: { total: 0, bots: 0 } }))).toBe('receiving');
  });

  /** #9。過去の期間に「集計待ち」は出さない。 */
  it('当期が今日を含まなければ、未集計に人のアクセスがあっても receiving', () => {
    expect(
      diagnoseReception(input({ periodIncludesToday: false, pending: { total: 3, bots: 0 } })),
    ).toBe('receiving');
  });

  /** #10。集計済みなら常にタブを出す（Bot だけの期間は概要タブの警告で示す）。 */
  it('当期に集計値があれば、未集計がすべて Bot でも receiving', () => {
    expect(
      diagnoseReception(input({ hasPointsInPeriod: true, pending: { total: 5, bots: 5 } })),
    ).toBe('receiving');
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
