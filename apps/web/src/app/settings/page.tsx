import Link from 'next/link';
import { listPermissions } from '@/application/authorization/permission-registry';
import { listUsers } from '@/application/user/user-use-cases';
import { roleRepository } from '@/infrastructure/role-repository';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { PermissionMatrix } from '@/ui/settings/permission-matrix';
import { UserList } from '@/ui/settings/user-list';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/**
 * 設定画面（06_画面設計.md §16）。
 *
 * 今回作るのは「ユーザー」「権限」の2タブ（`015-settings`）。
 * 一般 / 認証 / API は `015b`。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */

const TABS = [
  { key: 'users', label: 'ユーザー' },
  { key: 'permissions', label: '権限' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function toTab(value: string | string[] | undefined): TabKey {
  return value === 'permissions' ? 'permissions' : 'users';
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  // 表示制御ではなく認可。ナビを隠すだけでは止められない（同 §29-30）。
  if (!permissions.has('user.manage')) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const tab = toTab(params['tab']);
  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  const roles = await roleRepository.list(context.connection);

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>設定</h1>

      <nav
        aria-label="設定のタブ"
        style={{
          display: 'flex',
          gap: 'var(--tf-space-4)',
          borderBottom: '1px solid var(--tf-color-border)',
          marginBottom: 'var(--tf-space-4)',
        }}
      >
        {TABS.map((entry) => (
          <Link
            key={entry.key}
            href={`/settings?tab=${entry.key}`}
            aria-current={tab === entry.key ? 'page' : undefined}
            style={{
              padding: 'var(--tf-space-2) 0',
              color: tab === entry.key ? 'var(--tf-color-text)' : 'var(--tf-color-text-muted)',
              borderBottom:
                tab === entry.key ? '2px solid var(--tf-color-primary)' : '2px solid transparent',
              textDecoration: 'none',
            }}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {tab === 'users' ? (
        <UsersTab context={context} page={page} perPage={perPage} roles={roles} />
      ) : (
        <PermissionsTab context={context} roles={roles} />
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
type RoleList = Awaited<ReturnType<typeof roleRepository.list>>;

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
  const grants: Record<string, readonly string[]> = {};
  for (const role of roles) {
    grants[role.name] = await roleRepository.permissionsOf(context.connection, role.id);
  }

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
