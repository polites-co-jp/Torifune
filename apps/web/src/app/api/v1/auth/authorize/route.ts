import { z } from 'zod';
import { AUTHORIZATION_CALLBACK_PATH } from '@torifune/plugin-api';
import { startRedirectLogin } from '@/application/auth/redirect-login';
import { absoluteUrl, AbsoluteUrlError } from '@/api/absolute-url';
import { requestInfoOf } from '@/api/cookies';
import { errorResponse } from '@/api/errors';
import { defineRoute } from '@/api/route';
import { log } from '@/infrastructure/logging';
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

/**
 * リダイレクト型ログインの開始（`04_認証設計.md` §17 §21）。
 *
 * Plugin が `login.methods` へ差し込んだ「Googleでログイン」等のボタンは、
 * ここへのリンクになる（`@torifune/plugin-api` の `AUTHORIZATION_START_PATH`）。
 *
 * ## なぜ GET か
 *
 * `login.methods` へ差し込まれるのは Plugin が書いた部品であり、
 * **アンカー1つで辿れる形でなければボタンが書けない。**
 * リダイレクト型ログインの入口が GET なのは、IdP 連携で共通の形でもある。
 *
 * ## CSRF をかけない理由
 *
 * GET は `defineRoute` の `SAFE_METHODS` に入るため、そもそも CSRF 検証を通らない。
 * **それでよい。**
 *
 * * この口はセッションに紐づく操作を一切していない。
 *   叩きに来るのは**まだ誰とも分かっていない相手**である
 * * 他所のサイトから叩かれても、起きるのは「外部の認可画面へ飛ばされる」だけ。
 *   **セッションはここでは張られない**（張るのはコールバック側）
 * * 往復の正当性は State が担保する。State は Core がここで発行し、
 *   コールバックで照合する（`025-redirect-authentication` 設計 §6 §7）
 *
 * Rate Limit は `login` と同じ強さにする。State の大量発行を止める。
 */

const AuthorizeQuery = z.object({
  /** ログイン後の遷移先。安全でなければ UseCase が `/` に丸める。 */
  returnTo: z.string().optional(),
});

export const GET = defineRoute({
  operationId: 'startAuthorization',
  method: 'GET',
  path: '/auth/authorize',
  summary: '外部認証（リダイレクト型）のログインを開始する',
  permission: null,
  reason: '認証前に呼ばれる。ログインを開始するための口そのもの',
  // ブラウザのリダイレクト用の口であり、API クライアントが叩くものではない。
  documented: false,
  query: AuthorizeQuery,
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ request, query }) => {
    // **認証を通す前に Plugin を起動する。**
    // 認証方式を差し替える Plugin が起動していなければ、
    // 差し替えたはずの Provider を誰も通らない（`04_認証設計.md` §15）。
    await ensurePluginsStartedAnonymously();

    let redirectUri: string;
    try {
      // **`request.url` からは組み立てない。** Next.js が localhost へ正規化する。
      redirectUri = absoluteUrl(request, AUTHORIZATION_CALLBACK_PATH);
    } catch (error) {
      if (error instanceof AbsoluteUrlError) {
        log.error('failed to build redirect_uri', { reason: error.message });
        return errorResponse('INTERNAL_ERROR');
      }
      throw error;
    }

    const outcome = await startRedirectLogin({
      redirectUri,
      returnTo: query.returnTo,
      request: requestInfoOf(request),
    });

    if (!outcome.ok) {
      // **`unsupported` と `unavailable` を画面へ出し分けない。**
      // どちらも利用者から見れば「ログインを開始できなかった」でしかなく、
      // 「この環境は外部認証を設定していない」を外から探れるようにする理由が無い。
      return errorResponse('BAD_REQUEST');
    }

    return new Response(null, {
      status: 302,
      headers: { Location: outcome.authorizationUrl },
    });
  },
});
