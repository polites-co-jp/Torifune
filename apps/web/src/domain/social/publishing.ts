import { isValidExternalUrl, type SocialPost } from './social';

/**
 * SNS 投稿の配信（035-social-publishing 設計 §5.6.2）。
 *
 * **Domain 層。** DB も HTTP も Plugin API も時計も知らない。
 * 「いつ取り出すか」「結果をどう書き戻すか」の判断だけを純関数で持ち、
 * 実際の呼び出しと書き込みは Application（`application/social/publish.ts`）が行う。
 */

/**
 * 1 回の実行で着手する上限。
 *
 * Webhook（023）の `BATCH_SIZE = 50` より小さいのは、1 件が外部 API を数回叩くため。
 */
export const PUBLISH_BATCH_SIZE = 20;

/**
 * `publish()` 1 回の上限。
 *
 * 超えたら `AbortSignal` を発火し、**結果不明**として `failed` にする（再試行しない）。
 */
export const PUBLISH_TIMEOUT_MS = 30_000;

/** 着手回数の上限（Webhook の `MAX_DELIVERY_ATTEMPTS` と同じ 5。初回 + 再試行 4 回）。 */
export const PUBLISH_MAX_ATTEMPTS = 5;

/** Plugin の `retryAfterMs` の上限。1 件が永久に列を塞がないように切り詰める。 */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

/**
 * `validate()` 1 回の上限。
 *
 * `publish()` と違い、HTTP 要求 1 本・配信 1 件の中で 1 回だけ呼ぶ。
 * **応答しない `validate()` に処理を止めさせない**（設計 §6.1.2 / §6.5.2.2、検証レポート L-3）。
 */
export const VALIDATE_TIMEOUT_MS = 5_000;

/**
 * `manual()` 1 回の上限。
 *
 * **`publish()` より短く取る。** `/social` は 1 回の描画で最大 50 行ぶん呼ぶので、
 * 1 件あたり 30 秒では画面が返らない（設計 §6.6、検証レポート L-3）。
 */
export const MANUAL_TIMEOUT_MS = 2_000;

/**
 * 1 回の描画で `manual()` に費やしてよい合計（ミリ秒）。
 *
 * **行ごとの上限だけでは足りない。** 50 行 × 2 秒で最悪 100 秒かかり、
 * その間 `/social` はまっ白になる。呼ぶ側は打ち切り時刻を 1 回だけ作って
 * すべての行へ渡し、過ぎた行は `manual()` を呼ばずに打ち切る。**画面は必ず返る。**
 */
export const MANUAL_HANDOFF_BUDGET_MS = MANUAL_TIMEOUT_MS * 5;

/** 伏せ字にする値の最小の長さ。短い値まで置換すると関係のない文字列を潰す。 */
const REDACT_MIN_LENGTH = 4;

/**
 * 次に試すまでの待ち（ミリ秒）。
 *
 * Webhook（023）と同じ 1 → 2 → 4 → 8 分。**Plugin の指定が長ければそちらに従う**
 * （Rate Limit の `Retry-After`）。短い指定で既定の間隔を縮めさせない。
 */
export function publishRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  const base = 60_000 * 2 ** Math.max(0, attempt - 1);
  if (retryAfterMs === undefined) {
    return base;
  }
  return Math.max(base, Math.min(retryAfterMs, MAX_RETRY_AFTER_MS));
}

export function canRetry(attempt: number): boolean {
  return attempt < PUBLISH_MAX_ATTEMPTS;
}

/**
 * 配信の対象か（設計 §6.5.3 の SQL と同じ判定）。
 *
 * SQL 側とこの関数が食い違わないよう、テストは両方を同じ条件で突く。
 */
