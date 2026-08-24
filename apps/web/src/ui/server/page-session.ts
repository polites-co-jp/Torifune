import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/api/cookies';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { ensurePluginsStarted } from '@/plugin/runtime';

/**
 * ログインが要る画面の共通の入口。
 *
 * 各ページが Cookie の読み出しと未認証の扱いを書き写すと、
 * どこか1枚で書き忘れたときに認証されていない画面が出てしまう。
 *
 * **ここで Plugin の起動も済ませる。** 起動していないと
 * `collectMenus` が空になり、Plugin のメニューがその画面にだけ出ない。
 */
export interface PageSession {
  readonly context: AuthorizationContext;
  /** `context.identity` が null でないことが保証された表示名。 */
  readonly displayName: string;
  readonly permissions: ReadonlySet<string>;
}

export async function requirePageSession(): Promise<PageSession> {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const context = await buildAuthorizationContext(cookieStore.get(SESSION_COOKIE)?.value, {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  });

  if (context.identity === null) {
    redirect('/login');
  }

  // Plugin の起動に失敗しても画面は出す。
  // Plugin ひとつの不具合で本体が使えなくなるのは重すぎる。
  await ensurePluginsStarted(context);

  return {
    context,
    displayName: context.identity.displayName,
    permissions: context.permissions,
  };
}
