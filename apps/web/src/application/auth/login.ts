import { getAuthenticationProvider } from '../../authentication/registry';
import type { PublicUser } from '../../authentication/identity';
import { toPublicUser } from '../../authentication/identity';
import { withTransaction } from '../transaction';
import { authContext, type RequestInfo } from './context';

/**
 * ログイン UseCase。
 *
 * **トランザクション境界はここで張る**（01_アーキテクチャ設計.md §5）。
 * 認証・監査ログ・セッション発行を一括で成立させ、途中で失敗したら何も残さない。
 */

export interface LoginInput {
  readonly loginId: string;
  readonly password: string;
  readonly request: RequestInfo;
}

export type LoginOutcome =
  | {
      readonly ok: true;
      readonly user: PublicUser;
      readonly sessionToken: string;
      readonly expiresAt: Date;
    }
  | { readonly ok: false; readonly reason: 'invalid_credentials' | 'too_many_attempts' };

export async function login(input: LoginInput): Promise<LoginOutcome> {
  const provider = getAuthenticationProvider();

  return withTransaction(async (tx) => {
    const context = authContext(tx, input.request);

    const result = await provider.authenticate(
      { loginId: input.loginId, password: input.password },
      context,
    );

    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }

    // ログインのたびに新しいセッションを発行する。
    // 既存のセッション識別子を引き継ぐと Session Fixation が成立する。
    const session = await provider.issue(result.identity.userId, context);

    return {
      ok: true,
      user: toPublicUser(result.identity),
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    };
  });
}
