import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { getAuthenticationProvider } from '../../authentication/registry';
import type { PublicUser } from '../../authentication/identity';
import { toPublicUser } from '../../authentication/identity';
import { hashSessionToken } from '../../authentication/session-token';
import { supportsRedirectAuthentication } from '../../authentication/provider';
import {
  AUTHORIZATION_STATE_LIFETIME_MS,
  isAuthorizationStateUsable,
  safeReturnTo,
} from '../../domain/authorization-state';
import { SESSION_LIFETIME_MS } from '../../domain/session';
import { authAuditRepository } from '../../infrastructure/auth-audit-repository';
import { authorizationStateRepository } from '../../infrastructure/authorization-state-repository';
import { withTransaction } from '../transaction';
import { authContext, type RequestInfo } from './context';

/**
 * リダイレクト型ログインの UseCase（`025-redirect-authentication` 設計）。
 *
 * OIDC 等の外部認証は「認可エンドポイントへ送り出す」「コールバックで戻る」の
 * 往復で成立する。その往復を成立させるのがここ。
 *
 * **State・Nonce・Redirect URI の検証は Core が持つ**（`04_認証設計.md` §27）。
 * Plugin ごとに実装させると、どれか1つの実装ミスが認証全体の穴になる。
 *
 * **セッションの発行も Core に残る**（同 §22）。
 * Plugin が返すのは「この外部 ID は Torifune のこのユーザーだ」まで。
 *
 * **トランザクション境界はここで張る**（`01_アーキテクチャ設計.md` §5）。
 */

/** State / Nonce の長さ。256bit。総当たりが成立しない。 */
const RANDOM_BYTES = 32;

