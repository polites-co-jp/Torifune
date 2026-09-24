import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  DELIVERY_MODES,
  DISPLAY_NAME_MAX_LENGTH,
  EXTERNAL_ID_MAX_LENGTH,
  EXTERNAL_REF_MAX_LENGTH,
  FAILURE_REASON_MAX_LENGTH,
  isValidExternalUrl,
  isValidLink,
  isValidMediaUrl,
  MEDIA_ALT_MAX_LENGTH,
  MEDIA_MAX,
  MEDIA_URL_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_STATUSES,
  PROVIDER_OPTIONS_MAX_BYTES,
  type PostMedia,
  type SocialAccount,
  type SocialPost,
} from '@/domain/social/social';
import { SKIP_REASONS, type SkipReason } from '@/domain/social/publishing';
import { DEFAULT_PER_PAGE, MAX_PER_PAGE } from '@/api/query';
import { dataEnvelope, pageEnvelope } from './envelope';

/** SNS API の Zod スキーマ。 */

export const deliveryModeSchema = z.enum(DELIVERY_MODES);

/**
 * 飛ばした理由（035-social-publishing 設計 §6.1.4。裁定 #15-a）。
 *
 * **Domain の `SKIP_REASONS` をそのまま列挙にする。** DB の CHECK と Domain の一致は
 * 静的検査（#85）が見ているので、ここを Domain に繋げば DB → Domain → 応答が同じ集合になる。
 */
export const skipReasonSchema = z.enum(SKIP_REASONS);

/**
 * 投稿に添える媒体（035-social-publishing 設計 §6.1.1）。
 *
 * **要素ごとの検証も `media` の問題として返す。** 422 の `details` のキーを
 * `media.0.url` のように分岐させると、利用者側が拾う場所を増やすことになる。
 */
const mediaSchema = z
  .array(z.object({ url: z.string(), alt: z.string().nullable().default(null) }))
  .max(MEDIA_MAX, `媒体は${MEDIA_MAX}件以内にしてください。`)
  .refine(
    (items) => items.every((item) => isValidMediaUrl(item.url)),
    `媒体の URL は https で${MEDIA_URL_MAX_LENGTH}文字以内にしてください。`,
  )
  .refine(
    (items) => items.every((item) => (item.alt ?? '').length <= MEDIA_ALT_MAX_LENGTH),
    `代替テキストは${MEDIA_ALT_MAX_LENGTH}文字以内にしてください。`,
  );

/** provider 固有の追加項目。**中身を検証するのは Plugin**（`validate()`）。 */
const providerOptionsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= PROVIDER_OPTIONS_MAX_BYTES,
    `JSON にして${PROVIDER_OPTIONS_MAX_BYTES}バイト以内にしてください。`,
  );

/**
 * `credentialFields` に従う資格情報（035-social-publishing 設計 §6.4）。
 *
 * **応答には決して含めない。** 入力専用で、どのキーが設定されているかも返さない。
 * 値の型違いも `credentials` の問題として返す（キーごとに分岐させない）。
 */
const credentialsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Object.values(value).every((item) => typeof item === 'string'),
    '値は文字列で指定してください。',
  )
  .transform((value) => value as Record<string, string>);

export const accountStatusSchema = z.enum(ACCOUNT_STATUSES);
export const postStatusSchema = z.enum(POST_STATUSES);

/**
 * SNS の一覧の `page` / `perPage`（042-social-api-input-fixes 設計 §6.2）。
 *
 * **規則は `api/query.ts` の `paginationSchema` と同じ**（`page` は 1 未満を 1、`perPage` は 1〜100 に丸める。
 * 整数でなければ 422。既定は 1 / 20）。範囲外の整数は意図が明らかなので断らずに丸め、打ち間違い（`abc`）は断る。
 *
 * `paginationSchema` の形（`transform` の後ろに `.default()`）のまま使うと OpenAPI から `default` が消えるので、
 * `.default()` を `transform` の前に置く（042 実装プラン §8 の 1）。
 * `.int()` が出す `minimum` / `maximum`（安全な整数の範囲）はキーごと消す。書くと「範囲外は断られる」と読めて、
 * 実際の振る舞い（丸める）と食い違う（同 §6.2 末尾）。
 */
