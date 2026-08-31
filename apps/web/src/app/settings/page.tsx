import { Card } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * 設定画面（06_画面設計.md §16）。
 *
 * **いまは器だけ。** 一般 / ユーザー / 権限 / 認証 / API のタブは
 * `015-settings` で作る。
 *
 * 器を先に置くのは、`settings.tabs` に登録した Plugin のタブへ
 * 描画先を与えるため（同 §27）。描画先が無いと、Plugin 作者は
 * 登録しても何も起きない理由を自分のコードの中に探すことになる。
 */
export default async function SettingsPage() {
  const { context, displayName, permissions } = await requirePageSession();

  // 表示制御ではなく認可。ナビを隠すだけでは止められない（同 §29-30）。
  if (!permissions.has('user.manage')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>設定</h1>

      <Card title="Torifune の設定">
        <p style={{ margin: 0 }}>
          一般・ユーザー・権限・認証・API の設定はまだありません。
          プラグインが追加した設定は、この下に表示されます。
        </p>
      </Card>

      {/* Plugin が追加するタブ（06_画面設計.md §27）。 */}
      <div style={{ marginTop: 'var(--tf-space-4)' }}>
        <ExtensionPoint point="settings.tabs" permissions={permissions} context={context} />
      </div>
    </AppShell>
  );
}
