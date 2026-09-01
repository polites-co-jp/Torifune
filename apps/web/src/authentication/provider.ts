import type { Connection } from '../database/provider';
import type { UserIdentity } from './identity';

/**
 * 認証方式の抽象（04_認証設計.md §15）。
 *
 * Torifune 本体は、具体的な認証方式を直接認識しない。
 * Plugin が Provider を差し替えることで OIDC 等へ移行できる。
 *
 * **signature に Cookie / Request / Response の型を出さない。**
 * HTTP の詳細は API Layer の責務であり、Provider は CLI やバッチからも呼べる形にしておく。
 * ここは `010-plugin-api` でそのまま公開契約になる。
 */

/** 認証に必要な資格情報。方式によって中身が変わるため、Provider が解釈する。 */
export interface Credentials {
  readonly loginId: string;
  readonly password: string;
}

/** 認証を行った文脈。監査ログと試行制限に使う。 */
export interface AuthenticationContext {
  readonly connection: Connection;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly now: Date;
}

/**
 * 認証の結果。
 *
 * **失敗の理由を呼び出し側へ返さない。**
 * 「IDが無い」と「パスワードが違う」を区別できると、アカウントを列挙できてしまう。
 * 試行制限に到達したことだけは、429 を返すために区別する。
 */
export type AuthenticationResult =
  | { readonly ok: true; readonly identity: UserIdentity }
  | { readonly ok: false; readonly reason: 'invalid_credentials' | 'too_many_attempts' };

/**
 * 認可開始のときに Core が Provider へ渡すもの（リダイレクト型認証）。
 *
 * **State・Nonce・Redirect URI は Core が発行する。**
 * `025-redirect-authentication` 設計 §2。
 */
export interface AuthorizationStartContext extends AuthenticationContext {
  readonly state: string;
  readonly nonce: string;
  /** Core が受け付けるコールバック URL（絶対 URL）。 */
  readonly redirectUri: string;
}

/** 認可開始の結果。**失敗の理由を細かく返さない。** */
export type AuthorizationStart =
  | { readonly ok: true; readonly authorizationUrl: string }
  | { readonly ok: false; readonly reason: 'unavailable' };

/** コールバックで戻ってきたもの。**state の照合は Core が済ませてある。** */
export interface AuthorizationCallback {
  readonly params: Readonly<Record<string, string>>;
  readonly redirectUri: string;
  readonly nonce: string;
}

export interface AuthenticationProvider {
  /** Provider の識別子。`UserIdentity.providerId` に入る。 */
  readonly id: string;

  /** 資格情報を検証し、成功したら UserIdentity を返す。 */
  authenticate(
    credentials: Credentials,
    context: AuthenticationContext,
  ): Promise<AuthenticationResult>;

  /**
   * セッション識別子から UserIdentity を得る。
   *
   * 有効でないセッション（期限切れ・失効・存在しない）では null を返す。
   */
  getIdentity(sessionToken: string, context: AuthenticationContext): Promise<UserIdentity | null>;

  /** セッションを失効させる。 */
  logout(sessionToken: string, context: AuthenticationContext): Promise<void>;

  /**
   * セッションの有効期間を延ばす。
   *
   * 標準認証では最終アクセス時刻の更新にあたる。
   * 外部認証では、Refresh Token による更新にあたる。
   */
  refresh(sessionToken: string, context: AuthenticationContext): Promise<void>;

  /**
   * 認可エンドポイントへの誘導を始める（**任意実装**）。
   *
   * 標準認証はリダイレクト往復を持たないため実装しない。
   * **実装していないことをもって「この環境ではリダイレクト型ログインを使えない」と判定する。**
   */
  startAuthorization?(context: AuthorizationStartContext): Promise<AuthorizationStart>;

  /**
   * コールバックを受けて利用者を確定する（**任意実装**）。
   *
   * **セッションは発行しない。** 発行するのは Core（`SessionIssuer`）。
   */
  completeAuthorization?(
    callback: AuthorizationCallback,
    context: AuthenticationContext,
  ): Promise<AuthenticationResult>;
}

/** その Provider がリダイレクト往復に対応しているか。**両方揃って初めて往復が閉じる。** */
export function supportsRedirectAuthentication(provider: AuthenticationProvider): boolean {
  return (
    typeof provider.startAuthorization === 'function' &&
    typeof provider.completeAuthorization === 'function'
  );
}

/** セッション発行時の指定。 */
export interface IssueOptions {
  /**
   * セッションの有効期間。省略すると既定（SESSION_LIFETIME_MS）。
   *
   * 長期ログイン（Remember Me）で長くする。**呼び出し側が決める。**
   * Provider が方針を持つと、Provider を差し替えるたびに方針が変わる。
   */
  readonly lifetimeMs?: number | undefined;
}

/** ログイン成功時にセッションを発行する責務。Provider とは分けている。 */
export interface SessionIssuer {
  issue(
    userId: string,
    context: AuthenticationContext,
    options?: IssueOptions,
  ): Promise<{ readonly token: string; readonly expiresAt: Date }>;
}
