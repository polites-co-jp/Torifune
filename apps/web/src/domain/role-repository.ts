import type { Connection } from '../database/provider';
import type { PermissionName } from './permission';
import type { Role } from './role';

export interface RoleRepository {
  list(connection: Connection): Promise<readonly Role[]>;
  findByName(connection: Connection, name: string): Promise<Role | null>;
  /** そのロールが持つ Permission。 */
  permissionsOf(connection: Connection, roleId: string): Promise<readonly PermissionName[]>;
  /**
   * ユーザーの実効 Permission。
   *
   * ロールを持たないユーザーは空を返す。既定で何か持たせると、
   * ロールの割り当てを忘れたユーザーが操作できてしまう。
   */
  effectivePermissionsOf(
    connection: Connection,
    userId: string,
  ): Promise<readonly PermissionName[]>;
  rolesOf(connection: Connection, userId: string): Promise<readonly Role[]>;
}
