import { uuidv7 } from 'uuidv7';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import {
  generateApiToken,
  isValidApiTokenName,
  type ApiToken,
  API_TOKEN_NAME_MAX_LENGTH,
} from '@/domain/api-token';
import { isValidPermissionName, type PermissionName } from '@/domain/permission';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { apiTokenRepository } from '@/infrastructure/api-token-repository';

/**
 * API Token の発行・一覧・失効（05_API設計.md §37-38）。
 *
 * 設計は docs/設計/021-api-token/設計.md。
 *
 * **Token の所有者は常に発行した本人。** `userId` を入力で受け取らない。
 * 受け取れると権限の貸し出しになり、監査で「誰がやったか」が追えなくなる。
 */

export interface CreateApiTokenInput {
  readonly name: string;
  /** Permission の部分集合。所有者が持たないものは指定できない。 */
  readonly scopes: readonly string[];
  /** null は無期限。 */
  readonly expiresAt: Date | null;
}

export interface CreatedApiToken {
  readonly token: ApiToken;
  /** **発行時に一度だけ返す平文。** 保存されていないので、二度と取り出せない。 */
  readonly plaintext: string;
}

export const createApiToken = defineUseCase<CreateApiTokenInput, CreatedApiToken>({
  name: 'apiToken.create',
  permission: 'token.manage',
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);

    if (!isValidApiTokenName(input.name)) {
      throw new ValidationError(
        'ApiToken',
        'name',
        `名前を入力してください（${API_TOKEN_NAME_MAX_LENGTH}文字以内）。`,
      );
    }

    for (const scope of input.scopes) {
      if (!isValidPermissionName(scope)) {
        throw new ValidationError('ApiToken', 'scopes', `権限の形式が不正です: ${scope}`);
      }
      // **黙って削らない。** 使用時に交差させるので実害は無いが、
      // 「指定したのに効かない」より「指定できない」ほうがよい。
      if (!context.permissions.has(scope)) {
        throw new ValidationError(
          'ApiToken',
          'scopes',
          `自分が持たない権限は指定できません: ${scope}`,
        );
      }
    }

    if (input.expiresAt !== null && input.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('ApiToken', 'expiresAt', '有効期限が過去です。');
    }

    const generated = generateApiToken();

    const token = await context.connection.transaction((tx) =>
      apiTokenRepository.insert(tx, {
        id: uuidv7(),
        userId: identity.userId,
        name: input.name.trim(),
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        scopes: input.scopes as PermissionName[],
        expiresAt: input.expiresAt,
      }),
    );

    return { token, plaintext: generated.plaintext };
  },
});

/** 自分の Token だけを返す。他人のものは見せない（設計 §7）。 */
export const listApiTokens = defineUseCase<Record<string, never>, readonly ApiToken[]>({
  name: 'apiToken.list',
  permission: 'token.manage',
  handler: async (context) => {
    const identity = requireAuthenticated(context);
    return apiTokenRepository.listByUser(context.connection, identity.userId);
  },
});

export const revokeApiToken = defineUseCase<{ id: string }, void>({
  name: 'apiToken.revoke',
  permission: 'token.manage',
  audit: { action: 'deleted', resourceType: 'api_token', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const identity = requireAuthenticated(context);

    const token = await apiTokenRepository.findById(context.connection, input.id);
    // **他人の Token の存在を教えない。** 見つからない場合と同じ扱いにする。
    if (token === null || token.userId !== identity.userId) {
      throw new NotFoundError('ApiToken', input.id);
    }

    await context.connection.transaction((tx) =>
      apiTokenRepository.revoke(tx, input.id, new Date()),
    );
  },
});
