import { isManualPending, type SocialPost } from './social';

/**
 * SNS 画面の「送信待ち」（055-social-pending-tab 設計 §5.2・§5.3・§5.5・§5.6・§6）。
 *
 * 送信待ちの区分・並び順の定数と、手動投稿の「投稿画面を開く」「投稿した／投稿しなかった」の対象の判定。
 * 「いま」は引数で受け取る。**Domain 層。** DB 製品にも Plugin API にも依存しない。
 */

/** 送信待ちの区分。並びは「手が要るもの順」（設計 §5.3 の (A)）の区分の順。 */
export const PENDING_KINDS = ['manual_pending', 'awaiting_approval', 'scheduled'] as const;

export type PendingKind = (typeof PENDING_KINDS)[number];

export function isPendingKind(value: unknown): value is PendingKind {
  return typeof value === 'string' && (PENDING_KINDS as readonly string[]).includes(value);
}

/** 送信待ちの並び順（ユーザー裁定 7）。`action`＝手が要るもの順、`time`＝予定の時刻順。 */
export const PENDING_SORTS = ['action', 'time'] as const;

export type PendingSort = (typeof PENDING_SORTS)[number];

export const DEFAULT_PENDING_SORT: PendingSort = 'action';

/** 手動投稿の結果（ユーザー裁定 6）。 */
export const MANUAL_OUTCOMES = ['posted', 'not_posted'] as const;

export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number];

/** 「投稿しなかった」で確定した投稿の `failure_reason`（DB に入る固定の文言。配信の失敗と見分ける）。 */
export const MANUAL_NOT_POSTED_REASON = '手動投稿で『投稿しなかった』が選ばれました。';

type PendingSubject = Pick<SocialPost, 'status' | 'deliveryMode' | 'scheduledAt'>;

/**
 * 投稿の送信待ちの区分（設計 §5.2）。送信待ちでない（下書き・配信済み・失敗）なら `null`。
 *
 * `manual_pending` は `isManualPending` と同じ条件（予約時刻を過ぎた手動の予約）。
 */
export function pendingKindOf(post: PendingSubject, now: Date): PendingKind | null {
  if (post.status === 'awaiting_approval') return 'awaiting_approval';
  if (post.status !== 'scheduled') return null;
  return isManualPending(post, now) ? 'manual_pending' : 'scheduled';
}

/**
 * 「投稿画面を開く」を出せるか（ユーザー裁定 4）。手動の予約なら予約時刻の前でも真。
 * 承認待ちは偽（承認を経ずに SNS へ出す手がかりを残さない）。
 */
export function canOpenManualHandoff(post: Pick<SocialPost, 'status' | 'deliveryMode'>): boolean {
  return post.deliveryMode === 'manual' && post.status === 'scheduled';
}

/** 手動投稿の結果（`posted` / `not_posted`）を記録できるか（設計 §5.6）。対象は `canOpenManualHandoff` と同じ。 */
export function manualOutcomeEligibility(
  post: Pick<SocialPost, 'status' | 'deliveryMode'>,
): boolean {
  return canOpenManualHandoff(post);
}
