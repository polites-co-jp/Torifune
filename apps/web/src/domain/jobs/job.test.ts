import { describe, expect, it } from 'vitest';
import {
  JOB_ERROR_MAX_LENGTH,
  JOB_NAMES,
  JOB_RUN_RETENTION,
  JobBusyError,
  ROLLUP_MAX_LOOKBACK_DAYS,
  isJobName,
  parseIntervalMinutes,
  parseSchedulerSwitch,
  scheduledRollupFrom,
  truncateError,
} from './job';

/**
 * ジョブの Domain 純関数（029-scheduled-jobs 設計 §5.3、受け入れ条件 #3〜#5、#11a）。
 *
 * 環境変数の解釈は「不正なら null（呼ぶ側が既定に落として警告する）」。
 * 定期ロールアップの `from` は「最後の成功の開始日、ただし今日 − 7 日より前にしない、成功が無ければ昨日」（裁定 #5）。
 */

describe('JOB_NAMES / isJobName', () => {
  it('Core の 2 ジョブが名前の順に並ぶ', () => {
    expect(JOB_NAMES).toEqual(['analytics.rollup', 'webhook.deliver']);
  });

  it('isJobName は登録済みの名前だけを真にする', () => {
    expect(isJobName('analytics.rollup')).toBe(true);
    expect(isJobName('webhook.deliver')).toBe(true);
    expect(isJobName('analytics.prune')).toBe(false);
    expect(isJobName('')).toBe(false);
  });

  it('保持件数は 50、エラーの上限は 2000 文字、さかのぼりは 7 日', () => {
    expect(JOB_RUN_RETENTION).toBe(50);
    expect(JOB_ERROR_MAX_LENGTH).toBe(2000);
    expect(ROLLUP_MAX_LOOKBACK_DAYS).toBe(7);
  });
});

/** #3 */
describe('parseSchedulerSwitch', () => {
  it.each([undefined, '', 'on', 'ON'])('%j は true（既定で有効）', (raw) => {
    expect(parseSchedulerSwitch(raw)).toBe(true);
  });

  it.each(['off', 'Off'])('%j は false（大文字小文字を問わない）', (raw) => {
    expect(parseSchedulerSwitch(raw)).toBe(false);
  });

  it.each(['no', '0'])('%j は null（不正。呼ぶ側が既定に落として警告する）', (raw) => {
    expect(parseSchedulerSwitch(raw)).toBeNull();
  });
});

/** #4 */
describe('parseIntervalMinutes', () => {
  it.each([undefined, ''])('%j は null（未設定。既定を使う）', (raw) => {
    expect(parseIntervalMinutes(raw)).toBeNull();
  });

  it.each([
    ['15', 15],
    ['1', 1],
    ['1440', 1440],
  ])('%j は %d（1〜1440 の整数）', (raw, expected) => {
    expect(parseIntervalMinutes(raw)).toBe(expected);
  });

  it.each(['0', '1441', '1.5', 'abc', '-5'])('%j は null（範囲外・整数でない）', (raw) => {
    const parsed = parseIntervalMinutes(raw);
    expect(parsed).toBeNull();
    // NaN を返して呼ぶ側の比較を狂わせない。
    expect(Number.isNaN(parsed as unknown)).toBe(false);
  });
});

