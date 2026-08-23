import {
  CORE_PERMISSIONS,
  isReservedPermissionNamespace,
  isValidPermissionName,
  type PermissionName,
} from '../../domain/permission';

/**
 * 登録済み Permission の管理。
 *
 * **実行時のレジストリにしている理由**：Permission を TypeScript の union 型にすると、
 * Plugin が自分の Permission を足せなくなる（03_プラグイン設計.md §20.2）。
 *
 * 未登録の Permission を要求したときは、起動時ではなく**呼び出し時**にエラーにする。
 * Plugin は起動後に登録されるため。
 */

export interface PermissionDefinition {
  readonly name: PermissionName;
  readonly displayName: string;
  readonly description: string;
  /** 登録元。本体は null、Plugin はその ID。 */
  readonly owner: string | null;
}

export class PermissionRegistrationError extends Error {
  constructor(
    message: string,
    readonly name_: string,
  ) {
    super(message);
    this.name = 'PermissionRegistrationError';
  }
}

export class UnknownPermissionError extends Error {
  constructor(readonly permission: string) {
    super('未登録の Permission');
    this.name = 'UnknownPermissionError';
  }
}

const registry = new Map<string, PermissionDefinition>();

function registerCorePermissions(): void {
  for (const name of CORE_PERMISSIONS) {
    registry.set(name, {
      name,
      displayName: name,
      description: '',
      owner: null,
    });
  }
}

registerCorePermissions();

/**
 * Permission を登録する。
 *
 * Plugin からの登録では `owner` に Plugin ID を入れる。
 */
export function registerPermission(definition: PermissionDefinition): void {
  const { name, owner } = definition;

  if (!isValidPermissionName(name)) {
    throw new PermissionRegistrationError('Permission 名の形式が不正', name);
  }

  if (owner !== null && isReservedPermissionNamespace(name)) {
    // system.* は本体の予約。Plugin に取らせると、
    // 「システム管理相当の権限」を Plugin が勝手に定義できてしまう。
    throw new PermissionRegistrationError('system.* は本体の予約', name);
  }

  const existing = registry.get(name);
  if (existing !== undefined) {
    throw new PermissionRegistrationError('同じ Permission が既に登録されている', name);
  }

  registry.set(name, definition);
}

export function isRegisteredPermission(name: string): boolean {
  return registry.has(name);
}

/** 登録済み Permission を要求する。未登録なら例外。 */
export function assertRegisteredPermission(name: string): PermissionName {
  if (!registry.has(name)) {
    throw new UnknownPermissionError(name);
  }
  return name;
}

export function listPermissions(): readonly PermissionDefinition[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Plugin を無効化したときに、その Plugin の Permission を取り下げる。 */
export function unregisterPermissionsOf(owner: string): void {
  for (const [name, definition] of registry) {
    if (definition.owner === owner) {
      registry.delete(name);
    }
  }
}

/** テスト用。本体の Permission だけが登録された状態へ戻す。 */
export function resetPermissionRegistry(): void {
  registry.clear();
  registerCorePermissions();
}
