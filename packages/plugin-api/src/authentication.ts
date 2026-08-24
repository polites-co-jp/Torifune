/**
 * Authentication Provider の公開契約（04_認証設計.md §15）。
 *
 * Plugin が認証方式を差し替えるための入口。
 *
 * **signature に Cookie / Request / Response を出さない。**
 * HTTP の詳細は本体の API Layer の責務であり、
 * Provider は CLI やバッチからも呼べる形にしておく。
 */

/** 認証方式によらない、統一されたユーザー表現（同 §16）。 */
export interface PluginUserIdentity {
  readonly userId: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
  readonly providerId: string;
  /** 外部 Provider におけるユーザーID。標準認証では null。 */
  readonly externalUserId: string | null;
}

export interface PluginCredentials {
  readonly loginId: string;
  readonly password: string;
}

/**
 * 認証の結果。
 *
 * **失敗の理由を呼び出し側へ返さない。**
 * 「IDが無い」と「パスワードが違う」を区別できると、アカウントを列挙できてしまう。
 */
export type PluginAuthenticationResult =
  | { readonly ok: true; readonly identity: PluginUserIdentity }
  | { readonly ok: false; readonly reason: 'invalid_credentials' | 'too_many_attempts' };

export interface PluginAuthenticationContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

export interface PluginAuthenticationProvider {
  readonly id: string;
  authenticate(
    credentials: PluginCredentials,
    context: PluginAuthenticationContext,
  ): Promise<PluginAuthenticationResult>;
  getIdentity(
    sessionToken: string,
    context: PluginAuthenticationContext,
  ): Promise<PluginUserIdentity | null>;
  logout(sessionToken: string, context: PluginAuthenticationContext): Promise<void>;
  refresh(sessionToken: string, context: PluginAuthenticationContext): Promise<void>;
}
