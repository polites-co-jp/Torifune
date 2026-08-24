import { getCurrentUser } from '../auth/current-user';
import type { RequestInfo } from '../auth/context';
import type { UserIdentity } from '../../authentication/identity';
import type { Connection } from '../../database/provider';
import type { PermissionName } from '../../domain/permission';
import { roleRepository } from '../../infrastructure/role-repository';
import { withConnection } from '../transaction';
import type { AuthorizationContext } from './authorize';

/**
 * 認可の文脈を組み立てる**唯一の入口**。
 *
 * ここ以外で `AuthorizationContext` を作らない。
 * リクエストから受け取った値が `permissions` へ入る経路を作らないため
 * （04_認証設計.md §28、05_API設計.md §30）。
 */

/** 認証済みユーザーの実効 Permission を求める。 */
export async function effectivePermissions(
  connection: Connection,
  userId: string,
): Promise<ReadonlySet<PermissionName>> {
  const permissions = await roleRepository.effectivePermissionsOf(connection, userId);
  return new Set(permissions);
}

/**
 * セッショントークンから認可の文脈を組み立てる。
 *
 * 未認証でも文脈は返す（`identity` が null）。
 * 「未認証か権限不足か」の判断は `requirePermission` に委ねる。
 */
export async function buildAuthorizationContext(
  sessionToken: string | undefined,
  request: RequestInfo,
): Promise<AuthorizationContext> {
  const identity: UserIdentity | null = await getCurrentUser(sessionToken, request);

  return withConnection(async (connection) => {
    if (identity === null) {
      return { identity: null, permissions: new Set<PermissionName>(), connection };
    }
    return {
      identity,
      permissions: await effectivePermissions(connection, identity.userId),
      connection,
    };
  });
}

/** テストと内部処理から、既知の identity で文脈を組み立てる。 */
export async function authorizationContextFor(
  connection: Connection,
  identity: UserIdentity,
): Promise<AuthorizationContext> {
  return {
    identity,
    permissions: await effectivePermissions(connection, identity.userId),
    connection,
  };
}
