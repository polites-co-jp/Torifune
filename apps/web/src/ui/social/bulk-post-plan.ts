import type { ManualHandoffOutcome } from '@/application/social/social-use-cases';
import {
  excerptOf,
  summarizeBulkResults,
  type BulkPlanRow,
  type BulkRequestFailure,
  type BulkResultItem,
  type BulkResultSummary,
} from '@/ui/social/bulk-plan';
import type { ManualSequenceTarget } from '@/ui/social/manual-sequence-plan';

/**
 * 送信待ちタブの一括投稿の純関数（057-social-bulk-post 設計 §5.2・§5.3・§7.4・§7.5、実装プラン §8 の 18）。
 *
 * 選んだ行の振り分け、承認の要求の本文、承認した手動投稿の順に投稿の対象、終わりの表示の要約を作る。
 * **`'use client'` にしない**（単体テストで押せない操作をここで見る。054 の `bulk-plan.ts` と同じ考え方）。
 *
 * 振り分けは**画面が読んだ行**から作る見込みであって、正はサーバの項目ごとの結果。
 * 「いま」は見ない。期限が来ているか・配信中かは Server Component が決めて行に載せる（`scheduledFuture`・`publishing`）。
 */

/** 計画に使う行の項目（送信待ちの行 `PendingRow` の一部）。 */
export interface BulkPostRow extends BulkPlanRow {
  readonly socialAccountId: string;
  /** `resolveManualHandoff` の結果。手動の予約の行だけが持つ（承認待ちの行には渡さない。055 設計 §5.5）。 */
  readonly handoff?: ManualHandoffOutcome;
}

/** 対象外の理由（設計 §5.2）。この順に並べて出す。表示名は `BULK_POST_EXCLUDED_LABEL`。 */
export const BULK_POST_EXCLUDED_REASONS = [
  'no_approve_permission',
  'no_write_permission',
  'due_or_publishing',
  'handoff_unavailable',
] as const;

export type BulkPostExcludedReason = (typeof BULK_POST_EXCLUDED_REASONS)[number];

export interface BulkPostPlan<R extends BulkPostRow> {
  /** 承認する行（即投稿）。自動・手動を渡した順のまま 1 つの列。 */
  readonly approve: readonly R[];
  /** 今すぐ送る自動の予約。 */
  readonly publishNow: readonly R[];
  /** 順に開く予約済みの手動投稿（描画時に URL がある行）。 */
  readonly manual: readonly R[];
  /** 対象外の理由ごとの件数（0 件の理由は含めない）。 */
  readonly excluded: readonly { readonly reason: BulkPostExcludedReason; readonly count: number }[];
}

export interface BulkPostPermissions {
  readonly canApprove: boolean;
  readonly canWrite: boolean;
}

type Placement = 'approve' | 'publishNow' | 'manual' | BulkPostExcludedReason | null;

/** 1 行の行き先（設計 §5.2 の表）。送信待ちの区分でない行は null（数えずに捨てる）。 */
function placementOf(row: BulkPostRow, permissions: BulkPostPermissions): Placement {
  if (row.status === 'awaiting_approval') {
    if (!permissions.canApprove) return 'no_approve_permission';
    // 承認した手動投稿は記録（`social.write`）まで進めないと「手動投稿待ち」に残るだけになる（ユーザー裁定 4）。
    if (row.deliveryMode === 'manual' && !permissions.canWrite) return 'no_write_permission';
    return 'approve';
  }
  if (row.status !== 'scheduled') return null;

  if (row.deliveryMode === 'manual') {
    // 手動の予約は予約時刻の前後を問わず記録できる（055 裁定 4）ので、今すぐ送るに回さない（設計 §5.2）。
    if (!permissions.canWrite) return 'no_write_permission';
    return row.handoff?.ok === true ? 'manual' : 'handoff_unavailable';
  }

  // 期限の来た予約・配信中はすでに配信の順番を待っている（権限に依らず対象外）。
  if (row.publishing === true || row.scheduledFuture !== true) return 'due_or_publishing';
  if (!permissions.canWrite) return 'no_write_permission';
  const approved = row.approvedAt !== undefined && row.approvedAt !== null;
  if (approved && !permissions.canApprove) return 'no_approve_permission';
  return 'publishNow';
}

/**
 * 選んだ行を一括投稿の行き先に分ける（設計 §5.2）。**表示中の行の順で渡す。**
 * 時機は即投稿だけ（承認の `publishTiming: 'now'`）。
 */
export function bulkPostPlanOf<R extends BulkPostRow>(
  selectedRows: readonly R[],
  permissions: BulkPostPermissions,
): BulkPostPlan<R> {
  const approve: R[] = [];
  const publishNow: R[] = [];
  const manual: R[] = [];
  const counts = new Map<BulkPostExcludedReason, number>();

  for (const row of selectedRows) {
    const placement = placementOf(row, permissions);
    if (placement === null) continue;
    if (placement === 'approve') approve.push(row);
    else if (placement === 'publishNow') publishNow.push(row);
    else if (placement === 'manual') manual.push(row);
    else counts.set(placement, (counts.get(placement) ?? 0) + 1);
  }

  return {
    approve,
    publishNow,
    manual,
    excluded: BULK_POST_EXCLUDED_REASONS.flatMap((reason) => {
      const count = counts.get(reason) ?? 0;
      return count > 0 ? [{ reason, count }] : [];
    }),
  };
}

/** 一括投稿の対象の件数（今すぐ送る＋承認する＋予約済みの手動。設計 §7.3）。 */
export function bulkPostTargetCountOf(plan: BulkPostPlan<BulkPostRow>): number {
  return plan.approve.length + plan.publishNow.length + plan.manual.length;
}

