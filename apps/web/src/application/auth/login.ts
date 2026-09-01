import { getAuthenticationProvider } from '../../authentication/registry';
import type { PublicUser } from '../../authentication/identity';
import { toPublicUser } from '../../authentication/identity';
import { SESSION_LIFETIME_MS } from '../../domain/session';
import { sessionLifetimeMs } from '../../domain/system-settings';
import { loadSystemSettings } from '../system-settings/system-settings-use-cases';
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
  /**
   * 長期ログイン（04_認証設計.md §11）。
   *
   * **設定で禁止されていれば効かない。** 画面から指定されただけで
   * 期間が伸びる形にすると、組織の方針で止められない。
   */
  readonly rememberMe?: boolean;
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

  // 設定はトランザクションの外で読む。認証の可否に関わらない値であり、
  // ここで読めなくてもログインを止める理由が無い。
  const settings = await loadSystemSettings();

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
    const session = await provider.issue(result.identity.userId, context, {
      lifetimeMs: sessionLifetimeMs(SESSION_LIFETIME_MS, {
        rememberMe: input.rememberMe === true,
        rememberMeEnabled: settings.rememberMeEnabled,
      }),
    });

    return {
      ok: true,
      user: toPublicUser(result.identity),
      sessionToken: session.token,
      expiresAt: session.expiresAt,
    };
  });
}