/** #5 */
describe('truncateError', () => {
  it('2000 文字を超える文字列を 2000 文字に切る', () => {
    const truncated = truncateError('x'.repeat(2500));

    expect(truncated).toHaveLength(2000);
    expect(truncated).toBe('x'.repeat(2000));
  });

  it('ちょうど 2000 文字はそのまま返す', () => {
    expect(truncateError('y'.repeat(2000))).toBe('y'.repeat(2000));
  });

  it('2000 文字以下はそのまま返す', () => {
    expect(truncateError('接続に失敗した')).toBe('接続に失敗した');
    expect(truncateError('')).toBe('');
  });

  /**
   * #5（§5.3.1）。**コードポイント単位で切る。**
   *
   * `slice(0, 2000)` は UTF-16 コードユニット単位なので、サロゲートペアの途中で切れると
   * 孤立サロゲートが残り、画面と JSON で文字が壊れる。PostgreSQL の `char_length`（文字単位）で
   * 見る `job_runs_error_length`（2000）の制約とも食い違う。
   */
  it('絵文字だけの文字列を 2000 コードポイントに切る', () => {
    // コードユニットでは 3000、コードポイントでは 1500。
    const truncated = truncateError('😀'.repeat(1500));

    // 1500 コードポイントなので切られない。
    expect([...truncated]).toHaveLength(1500);
    expect(truncated).toBe('😀'.repeat(1500));
  });

  it('2000 コードポイントを超える絵文字の列は 2000 コードポイントに切る', () => {
    const truncated = truncateError('😀'.repeat(2500));

    expect([...truncated]).toHaveLength(2000);
    // コードユニット数ではなくコードポイント数で 2000。
    expect(truncated.length).toBe(4000);
  });

  it('切った結果に孤立サロゲートが残らない', () => {
    const truncated = truncateError('😀'.repeat(2500));

    expect([...truncated].every((character) => (character.codePointAt(0) ?? 0) > 0xffff)).toBe(
      true,
    );
    // 孤立サロゲート（\uD800〜\uDFFF の単独）を含まない。
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(truncated),
    ).toBe(false);
  });

  /** #5。境界：2000 文字目がサロゲートペアでも壊れない。 */
  it('2000 文字目がサロゲートペアの境界でも壊れない', () => {
    // 1999 文字の ASCII + 絵文字 2 つ = 2001 コードポイント。2000 文字目が絵文字。
    const truncated = truncateError(`${'a'.repeat(1999)}😀😀`);

    expect([...truncated]).toHaveLength(2000);
    expect(truncated.endsWith('😀')).toBe(true);
    expect(truncated).toBe(`${'a'.repeat(1999)}😀`);
  });

  /** #5。2001 文字目が絵文字なら、その手前で止まる（半分だけ残さない）。 */
  it('切断位置がペアの途中になるときは 1 つ手前で止まる', () => {
    // 2000 文字の ASCII + 絵文字。コードユニットで切ると 2000 番目は 'a' なので影響が出ないが、
    // 1999 文字 + 絵文字 + 'b' で「コードユニット 2000 = サロゲートの片割れ」を作る。
    const truncated = truncateError(`${'a'.repeat(1999)}😀${'b'.repeat(10)}`);

    expect([...truncated]).toHaveLength(2000);
    expect(truncated).toBe(`${'a'.repeat(1999)}😀`);
  });
});

/** #11a。today = 2026-09-10。 */
describe('scheduledRollupFrom', () => {
  const today = '2026-09-10';

  it('成功の記録が無ければ昨日', () => {
    expect(scheduledRollupFrom({ lastSucceededStartedAt: null, today })).toBe('2026-09-09');
  });

  it('最後の成功が 3 日前なら、その開始日（境界日を含めて流し直す）', () => {
    expect(scheduledRollupFrom({ lastSucceededStartedAt: '2026-09-07', today })).toBe('2026-09-07');
  });

  it('最後の成功が 10 日前なら、7 日前で頭打ち', () => {
    expect(scheduledRollupFrom({ lastSucceededStartedAt: '2026-08-31', today })).toBe('2026-09-03');
  });

  it('最後の成功が今日なら今日', () => {
    expect(scheduledRollupFrom({ lastSucceededStartedAt: '2026-09-10', today })).toBe('2026-09-10');
  });

  it('最後の成功がちょうど 7 日前なら、その日（境界値）', () => {
    expect(scheduledRollupFrom({ lastSucceededStartedAt: '2026-09-03', today })).toBe('2026-09-03');
  });
});

/** §6.3 / 実装プラン §8 #5。API が 409 に写す例外。 */
describe('JobBusyError', () => {
  it('Error であり、ジョブ名を持つ', () => {
    const error = new JobBusyError('analytics.rollup');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('JobBusyError');
    expect(error.jobName).toBe('analytics.rollup');
  });
});
