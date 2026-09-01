import type { PermissionName } from '@/domain/permission';
import type { Role } from '@/domain/role';
import { roleRepository } from '@/infrastructure/role-repository';
import { defineUseCase } from './use-case';

/**
 * ロールの参照（04_認証設計.md §14、06_画面設計.md §16）。
 *
 * **画面と API はここを通る。** Repository を直接呼ぶと、
 * 呼び出し口ごとに認可が抜ける（決定事項 D-06）。
 * 実際に設定画面と `/api/v1/roles` が Repository を直叩きしていた。
 */

export const listRoles = defineUseCase<Record<string, never>, readonly Role[]>({
  name: 'role.list',
  // ロールはユーザーへ割り当てるためのもの。ユーザー管理と同じ権限で見せる。
  permission: 'user.manage',
  handler: async (context) => roleRepository.list(context.connection),
});

/** ロール名 → 付与された Permission。権限マトリクスの表示に使う。 */
export type RoleGrants = Readonly<Record<string, readonly PermissionName[]>>;

export const listRoleGrants = defineUseCase<Record<string, never>, RoleGrants>({
  name: 'role.grants',
  permission: 'user.manage',
  handler: async (context) => roleRepository.allGrants(context.connection),
});
