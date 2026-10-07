import { z } from 'zod';
import type { ApiToken } from '@/domain/api-token';
import { API_TOKEN_NAME_MAX_LENGTH } from '@/domain/api-token';
import { dataEnvelope, listEnvelope } from './envelope';

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
  siteId: z
    .guid('UUID の形で指定してください。')
    .nullable()
    .optional()
    .describe(
      '紐づけるサイト。省略・null は共通のトークン。サイトのトークンの scopes は SNS の権限（social.read・social.write・social.delete・social.approve）だけ。アーカイブしたサイトには発行できない。',
    ),
  csrfToken: z.string().optional(),
});

/**
 * API が返す形（OpenAPI 用）。
 *
 * **平文（`token`）を含めない。** 発行時だけ別のスキーマで返す。
 */
export const apiTokenResponseSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
  siteId: z
    .guid()
    .nullable()
    .describe('紐づいたサイト。null は共通のトークン（サイトに紐づかない）。'),
  siteScoped: z
    .boolean()
    .describe(
      'サイトのトークンか。true で siteId が null はサイトが削除されたトークン（使えない）。',
    ),
});

/** 発行時だけ平文を返す。**ここでしか返らない。** */
export const createdApiTokenResponseSchema = apiTokenResponseSchema.extend({
  token: z.string(),
});

export const apiTokenListSchema = listEnvelope(apiTokenResponseSchema);
export const createdApiTokenEnvelopeSchema = dataEnvelope(createdApiTokenResponseSchema);

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
  readonly siteId: string | null;
  readonly siteScoped: boolean;
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
    siteId: token.siteId,
    siteScoped: token.siteScoped,
  };
}

export interface CreatedApiTokenResponse extends ApiTokenResponse {
  /**
   * **ここでしか返らない平文。**
   * 保存していないので、失くしたら作り直すしかない。
   */
  readonly token: string;
}