export function isDue(
  post: Pick<
    SocialPost,
    'status' | 'deliveryMode' | 'scheduledAt' | 'nextAttemptAt' | 'publishStartedAt'
  >,
  now: Date,
): boolean {
  if (post.status !== 'scheduled' || post.deliveryMode !== 'auto') {
    return false;
  }
  // 着手印が立っている＝配信が進行中。二重投稿を起こさない（設計 §5.8）。
  if (post.publishStartedAt !== null) {
    return false;
  }
  if (post.scheduledAt === null || post.scheduledAt.getTime() > now.getTime()) {
    return false;
  }
  return post.nextAttemptAt === null || post.nextAttemptAt.getTime() <= now.getTime();
}

/**
 * 前回の実行が `publish()` の途中で死んだ行か（設計 §6.5.4）。
 *
 * 正常に終われば着手印は必ず NULL に戻る（§5.8）。残っていれば前回が死んでいる。
 */
export function isInterrupted(
  post: Pick<SocialPost, 'status' | 'deliveryMode' | 'publishStartedAt'>,
): boolean {
  return (
    post.status === 'scheduled' && post.deliveryMode === 'auto' && post.publishStartedAt !== null
  );
}

export const INTERRUPTED_REASON =
  '配信の途中で処理が中断しました。SNS 側に投稿されているか確認してください（結果不明）。';
export const TIMEOUT_REASON = '配信 Plugin が 30 秒以内に応答しませんでした（結果不明）。';
export const CREDENTIAL_MISSING_REASON = '資格情報が設定されていません。';
export const CREDENTIAL_UNREADABLE_REASON =
  '資格情報を復号できません。暗号化鍵を確認するか、資格情報を登録し直してください。';

/** 平文が publisher の宣言した形と合わないとき（設計 §5.7）。要求するキー名を書く。 */
export function credentialMismatchReason(keys: readonly string[]): string {
  return `資格情報の形式が配信 Plugin の要求（${keys.join(', ')}）と合いません。登録し直してください。`;
}

/** Plugin が例外を投げたとき。送ったかどうかは分からない。 */
export function pluginErrorReason(message: string): string {
  return `配信 Plugin でエラーが起きました（結果不明）: ${message}`;
}

