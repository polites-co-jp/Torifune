import type { ManualOutcome } from '@/domain/social/pending';

/**
 * 手動投稿の順に投稿の純関数（055-social-pending-tab 設計 §9.5.2・§9.12、057-social-bulk-post 設計 §5.3・§5.4）。
 *
 * 順に投稿の対象の形、窓の段の移り方、手動投稿の結果の要求の本文を作る。**`'use client'` にしない**
 * （単体テストで押せない操作をここで見る。054 の `bulk-plan.ts` と同じ考え方）。
 * 対象の振り分けは 057 で一括投稿の `bulkPostPlanOf`（`bulk-post-plan.ts`）に移った。
 * 正はサーバの判定（`manual-outcome` の 409 / 422）。
 */

/**
 * 順に投稿の 1 件（057-social-bulk-post 設計 §5.3・§7.5）。予約済みの手動投稿は行から、
 * 一括投稿で承認した手動投稿は承認の結果と取得の口の URL から作る。
 *
 * `updatedAt` は記録の `expectedUpdatedAt`。承認した手動投稿では**承認の結果の `post.updatedAt`**
 * （行の値は承認の前のもの）。見た後に本文が変わっていれば記録は 409 になる。
 */
export interface ManualSequenceTarget {
  readonly id: string;
  readonly body: string;
  readonly socialAccountId: string;
  readonly scheduledAt: string | null;
  readonly updatedAt: string;
  /** 投稿画面の URL（配信 Plugin の `manual()` が作ったもの）。 */
  readonly url: string;
  readonly note: string | null;
}

/**
 * 順に投稿の今の件の段（057 設計 §5.4）。
 *
 * * `ready`：まだこの件の窓を開いていない
 * * `opened`：窓を開いた。とりふねの画面に戻るのを待つ
 * * `returned`：戻った（か「記録へ進む」を押した）。記録のボタンを出す
 */
export type WindowStage = 'ready' | 'opened' | 'returned';

/**
 * 段を動かす出来事（057 設計 §5.4）。`open` は窓を開いた・「別のタブで開く」を押した、`left` はとりふねの
 * `window` の `blur` か `hidden`、`back` は `focus` か `visible`、`recordNow` は「記録へ進む」。
 */
export type WindowEvent = 'open' | 'left' | 'back' | 'recordNow';

/** 段と、窓を開いた後にとりふねの画面から離れたか（離れた後に戻ったら `returned`）。 */
export interface WindowState {
  readonly stage: WindowStage;
  readonly left: boolean;
}

/**
 * 出来事で段を移す（057 設計 §5.4 の表）。**窓を閉じたことは知れない**（X・Threads の COOP で、開き手の参照は
 * 開いた直後から `closed`。§3.4）ので、開いた後に離れて戻ってきたことを「閉じた」の代わりにする。
 * 離れる前の `back` では戻ったとみなさない。`open` は離れたかを数え直す。渡した状態は書き換えない。
 */
export function windowStageAfter(state: WindowState, event: WindowEvent): WindowState {
  switch (event) {
    case 'open':
      return { stage: 'opened', left: false };
    case 'left':
      return state.stage === 'opened' ? { stage: 'opened', left: true } : state;
    case 'back':
      return state.stage === 'opened' && state.left ? { stage: 'returned', left: true } : state;
    case 'recordNow':
      return state.stage === 'returned' ? state : { stage: 'returned', left: state.left };
  }
}

/** `POST /social/posts/{id}/manual-outcome` の本文（設計 §5.6・§9.5.2）。 */
export interface ManualOutcomeRequestBody {
  readonly outcome: ManualOutcome;
  readonly expectedUpdatedAt: string;
  readonly externalUrl?: string;
}

/**
 * 手動投稿の結果の要求の本文（設計 §9.5.2）。`externalUrl` は前後の空白を落とし、空なら含めない。
 * `not_posted` は URL を送らない（送るとサーバが 422 にする）。
 */
export function manualOutcomeRequestBody(
  outcome: ManualOutcome,
  expectedUpdatedAt: string,
  externalUrl: string,
): ManualOutcomeRequestBody {
  const url = externalUrl.trim();
  if (outcome === 'not_posted' || url === '') {
    return { outcome, expectedUpdatedAt };
  }
  return { outcome, expectedUpdatedAt, externalUrl: url };
}
