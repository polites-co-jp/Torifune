import type { PluginAuthenticationProvider, PluginUserIdentity } from '@torifune/plugin-api';
import type {
  AuthenticationContext,
  AuthenticationProvider,
  AuthenticationResult,
  AuthorizationCallback,
  AuthorizationStart,
  AuthorizationStartContext,
  SessionIssuer,
} from '@/authentication/provider';
import type { UserIdentity } from '@/authentication/identity';
import { userRepository } from '@/infrastructure/user-repository';

/**
 * Plugin の Authentication Provider を本体の Provider として使えるようにする。
 *
 * **セッションの発行は Core に残す。**
 * 公開契約（`plugin-api/authentication.ts`）に `issue` は無く、Plugin が
 * 受け持つのは「その資格情報が誰なのか」を決めるところまで。
 * セッションの発行・ハッシュ保存・ログイン時の再生成・有効期限・
 * アイドルタイムアウトは Core のままにする
 * （`04_認証設計.md` §22「Torifune自身のセッションを確立する方式を基本とする」）。
 *
 * そのため `issue` は差し替え前の Provider（標準認証）のものを使い続ける。
 * ここを Plugin へ渡すと、Session Fixation 対策と失効の責任が
 * Plugin ごとにばらける。
 *
 * **リダイレクト型（OIDC 等）でも同じ。**
 * `completeAuthorization` が返すのは「この外部 ID は Torifune のこのユーザーだ」まで。
 * State の発行・照合・使い捨てと、セッションの発行は Core に残る
 * （`025-redirect-authentication` 設計 §2）。
 */

export interface AdaptOptions {
  readonly provider: PluginAuthenticationProvider;
  /** セッション発行を担う、差し替え前の Provider。 */
  readonly sessionIssuer: SessionIssuer;
}

/** Plugin 側の文脈へ落とす。**`Connection` を渡さない。** */
function toPluginContext(context: AuthenticationContext): {
  ipAddress: string | null;
  userAgent: string | null;
  now: Date;
} {
  return {
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    now: context.now,
  };
}

/**
 * Plugin が返した表現を本体の `UserIdentity` にする。
 *
 * **Torifune に実在するユーザーであることをここで確かめる。**
 * 確かめないと、Plugin が任意の `userId` を名乗るだけで
 * そのユーザーとしてセッションが発行されてしまう。
 * 実在しなければ `null` を返し、呼び出し元は資格情報の誤りとして扱う。
 */
async function resolveIdentity(
  identity: PluginUserIdentity,
  providerId: string,
  context: AuthenticationContext,
): Promise<UserIdentity | null> {
  const user = await userRepository.findById(context.connection, identity.userId);
  if (user === null) {
    return null;
  }

  return {
    userId: user.id,
    loginId: user.loginId,
    displayName: user.displayName,
    email: user.email,
    // **Plugin の申告ではなく、登録された Provider の ID を使う。**
    providerId,
    externalUserId: identity.externalUserId,
  };
}

/**
 * リダイレクト往復（`04_認証設計.md` §17 §21）を橋渡しする。
 *
 * **両方揃っているときだけ生やす。** 片方だけでは往復が閉じず、
 * 「認可エンドポイントへは飛ぶがログインは決して成立しない」という
 * 気づきにくい壊れ方になる。生やさなければ Core は `unsupported` と答えられる。
 *
 * **State / Nonce / Redirect URI は Core が発行して `context` で渡す。**
 * ここでは Plugin の申告を一切受け取らない。
 */
function redirectMethodsOf(
  provider: PluginAuthenticationProvider,
): Pick<AuthenticationProvider, 'startAuthorization' | 'completeAuthorization'> {
  const start = provider.startAuthorization;
  const complete = provider.completeAuthorization;

  if (start === undefined || complete === undefined) {
    return {};
  }

  return {
    async startAuthorization(context: AuthorizationStartContext): Promise<AuthorizationStart> {
      return start.call(provider, {
        ...toPluginContext(context),
        state: context.state,
        nonce: context.nonce,
        redirectUri: context.redirectUri,
      });
    },

    async completeAuthorization(
      callback: AuthorizationCallback,
      context: AuthenticationContext,
    ): Promise<AuthenticationResult> {
      const result = await complete.call(provider, callback, toPluginContext(context));
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }

      const identity = await resolveIdentity(result.identity, provider.id, context);
      if (identity === null) {
        // **理由を分けない。** `authenticate` と同じ扱い。
        // 「そのユーザーは居ない」と返すと、外部の識別子から利用者を探れる。
        return { ok: false, reason: 'invalid_credentials' };
      }

      return { ok: true, identity };
    },
  };
}

export function adaptPluginAuthenticationProvider(
  options: AdaptOptions,
): AuthenticationProvider & SessionIssuer {
  const { provider, sessionIssuer } = options;

  return {
    id: provider.id,

    // 往復型を実装している Plugin のときだけ生える。
    ...redirectMethodsOf(provider),

    async authenticate(credentials, context): Promise<AuthenticationResult> {
      const result = await provider.authenticate(credentials, toPluginContext(context));
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }

      const identity = await resolveIdentity(result.identity, provider.id, context);
      if (identity === null) {
        // **理由を分けない。** 「そのユーザーは居ない」と返すと、
        // 外部の識別子から Torifune の利用者を探れる。
        return { ok: false, reason: 'invalid_credentials' };
      }

      return { ok: true, identity };
    },

    async getIdentity(sessionToken, context): Promise<UserIdentity | null> {
      const identity = await provider.getIdentity(sessionToken, toPluginContext(context));
      if (identity === null) {
        return null;
      }
      return resolveIdentity(identity, provider.id, context);
    },

    async logout(sessionToken, context): Promise<void> {
      await provider.logout(sessionToken, toPluginContext(context));
    },

    async refresh(sessionToken, context): Promise<void> {
      await provider.refresh(sessionToken, toPluginContext(context));
    },

    // セッションの発行は差し替えない。
    //
    // **`options` をそのまま渡す。** 落とすと、Authentication Provider を
    // 差し替えた環境でだけ長期ログイン（Remember Me）が効かなくなる。
    // 画面のチェックボックスは押せるのに効かない、という気づきにくい壊れ方になる。
    issue: (userId, context, options) => sessionIssuer.issue(userId, context, options),
  };
}