/** Plugin の戻り値（または例外・タイムアウト）を、投稿への書き戻しに写した結果。 */
export type PublishVerdict =
  | {
      readonly kind: 'published';
      readonly externalId: string | null;
      readonly externalUrl: string | null;
    }
  | { readonly kind: 'retry'; readonly nextAttemptAt: Date; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** `publish()` を 1 回呼んだ結果。Core が観測できる形に畳んである。 */
export type PublishAttemptResult =
  | {
      readonly type: 'result';
      readonly ok: true;
      readonly externalId?: string;
      readonly externalUrl?: string;
    }
  | {
      readonly type: 'result';
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
      readonly retryAfterMs?: number;
    }
  | { readonly type: 'thrown'; readonly message: string }
  | { readonly type: 'timeout' };

/**
 * 結果を投稿の書き戻しに写す（設計 §5.6.2 の表）。
 *
 * **例外とタイムアウトは attempt によらず `failed`（結果不明）。** 届いたか分からない以上、
 * 二重投稿より未投稿のほうがまし（裁定）。送る前の失敗は Plugin が `retryable: true` で返す契約。
 */
export function decidePublishOutcome(
  result: PublishAttemptResult,
  attempt: number,
  now: Date,
): PublishVerdict {
  if (result.type === 'timeout') {
    return { kind: 'failed', reason: TIMEOUT_REASON };
  }
  if (result.type === 'thrown') {
    return { kind: 'failed', reason: pluginErrorReason(result.message) };
  }
  if (result.ok) {
    // https でない URL は履歴の導線に出せない（Application が警告を残す）。
    const externalUrl =
      result.externalUrl !== undefined && isValidExternalUrl(result.externalUrl)
        ? result.externalUrl
        : null;
    return { kind: 'published', externalId: result.externalId ?? null, externalUrl };
  }
  if (!result.retryable) {
    return { kind: 'failed', reason: result.reason };
  }
  if (!canRetry(attempt)) {
    // なぜ打ち切ったかが履歴から分かるようにする。
    return { kind: 'failed', reason: `${result.reason}（再試行の上限）` };
  }
  return {
    kind: 'retry',
    nextAttemptAt: new Date(now.getTime() + publishRetryDelayMs(attempt, result.retryAfterMs)),
    reason: result.reason,
  };
}

/**
 * Plugin が返した理由・例外メッセージから資格情報の値を伏せる。
 *
 * **4 文字以上の値だけ。** 短い値まで置換すると、関係のない文字列を潰してしまう。
 */
export function redactCredentialValues(text: string, values: readonly string[]): string {
  let result = text;
  for (const value of values) {
    if (value.length < REDACT_MIN_LENGTH) {
      continue;
    }
    result = result.split(value).join('***');
  }
  return result;
}

// ---------------------------------------------------------------------------
// 配信できない予約を後ろへ送る（設計 §5.1.1 / §6.5.2.1、裁定 #9）
// ---------------------------------------------------------------------------

/**
 * 飛ばした理由。
 *
 * **`social_posts.skip_reason` の CHECK と 1 対 1**（設計 §5.1.1）。
 * 片方だけ増やすと、書けない値を Application が作るか、Domain の知らない値が DB に入る。
 */
export const SKIP_REASONS = ['no_publisher', 'credential_missing', 'account_missing'] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

export function isSkipReason(value: string): value is SkipReason {
  return (SKIP_REASONS as readonly string[]).includes(value);
}

/** 同じ理由で飛ばしてよい回数。**3 回目で `failed`。** */
export const PUBLISH_MAX_SKIPS = 3;

/**
 * 飛ばした後に次を見るまでの待ち（ミリ秒）。
 *
 * 1 回目の後に 1 時間、2 回目の後に 23 時間。**合計およそ 24 時間の猶予**にする。
 * ジョブの周期（1 分）で 3 回数えると 3 分で諦めてしまい、
 * 「Plugin を後から入れる」という裁定 #8 の趣旨を壊す。
 */
export const SKIP_RETRY_DELAYS_MS = [60 * 60_000, 23 * 60 * 60_000] as const;

/** `skipCount` 回目を飛ばした直後の待ち（ミリ秒）。範囲外は末尾の値。 */
export function skipRetryDelayMs(skipCount: number): number {
  const last = SKIP_RETRY_DELAYS_MS[SKIP_RETRY_DELAYS_MS.length - 1] ?? 0;
  const index = Math.max(1, Math.trunc(skipCount)) - 1;
  return SKIP_RETRY_DELAYS_MS[index] ?? last;
}

export type SkipVerdict =
  | {
      readonly kind: 'deferred';
      readonly skipCount: number;
      readonly reason: SkipReason;
      readonly nextAttemptAt: Date;
    }
  | {
      readonly kind: 'failed';
      readonly skipCount: number;
      readonly reason: SkipReason;
      readonly failureReason: string;
    };

/**
 * 飛ばす行をどう扱うか決める（設計 §5.6.2 の表）。
 *
 * **同じ理由なら加算、理由が変われば数え直す。** 「publisher が無い → 入った →
 * 今度は資格情報が無い」は別の事象で、運用者は 1 つずつ直している最中である。
 * まとめて数えると、直している途中で打ち切られる。
 */
export function decideSkipOutcome(
  post: Pick<SocialPost, 'skipCount' | 'skipReason'>,
  reason: SkipReason,
  now: Date,
): SkipVerdict {
  const continued = post.skipReason === reason;
  const skipCount = continued ? post.skipCount + 1 : 1;

  if (skipCount >= PUBLISH_MAX_SKIPS) {
    // **順番待ちから外す。** 居座らせると他のアカウントの配信まで止まる（検証レポート S-1）。
    return {
      kind: 'failed',
      skipCount: PUBLISH_MAX_SKIPS,
      reason,
      failureReason: skipFailureReason(reason),
    };
  }

  return {
    kind: 'deferred',
    skipCount,
    reason,
    nextAttemptAt: new Date(now.getTime() + skipRetryDelayMs(skipCount)),
  };
}

/**
 * 3 回飛ばして諦めたときの `failure_reason`（設計 §5.6.2 の表）。
 *
 * **投稿一覧・履歴にそのまま出る。** 何が足りず、次に何をすればよいかが読めること。
 * `failed` は終端なので、支度が整っても自動では戻らない。
 */
export function skipFailureReason(reason: SkipReason): string {
  if (reason === 'no_publisher') {
    return (
      '配信 Plugin が有効にならないまま予約日時から約24時間が過ぎたため、この予約を取りやめました。' +
      'Plugin を有効にしてから、新しい投稿として登録し直してください。'
    );
  }
  if (reason === 'credential_missing') {
    return (
      '資格情報が設定されないまま予約日時から約24時間が過ぎたため、この予約を取りやめました。' +
      'SNSアカウントに資格情報を設定してから、新しい投稿として登録し直してください。'
    );
  }
  return (
    'SNSアカウントが見つからないまま予約日時から約24時間が過ぎたため、この予約を取りやめました。' +
    'SNSアカウントを確認してから、新しい投稿として登録し直してください。'
  );
}

// ---------------------------------------------------------------------------
// 配信直前の再検査（設計 §6.5.2.2、検証レポート S-2）
// ---------------------------------------------------------------------------

export interface PublisherLimitProblem {
  readonly field: 'body' | 'media';
  readonly message: string;
}

/**
 * publisher が宣言した `limits` に照らして問題を挙げる（設計 §6.1.2 の j〜l）。
 *
 * **登録時（UseCase）と配信直前（ジョブ）の両方がこの 1 つの関数を使う。**
 * 別々に書くと、片方だけ直したときに「登録では弾かれるのに配信では通る」が黙って生まれる。
 *
 * 見つかった問題は**すべて**返す。1 件に絞るかどうかは呼ぶ側が決める
 * （UseCase は先頭 1 件を `ValidationError` にし、配信直前は理由に並べる）。
 */
export function checkPublisherLimits(
  post: Pick<SocialPost, 'body' | 'media' | 'deliveryMode'>,
  limits: {
    readonly bodyMaxLength?: number | undefined;
    readonly mediaRequired?: boolean | undefined;
    readonly mediaMax?: number | undefined;
  },
  label: string,
): readonly PublisherLimitProblem[] {
  const problems: PublisherLimitProblem[] = [];

  if (limits.bodyMaxLength !== undefined && post.body.length > limits.bodyMaxLength) {
    problems.push({
      field: 'body',
      message: `本文は${limits.bodyMaxLength}文字以内にしてください（${label}）。`,
    });
  }
  if (limits.mediaMax !== undefined && post.media.length > limits.mediaMax) {
    problems.push({
      field: 'media',
      message: `媒体は${limits.mediaMax}件以内にしてください（${label}）。`,
    });
  }
  // **手動投稿には掛けない。** 手動投稿はそもそも媒体を持てない（設計 §6.1.2 の f・l）。
  if (limits.mediaRequired === true && post.deliveryMode === 'auto' && post.media.length === 0) {
    problems.push({
      field: 'media',
      message: `${label} への配信には画像または動画が必要です。`,
    });
  }

  return problems;
}

/**
 * 配信直前の再検査に落ちたとき（設計 §6.5.2.2）。
 *
 * **「送っていない」と読める文言にする。** `pluginErrorReason` / `TIMEOUT_REASON`
 * （どちらも結果不明）と混ぜない。運用者の次の行動が違う。
 */
export function publisherRejectedReason(
  problems: readonly { readonly field: string; readonly message: string }[],
): string {
  const detail = problems.map((problem) => `${problem.field}: ${problem.message}`).join('; ');
  return `配信 Plugin の検査に通らなかったため、配信していません: ${detail}`;
}

/** 配信直前の `validate()` が例外／制限時間超過だったとき（未送信）。 */
export function validateErrorReason(message: string): string {
  return `配信前の検査で配信 Plugin がエラーを返しました（未送信）: ${message}`;
}
