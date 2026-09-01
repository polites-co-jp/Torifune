import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/api/cookies';
import { resolveHomeDestination } from '@/ui/server/home-destination';

// セットアップの完了やログインの前後で遷移先が変わる。静的化すると最初の1回で固定される。
export const dynamic = 'force-dynamic';

/**
 * トップページ。表示を持たず、状態に応じた画面へ送る（016-home-routing）。
 *
 * 戻り値が `never` なのは `redirect()` が例外を投げて必ず遷移するため。
 * **画面を描画する経路をここへ足さない。**
 */
export default async function HomePage(): Promise<never> {
  const cookieStore = await cookies();
  const headerStore = await headers();

  redirect(
    await resolveHomeDestination(cookieStore.get(SESSION_COOKIE)?.value, {
      ipAddress: headerStore.get('x-forwarded-for'),
      userAgent: headerStore.get('user-agent'),
    }),
  );
}
