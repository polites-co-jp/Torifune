import { trackingScript, trackingScriptEtag } from '@/application/analytics/collect';

/**
 * 計測スクリプト（018-analytics 設計 §3.4）。
 *
 * 利用者は測りたいサイトへ1行貼るだけにする。
 *
 * ```html
 * <script src="https://torifune.example.com/t.js" data-site="<公開キー>"></script>
 * ```
 *
 * **`defineRoute` を使わない。** JSON でも `/api/v1` でもなく、
 * 認証も CSRF も関係しない静的な配布物であるため。
 */
export async function GET(request: Request): Promise<Response> {
  const origin = process.env['APP_URL']?.trim() ?? new URL(request.url).origin;
  const body = trackingScript(origin);
  const etag = trackingScriptEtag(origin);

  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      // 計測タグは全ページから読まれる。毎回取りに来させない。
      'Cache-Control': 'public, max-age=3600',
      ETag: etag,
      // 測る側のサイトから読まれる。ここは誰にでも配ってよい。
      'Access-Control-Allow-Origin': '*',
    },
  });
}
