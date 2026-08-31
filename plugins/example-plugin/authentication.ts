import type {
  PluginAuthenticationProvider,
  PluginAuthenticationResult,
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
 */

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
