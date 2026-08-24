import { authAuditRepository } from '../infrastructure/auth-audit-repository';
import { loginAttemptRepository } from '../infrastructure/login-attempt-repository';
import { sessionRepository } from '../infrastructure/session-repository';
import { userRepository } from '../infrastructure/user-repository';
import { createLocalProvider } from './local-provider';
import type { AuthenticationProvider, SessionIssuer } from './provider';
import { createRateLimiter } from './rate-limit';

/**
 * Authentication Provider の登録と解決（04_認証設計.md §4）。
 *
 * 標準では標準認証を使う。Plugin が差し替えることで OIDC 等へ移行できる。
 * 差し替えの口は `011-plugin-runtime` でここへ繋ぐ。
 *
 * **Application 層はこの関数だけを見る。**
 * どの Provider が使われているかを本体のどこにも書かない。
 */

type Provider = AuthenticationProvider & SessionIssuer;

let provider: Provider | null = null;

function createDefaultProvider(): Provider {
  return createLocalProvider({
    users: userRepository,
    sessions: sessionRepository,
    audit: authAuditRepository,
    rateLimiter: createRateLimiter(loginAttemptRepository),
  });
}

export function getAuthenticationProvider(): Provider {
  provider ??= createDefaultProvider();
  return provider;
}

/** Plugin の Authentication Provider と、テストの差し替えのための入口。 */
export function setAuthenticationProvider(next: Provider | null): void {
  provider = next;
}
