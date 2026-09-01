import { allowedOrigins } from '@/api/cors';
import { listPermissions } from '@/application/authorization/permission-registry';
import { getSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import { authenticationProviderId } from '@/authentication/registry';
import { listUsers } from '@/application/user/user-use-cases';
import { listRoleGrants, listRoles } from '@/application/authorization/role-use-cases';
import { Tabs } from '@/ui/components';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { ApiSettings } from '@/ui/settings/api-settings';
import { AuthSettings } from '@/ui/settings/auth-settings';
import { GeneralSettings } from '@/ui/settings/general-settings';
import { PermissionMatrix } from '@/ui/settings/permission-matrix';
import { UserList } from '@/ui/settings/user-list';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * 設定画面（06_画面設計.md §16）。
 *
 * 一般 / ユーザー / 権限 / 認証 / API の5タブ（`015-settings` ＋ `015b-settings`）。
 * Plugin は別画面（`/plugins`）。
 *
 * **タブごとに要る権限が違う。** 画面全体を1つの権限で塞がない。
 * 一般・認証・API は認証さえしていれば見え、変更に `system.manage` が要る。
 * ユーザー・権限は `user.manage` が要る。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */

const TAB_KEYS = ['general', 'users', 'permissions', 'auth', 'api'] as const;

type TabKey = (typeof TAB_KEYS)[number];

function toTab(value: string | string[] | undefined): TabKey {
  return (TAB_KEYS as readonly string[]).includes(String(value)) ? (value as TabKey) : 'general';
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  const canManageUsers = permissions.has('user.manage');
  const canManageSystem = permissions.has('system.manage');
  const canManageTokens = permissions.has('token.manage');

  const requested = toTab(params['tab']);

  // **表示制御ではなく認可。** ナビを隠すだけでは止められない（同 §29-30）。
  // 見えないタブを URL で直接指しても中身を出さない。
  const allowed: Record<TabKey, boolean> = {
    general: true,
    users: canManageUsers,
    permissions: canManageUsers,
    auth: true,
    api: canManageTokens,
  };

  if (!allowed[requested]) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const tab = requested;
  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  const roles = canManageUsers ? await listRoles(context, {}) : [];
  const settings = await getSystemSettings(context, {});

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>設定</h1>

      <Tabs
        label="設定のタブ"
        current={tab}
        hrefFor={(key) => `/settings?tab=${key}`}
        items={[
          { key: 'general', label: '一般' },
          { key: 'users', label: 'ユーザー', visible: canManageUsers },
          { key: 'permissions', label: '権限', visible: canManageUsers },
          { key: 'auth', label: '認証' },
          { key: 'api', label: 'API', visible: canManageTokens },
        ]}
      />

      {tab === 'general' && <GeneralSettings settings={settings} canManage={canManageSystem} />}
      {tab === 'users' && (
        <UsersTab context={context} page={page} perPage={perPage} roles={roles} />
      )}
      {tab === 'permissions' && <PermissionsTab context={context} roles={roles} />}
      {tab === 'auth' && (
        <AuthSettings
          settings={settings}
          canManage={canManageSystem}
          authProviderId={authenticationProviderId()}
        />
      )}
      {tab === 'api' && (
        <ApiSettings scopeCandidates={[...permissions].sort()} corsOrigins={allowedOrigins()} />
      )}

      {/*
        Plugin が追加するタブ（06_画面設計.md §27）。
        Core のタブの下に並べる。**Core のタブへ割り込ませない。**
      */}
      <div style={{ marginTop: 'var(--tf-space-6)' }}>
        <ExtensionPoint point="settings.tabs" permissions={permissions} context={context} />
      </div>
    </AppShell>
  );
}

type PageContext = Awaited<ReturnType<typeof requirePageSession>>['context'];
type RoleList = Awaited<ReturnType<typeof listRoles>>;

async function UsersTab({
  context,
  page,
  perPage,
  roles,
}: {
  context: PageContext;
  page: number;
  perPage: number;
  roles: RoleList;
}) {
  const result = await listUsers(context, {
    page,
    perPage,
    status: null,
    keyword: null,
    sort: [{ field: 'created_at', direction: 'desc' }],
  });

  return (
    <UserList
      initialUsers={result.items.map(({ user, roles: assigned }) => ({
        id: user.id,
        loginId: user.loginId,
        displayName: user.displayName,
        email: user.email,
        status: user.status,
        roles: [...assigned],
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      }))}
      availableRoles={roles.map((role) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
      }))}
      currentUserId={context.identity?.userId ?? ''}
      total={result.total}
      page={page}
      perPage={perPage}
    />
  );
}

async function PermissionsTab({ context, roles }: { context: PageContext; roles: RoleList }) {
  // ロールの数だけ問い合わせない（N+1）。1クエリでまとめて引く。
  const grants = await listRoleGrants(context, {});

  return (
    <PermissionMatrix
      roles={roles.map((role) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
      }))}
      permissions={listPermissions().map((permission) => ({
        name: permission.name,
        displayName: permission.displayName,
      }))}
      grants={grants}
    />
  );
}