function randomToken(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

export type StartRedirectLoginOutcome =
  | { readonly ok: true; readonly authorizationUrl: string }
  /** いまの Authentication Provider がリダイレクト往復を実装していない。 */
  | { readonly ok: false; readonly reason: 'unsupported' }
  /** Plugin が開始できなかった（設定漏れ・外部の不調）。 */
  | { readonly ok: false; readonly reason: 'unavailable' };

export interface StartRedirectLoginInput {
  /** API Layer が組み立てたコールバックの絶対 URL。 */
  readonly redirectUri: string;
  /** ログイン後の遷移先。安全でなければ `/` に丸める。 */
  readonly returnTo?: string | null | undefined;
  readonly request: RequestInfo;
}

/**
 * 認可エンドポイントへの誘導を始める。
 *
 * **State と Nonce はここで作る。Plugin には作らせない。**
 */
export async function startRedirectLogin(
  input: StartRedirectLoginInput,
): Promise<StartRedirectLoginOutcome> {
  const provider = getAuthenticationProvider();

  if (!supportsRedirectAuthentication(provider)) {
    // 標準認証にリダイレクト往復は無い。実装していないことが答えになる。
    return { ok: false, reason: 'unsupported' };
  }

  const state = randomToken();
  const nonce = randomToken();
  const returnTo = safeReturnTo(input.returnTo);

  return withTransaction(async (tx) => {
    const context = authContext(tx, input.request);

    // **Plugin を呼ぶ前に保管する。** 呼んでから保管すると、
    // 外部 Provider が即座にコールバックを返す構成で
    // 「State がまだ保存されていない」という取りこぼしが起きうる。
    await authorizationStateRepository.insert(tx, {
      id: uuidv7(),
      // State そのものは保存しない。ハッシュだけ（パスワードリセットと同じ）。
      stateHash: hashSessionToken(state),
      nonce,
      providerId: provider.id,
      redirectUri: input.redirectUri,
      returnTo,
      expiresAt: new Date(context.now.getTime() + AUTHORIZATION_STATE_LIFETIME_MS),
    });

    // 期限切れの掃除をついでに行う。専用の常駐処理を増やさない。
    await authorizationStateRepository.deleteExpired(tx, context.now);

    const started = await provider.startAuthorization!({
      ...context,
      state,
      nonce,
      redirectUri: input.redirectUri,
    });

    if (!started.ok) {
      // 保管した State はそのまま期限切れになる。**消しに行かない。**
      // 消す処理を足すと、失敗の経路が増えるだけで得るものが無い。
      return { ok: false, reason: 'unavailable' };
    }

    return { ok: true, authorizationUrl: started.authorizationUrl };
  });
}

export type CompleteRedirectLoginOutcome =
  | {
      readonly ok: true;
      readonly user: PublicUser;
      readonly sessionToken: string;
      readonly expiresAt: Date;
      readonly returnTo: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        'unsupported' | 'invalid_state' | 'invalid_credentials' | 'too_many_attempts';
    };

export interface CompleteRedirectLoginInput {
  /** コールバック URL のクエリ文字列。`code` / `state` などが入る。 */
  readonly params: Readonly<Record<string, string>>;
  /** いま到達しているコールバックの絶対 URL。発行時と同じかを照合する。 */
  readonly redirectUri: string;
  readonly request: RequestInfo;
}

/**
 * コールバックを受けてログインを成立させる。
 *
 * 検証は**1つでも合わなければ即座に失敗**。理由は呼び出し元へ細かく返さない
 * （「State が期限切れ」と「State が存在しない」を分けると、State の生死を外から探れる）。
 */
export async function completeRedirectLogin(
  input: CompleteRedirectLoginInput,
): Promise<CompleteRedirectLoginOutcome> {
  const provider = getAuthenticationProvider();

  if (!supportsRedirectAuthentication(provider)) {
    return { ok: false, reason: 'unsupported' };
  }

  const state = input.params['state'];
  if (state === undefined || state === '') {
    return { ok: false, reason: 'invalid_state' };
  }

  return withTransaction(async (tx) => {
    const context = authContext(tx, input.request);

    const stored = await authorizationStateRepository.findByStateHash(tx, hashSessionToken(state));

    if (stored === null || !isAuthorizationStateUsable(stored, context.now)) {
      return { ok: false, reason: 'invalid_state' };
    }

    // **その場で使い捨てる。** 未使用だったのが自分だけであることを、
    // 更新できた行数で確かめる。読んでから書くと、同時に来た2本が両方通る。
    const claimed = await authorizationStateRepository.markUsed(tx, stored.id, context.now);
    if (!claimed) {
      return { ok: false, reason: 'invalid_state' };
    }

    // 認可開始のあとに Authentication Provider が差し替わっていたら受け付けない。
    // 別の Provider が始めた往復を、いまの Provider に閉じさせない。
    if (stored.providerId !== provider.id) {
      return { ok: false, reason: 'invalid_state' };
    }

    // Redirect URI 検証（`04_認証設計.md` §27）。
    // **Core が発行した値と、いま実際に到達している URL が同じであること。**
    // Plugin に選ばせていないので、Plugin 側の実装ミスでここが緩むことはない。
    if (stored.redirectUri !== input.redirectUri) {
      return { ok: false, reason: 'invalid_state' };
    }

    const result = await provider.completeAuthorization!(
      {
        params: input.params,
        redirectUri: stored.redirectUri,
        // ID Token の nonce Claim との照合は Plugin が行う。
        // Core が保証するのは「新鮮・この往復専用・一度きり」まで。
        nonce: stored.nonce,
      },
      context,
    );

    if (!result.ok) {
      await authAuditRepository.record(tx, {
        id: uuidv7(),
        event: 'login.failed',
        userId: null,
        loginIdAttempted: null,
        ipAddress: input.request.ipAddress,
        userAgent: input.request.userAgent,
        detail: { flow: 'redirect', providerId: provider.id },
      });
      return { ok: false, reason: result.reason };
    }

    // ログインのたびに新しいセッションを発行する（Session Fixation 対策）。
    //
    // **Remember Me は効かせない。** リダイレクト型では
    // 「ログインしたままにする」を選ばせる画面が Torifune 側に無く、
    // 利用者が選んでいないものを勝手に長期化しない。
    const session = await provider.issue(result.identity.userId, context, {
      lifetimeMs: SESSION_LIFETIME_MS,
    });

    await authAuditRepository.record(tx, {
      id: uuidv7(),
      event: 'login.succeeded',
      userId: result.identity.userId,
      loginIdAttempted: null,
      ipAddress: input.request.ipAddress,
      userAgent: input.request.userAgent,
      detail: { flow: 'redirect', providerId: provider.id },
    });

    return {
      ok: true,
      user: toPublicUser(result.identity),
      sessionToken: session.token,
      expiresAt: session.expiresAt,
      returnTo: stored.returnTo,
    };
  });
}
