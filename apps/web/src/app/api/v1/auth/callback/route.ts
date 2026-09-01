import { AUTHORIZATION_CALLBACK_PATH } from '@torifune/plugin-api';
import { completeRedirectLogin } from '@/application/auth/redirect-login';
import { absoluteUrl, AbsoluteUrlError } from '@/api/absolute-url';
import { requestInfoOf, sessionCookie } from '@/api/cookies';
import { defineRoute } from '@/api/route';
import { log } from '@/infrastructure/logging';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * リダイレクト型ログインのコールバック（`04_認証設計.md` §21）。
 *
 * 外部 Provider が利用者のブラウザをここへ戻す。
 * ここで Plugin に Token Exchange と Token 検証をさせ、
 * **セッションは Core が発行する**（同 §22）。
 *
 * ## CSRF の扱い（`025-redirect-authentication` 設計 §7.2）
 *
 * **外部からのリダイレクトなので、通常の CSRF 判定はそのままでは効かない。**
 *
 * * `Origin` は外部 Provider のオリジン（または欠落）になる。
 *   `isSameOriginRequest()` は必ず false を返す
 * * `Sec-Fetch-Site` は `cross-site`
 * * CSRF トークン（`torifune_csrf` Cookie と `x-csrf-token`）は、
 *   **外部 Provider が張るリダイレクトに載せられない**
 *
 * つまり `verifyCsrf()` をここへ当てると、正当なコールバックが100%落ちる。
 *
 * **その代わりを State 検証が担う。** State は
 *
 * * Core が 256bit の乱数で発行し、DB にハッシュで保管する
 * * 認可要求と一緒に外部 Provider へ渡り、そのまま返ってくる
 * * **一度しか使えない**（`used_at`）／**10分で切れる**
 * * Provider と redirect_uri に束縛されている
 *
 * ため、攻撃者が有効な State を用意してコールバックを偽造できない。
 * これは OAuth 2.0 / OIDC で State が担う役割そのものであり、
 * `04_認証設計.md` §27 が「State検証」として挙げている項目にあたる。
 *
 * **`csrfExemptReason` は書かない。** GET なので `defineRoute` の CSRF 検証は
 * もともと通らず、書くと「非安全メソッドで CSRF を外した」ように読める。
 *
 * ## GET の応答でセッション Cookie を張ることについて
 *
 * 通常なら避けたい形だが、コールバックは
 * 「State という一度きりの秘密を持って到達した要求」であり、偽造も再送もできない。
 * **ログイン成立の一点に限って許す。**
 */

/** 失敗したときの戻り先。**理由を細かく出さない。** */
const LOGIN_FAILURE_LOCATION = '/login?error=authorization_failed';

function redirectTo(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { Location: location, ...headers } });
}

export const GET = defineRoute({
  operationId: 'completeAuthorization',
  method: 'GET',
  path: '/auth/callback',
  summary: '外部認証（リダイレクト型）のコールバックを受ける',
  permission: null,
  reason: '外部 Provider からのリダイレクトを受ける。認証を成立させる口そのもの',
  // ブラウザのリダイレクト用の口であり、API クライアントが叩くものではない。
  documented: false,
  // クエリの中身は方式ごとに違う（code / state / error / …）。素通しして Plugin へ渡す。
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ request }) => {
    // 認証を通す前に Plugin を起動する（`/auth/login` と同じ）。
    await ensurePluginsStartedAnonymously();

    const url = new URL(request.url);
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      params[key] = value;
    }

    let redirectUri: string;
    try {
      // 発行時と同じ組み立て方をする。ここが揃わないと Redirect URI 検証が通らない。
      redirectUri = absoluteUrl(request, AUTHORIZATION_CALLBACK_PATH);
    } catch (error) {
      if (error instanceof AbsoluteUrlError) {
        log.error('failed to build redirect_uri', { reason: error.message });
        return redirectTo(LOGIN_FAILURE_LOCATION);
      }
      throw error;
    }

    const outcome = await completeRedirectLogin({
      params,
      redirectUri,
      request: requestInfoOf(request),
    });

    if (!outcome.ok) {
      // **理由を出し分けない。** State の生死や、外部の利用者が Torifune に
      // 居るかどうかを、戻り先の違いから探れるようにしない。
      return redirectTo(LOGIN_FAILURE_LOCATION);
    }

    // 遷移先は UseCase が安全な値へ丸めてある（アプリ内の絶対パスのみ）。
    return redirectTo(outcome.returnTo, {
      'Set-Cookie': sessionCookie(request, outcome.sessionToken, outcome.expiresAt),
    });
  },
});
