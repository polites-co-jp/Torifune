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

/**
 * 認可開始のときに Torifune が渡すもの（リダイレクト型認証）。
 *
 * **State・Nonce・Redirect URI は Torifune が発行する。Plugin が作らない。**
 * Plugin ごとに実装させると、どれか1つの実装ミスが認証全体の穴になる
 * （`04_認証設計.md` §27）。
 */
export interface PluginAuthorizationStartContext extends PluginAuthenticationContext {
  /**
   * Torifune が発行した state。
   *
   * **認可要求の `state` へそのまま載せる。自分で作らない。**
   * 照合・使い捨て・有効期限は Torifune がコールバックで面倒を見る。
   */
  readonly state: string;
  /**
   * Torifune が発行した nonce。OIDC では認可要求の `nonce` へ載せる。
   *
   * Torifune が保証するのは「新鮮・この往復専用・一度きり」まで。
   * **ID Token の `nonce` Claim との照合は Plugin が行う**
   * （Torifune は JWT を解釈しない。解釈すると Core が OIDC を知ることになる）。
   */
  readonly nonce: string;
  /**
   * Torifune が受け付けるコールバック URL（絶対 URL）。
   *
   * **これをそのまま `redirect_uri` に使う。別の URL を使わない。**
   * コールバック時に、Torifune が同じ値であることを照合する。
   */
  readonly redirectUri: string;
}

/**
 * 認可開始の結果。
 *
 * **失敗の理由を細かく返さない。** 設定漏れも外部の不調も、
 * 利用者から見れば「ログインを開始できなかった」でしかない。
 */
export type PluginAuthorizationStart =
  | { readonly ok: true; readonly authorizationUrl: string }
  | { readonly ok: false; readonly reason: 'unavailable' };

/**
 * コールバックで戻ってきたもの。
 *
 * **`state` の照合は Torifune が済ませてある。** Plugin は再度確かめなくてよい。
 */
export interface PluginAuthorizationCallback {
  /** コールバック URL のクエリ文字列。`code` などが入る。 */
  readonly params: Readonly<Record<string, string>>;
  /** 認可開始時に渡したのと同じ redirect_uri。Token Exchange で要る。 */
  readonly redirectUri: string;
  /** 認可開始時に渡したのと同じ nonce。ID Token の Claim と照合する。 */
  readonly nonce: string;
}

/**
 * 認可開始の入口。**Plugin はこのパスを推測せず、この定数を使う。**
 *
 * `login.methods` 拡張点へ差し込む「Googleでログイン」等のボタンは、
 * ここへのリンクにする（`06_画面設計.md` §5）。
 */
export const AUTHORIZATION_START_PATH = '/api/v1/auth/authorize';

/** コールバックの受け口。外部 Provider へ登録する Redirect URI のパス。 */
export const AUTHORIZATION_CALLBACK_PATH = '/api/v1/auth/callback';

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

  /**
   * 認可エンドポイントへの誘導を始める（**任意実装**）。
   *
   * OIDC / SAML / SNS ログインのような、ブラウザのリダイレクト往復を伴う方式で使う。
   * 標準認証や合言葉型のように往復が無い方式では実装しない。
   *
   * ここで組み立てるのは Authorization Request（`client_id` / `scope` / PKCE 等）。
   * **`state` と `nonce` と `redirect_uri` は `context` のものをそのまま使う。**
   *
   * `completeAuthorization` と**両方を実装するか、両方とも実装しないか。**
   * 片方だけでは往復が閉じない。
   */
  startAuthorization?(context: PluginAuthorizationStartContext): Promise<PluginAuthorizationStart>;

  /**
   * コールバックを受けて利用者を確定する（**任意実装**）。
   *
   * ここで行うのは Token Exchange と Token 検証（`04_認証設計.md` §23）。
   * 発行者・Audience・有効期限・署名・nonce・必要な Claim を確かめる。
   *
   * **戻り値は `authenticate()` と同じ。** 成功の表現を2つ作らない。
   * 返した `userId` が Torifune に実在することは Torifune 側が確かめる。
   * **セッションは Torifune が発行する。**
   */
  completeAuthorization?(
    callback: PluginAuthorizationCallback,
    context: PluginAuthenticationContext,
  ): Promise<PluginAuthenticationResult>;
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
