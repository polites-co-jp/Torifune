import type { ApprovalTiming } from '@/domain/social/social';
import { toIsoOrNull } from './datetime-local';

/**
 * 承認の要求の本文と、ダイアログの既定の選択（048-social-post-approval 設計 §7.1.3）。
 *
 * **純関数。** `'use client'` のモジュールに置かない（単体テストから直接呼ぶ）。
 */

export interface ApproveRequestBody {
  readonly publishTiming: ApprovalTiming;
  readonly expectedUpdatedAt: string;
  readonly scheduledAt?: string | null;
}

/**
 * 承認の要求の本文。`expectedUpdatedAt` には画面を描いたときの `updatedAt` を添える（見た内容を承認する）。
 * 「指定の時間に投稿」のときだけ、日時の欄の値（閲覧者の時刻）を ISO にした `scheduledAt` を含める。
 */
export function approveRequestBody(input: {
  readonly timing: ApprovalTiming;
  readonly scheduledAtLocal: string;
  readonly updatedAt: string;
}): ApproveRequestBody {
  return {
    publishTiming: input.timing,
    expectedUpdatedAt: input.updatedAt,
    ...(input.timing === 'scheduled' ? { scheduledAt: toIsoOrNull(input.scheduledAtLocal) } : {}),
  };
}

/**
 * ダイアログの既定の選択。希望日時があり過ぎていなければ「指定の時間に投稿」、
 * それ以外（希望日時が無い・過ぎている）は「即投稿」。手動投稿しかできない配信 Plugin の行は常に「即投稿」。
 */
export function defaultApprovalTiming(row: {
  readonly desiredScheduledAt: string | null;
  readonly desiredPast: boolean;
  readonly manualOnly: boolean;
}): ApprovalTiming {
  if (row.manualOnly || row.desiredScheduledAt === null || row.desiredPast) {
    return 'now';
  }
  return 'scheduled';
}
