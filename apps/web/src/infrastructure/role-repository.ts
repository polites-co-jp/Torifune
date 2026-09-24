import type { Connection } from '../database/provider';
import type { PermissionName } from '../domain/permission';
import type { Role } from '../domain/role';
import type { RoleRepository } from '../domain/role-repository';

interface RoleRow {
  id: string;
  name: string;
  display_name: string;
  is_system: boolean;
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    isSystem: row.is_system,
  };
}

const COLUMNS = ['id', 'name', 'display_name', 'is_system'] as const;

export const roleRepository: RoleRepository = {
  async list(connection: Connection): Promise<readonly Role[]> {
    const rows = await connection.db.selectFrom('roles').select(COLUMNS).orderBy('name').execute();
    return rows.map((row) => toRole(row as RoleRow));
  },

  async findByName(connection: Connection, name: string): Promise<Role | null> {
    const row = await connection.db
      .selectFrom('roles')
      .select(COLUMNS)
      .where('name', '=', name)
      .executeTakeFirst();
    return row === undefined ? null : toRole(row as RoleRow);
  },

  async permissionsOf(connection: Connection, roleId: string): Promise<readonly PermissionName[]> {
    const rows = await connection.db
      .selectFrom('role_permissions')
      .select('permission_name')
      .where('role_id', '=', roleId)
      .orderBy('permission_name')
      .execute();
    return rows.map((row) => row.permission_name);
  },

  async allGrants(
    connection: Connection,
  ): Promise<Readonly<Record<string, readonly PermissionName[]>>> {
    const rows = await connection.db
      .selectFrom('role_permissions')
      .innerJoin('roles', 'roles.id', 'role_permissions.role_id')
      .select(['roles.name as role_name', 'role_permissions.permission_name'])
      .orderBy('roles.name')
      .orderBy('role_permissions.permission_name')
      .execute();

    // ロール名は運用者が DB に直接書ける。素のオブジェクトへ積むと、`constructor` のとき
    // 継承した `Object` 関数を拾って push が TypeError になるので、`Map` に積む
    // （047-prototype-key-sweep 設計 §4.1）。挿入順は ORDER BY roles.name の順。
    const byRole = new Map<string, PermissionName[]>();
    for (const row of rows) {
      const permissions = byRole.get(row.role_name);
      if (permissions === undefined) {
        byRole.set(row.role_name, [row.permission_name]);
      } else {
        permissions.push(row.permission_name);
      }
    }
    return Object.fromEntries(byRole);
  },

  async effectivePermissionsOf(
    connection: Connection,
    userId: string,
  ): Promise<readonly PermissionName[]> {
    // User → Role → Permission を1クエリで解決する。
    // 複数ロールから同じ Permission を得ても重複しないよう DISTINCT。
    const rows = await connection.db
      .selectFrom('user_roles')
      .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
      .select('role_permissions.permission_name')
      .distinct()
      .where('user_roles.user_id', '=', userId)
      .orderBy('role_permissions.permission_name')
      .execute();
    return rows.map((row) => row.permission_name);
  },

  async rolesOf(connection: Connection, userId: string): Promise<readonly Role[]> {
    const rows = await connection.db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select(['roles.id', 'roles.name', 'roles.display_name', 'roles.is_system'])
      .where('user_roles.user_id', '=', userId)
      .orderBy('roles.name')
      .execute();
    return rows.map((row) => toRole(row as RoleRow));
  },
};
