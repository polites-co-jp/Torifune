import type { UserIdentity } from '../../authentication/identity';
import type { Connection } from '../../database/provider';
import type { PermissionName } from '../../domain/permission';
import type { RequestInfo } from '../auth/context';
import { assertRegisteredPermission } from './permission-registry';

/**
 * 認可（04_認証設計.md §14）。
 *
 * **判定は Application 層で行う**（決定事項 D-06）。
 * Server Component から直接呼んでも、REST 経由でも、Plugin 経由でも同じ判定が働く。
 * API Layer に置くと経路ごとに漏れる。
 */

/** 未認証。ログインを促すべき状態。 */
export class UnauthenticatedError extends Error {
  constructor() {
    super('認証が必要');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * 認証済みだが権限が足りない。
 *
 * **要求された Permission 名をメッセージへ入れない。**
 * どの権限が足りないかを相手へ教えると、権限体系の探索に使える。
 * デバッグに必要な情報はサーバー側のログへ出す。
 */
export class ForbiddenError extends Error {
  constructor() {
    super('権限が不足している');
    this.name = 'ForbiddenError';
  }
}

/**
 * 認可の文脈。
 *
 * `permissions` には**サーバー側で組み立てたものだけ**を入れる。
 * リクエストから受け取った値をここへ入れる経路を作らない
 * （04_認証設計.md §28、05_API設計.md §30）。
 */
export interface AuthorizationContext {
  /** null なら未認証。 */
  readonly identity: UserIdentity | null;
  readonly permissions: ReadonlySet<PermissionName>;
  readonly connection: Connection;
  /**
   * リクエストの発信元。監査ログに残す（05_API設計.md §42）。
   *
   * HTTP を経由しない呼び出し（CLI・内部処理・テスト）では無い。
   * **認可の判断には使わない。** クライアントが自由に変えられる値であり、
   * 権限の判断に混ぜると詐称の余地を作る。
   */
  readonly request?: RequestInfo;
}

/** その文脈が Permission を持つか。 */
export function hasPermission(context: AuthorizationContext, permission: PermissionName): boolean {
  return context.identity !== null && context.permissions.has(permission);
}

/**
 * Permission を要求する。持っていなければ例外を投げる。
 *
 * 未認証と権限不足を区別する。未認証に 403 を返すとログインを促せず、
 * 権限不足に 401 を返すと再ログインを促してしまう。
 */
export function requirePermission(context: AuthorizationContext, permission: PermissionName): void {
  // 未登録の Permission を要求していたら、それは実装の誤り。
  // 「誰も持っていない権限」を要求して常に 403 になるより、はっきり落とす。
  assertRegisteredPermission(permission);

  if (context.identity === null) {
    throw new UnauthenticatedError();
  }

  if (!context.permissions.has(permission)) {
    throw new ForbiddenError();
  }
}

/** 認証だけを要求する（Permission は問わない）。 */
export function requireAuthenticated(context: AuthorizationContext): UserIdentity {
  if (context.identity === null) {
    throw new UnauthenticatedError();
  }
  return context.identity;
}
