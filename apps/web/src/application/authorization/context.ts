import { getCurrentUser } from '../auth/current-user';
import type { RequestInfo } from '../auth/context';
import type { UserIdentity } from '../../authentication/identity';
import type { Connection } from '../../database/provider';
import { effectiveTokenPermissions, hashApiToken, isUsable } from '../../domain/api-token';
import type { PermissionName } from '../../domain/permission';
import { apiTokenRepository } from '../../infrastructure/api-token-repository';
import { log } from '../../infrastructure/logging';
import { roleRepository } from '../../infrastructure/role-repository';
import { userRepository } from '../../infrastructure/user-repository';
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
      return { identity: null, permissions: new Set<PermissionName>(), connection, request };
    }
    return {
      identity,
      permissions: await effectivePermissions(connection, identity.userId),
      connection,
      request,
    };
  });
}

/**
 * API Token から認可の文脈を組み立てる（05_API設計.md §37-38）。
 *
 * **実効 Permission は「所有者のいまの Permission ∩ Token の Scope」。**
 * 固定した Scope をそのまま信じると、ロールを外されたユーザーの Token が
 * 外す前の権限で動き続ける。Token は権限を増やせない。絞るだけ。
 *
 * 使えない Token（失効・期限切れ）と、所有者が無効化されている場合は
 * 未認証として扱う。**理由は呼び出し側へ伝えない。**
 * 伝えると、Token の状態を調べる手段になる。
 */
export async function buildApiTokenContext(
  bearerToken: string,
  request: RequestInfo,
): Promise<AuthorizationContext> {
  return withConnection(async (connection) => {
    const anonymous: AuthorizationContext = {
      identity: null,
      permissions: new Set<PermissionName>(),
      connection,
      request,
    };

    const token = await apiTokenRepository.findByHash(connection, hashApiToken(bearerToken));
    if (token === null || !isUsable(token, new Date())) {
      return anonymous;
    }

    const owner = await userRepository.findById(connection, token.userId);
    if (owner === null || owner.status !== 'active') {
      return anonymous;
    }

    const ownerPermissions = await effectivePermissions(connection, owner.id);

    // 最終利用時刻の更新に失敗しても認証は通す。
    // 記録のための書き込みで、認証そのものを止める理由が無い。
    try {
      await apiTokenRepository.touch(connection, token.id, new Date());
    } catch (error) {
      log.warn('failed to update api token last_used_at', {
        tokenId: token.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    return {
      identity: {
        userId: owner.id,
        loginId: owner.loginId,
        displayName: owner.displayName,
        email: owner.email,
        providerId: 'api-token',
        externalUserId: null,
      },
      permissions: effectiveTokenPermissions(ownerPermissions, token.scopes),
      connection,
      request,
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
