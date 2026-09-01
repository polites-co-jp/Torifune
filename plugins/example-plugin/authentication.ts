import type {
  PluginAuthenticationProvider,
  PluginAuthenticationResult,
  PluginAuthorizationCallback,
  PluginAuthorizationStart,
  PluginAuthorizationStartContext,
  PluginCredentials,
  PluginLogger,
} from '@torifune/plugin-api';

/**
 * ダミーの Authentication Provider。
 *
 * **差し替えが成立することを見せるためだけのもの。実運用に使わない。**
 *
 * 本物の外部認証（OIDC / LDAP）はここで外部へ問い合わせ、
 * 得た識別子を Torifune のユーザーへ結び付ける。
 *
 * **セッションは Torifune が発行する。** Provider が返すのは「誰か」まで。
 * `userId` は Torifune に実在するユーザーの ID でなければならず、
 * 実在しなければログインは資格情報の誤りとして扱われる。
 *
 * この Provider は2つの方式を同時に見せている。
 *
 * 1. `authenticate()` — 合言葉による直接認証（往復なし）
 * 2. `startAuthorization()` / `completeAuthorization()` — リダイレクト往復
 *
 * **2 は外部サービスへ繋がない。** 認可エンドポイントの代わりに
 * Torifune のコールバックへそのまま戻る URL を返す（0ホップの IdP）。
 * 短絡しているのは「外部 Provider が居るかどうか」だけで、
 * ブラウザの往復・State の発行と照合と使い捨て・セッション発行は
 * **本番と同じ経路を通る。**
 */

/**
 * ダミーの Authorization Code。
 *
 * 本物ではここが外部 Provider の発行した使い捨てコードになり、
 * `completeAuthorization` で Token Exchange に使う。
 */
const DUMMY_AUTHORIZATION_CODE = 'example-authorization-code';

export interface DummyAuthenticationOptions {
  readonly logger: PluginLogger;
  /** この Provider が認証を通すユーザー。実在する Torifune のユーザー ID。 */
  readonly userId: string;
  /** 合言葉。**サンプルなので固定値。本物は外部へ問い合わせる。** */
  readonly passphrase: string;
}

export function createDummyAuthenticationProvider(
  options: DummyAuthenticationOptions,
): PluginAuthenticationProvider {
  const { logger, userId, passphrase } = options;

  return {
    id: 'example-plugin.dummy',

    async authenticate(credentials: PluginCredentials): Promise<PluginAuthenticationResult> {
      // **失敗の理由を分けない。** 分けるとアカウントを列挙できる。
      if (credentials.password !== passphrase) {
        logger.info('認証に失敗した');
        return { ok: false, reason: 'invalid_credentials' };
      }

      logger.info('認証に成功した');
      return {
        ok: true,
        identity: {
          userId,
          loginId: credentials.loginId,
          displayName: credentials.loginId,
          email: '',
          providerId: 'example-plugin.dummy',
          externalUserId: `external:${credentials.loginId}`,
        },
      };
    },

    async startAuthorization(
      context: PluginAuthorizationStartContext,
    ): Promise<PluginAuthorizationStart> {
      // 本物はここで認可エンドポイントの URL を組み立てる。
      //
      //   https://idp.example/authorize
      //     ?response_type=code&client_id=…&scope=openid%20profile
      //     &redirect_uri=<context.redirectUri>
      //     &state=<context.state>&nonce=<context.nonce>
      //
      // **state / nonce / redirect_uri は自分で作らない。** Torifune が渡したものを使う。
      // ここではその外部 Provider を省き、コールバックへ直接戻る URL を返す。
      const url = new URL(context.redirectUri);
      url.searchParams.set('state', context.state);
      url.searchParams.set('code', DUMMY_AUTHORIZATION_CODE);

      logger.info('認可へ誘導した');
      return { ok: true, authorizationUrl: url.toString() };
    },

    async completeAuthorization(
      callback: PluginAuthorizationCallback,
    ): Promise<PluginAuthenticationResult> {
      // 本物はここで
      //   1. Authorization Code を Token Exchange して ID Token を得る
      //   2. iss / aud / exp / 署名 / 必要な Claim を検証する（04_認証設計.md §23）
      //   3. ID Token の nonce Claim が callback.nonce と一致することを確かめる
      //   4. sub（外部ユーザーID）から Torifune のユーザーを引く
      // を行う。
      //
      // **state の照合は Torifune が済ませてある。** ここでやり直さない。
      if (callback.params['code'] !== DUMMY_AUTHORIZATION_CODE) {
        // **失敗の理由を分けない。** authenticate() と同じ扱い。
        logger.info('コールバックの検証に失敗した');
        return { ok: false, reason: 'invalid_credentials' };
      }

      logger.info('コールバックの検証に成功した');
      return {
        ok: true,
        identity: {
          userId,
          loginId: 'example-sso',
          displayName: 'example-sso',
          email: '',
          providerId: 'example-plugin.dummy',
          externalUserId: 'external:example-sso',
        },
      };
    },

    async getIdentity(): Promise<null> {
      // セッションの検証は Torifune 側が行う。
      // 外部認証でも、Torifune のセッションが張られたあとはそちらが正になる。
      return null;
    },

    async logout(): Promise<void> {
      logger.info('ログアウトを受け取った');
    },

    async refresh(): Promise<void> {
      // 本物は Refresh Token でここを更新する。
    },
  };
}
