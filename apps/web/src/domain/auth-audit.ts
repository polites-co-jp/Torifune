/**
 * 認証・認可に関する監査イベント（04_認証設計.md §26）。
 *
 * **このイベントの詳細情報にパスワード・トークン・Cookie を入れてはならない。**
 *
 * `password.changed` / `user.created` / `user.disabled` / `role.changed` は
 * `015-settings` のユーザー管理から発火する。
 *
 * 同 §26 が挙げる「Permission変更」「外部認証連携設定変更」はまだ無い。
 * **その操作自体が存在しないため。** 操作を作るときに同時に足す。
 */

export const AUTH_AUDIT_EVENTS = [
  'login.succeeded',
  'login.failed',
  'logout',
  'password.changed',
  'password.reset.requested',
  'password.reset.completed',
  'user.created',
  'user.disabled',
  'role.changed',
  'setup.completed',
] as const;

export type AuthAuditEvent = (typeof AUTH_AUDIT_EVENTS)[number];

export interface AuthAuditEntry {
  readonly id: string;
  readonly event: AuthAuditEvent;
  readonly userId: string | null;
  /** 存在しないアカウントへの試行も記録するため、ユーザーとは別に持つ。 */
  readonly loginIdAttempted: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly detail: Record<string, unknown>;
}

/** 監査ログへ入れてはならないキー。実装側で機械的に落とす。 */
const FORBIDDEN_DETAIL_KEYS = [
  'password',
  'passwordhash',
  'token',
  'tokenhash',
  'cookie',
  'secret',
  'authorization',
  'sessionid',
];

/**
 * 詳細情報から機密になりうるキーを落とす。
 *
 * 「入れない」を規約に頼ると、いつか入る。機械的に落とす。
 */
export function sanitizeAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (FORBIDDEN_DETAIL_KEYS.some((forbidden) => normalized.includes(forbidden))) {
      continue;
    }
    result[key] = value;
  }
  return result;
}
