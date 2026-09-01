import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  DISPLAY_NAME_MAX_LENGTH,
  FAILURE_REASON_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_STATUSES,
  type SocialAccount,
  type SocialPost,
} from '@/domain/social/social';
import { dataEnvelope, pageEnvelope } from './envelope';

/** SNS API の Zod スキーマ。 */

export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export const postStatusSchema = z.enum(POST_STATUSES);

export const accountListQuerySchema = z.object({
  page: z.coerce.number().int('整数を指定してください。').default(1),
  perPage: z.coerce.number().int('整数を指定してください。').default(20),
  provider: z.string().max(32).optional(),
});

export const createAccountSchema = z.object({
  provider: z.string().min(1, '入力してください。').max(32),
  displayName: z.string().trim().min(1, '入力してください。').max(DISPLAY_NAME_MAX_LENGTH),
  handle: z.string().max(200).default(''),
  /** 平文。**応答には決して含めない。** */
  credential: z.string().max(4096).optional(),
  status: accountStatusSchema.default('disconnected'),
  csrfToken: z.string().optional(),
});

export const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH).optional(),
  handle: z.string().max(200).optional(),
  status: accountStatusSchema.optional(),
  /** 省略すると変えない。空文字を送ると消す。 */
  credential: z.string().max(4096).optional(),
  csrfToken: z.string().optional(),
});

export const postListQuerySchema = z.object({
  page: z.coerce.number().int('整数を指定してください。').default(1),
  perPage: z.coerce.number().int('整数を指定してください。').default(20),
  accountId: z.string().max(64).optional(),
  status: postStatusSchema.optional(),
});

export const createPostSchema = z.object({
  socialAccountId: z.string().min(1, '入力してください。'),
  body: z.string().min(1, '入力してください。').max(POST_BODY_MAX_LENGTH),
  scheduledAt: z.coerce.date().nullable().optional(),
  status: postStatusSchema.default('draft'),
  csrfToken: z.string().optional(),
});

export const updatePostSchema = z.object({
  body: z.string().min(1).max(POST_BODY_MAX_LENGTH).optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  status: postStatusSchema.optional(),
  /**
   * 配信に失敗した理由。
   *
   * **外部の配信ワーカーがここへ記録する。** 実配信は Plugin の責務なので、
   * 「失敗した」だけを送れて理由を送れないと、画面から原因が追えない。
   */
  failureReason: z.string().max(FAILURE_REASON_MAX_LENGTH).nullish(),
  csrfToken: z.string().optional(),
});

/**
 * API が返すアカウントの形。
 *
 * **`credential` を返さない。** 設定済みかどうかだけを返す（05_API設計.md §18）。
 */
export const accountResponseSchema = z.object({
  id: z.string(),
  provider: z.string(),
  displayName: z.string(),
  handle: z.string(),
  status: accountStatusSchema,
  /** **平文は返さない。** 設定済みかどうかだけ。 */
  credentialConfigured: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const accountEnvelopeSchema = dataEnvelope(accountResponseSchema);
export const accountPageSchema = pageEnvelope(accountResponseSchema);

export interface AccountResponse {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  readonly status: string;
  readonly credentialConfigured: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAccountResponse(account: SocialAccount): AccountResponse {
  return {
    id: account.id,
    provider: account.provider,
    displayName: account.displayName,
    handle: account.handle,
    status: account.status,
    credentialConfigured: account.credentialConfigured,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

export const postResponseSchema = z.object({
  id: z.string(),
  socialAccountId: z.string(),
  body: z.string(),
  scheduledAt: z.string().nullable(),
  status: postStatusSchema,
  publishedAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const postEnvelopeSchema = dataEnvelope(postResponseSchema);
export const postPageSchema = pageEnvelope(postResponseSchema);

export interface PostResponse {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly failedAt: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toPostResponse(post: SocialPost): PostResponse {
  return {
    id: post.id,
    socialAccountId: post.socialAccountId,
    body: post.body,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    failedAt: post.failedAt?.toISOString() ?? null,
    failureReason: post.failureReason,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}
