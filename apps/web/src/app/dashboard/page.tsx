import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { SESSION_COOKIE } from '@/api/cookies';
import { Card } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const headerStore = await headers();

  // Server Component から Application 層を直接呼ぶ（決定事項 D-06）。
  // 認可は UseCase 側で行われる。ここは表示のための取得だけ。
  const context = await buildAuthorizationContext(cookieStore.get(SESSION_COOKIE)?.value, {
    ipAddress: headerStore.get('x-forwarded-for'),
    userAgent: headerStore.get('user-agent'),
  });

  if (context.identity === null) {
    redirect('/login');
  }

  return (
    <AppShell displayName={context.identity.displayName} permissions={context.permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>ダッシュボード</h1>
      <Card title="ようこそ">
        <p style={{ margin: 0 }}>
          とりふねへログインしています。左のメニューから機能を選んでください。
        </p>
      </Card>
      {/*
        Core Widget と Plugin Widget は 014-dashboard / 011-plugin-runtime で追加する。
        拡張点の位置をここに確保しておく。
      */}
    </AppShell>
  );
}
