import type { Secret } from '../secret';

/**
 * SNSアカウントと投稿。
 *
 * **外部SNSとの実連携は Plugin の責務**（01_アーキテクチャ設計.md §12）。
 * ここが表すのはデータと状態だけ。
 *
 * **Domain 層。** 暗号方式も HTTP も知らない。
 */

/**
 * Core が知っている provider。
 *
 * **この一覧に無い値も受け入れる。** Plugin が新しいSNSを足せる必要がある
 * （03_プラグイン設計.md §9）。ここは表示名を引くための対応表にすぎない。
 */
export const KNOWN_PROVIDERS = ['x', 'facebook', 'instagram', 'youtube', 'other'] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  x: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  other: 'その他',
};

/** provider の形式。任意の文字列を通すと、画面や URL で扱いにくくなる。 */
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export function isValidProvider(value: string): boolean {
  return PROVIDER_PATTERN.test(value);
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export const ACCOUNT_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface SocialAccount {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  /**
   * 資格情報。**復号済みの値をここへ入れない。**
   * 「設定されているか」だけを保持し、平文は必要なときに復号して取り出す。
   */
  readonly credentialConfigured: boolean;
  readonly status: AccountStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 内部処理が資格情報を必要とするときだけ使う形。 */
export interface SocialAccountWithCredential extends SocialAccount {
  readonly credential: Secret | null;
}

export const DISPLAY_NAME_MAX_LENGTH = 200;

export function isValidDisplayName(value: string): boolean {
  return value.trim() !== '' && value.length <= DISPLAY_NAME_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// 投稿
// ---------------------------------------------------------------------------

export const POST_STATUSES = ['draft', 'scheduled', 'published', 'failed'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export interface SocialPost {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: Date | null;
  readonly status: PostStatus;
  readonly publishedAt: Date | null;
  /**
   * 配信に失敗した時刻。
   *
   * **`updatedAt` で代用しない。** あれは「最後に触った時刻」であって
   * 「失敗した時刻」ではない。履歴を結果の時系列で並べるには別に要る。
   */
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 配信結果が確定した状態（06_画面設計.md §13「履歴」）。
 *
 * **試行履歴のテーブルは作らない。** この2つは終端で、
 * 1つの投稿が持つ配信結果は高々1つ。履歴とは
 * 「結果が確定した投稿の一覧」である（026-screen-completion 設計 §4.3）。
 */
export const DELIVERED_STATUSES: readonly PostStatus[] = ['published', 'failed'];

export const POST_BODY_MAX_LENGTH = 10_000;

/**
 * 失敗理由の長さの上限。
 *
 * 外部サービスの応答をそのまま渡す使い方が想定されるため、
 * **長さで弾かずに切り詰める**（`normalizeFailureReason`）。
 * 長かっただけで失敗の記録が残らないほうが困る。
 */
export const FAILURE_REASON_MAX_LENGTH = 2000;

export function isValidPostBody(value: string): boolean {
  return value.trim() !== '' && value.length <= POST_BODY_MAX_LENGTH;
}

/**
 * 状態遷移の可否。
 *
 * ```text
 * draft ──→ scheduled ──→ published
 *   │           │
 *   └───────────┴──→ failed
 * ```
 *
 * **`published` と `failed` からは戻せない。** 起きた事実は書き換えない。
 * 「配信した」を「下書き」に戻せると、記録が信用できなくなる。
 */
const ALLOWED_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ['draft', 'scheduled', 'published', 'failed'],
  scheduled: ['scheduled', 'draft', 'published', 'failed'],
  published: ['published'],
  failed: ['failed'],
};

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isPostStatus(value: string): value is PostStatus {
  return (POST_STATUSES as readonly string[]).includes(value);
}

export function isAccountStatus(value: string): value is AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(value);
}
