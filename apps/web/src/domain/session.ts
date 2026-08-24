/** 認証セッション。**Domain 層。Cookie の存在を知らない。** */
export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastAccessedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/** セッションの既定の有効期限（ミリ秒）。 */
export const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** 無操作でセッションが切れるまでの時間（ミリ秒）。 */
export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/** そのセッションが今この瞬間に有効かを判定する。 */
export function isSessionUsable(session: Session, now: Date): boolean {
  if (session.revokedAt !== null) {
    return false;
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  if (now.getTime() - session.lastAccessedAt.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    return false;
  }
  return true;
}
