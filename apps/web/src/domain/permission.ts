/**
 * Permission 名（04_認証設計.md §14、03_プラグイン設計.md §20.2）。
 *
 * **固定の union 型にしない。** そうすると Plugin が自分の Permission を足せなくなる。
 * 文字列に形式の制約だけを課し、実在するかは実行時のレジストリで見る。
 */

/**
 * `<resource>.<action>` 形式。ドットで2つ以上の区切りを許す（Plugin の名前空間用）。
 *
 * **ハイフンを許す。** Plugin ID がハイフンを含むため（`seo-plugin.report.read`）、
 * 許さないと Plugin が自分の ID を名前空間にできない。
 * DB 側の制約は migrations/008 で合わせてある。
 */
const PERMISSION_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

export type PermissionName = string & { readonly __brand?: 'PermissionName' };

export function isValidPermissionName(value: string): boolean {
  return PERMISSION_PATTERN.test(value) && value.length <= 100;
}

export class InvalidPermissionNameError extends Error {
  constructor(readonly value: string) {
    super('Permission 名の形式が不正');
    this.name = 'InvalidPermissionNameError';
  }
}

export function toPermissionName(value: string): PermissionName {
  if (!isValidPermissionName(value)) {
    throw new InvalidPermissionNameError(value);
  }
  return value;
}

/** `system.*` は本体が予約する。Plugin に取らせない。 */
export function isReservedPermissionNamespace(value: string): boolean {
  return value.startsWith('system.');
}

/**
 * Torifune 本体が定義する Permission。マイグレーションの投入内容と一致させる。
 *
 * **コンテンツは Core の責務ではない**（`docs/仕様書/改訂履歴.md` 2026-08-24）。
 * コンテンツを扱う Plugin は、自身の Permission を Plugin ID の名前空間で登録する。
 */
export const CORE_PERMISSIONS = [
  'site.read',
  'site.write',
  'site.delete',
  'social.read',
  'social.write',
  'social.delete',
  'user.manage',
  'plugin.manage',
  'system.manage',
] as const;

export type CorePermission = (typeof CORE_PERMISSIONS)[number];
