import { Card } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint, PluginWidgets } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // Server Component から Application 層を直接呼ぶ（決定事項 D-06）。
  // 認可は UseCase 側で行われる。ここは表示のための取得だけ。
  const { displayName, permissions } = await requirePageSession();

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>ダッシュボード</h1>

      <ExtensionPoint point="dashboard.before" permissions={permissions} />

      <Card title="ようこそ">
        <p style={{ margin: 0 }}>
          とりふねへログインしています。左のメニューから機能を選んでください。
        </p>
      </Card>

      {/* Plugin の Widget。何が入るかは本体が知らない（03_プラグイン設計.md §9）。 */}
      <PluginWidgets location="dashboard" permissions={permissions} />

      <ExtensionPoint point="dashboard.after" permissions={permissions} />
    </AppShell>
  );
}
