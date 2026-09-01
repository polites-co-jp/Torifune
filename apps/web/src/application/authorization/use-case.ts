import type { AuditAction, AuditResourceType } from '../../domain/audit';
import type { PermissionName } from '../../domain/permission';
import { recordAudit } from '../audit';
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

/**
 * 監査ログの残し方（05_API設計.md §42）。
 *
 * **状態を変える UseCase には付ける。** 参照系には付けない
 * （記録すると量が跳ね上がり、肝心の変更が埋もれる）。
 */
export interface UseCaseAudit<TInput, TOutput> {
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  /** 対象の識別子。作成では出力からしか取れないため、両方を渡す。 */
  readonly resourceId: (input: TInput, output: TOutput) => string | null;
  /** 追加で残す情報。**機密は入れない**（入っても保存の直前で落ちる）。 */
  readonly detail?: (input: TInput, output: TOutput) => Record<string, unknown>;
}

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
  /** 監査ログ。状態を変える UseCase には付ける。 */
  readonly audit?: UseCaseAudit<TInput, TOutput>;
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

    const output = await definition.handler(context, input);

    // **成功したものだけを記録する。** 起きなかったことを監査ログに残さない。
    // 例外が出たらここへ来ないので、失敗した操作は記録されない。
    if (definition.audit !== undefined) {
      const { action, resourceType, resourceId, detail } = definition.audit;
      await recordAudit(context, {
        action,
        resourceType,
        resourceId: resourceId(input, output),
        ...(detail === undefined ? {} : { detail: detail(input, output) }),
      });
    }

    return output;
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
