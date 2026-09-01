import { z } from 'zod';
import type { ApiToken } from '@/domain/api-token';
import { API_TOKEN_NAME_MAX_LENGTH } from '@/domain/api-token';

/**
 * API Token の Zod スキーマ（05_API設計.md §37-38）。
 *
 * **平文を応答の型に持たせない。** 型として存在しなければ、うっかり足すこともできない。
 * 発行時だけは別の型（`CreatedApiTokenResponse`）で返す。
 */

export const createApiTokenSchema = z.object({
  name: z
    .string()
    .min(1, '入力してください。')
    .max(API_TOKEN_NAME_MAX_LENGTH, `${API_TOKEN_NAME_MAX_LENGTH}文字以内で入力してください。`),
  scopes: z.array(z.string()).default([]),
  /** ISO8601。省略・null で無期限。 */
  expiresAt: z.string().datetime({ message: '日時の形式が不正です。' }).nullish(),
  csrfToken: z.string().optional(),
});

export interface ApiTokenResponse {
  readonly id: string;
  readonly name: string;
  /** 見分けるための先頭部分。これだけでは認証に使えない。 */
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export function toApiTokenResponse(token: ApiToken): ApiTokenResponse {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    scopes: [...token.scopes],
    expiresAt: token.expiresAt?.toISOString() ?? null,
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
    createdAt: token.createdAt.toISOString(),
  };
}

export interface CreatedApiTokenResponse extends ApiTokenResponse {
  /**
   * **ここでしか返らない平文。**
   * 保存していないので、失くしたら作り直すしかない。
   */
  readonly token: string;
}