const listPageSchema = z.coerce
  .number()
  .int('整数を指定してください。')
  .default(1)
  .transform((value) => Math.max(1, value))
  .meta({
    description: '1 以上。範囲外は 1 に丸める。',
    minimum: undefined,
    maximum: undefined,
  });

const listPerPageSchema = z.coerce
  .number()
  .int('整数を指定してください。')
  .default(DEFAULT_PER_PAGE)
  .transform((value) => Math.min(MAX_PER_PAGE, Math.max(1, value)))
  .meta({
    description: `1〜${MAX_PER_PAGE}。範囲外は 1〜${MAX_PER_PAGE} に丸める。`,
    minimum: undefined,
    maximum: undefined,
  });

export const accountListQuerySchema = z.object({
  page: listPageSchema,
  perPage: listPerPageSchema,
  provider: z.string().max(32).optional(),
});

export const createAccountSchema = z.object({
  provider: z.string().min(1, '入力してください。').max(32),
  displayName: z.string().trim().min(1, '入力してください。').max(DISPLAY_NAME_MAX_LENGTH),
  handle: z.string().max(200).default(''),
  /** 平文。**応答には決して含めない。** */
  credential: z.string().max(4096).optional(),
  /** `credentialFields` に従う資格情報。`credential` との同時指定は 422。 */
  credentials: credentialsSchema.optional(),
  status: accountStatusSchema.default('disconnected'),
  csrfToken: z.string().optional(),
});

export const updateAccountSchema = z.object({
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH).optional(),
  handle: z.string().max(200).optional(),
  status: accountStatusSchema.optional(),
  /** 省略すると変えない。空文字を送ると消す。 */
  credential: z.string().max(4096).optional(),
  /** 省略すると変えない。空のオブジェクトを送ると消す。 */
  credentials: credentialsSchema.optional(),
  csrfToken: z.string().optional(),
});

export const postListQuerySchema = z.object({
  page: listPageSchema,
  perPage: listPerPageSchema,
  /**
   * UUID の形（8-4-4-4-12 の 16 進。大文字・小文字を問わず、版と variant を見ない）でなければ 422
   * （042-social-api-input-fixes 設計 §6.3）。**絞り込みを黙って外さない。** 空文字も 422。
   *
   * `z.uuid()` は版と variant を見るので使わない（Repository が絞り込める ID を API が断りうる）。
   * `z.guid()` の判定は Repository の判定と同じ。値は変換しない。
   */
  accountId: z.guid('UUID の形で指定してください。').optional(),
  status: postStatusSchema.optional(),
});

export const createPostSchema = z.object({
  socialAccountId: z.string().min(1, '入力してください。'),
  body: z.string().min(1, '入力してください。').max(POST_BODY_MAX_LENGTH),
  scheduledAt: z.coerce.date().nullable().optional(),
  status: postStatusSchema.default('draft'),
  deliveryMode: deliveryModeSchema.default('auto'),
  media: mediaSchema.default([]),
  link: z
    .string()
    .nullish()
    .refine(
      (value) => value === null || value === undefined || isValidLink(value),
      `URL は https で${MEDIA_URL_MAX_LENGTH}文字以内にしてください。`,
    ),
  providerOptions: providerOptionsSchema.default({}),
  /** 外部アプリ側の ID。同じ API Token からの再送を 1 行にまとめる冪等キー。 */
  externalRef: z
    .string()
    .trim()
    .min(1, '入力してください。')
    .max(EXTERNAL_REF_MAX_LENGTH)
    .optional(),
  csrfToken: z.string().optional(),
});

