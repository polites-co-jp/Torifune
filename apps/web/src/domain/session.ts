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

/**
 * そのセッションに適用するアイドルタイムアウト。
 *
 * **長期ログイン（Remember Me）では既定のアイドルタイムアウトを使わない。**
 * 12時間の無操作で切れるなら「長期ログイン」にならず、指定した意味が無い。
 *
 * 長期かどうかは、セッション自身の期間から判断する。
 * 列を足して持たせる方法もあるが、**期間そのものが答えを持っている**ので、
 * 二重に持って食い違わせる理由が無い。
 */
export function sessionIdleTimeoutMs(session: Session): number {
  const span = session.expiresAt.getTime() - session.createdAt.getTime();
  return span > SESSION_LIFETIME_MS ? span : SESSION_IDLE_TIMEOUT_MS;
}

/** そのセッションが今この瞬間に有効かを判定する。 */
export function isSessionUsable(session: Session, now: Date): boolean {
  if (session.revokedAt !== null) {
    return false;
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  if (now.getTime() - session.lastAccessedAt.getTime() > sessionIdleTimeoutMs(session)) {
    return false;
  }
  return true;
}
