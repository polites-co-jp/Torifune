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
