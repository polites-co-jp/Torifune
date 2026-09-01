import { NextResponse, type NextRequest } from 'next/server';
import { corsPreflightHeaders } from '@/api/cors';
import { buildSecurityHeaders, generateNonce } from '@/security-headers';

/**
 * 全リクエストに対して同じことをする処理を1箇所へ集める。
 *
 * * CSP / HSTS などのセキュリティヘッダ（`04` §13、`05` §42）
 * * CORS の Preflight（`05` §43）
 *
 * **ルートごとに書くと必ず抜ける。** `defineRoute` が認証・CSRF・Rate Limit を
 * 引き受けているのと同じ理由で、ここへ寄せる。
 *
 * 認証はここで行わない。ページ側の `requirePageSession()` と
 * UseCase の `requirePermission` が行う（決定事項 D-06）。
 * middleware で認可すると、判定が2箇所になって食い違う。
 */

export function middleware(request: NextRequest): NextResponse {
  // Preflight は本体の処理へ通さない。通しても意味が無く、
  // 認証や CSRF の検証にかかって落ちるだけ。
  if (request.method === 'OPTIONS' && request.nextUrl.pathname.startsWith('/api/')) {
    const cors = corsPreflightHeaders(request);
    // 許可していない Origin には CORS ヘッダを付けない。
    // ブラウザ側が「許可されていない」と判断できればよく、
    // ここで 403 を返す必要は無い（返しても情報が増えるだけ）。
    return new NextResponse(null, { status: 204, headers: cors });
  }

  const nonce = generateNonce();
  const headers = buildSecurityHeaders(request, nonce);

  // **リクエスト側にも CSP を載せる。** Next.js はここから nonce を取り出して
  // 自分の script タグへ付ける。
  //
  // 載せないと、**静的に生成されたページだけが壊れる**。
  // 生成時のHTMLには nonce が入らないのに、応答ヘッダには毎回新しい nonce が載るため、
  // そのページのスクリプトが全部ブロックされる（画面は出るが操作できない）。
  //
  // なお、これによりすべてのページが動的描画になる。管理画面はもともと
  // ほぼ全ページが動的なので、失うものは小さい。
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy'] as string);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

export const config = {
  /**
   * 静的アセットには適用しない。
   *
   * ヘッダを付ける意味が無く、リクエストのたびに nonce を作るのは無駄。
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
