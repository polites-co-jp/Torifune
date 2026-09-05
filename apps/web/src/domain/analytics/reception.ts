/**
 * 受信状況の 4 状態（029-scheduled-jobs 設計 §5.5）。
 *
 * 「届いているが未集計」「Bot だけ届いている」を管理画面だけで切り分けるための判定。
 * **受け口（`POST /api/v1/collect`）は理由を返さない**（204 のまま）ので、
 * 診断性はここと画面側で担保する。
 */

export type ReceptionState =
  /** 一度も届いていない → 「計測タグ未設置」。 */
  | 'not-received'
  /** 届いているが、この期間に集計値が無く、未集計に人のアクセスがある。 */
  | 'pending-rollup'
  /** 届いているが、未集計がすべて Bot。 */
  | 'bots-only'
  /** 通常表示（集計値がある、過去の期間、いまは届いていない）。 */
  | 'receiving';

export interface ReceptionInput {
  /** 生ログの最終受信（Bot 含む）。 */
  readonly lastReceivedAt: Date | null;
  /** 最終集計以降に届いた生ログの件数（上限つき）。 */
  readonly pending: { readonly total: number; readonly bots: number };
  /** 当期に `key = ''` の点が 1 つでもあるか。 */
  readonly hasPointsInPeriod: boolean;
  /**
   * 当期の末尾が、まだ集計が追いついていない可能性のある日に掛かるか
   * （`to >= 昨日`。030-analytics-today 設計 §9.1）。
   *
   * 過去の期間に「集計待ち」は出さない。**プリセットの `to` は昨日**なので、
   * 「今日以降か」で見ると「昨日届いたがまだ集計されていない」状態を拾えなくなる。
   */
  readonly periodMayLackRollup: boolean;
}

/**
 * 上から順に、最初に当たったものを返す。
 *
 * | 条件 | 状態 |
 * | --- | --- |
 * | `lastReceivedAt === null` | `not-received` |
 * | `hasPointsInPeriod` | `receiving` |
 * | `!periodMayLackRollup` | `receiving` |
 * | `pending.total === 0` | `receiving` |
 * | `pending.bots === pending.total` | `bots-only` |
 * | それ以外 | `pending-rollup` |
 *
 * `hasPointsInPeriod` が真なら常に通常表示にする。集計済みで Bot だけの期間は
 * 概要タブの警告（`botsOnlyInPeriod`）で示す。訪問者タブの「Bot のアクセス」を見られるようにするため。
 *
 * `pending` は上限で打ち切った値でよい（最新 1000 件がすべて Bot なら Bot だけとみなす）。
 */
export function diagnoseReception(input: ReceptionInput): ReceptionState {
  if (input.lastReceivedAt === null) {
    return 'not-received';
  }
  if (input.hasPointsInPeriod) {
    return 'receiving';
  }
  if (!input.periodMayLackRollup) {
    return 'receiving';
  }
  if (input.pending.total === 0) {
    return 'receiving';
  }
  return input.pending.bots === input.pending.total ? 'bots-only' : 'pending-rollup';
}

/**
 * 集計済みの当期が「人の PV は 0、Bot の PV は 1 以上」か（設計 §7.1.4）。
 *
 * 概要タブの警告に使う。**集計値から出す。生ログは読まない。**
 */
export function botsOnlyInPeriod(summary: {
  readonly pageviews: number;
  readonly botPageviews: number;
}): boolean {
  return summary.pageviews === 0 && summary.botPageviews > 0;
}
