import type { PermissionName } from '../../domain/permission';
import { requirePermission, type AuthorizationContext } from './authorize';

/**
 * UseCase の定義形式。
 *
 * **認可の「呼び忘れ」を構造的に起こせなくする。**
 * 「必ず requirePermission を呼ぶ」という規約に頼ると、いつか抜ける。
 * ここでは Permission を定義の一部にし、`defineUseCase` が代わりに呼ぶ。
 *
 * 認可を必要としない UseCase は `permission: null` を**明示**する。
 * 明示されたものは一覧として検査できるので、意図しない `null` が増えたら気づける。
 */

export interface UseCaseDefinition<TInput, TOutput> {
  /** 一意な名前。検査とログに使う。 */
  readonly name: string;
  /**
   * 要求する Permission。
   * `null` は「認可を必要としない」ことを明示するもので、**理由を `reason` に書く**。
   */
  readonly permission: PermissionName | null;
  /** `permission` が null のときに必須。なぜ認可が要らないのか。 */
  readonly reason?: string;
  readonly handler: (context: AuthorizationContext, input: TInput) => Promise<TOutput>;
}

export interface UseCase<TInput, TOutput> {
  readonly name: string;
  readonly permission: PermissionName | null;
  readonly reason: string | null;
  (context: AuthorizationContext, input: TInput): Promise<TOutput>;
}

const registry = new Map<string, UseCase<unknown, unknown>>();

export class UseCaseDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UseCaseDefinitionError';
  }
}

export function defineUseCase<TInput, TOutput>(
  definition: UseCaseDefinition<TInput, TOutput>,
): UseCase<TInput, TOutput> {
  if (definition.permission === null && (definition.reason ?? '') === '') {
    // 「認可が要らない」は必ず説明を伴わせる。
    // 説明を書けないなら、たいてい認可が要る。
    throw new UseCaseDefinitionError(
      `${definition.name}: permission が null のときは reason が必須`,
    );
  }

  if (registry.has(definition.name)) {
    throw new UseCaseDefinitionError(`UseCase 名が重複している: ${definition.name}`);
  }

  const useCase = (async (context: AuthorizationContext, input: TInput): Promise<TOutput> => {
    if (definition.permission !== null) {
      requirePermission(context, definition.permission);
    }
    return definition.handler(context, input);
  }) as UseCase<TInput, TOutput>;

  Object.defineProperties(useCase, {
    name: { value: definition.name },
    permission: { value: definition.permission },
    reason: { value: definition.reason ?? null },
  });

  registry.set(definition.name, useCase as UseCase<unknown, unknown>);
  return useCase;
}

/** 定義済みの UseCase を列挙する。 */
export function listUseCases(): readonly UseCase<unknown, unknown>[] {
  return [...registry.values()];
}

/** 認可を必要としないと明示された UseCase を列挙する。テストで検査する。 */
export function listUnprotectedUseCases(): readonly UseCase<unknown, unknown>[] {
  return listUseCases().filter((useCase) => useCase.permission === null);
}

/** テスト用。 */
export function resetUseCaseRegistry(): void {
  registry.clear();
}

/**
 * 認可を必要としない処理を、**理由つきで明示的に宣言する**。
 *
 * ログインや初回セットアップは認証前に呼ばれるため `AuthorizationContext` を取れず、
 * `defineUseCase` の形に収まらない。無理に通すと引数が嘘になる。
 *
 * 代わりにここで宣言し、`listUnprotectedUseCases()` の検査対象に含める。
 * 「認可されていない処理の一覧」が1箇所に集まっていることが重要で、
 * 実行経路が同じである必要はない。
 */
export function declarePublicUseCase(name: string, reason: string): void {
  if (reason.trim() === '') {
    throw new UseCaseDefinitionError(`${name}: reason が必須`);
  }
  if (registry.has(name)) {
    throw new UseCaseDefinitionError(`UseCase 名が重複している: ${name}`);
  }

  const declared = async (): Promise<never> => {
    throw new UseCaseDefinitionError(`${name} は宣言のみで、ここからは呼べない`);
  };

  Object.defineProperties(declared, {
    name: { value: name },
    permission: { value: null },
    reason: { value: reason },
  });

  registry.set(name, declared as unknown as UseCase<unknown, unknown>);
}