/** `POST /social/posts/bulk/approve` の本文。時機は常に即投稿（設計 §5.2・§7.4）。 */
export function bulkPostApproveRequestBody(rows: readonly BulkPlanRow[]): {
  publishTiming: 'now';
  items: { id: string; expectedUpdatedAt: string }[];
} {
  return {
    publishTiming: 'now',
    items: rows.map((row) => ({ id: row.id, expectedUpdatedAt: row.updatedAt ?? '' })),
  };
}

/** 承認したが投稿画面の URL を取れなかった手動投稿（手動投稿待ちに残る。設計 §5.3）。 */
export interface HandoffFailedItem {
  readonly id: string;
  readonly excerpt: string;
}

export interface ApprovedManualTargets {
  readonly targets: readonly ManualSequenceTarget[];
  readonly handoffFailed: readonly HandoffFailedItem[];
}

/** 承認の結果の `post`（応答の形の投稿）から文字列の項目を読む。 */
function approvedPostField(post: unknown, key: 'updatedAt' | 'scheduledAt'): string | null {
  if (typeof post !== 'object' || post === null) return null;
  const value = (post as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * 一括承認で承認できた手動投稿を、順に投稿の対象と URL の取れなかった件に分ける（設計 §5.3）。
 *
 * * 対象は `ok` の結果で、行が手動のもの。並びは `results` の順（承認の要求は表の順で送る）
 * * `updatedAt`・`scheduledAt` は**結果の `post` の値**（承認で変わる。記録の `expectedUpdatedAt` に使う）
 * * `handoffs` は取得の口の結果。`null` か無いキーは要求の失敗。`ok: false` と合わせて「URL の取れなかった件」
 */
export function approvedManualTargetsOf(
  results: readonly BulkResultItem[],
  rows: readonly BulkPostRow[],
  handoffs: Readonly<Record<string, ManualHandoffOutcome | null>>,
): ApprovedManualTargets {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const targets: ManualSequenceTarget[] = [];
  const handoffFailed: HandoffFailedItem[] = [];

  for (const result of results) {
    if (!result.ok) continue;
    const row = byId.get(result.id);
    if (row === undefined || row.deliveryMode !== 'manual') continue;
    const handoff = handoffs[result.id] ?? null;
    const updatedAt = approvedPostField(result.post, 'updatedAt');
    if (handoff === null || !handoff.ok || updatedAt === null) {
      handoffFailed.push({ id: row.id, excerpt: excerptOf(row.body) });
      continue;
    }
    targets.push({
      id: row.id,
      body: row.body,
      socialAccountId: row.socialAccountId,
      scheduledAt: approvedPostField(result.post, 'scheduledAt'),
      updatedAt,
      url: handoff.url,
      note: handoff.note,
    });
  }
  return { targets, handoffFailed };
}

/** 予約済みの手動投稿の行を順に投稿の対象にする（URL は描画時の `handoff`。`bulkPostPlanOf` の `manual` の行）。 */
export function scheduledManualTargetsOf(rows: readonly BulkPostRow[]): ManualSequenceTarget[] {
  return rows.flatMap((row) =>
    row.handoff?.ok === true && row.updatedAt !== undefined
      ? [
          {
            id: row.id,
            body: row.body,
            socialAccountId: row.socialAccountId,
            scheduledAt: row.scheduledAt,
            updatedAt: row.updatedAt,
            url: row.handoff.url,
            note: row.handoff.note,
          },
        ]
      : [],
  );
}

/** 順に投稿の 1 件の記録（「飛ばして次へ」は `skipped`）。 */
export interface SequenceRecord {
  readonly id: string;
  readonly outcome: 'posted' | 'not_posted' | 'skipped';
}

export interface BulkPostOutcomeInput {
  /** 1 段目（承認・今すぐ送る）の項目ごとの結果。 */
  readonly results: readonly BulkResultItem[];
  readonly requestFailures: readonly BulkRequestFailure[];
  readonly rows: readonly BulkPlanRow[];
  readonly records: readonly SequenceRecord[];
  /** 順に投稿の対象の数。 */
  readonly sequenceTotal: number;
  readonly handoffFailed: readonly HandoffFailedItem[];
}

export interface BulkPostOutcome extends BulkResultSummary {
  readonly manual: {
    readonly posted: number;
    readonly notPosted: number;
    readonly skipped: number;
  };
  /** 記録していない手動投稿の数（途中でやめた）。送信待ちに残る。 */
  readonly unrecorded: number;
  readonly handoffFailed: readonly HandoffFailedItem[];
  /** 「閉じる」の後に選択を空にして読み込み直すか（設計 §7.5）。 */
  readonly reload: boolean;
}

/**
 * 終わりの表示の要約（設計 §7.5）。1 段目は 054 の `summarizeBulkResults` で集める。
 *
 * 読み込み直すのは、1 段目で 1 件でも成功したか、「投稿した」「投稿しなかった」を 1 件でも保存したときだけ。
 * 飛ばしただけ・すべて失敗なら何もしない（055 §9.5.2 の「飛ばしただけなら何もしない」と同じ考え方）。
 */
export function bulkPostOutcomeOf(input: BulkPostOutcomeInput): BulkPostOutcome {
  const summary = summarizeBulkResults(input.results, input.rows, input.requestFailures);
  const count = (outcome: SequenceRecord['outcome']): number =>
    input.records.filter((record) => record.outcome === outcome).length;
  const manual = {
    posted: count('posted'),
    notPosted: count('not_posted'),
    skipped: count('skipped'),
  };
  return {
    ...summary,
    manual,
    unrecorded: Math.max(0, input.sequenceTotal - input.records.length),
    handoffFailed: input.handoffFailed,
    reload: summary.succeeded.total > 0 || manual.posted + manual.notPosted > 0,
  };
}
