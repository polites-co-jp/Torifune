import type { RequestInfo } from '@/application/auth/context';
import { isSetupOpen } from '@/application/auth/setup';
import { buildAuthorizationContext } from '@/application/authorization/context';

/**
 * トップページ（`/`）の遷移先を決める（016-home-routing）。
 *
 * `/` は表示を持たない。来た人を、そのとき入るべき画面へ送るだけの入口。
 *
 * **Next.js のリクエスト文脈をここへ持ち込まない。**
 * `cookies()` / `headers()` をこの中で呼ぶとテストから呼べなくなるため、
 * セッショントークンとリクエスト情報は呼び出し側（`app/page.tsx`）が読んで渡す。
 */

export type HomeDestination = '/setup' | '/login' | '/dashboard';

export async function resolveHomeDestination(
  sessionToken: string | undefined,
  request: RequestInfo,
): Promise<HomeDestination> {
  // **セッションより先に判定する。** 管理者が0人の間はログインする相手が存在せず、
  // `/login` へ送っても先へ進めない。
  if (await isSetupOpen()) {
    return '/setup';
  }

  const context = await buildAuthorizationContext(sessionToken, request);

  // ここでは認可を判定しない。ログイン済みかどうかだけを見る。
  // その先の権限は `/dashboard` が `requirePageSession` で確かめる。
  return context.identity === null ? '/login' : '/dashboard';
}