export const updatePostSchema = z.object({
  body: z.string().min(1).max(POST_BODY_MAX_LENGTH).optional(),
  scheduledAt: z.coerce.date().nullable().optional(),
  status: postStatusSchema.optional(),
  deliveryMode: deliveryModeSchema.optional(),
  media: mediaSchema.optional(),
  link: z
    .string()
    .nullish()
    .refine(
      (value) => value === null || value === undefined || isValidLink(value),
      `URL は https で${MEDIA_URL_MAX_LENGTH}文字以内にしてください。`,
    ),
  providerOptions: providerOptionsSchema.optional(),
  /** 配信後の SNS 側の投稿 ID。手動投稿では人が貼る。 */
  externalId: z.string().max(EXTERNAL_ID_MAX_LENGTH).nullish(),
  externalUrl: z
    .string()
    .nullish()
    .refine(
      (value) => value === null || value === undefined || isValidExternalUrl(value),
      '投稿の URL は https で指定してください。',
    ),
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

/**
 * API が返す投稿の形。
 *
 * **`publishStartedAt` と `createdByTokenId` は出さない**（035-social-publishing 設計 §6.1.4）。
 * 前者は内部の進行状態、後者は他の外部アプリの Token ID を `social.read` の誰にでも
 * 見せることになる。資格情報に関する項目は無い。
 *
 * **`skipCount` / `skipReason` は出す**（2026-09-23。裁定 #15-a）。
 * 裁定 #9 は「内部の待ち行列を公開契約にしない」として出さないと決めていたが、
 * 裁定 #14-a（予約し直しでは飛ばした回数を減らさない）の結果、
 * **運用者が予約し直す前に「あと何回で取りやめか」を知る手段が無くなった**。
 * 出さないと投稿を失う（設計 §11 #24）。**`SocialPostView`（Plugin）には足さない。**
 */
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
  deliveryMode: deliveryModeSchema,
  media: z.array(z.object({ url: z.string(), alt: z.string().nullable() })),
  link: z.string().nullable(),
  providerOptions: z.record(z.string(), z.unknown()),
  externalRef: z.string().nullable(),
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  attemptCount: z.number(),
  nextAttemptAt: z.string().nullable(),
  skipCount: z.number(),
  skipReason: skipReasonSchema.nullable(),
});

export const postEnvelopeSchema = dataEnvelope(postResponseSchema);
export const postPageSchema = pageEnvelope(postResponseSchema);

/**
 * 配信の手動実行の応答（035-social-publishing 設計 §6.5.9 / §6.5.7）。
 *
 * **固定キーの数だけ。** 自由文は載せない（資格情報が混じりうる）。
 * `job_runs.summary` と同じ 9 キーで、監視から件数を読める。
 *
 * `skipped`（後ろへ送った）と `skipFailed`（3 回飛ばして諦めた）を**1 つにまとめない**。
 * まとめると「待っているだけ」と「諦めた」の区別がつかなくなる（裁定 #9）。
 */
export const publishSummarySchema = z.object({
  interrupted: z.number(),
  due: z.number(),
  skipped: z.number(),
  skipFailed: z.number(),
  attempted: z.number(),
  published: z.number(),
  retried: z.number(),
  failed: z.number(),
  unrecorded: z.number(),
});

export const publishSummaryEnvelopeSchema = dataEnvelope(publishSummarySchema);

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
  readonly deliveryMode: string;
  readonly media: readonly PostMedia[];
  readonly link: string | null;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly externalRef: string | null;
  readonly externalId: string | null;
  readonly externalUrl: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  /** 同じ理由で続けて飛ばした回数（設計 §6.1.4。裁定 #15-a）。 */
  readonly skipCount: number;
  /** どの理由で飛ばしたか。飛ばされていなければ null。 */
  readonly skipReason: SkipReason | null;
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
    deliveryMode: post.deliveryMode,
    media: post.media.map((item) => ({ url: item.url, alt: item.alt })),
    link: post.link,
    providerOptions: post.providerOptions,
    externalRef: post.externalRef,
    externalId: post.externalId,
    externalUrl: post.externalUrl,
    attemptCount: post.attemptCount,
    nextAttemptAt: post.nextAttemptAt?.toISOString() ?? null,
    skipCount: post.skipCount,
    skipReason: post.skipReason,
  };
}
