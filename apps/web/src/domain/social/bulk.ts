import { POST_PUBLISHING_MESSAGE, type PostStatus, type SocialPost } from './social';

/**
 * SNS 投稿の一括操作（054-bulk-post-actions 設計 §5.4・§5.5・§8.1・§8.3・§8.4）。
 *
 * 一括の承認・今すぐ送る・取り消しは、項目ごとに既存の 1 件の UseCase を呼び、結果を項目ごとに返す。
 * ここは定数・結果の型・対象かどうかの判定の純関数だけを持つ。「いま」は引数で受け取る。
 * **Domain 層。** DB 製品にも Plugin API にも依存しない。
 */

/** 1 回の要求の項目の上限。一覧の `perPage` の上限（`MAX_PER_PAGE`）と同じ値。 */
export const BULK_MAX_ITEMS = 100;

/** 1 回の要求の処理の時間の予算（設計 §8.6）。過ぎたら、まだ始めていない項目を `timeout` で返す。 */
export const BULK_BUDGET_MS = 25_000;

/** 項目の失敗の理由（設計 §8.1）。 */
export const BULK_FAILURE_REASONS = [
  'not_found', // 無い・区画の外・UUID の形でない
  'not_applicable', // その操作の対象の状態でない（承認待ちでない・予約でない・配信済み など）
  'already_due', // 今すぐ送る：予約日時が既に来ている（配信待ち・再試行待ち・支度待ち）
  'publishing', // 配信中（着手印あり）
  'approval_required', // 今すぐ送る：承認済みの予約で、操作した人が social.approve を持たない
  'stale', // 見た後に内容か状態が変わった（409 相当）
  'no_desired_time', // 承認（希望日時）：希望日時が無い
  'desired_time_passed', // 承認（希望日時）：希望日時を過ぎている
  'validation', // 配信 Plugin の規則など、その他の 422 相当
  'timeout', // 時間の予算を超え、処理しなかった
  'internal_error', // 想定外の失敗
] as const;

export type BulkFailureReason = (typeof BULK_FAILURE_REASONS)[number];

/** 項目の成功の効果（設計 §8.1）。 */
export const BULK_EFFECTS = [
  'approved_now', // 承認・即投稿
  'approved_scheduled', // 承認・希望日時で予約
  'approved_forced_now', // 承認・希望日時を選んだが、手動投稿のみの SNS のため即投稿（048 裁定 5）
  'queued', // 今すぐ送る：次の定期実行で配信
  'manual_pending', // 今すぐ送る：手動投稿待ちに並んだ
  'deleted', // 取り消し（削除）
] as const;

export type BulkEffect = (typeof BULK_EFFECTS)[number];

/** 一括取り消しで消せる状態（ユーザー裁定 6。配信中の予約を除く）。 */
export const BULK_DELETABLE_STATUSES = [
  'draft',
  'awaiting_approval',
  'scheduled',
] as const satisfies readonly PostStatus[];

/** 項目の結果。`results` は要求の並びと同じ順・同じ数。 */
export type BulkItemResult =
  | {
      readonly id: string;
      readonly ok: true;
      readonly effect: BulkEffect;
      /** 処理後の投稿。削除は null。 */
      readonly post: SocialPost | null;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: BulkFailureReason;
      /** 1 件の操作が返すのと同じ文言。 */
      readonly message: string;
      /** 422 の `details` のキーにあたるもの。無ければ null。 */
      readonly field: string | null;
    };

/** 対象かどうかの判定の結果（`resolveApprovalSchedule` と同じ流儀）。 */
export type BulkEligibility =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'not_applicable' | 'already_due' | 'publishing';
      readonly message: string;
    };

/** `not_found` の文言（1 件の操作の 404 の文言と同じ）。 */
export const BULK_NOT_FOUND_MESSAGE = '見つかりませんでした。';

/** `timeout` の文言（設計 §8.6）。 */
export const BULK_TIMEOUT_MESSAGE = '時間内に処理できませんでした。もう一度操作してください。';

/** `internal_error` の文言（設計 §8.1.1）。例外の文言は載せない。 */
export const BULK_INTERNAL_ERROR_MESSAGE = '処理中にエラーが発生しました。';

/** 今すぐ送るの `stale` の文言（1 件の操作が無いので、承認の文言ではなくこれを使う）。 */
export const PUBLISH_NOW_STALE_MESSAGE =
  '投稿の内容が変わっています。読み込み直してから操作し直してください。';

/** 今すぐ送るの `approval_required` の文言（設計 §8.3 の 4）。 */
export const APPROVAL_REQUIRED_MESSAGE = '承認済みの予約を今すぐ送るには、承認の権限が要ります。';

/** 今すぐ送るの `already_due` の文言（設計 §8.3）。 */
export const ALREADY_DUE_MESSAGE = '予約日時を過ぎているため、既に配信の順番を待っています。';

/** 一括取り消しの `not_applicable` の文言（設計 §8.4）。 */
export const BULK_DELETE_NOT_APPLICABLE_MESSAGE =
  '配信済み・失敗の投稿は一括取り消しの対象外です。1 件ずつ削除してください。';

/** 今すぐ送るの `not_applicable` の文言（設計 §8.3）。 */
export function publishNowNotApplicableMessage(status: PostStatus): string {
  return `予約済みの投稿ではありません（いまの状態：${status}）。`;
}

type EligibilitySubject = Pick<
  SocialPost,
  'status' | 'deliveryMode' | 'scheduledAt' | 'publishStartedAt'
>;

/** 配信中（自動配信で着手印がある予約）か。 */
function isPublishing(post: EligibilitySubject): boolean {
  return (
    post.status === 'scheduled' && post.deliveryMode === 'auto' && post.publishStartedAt !== null
  );
}

/**
 * 今すぐ送れるか（設計 §8.3 の表。並びは判定の順）。
 *
 * 対象は `scheduled` で、配信中でなく、予約日時が未来か NULL のもの。承認の権限は UseCase が見る。
 */
export function publishNowEligibility(post: EligibilitySubject, now: Date): BulkEligibility {
  if (post.status !== 'scheduled') {
    return {
      ok: false,
      reason: 'not_applicable',
      message: publishNowNotApplicableMessage(post.status),
    };
  }
  if (isPublishing(post)) {
    return { ok: false, reason: 'publishing', message: POST_PUBLISHING_MESSAGE };
  }
  if (post.scheduledAt !== null && post.scheduledAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'already_due', message: ALREADY_DUE_MESSAGE };
  }
  return { ok: true };
}

/**
 * 一括取り消しで消せるか（設計 §5.5・§8.4 の 2）。
 *
 * `BULK_DELETABLE_STATUSES` に無い状態（配信済み・失敗）は `not_applicable`、配信中は `publishing`。
 */
export function bulkDeleteEligibility(post: EligibilitySubject): BulkEligibility {
  if (!(BULK_DELETABLE_STATUSES as readonly PostStatus[]).includes(post.status)) {
    return { ok: false, reason: 'not_applicable', message: BULK_DELETE_NOT_APPLICABLE_MESSAGE };
  }
  if (isPublishing(post)) {
    return { ok: false, reason: 'publishing', message: POST_PUBLISHING_MESSAGE };
  }
  return { ok: true };
}
