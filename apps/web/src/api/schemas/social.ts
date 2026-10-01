import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  APPROVAL_TIMINGS,
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
  PUBLISH_TIMINGS,
  type PostMedia,
  type SocialAccount,
  type SocialPost,
} from '@/domain/social/social';
import { SKIP_REASONS, type SkipReason } from '@/domain/social/publishing';
import { pageQuerySchema, perPageQuerySchema } from '@/api/query';
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

/**
 * JSON にしたときの大きさが上限の内側か。
 *
 * **書けない値は上限を超えたものとして扱う**（046 検証の指摘 N2）。`JSON.parse` は読めても
 * `JSON.stringify` は書けない深さの入れ子（数千段）があり、そのまま投げると 500 になる。
 */
function fitsProviderOptionsSize(value: Record<string, unknown>): boolean {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  return Buffer.byteLength(json, 'utf8') <= PROVIDER_OPTIONS_MAX_BYTES;
}

/** provider 固有の追加項目。**中身を検証するのは Plugin**（`validate()`）。 */
const providerOptionsSchema = z
  .record(z.string(), z.unknown())
  .refine(
    fitsProviderOptionsSize,
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
 * 登録の時機（048-social-post-approval 設計 §6.1・§6.11）。`deliveryMode`（誰が出すか）とは別の軸。
 */
export const publishTimingSchema = z
  .enum(PUBLISH_TIMINGS)
  .describe(
    '即投稿（now）・指定の時間に投稿（scheduled）・承認を待ってから投稿（after_approval）。省略すると status と scheduledAt で決まる（従来どおり）。',
  );

export const accountListQuerySchema = z.object({
  page: pageQuerySchema,
  perPage: perPageQuerySchema,
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
  page: pageQuerySchema,
  perPage: perPageQuerySchema,
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

/** ISO 8601 の日時（`2026-10-01T09:00:00.000Z` / `+09:00` の形）。 */
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * 予約日時（046-input-500-nul-and-ranges 設計 §6.5）。範囲の検査は UseCase（`isValidScheduledAt`）が行う。
 * OpenAPI の `date-time` には範囲を表す仕組みが無いので、説明に書く。
 */
const scheduledAtSchema = z.coerce
  .date()
  .nullable()
  .optional()
  .describe(
    '予約日時。0001-01-01T00:00:00Z から 9999-12-31T23:59:59.999Z まで（範囲外は 422）。null は予約しない。',
  );

export const createPostSchema = z
  .object({
    socialAccountId: z.string().min(1, '入力してください。'),
    body: z.string().min(1, '入力してください。').max(POST_BODY_MAX_LENGTH),
    scheduledAt: scheduledAtSchema,
    /** 省略すると今の振る舞い（048 設計 §6.2.2）。 */
    publishTiming: publishTimingSchema.optional(),
    /**
     * **Zod の既定を置かない**（048 設計 §6.2.1）。送られなかったのか `draft` を送ったのかを区別しないと、
     * `publishTiming` との同時指定を断れない。省略時の `draft` は UseCase が補う。
     */
    status: postStatusSchema
      .optional()
      .describe(
        '投稿の状態。省略時は draft（publishTiming を送らないとき）。publishTiming と同時には指定できない（422）。推奨は publishTiming。',
      ),
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
  })
  // 要求全体の形が通ったときだけ掛かる（048 設計 §6.2.4 の 1b）。違反はまとめて返す。
  .superRefine((value, context) => {
    if (value.publishTiming === undefined) return;
    if (value.status !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'publishTiming と status は同時に指定できません。',
      });
    }
    if (
      value.publishTiming === 'now' &&
      value.scheduledAt !== undefined &&
      value.scheduledAt !== null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scheduledAt'],
        message: 'publishTiming が now のときは scheduledAt を指定できません。',
      });
    }
  });

export const updatePostSchema = z.object({
  body: z.string().min(1).max(POST_BODY_MAX_LENGTH).optional(),
  scheduledAt: scheduledAtSchema,
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
  /**
   * **どんな値でも 422**（048 設計 §6.3.5）。知らない項目は黙って無視されるので、`POST` で覚えた
   * `publishTiming` を `PATCH` に送ると承認を依頼したつもりで何も起きない。黙って捨てない。
   */
  publishTiming: z
    .unknown()
    .optional()
    .refine(
      (value) => value === undefined,
      'publishTiming は登録のときだけ指定できます。承認を依頼するときは status に awaiting_approval を指定してください。',
    )
    .describe('指定すると 422。登録のときだけ使う。'),
  csrfToken: z.string().optional(),
});

/**
 * 承認の要求（048-social-post-approval 設計 §6.4.1）。
 *
 * `expectedUpdatedAt` は画面（または `GET`）で読んだ投稿の `updatedAt`。**必須**（付け忘れた承認が黙って
 * 最新の内容を承認しないように）。`z.coerce.date()` は数値も受けるので使わず、ISO 8601 の文字列として受ける。
 */
export const approvePostSchema = z.object({
  publishTiming: z
    .enum(APPROVAL_TIMINGS)
    .describe(
      '即投稿（now）か指定の時間に投稿（scheduled）。scheduled で scheduledAt を省略すると登録された希望日時を使う。',
    ),
  scheduledAt: scheduledAtSchema,
  expectedUpdatedAt: z
    .string()
    .refine(
      (value) => ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value)),
      'ISO 8601 の日時で指定してください。',
    )
    .describe(
      '画面（または GET）で読んだ投稿の updatedAt。投稿の updatedAt と合わなければ 409（見た後に内容が変わった）。',
    ),
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
  /** 承認して予約にした時刻。承認を経ていなければ null（048 設計 §6.11）。 */
  approvedAt: z.string().nullable(),
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
  /** 承認して予約にした時刻（048 設計 §6.11）。承認を経ていなければ null。 */
  readonly approvedAt: string | null;
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
    approvedAt: post.approvedAt?.toISOString() ?? null,
  };
}
