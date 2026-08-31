import { z } from 'zod';
import type { UserWithRoles } from '@/application/user/user-use-cases';
import { USER_STATUSES } from '@/domain/user';

/**
 * User API の Zod スキーマ（05_API設計.md §15）。
 *
 * **`passwordHash` を応答の型に持たせない。**
 * 型として存在しなければ、うっかり足すこともできない。
 */

/**
 * 並び替えに使える公開名 → 内部キー。
 *
 * **DB のカラム名を直接指定させない**（05_API設計.md §35）。
 */
export const USER_SORT_FIELDS = {
  loginId: 'login_id',
  displayName: 'display_name',
  createdAt: 'created_at',
  lastLoginAt: 'last_login_at',
} as const;

export const userStatusSchema = z.enum(USER_STATUSES);

export const userListQuerySchema = z.object({
  page: z.coerce.number().int('整数を指定してください。').default(1),
  perPage: z.coerce.number().int('整数を指定してください。').default(20),
  status: userStatusSchema.optional(),
  q: z.string().max(200, '検索語が長すぎます。').optional(),
  sort: z.string().optional(),
});

/**
 * ロールの指定。
 *
 * **クライアントから来た値をそのまま信じない。** 実在するかは UseCase が確かめる
 * （`04_認証設計.md` §28）。ここでは形だけを見る。
 */
const rolesSchema = z.array(z.string().max(64)).max(16, 'ロールが多すぎます。');

export const createUserSchema = z.object({
  loginId: z.string().min(1, '入力してください。').max(64),
  displayName: z.string().trim().min(1, '入力してください。').max(200),
  email: z.string().min(1, '入力してください。').max(320),
  password: z.string().min(1, '入力してください。'),
  roles: rolesSchema.default([]),
  csrfToken: z.string().optional(),
});

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1, '入力してください。').max(200).optional(),
  email: z.string().min(1, '入力してください。').max(320).optional(),
  status: userStatusSchema.optional(),
  /** 空文字なら変えない。UseCase 側でも同じ扱いにしてある。 */
  password: z.string().optional(),
  roles: rolesSchema.optional(),
  csrfToken: z.string().optional(),
});

/**
 * API が返す形。
 *
 * **`passwordHash` を含めない**（05_API設計.md §15）。
 * `User` をそのまま返さず、ここで明示的に選ぶ。
 */
export interface UserResponse {
  readonly id: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
}

export function toUserResponse(entry: UserWithRoles): UserResponse {
  const { user, roles } = entry;
  return {
    id: user.id,
    loginId: user.loginId,
    displayName: user.displayName,
    email: user.email,
    status: user.status,
    roles: [...roles],
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
