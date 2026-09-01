import { uuidv7 } from 'uuidv7';
import { canSignIn } from '../domain/user';
import type { AuthAuditRepository } from '../domain/auth-audit-repository';
import type { SessionRepository } from '../domain/session-repository';
import { SESSION_LIFETIME_MS, isSessionUsable } from '../domain/session';
import type { UserRepository } from '../domain/user-repository';
import type { UserIdentity } from './identity';
import { verifyPassword, verifyPasswordAgainstDummy } from './password';
import type {
  AuthenticationContext,
  AuthenticationProvider,
  AuthenticationResult,
  Credentials,
  IssueOptions,
  SessionIssuer,
} from './provider';
import type { RateLimiter } from './rate-limit';
import { generateSessionToken, hashSessionToken } from './session-token';

export const LOCAL_PROVIDER_ID = 'local';

export interface LocalProviderDeps {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly audit: AuthAuditRepository;
  readonly rateLimiter: RateLimiter;
}

function identityOf(user: {
  id: string;
  loginId: string;
  displayName: string;
  email: string;
}): UserIdentity {
  return {
    userId: user.id,
    loginId: user.loginId,
    displayName: user.displayName,
    email: user.email,
    providerId: LOCAL_PROVIDER_ID,
    externalUserId: null,
  };
}

/**
 * 標準認証（04_認証設計.md §5）。
 *
 * 外部サービスを必要とせず、Torifune 単体でログインが完結する。
 */
export function createLocalProvider(
  deps: LocalProviderDeps,
): AuthenticationProvider & SessionIssuer {
  const { users, sessions, audit, rateLimiter } = deps;

  return {
    id: LOCAL_PROVIDER_ID,

    async authenticate(
      credentials: Credentials,
      context: AuthenticationContext,
    ): Promise<AuthenticationResult> {
      const { connection, ipAddress, userAgent, now } = context;
      const { loginId, password } = credentials;

      const allowed = await rateLimiter.isAllowed(connection, { loginId, ipAddress, now });
      if (!allowed) {
        await audit.record(connection, {
          id: uuidv7(),
          event: 'login.failed',
          userId: null,
          loginIdAttempted: loginId,
          ipAddress,
          userAgent,
          detail: { reason: 'rate_limited' },
        });
        return { ok: false, reason: 'too_many_attempts' };
      }

      const user = await users.findByLoginId(connection, loginId);

      // 存在しないユーザーでも同じだけ計算する。
      // 即座に失敗すると、応答時間の差からアカウントの存在を推測できる。
      const passwordMatches =
        user === null || user.passwordHash === null
          ? await verifyPasswordAgainstDummy(password)
          : await verifyPassword(user.passwordHash, password);

      if (user === null || !canSignIn(user) || !passwordMatches) {
        await rateLimiter.recordFailure(connection, { loginId, ipAddress, now });
        await audit.record(connection, {
          id: uuidv7(),
          event: 'login.failed',
          userId: user?.id ?? null,
          loginIdAttempted: loginId,
          ipAddress,
          userAgent,
          detail: {},
        });
        return { ok: false, reason: 'invalid_credentials' };
      }

      await rateLimiter.clearAccount(connection, loginId);
      await users.touchLastLogin(connection, user.id, now);
      await audit.record(connection, {
        id: uuidv7(),
        event: 'login.succeeded',
        userId: user.id,
        loginIdAttempted: loginId,
        ipAddress,
        userAgent,
        detail: {},
      });

      return { ok: true, identity: identityOf(user) };
    },

    async issue(
      userId: string,
      context: AuthenticationContext,
      options?: IssueOptions,
    ): Promise<{ token: string; expiresAt: Date }> {
      const { connection, ipAddress, userAgent, now } = context;

      // ログインのたびに新しいトークンを発行する。
      // 既存のセッションIDを使い回すと Session Fixation が成立する（04_認証設計.md §9）。
      const token = generateSessionToken();
      const expiresAt = new Date(now.getTime() + (options?.lifetimeMs ?? SESSION_LIFETIME_MS));

      await sessions.insert(connection, {
        id: uuidv7(),
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        ipAddress,
        userAgent,
      });

      return { token, expiresAt };
    },

    async getIdentity(
      sessionToken: string,
      context: AuthenticationContext,
    ): Promise<UserIdentity | null> {
      const { connection, now } = context;

      const session = await sessions.findByTokenHash(connection, hashSessionToken(sessionToken));
      if (session === null || !isSessionUsable(session, now)) {
        return null;
      }

      const user = await users.findById(connection, session.userId);
      if (user === null || user.status !== 'active') {
        // 無効化された直後でもセッションが通ってしまわないよう、毎回ユーザーを確認する。
        return null;
      }

      return identityOf(user);
    },

    async logout(sessionToken: string, context: AuthenticationContext): Promise<void> {
      const { connection, ipAddress, userAgent, now } = context;

      const session = await sessions.findByTokenHash(connection, hashSessionToken(sessionToken));
      if (session === null) {
        return;
      }

      await sessions.revoke(connection, session.id, now);
      await audit.record(connection, {
        id: uuidv7(),
        event: 'logout',
        userId: session.userId,
        loginIdAttempted: null,
        ipAddress,
        userAgent,
        detail: {},
      });
    },

    async refresh(sessionToken: string, context: AuthenticationContext): Promise<void> {
      const { connection, now } = context;

      const session = await sessions.findByTokenHash(connection, hashSessionToken(sessionToken));
      if (session === null || !isSessionUsable(session, now)) {
        return;
      }
      await sessions.touch(connection, session.id, now);
    },
  };
}
