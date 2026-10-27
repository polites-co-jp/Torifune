import type { ManualHandoffOutcome } from '@/application/social/social-use-cases';
import type { ManualOutcome } from '@/domain/social/pending';

/**
 * 選んだ手動投稿を順に投稿の純関数（055-social-pending-tab 設計 §9.5.1・§9.5.2・§9.12）。
 *
 * 対象の振り分けと、手動投稿の結果の要求の本文を作る。**`'use client'` にしない**
 * （単体テストで押せない操作をここで見る。054 の `bulk-plan.ts` と同じ考え方）。
 * 対象は**画面が読んだ行**から作る見込みであって、正はサーバの判定（`manual-outcome` の 409 / 422）。
 */

/** 計画に使う行の項目（送信待ちの行 `PendingRow` の一部）。 */
export interface ManualSequenceRow {
  readonly id: string;
  readonly status: string;
  readonly deliveryMode: 'auto' | 'manual';
  /** `resolveManualHandoff` の結果。手動の予約の行だけが持つ（承認待ちの行には渡さない）。 */
  readonly handoff?: ManualHandoffOutcome;
}

/** 対象外の理由（設計 §9.5.1）。表示名は `MANUAL_SEQUENCE_EXCLUDED_LABEL`。 */
export type ManualSequenceExcludedReason = 'awaiting_approval' | 'handoff_unavailable' | 'auto';

export interface ManualSequencePlan<R extends ManualSequenceRow> {
  /** 順に投稿する行。渡された順（表の並び）を保つ。 */
  readonly targets: readonly R[];
  /** 対象外の理由ごとの件数（0 件の理由は含めない）。 */
  readonly excluded: readonly {
    readonly reason: ManualSequenceExcludedReason;
    readonly count: number;
  }[];
}

/** 対象外の理由の並び（ダイアログに出す順）。 */
const EXCLUDED_ORDER: readonly ManualSequenceExcludedReason[] = [
  'awaiting_approval',
  'handoff_unavailable',
  'auto',
];

/** 対象外なら理由、対象なら null。自動配信は承認待ちでも「自動配信」と数える（手動投稿の計画には乗らない）。 */
function excludedReasonOf(row: ManualSequenceRow): ManualSequenceExcludedReason | null {
  if (row.deliveryMode !== 'manual') return 'auto';
  if (row.status === 'awaiting_approval') return 'awaiting_approval';
  // 手動の予約で、描画時に投稿画面の URL が作れた行だけが対象（設計 §9.5.1）。
  if (row.status !== 'scheduled' || row.handoff === undefined || !row.handoff.ok) {
    return 'handoff_unavailable';
  }
  return null;
}

/**
 * 選んだ行を順に投稿の対象と対象外に分ける（設計 §9.5.1）。**表示中の行の順で渡す。**
 * 対象は `deliveryMode = 'manual'` かつ `status = 'scheduled'` かつ `handoff.ok` の行。
 */
export function manualSequencePlanOf<R extends ManualSequenceRow>(
  selectedRows: readonly R[],
): ManualSequencePlan<R> {
  const targets: R[] = [];
  const counts = new Map<ManualSequenceExcludedReason, number>();
  for (const row of selectedRows) {
    const reason = excludedReasonOf(row);
    if (reason === null) {
      targets.push(row);
    } else {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return {
    targets,
    excluded: EXCLUDED_ORDER.flatMap((reason) => {
      const count = counts.get(reason) ?? 0;
      return count > 0 ? [{ reason, count }] : [];
    }),
  };
}

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
