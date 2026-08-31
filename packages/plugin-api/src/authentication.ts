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
  /** Provider の識別子。認証したユーザーの `providerId` に入る。 */
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

/**
 * Authentication Provider を差し替えるための入口。
 *
 * **Manifest で `extensions: ['authentication']` を宣言していなければ使えない。**
 * 宣言なしに差し替えられると、Plugin を入れた側が
 * 「何が認証を握っているか」を知らないまま運用することになる。
 *
 * **セッションは Torifune が発行する。**
 * Provider が受け持つのは「その資格情報が誰なのか」を決めるところまでで、
 * セッションの発行・ハッシュ保存・ログイン時の再生成・有効期限は Core に残る
 * （`04_認証設計.md` §22「Torifune自身のセッションを確立する方式を基本とする」）。
 *
 * そのため `authenticate()` が返す `userId` は、**Torifune に既に存在する
 * ユーザーの ID でなければならない。** 存在しない ID を返した場合、
 * ログインは資格情報の誤りとして扱われる（理由は呼び出し元へ返さない）。
 * 外部の利用者を初回ログインで自動作成する仕組みは、まだ提供していない。
 */
export interface PluginAuthenticationApi {
  registerProvider(provider: PluginAuthenticationProvider): void;
}
