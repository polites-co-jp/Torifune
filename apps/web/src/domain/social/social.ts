import { isSafeReturnTo } from '../authorization-state';
import { ownValue } from '../own-value';
import type { Secret } from '../secret';
import { containsNul } from '../text';
import type { SkipReason } from './publishing';

/**
 * SNSアカウントと投稿。
 *
 * **外部SNSとの実連携は Plugin の責務**（01_アーキテクチャ設計.md §12）。
 * ここが表すのはデータと状態だけ。
 *
 * **Domain 層。** 暗号方式も HTTP も知らない。
 */

/**
 * Core が知っている provider。
 *
 * **この一覧に無い値も受け入れる。** Plugin が新しいSNSを足せる必要がある
 * （03_プラグイン設計.md §9）。ここは表示名を引くための対応表にすぎない。
 */
export const KNOWN_PROVIDERS = [
  'x',
  'facebook',
  'instagram',
  'youtube',
  'bluesky',
  'other',
] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  x: 'X',
  facebook: 'Facebook',
  instagram: 'Instagram',
  youtube: 'YouTube',
  bluesky: 'Bluesky',
  other: 'その他',
};

/** provider の形式。任意の文字列を通すと、画面や URL で扱いにくくなる。 */
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export function isValidProvider(value: string): boolean {
  return PROVIDER_PATTERN.test(value);
}

/**
 * provider の表示名。
 *
 * **登録された publisher の表示名を優先する。** `overrides` は Application が
 * publisher の登録簿から作って渡す。Plugin を無効にしても `PROVIDER_LABELS` が
 * 残るので、一覧の表示が生の値に落ちない（035-social-publishing 設計 §5.6.1）。
 */
export function providerLabel(
  provider: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  // provider は HTTP で決められる。`constructor` などで継承した関数を拾わないよう、
  // 自分のプロパティだけを見る（047-prototype-key-sweep 設計 §4.1）。
  return ownValue(overrides, provider) ?? ownValue(PROVIDER_LABELS, provider) ?? provider;
}

export const ACCOUNT_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface SocialAccount {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  /**
   * 資格情報。**復号済みの値をここへ入れない。**
   * 「設定されているか」だけを保持し、平文は必要なときに復号して取り出す。
   */
  readonly credentialConfigured: boolean;
  readonly status: AccountStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 内部処理が資格情報を必要とするときだけ使う形。 */
export interface SocialAccountWithCredential extends SocialAccount {
  readonly credential: Secret | null;
  /**
   * 読んだ時点の資格情報の版（039 設計 §6.1）。比較更新にだけ使う不透明な値で、中身は保存されている暗号文。
   * **復号しない・ログ／監査／summary／Plugin へ渡さない。** 保存されていなければ null。
   */
  readonly credentialVersion: string | null;
}

export const DISPLAY_NAME_MAX_LENGTH = 200;

export function isValidDisplayName(value: string): boolean {
  return value.trim() !== '' && value.length <= DISPLAY_NAME_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// 投稿
// ---------------------------------------------------------------------------

export const POST_STATUSES = ['draft', 'scheduled', 'published', 'failed'] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * 配信の方法（035-social-publishing 設計 §5.6.1）。
 *
 * `auto` はジョブが Plugin を通して送る。`manual` は人が SNS 側で投稿し、
 * 結果を画面から記録する。**状態（`PostStatus`）は増やさない**（§5.8）。
 */
export const DELIVERY_MODES = ['auto', 'manual'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export function isDeliveryMode(value: string): value is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(value);
}

/**
 * 投稿に添える媒体。
 *
 * **ファイルは預からない。** URL だけを持ち、取りに行くのは Plugin の仕事。
 */
export interface PostMedia {
  readonly url: string;
  readonly alt: string | null;
}

export interface SocialPost {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: Date | null;
  readonly status: PostStatus;
  readonly publishedAt: Date | null;
  /**
   * 配信に失敗した時刻。
   *
   * **`updatedAt` で代用しない。** あれは「最後に触った時刻」であって
   * 「失敗した時刻」ではない。履歴を結果の時系列で並べるには別に要る。
   */
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deliveryMode: DeliveryMode;
  readonly media: readonly PostMedia[];
  /** 本文に添える URL（X の `url=`、Bluesky の外部埋め込みなど）。 */
  readonly link: string | null;
  /** provider 固有の追加項目。**中身を検証するのは Plugin**（`validate()`）。 */
  readonly providerOptions: Readonly<Record<string, unknown>>;
  /** 外部アプリ側の ID。同じ API Token からの再送を 1 行にまとめる冪等キー。 */
  readonly externalRef: string | null;
  /** 登録した API Token。セッションからの登録は null。 */
  readonly createdByTokenId: string | null;
  /** 配信後の SNS 側の投稿 ID。 */
  readonly externalId: string | null;
  /** 配信後の投稿の URL。 */
  readonly externalUrl: string | null;
  /** 配信の着手印。**非 NULL ⇔ 配信が進行中**（035-social-publishing 設計 §5.8）。 */
  readonly publishStartedAt: Date | null;
  readonly attemptCount: number;
  /** 再試行の予定。null なら `scheduledAt` で期限を判定する。 */
  readonly nextAttemptAt: Date | null;
  /**
   * 同じ理由で続けて飛ばした回数（035-social-publishing 設計 §5.1.1）。
   *
   * **`attemptCount` とは別。** あれは `publish()` を呼んだ回数で、飛ばした行では 0 のまま。
   */
  readonly skipCount: number;
  /** どの理由で飛ばしたか。null なら飛ばされていない。 */
  readonly skipReason: SkipReason | null;
}

/**
 * 配信結果が確定した状態（06_画面設計.md §13「履歴」）。
 *
 * **試行履歴のテーブルは作らない。** この2つは終端で、
 * 1つの投稿が持つ配信結果は高々1つ。履歴とは
 * 「結果が確定した投稿の一覧」である（026-screen-completion 設計 §4.3）。
 */
export const DELIVERED_STATUSES: readonly PostStatus[] = ['published', 'failed'];

export const POST_BODY_MAX_LENGTH = 10_000;

/**
 * 失敗理由の長さの上限。
 *
 * 外部サービスの応答をそのまま渡す使い方が想定されるため、
 * **長さで弾かずに切り詰める**（`normalizeFailureReason`）。
 * 長かっただけで失敗の記録が残らないほうが困る。
 */
export const FAILURE_REASON_MAX_LENGTH = 2000;

/**
 * 予約日時の範囲（046-input-500-nul-and-ranges 設計 §6.5）。`0001-01-01T00:00:00.000Z`〜`9999-12-31T23:59:59.999Z`。
 *
 * **`Date.UTC(1, …)` で作らない**（2 桁の年は 1900 年代になる）。エポックミリ秒のリテラルで持つ。
 * PostgreSQL の `timestamptz` の下限より十分内側で、応答の `toISOString()` が 4 桁の年の形に収まる。
 */
export const SCHEDULED_AT_MIN_MS = -62135596800000;
export const SCHEDULED_AT_MAX_MS = 253402300799999;

/** 予約日時として受け付けるか。`Invalid Date` は偽。 */
export function isValidScheduledAt(value: Date): boolean {
  const time = value.getTime();
  return !Number.isNaN(time) && time >= SCHEDULED_AT_MIN_MS && time <= SCHEDULED_AT_MAX_MS;
}

export function isValidPostBody(value: string): boolean {
  return value.trim() !== '' && value.length <= POST_BODY_MAX_LENGTH;
}

/** 1 つの投稿に添えられる媒体の数。 */
export const MEDIA_MAX = 10;
export const MEDIA_URL_MAX_LENGTH = 2048;
export const MEDIA_ALT_MAX_LENGTH = 1000;
export const LINK_MAX_LENGTH = 2048;
export const EXTERNAL_REF_MAX_LENGTH = 200;
export const EXTERNAL_ID_MAX_LENGTH = 200;
export const EXTERNAL_URL_MAX_LENGTH = 2048;
/** `providerOptions` を JSON にしたときの上限（バイト）。 */
export const PROVIDER_OPTIONS_MAX_BYTES = 4096;

/**
 * 外から取りに行く URL として受け付けるか。
 *
 * **https だけ。** 資格情報付き URL は不可（`isValidWebhookUrl` と同じ判断）。
 * ただし localhost の http は許さない。**Plugin が取りに行く URL** であり、
 * 開発用の抜け道を作ると、そのまま SNS へ渡して届かない URL になる。
 */
function isValidExternalHttpsUrl(value: string, maxLength: number): boolean {
  if (value.length > maxLength) {
    return false;
  }
  if (containsNul(value)) {
    // new URL() は NUL をパーセント符号化して通すが、元の文字列は text 列に保存できない
    // （046-input-500-nul-and-ranges 設計 §9.4）。ブラウザでも開けない URL として断る。
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    // URL に資格情報を書かせない。保存すると一覧やログに載る。
    return false;
  }
  return url.protocol === 'https:';
}

export function isValidMediaUrl(value: string): boolean {
  return isValidExternalHttpsUrl(value, MEDIA_URL_MAX_LENGTH);
}

export function isValidLink(value: string): boolean {
  return isValidExternalHttpsUrl(value, LINK_MAX_LENGTH);
}

export function isValidExternalUrl(value: string): boolean {
  return isValidExternalHttpsUrl(value, EXTERNAL_URL_MAX_LENGTH);
}

/**
 * publisher の `manual()` が返した投稿画面の URL として受け付けるか（設計 §6.6）。
 *
 * * **絶対 URL は `isValidExternalUrl` と同じ規則**（https のみ・資格情報付き URL を拒否・
 *   2048 文字以内）。同じ「Plugin が返した URL」なのに、`publish()` の `externalUrl` より
 *   甘い門があってはならない
 * * **`/` で始まるものだけ Torifune 内のパスとして `isSafeReturnTo` に委ねる**
 *   （`//` / `/\` で始まらない、制御文字を含まない）
 *
 * **`isSafeReturnTo` を絶対 URL の判定に流用しない**（検証レポート L-2）。
 * 目的が違う関数を共有すると、片方の都合で緩めたときにもう片方が黙って緩む。
 */
export function isValidManualUrl(value: string): boolean {
  if (value.startsWith('/')) {
    return isSafeReturnTo(value);
  }
  return isValidExternalUrl(value);
}

/**
 * 手動投稿待ちか。
 *
 * **状態は増やさない**（035-social-publishing 設計 §5.8）。
 * 「手動投稿待ち」は `manual` かつ `scheduled` かつ予約時刻が来たことから導く。
 */
export function isManualPending(
  post: Pick<SocialPost, 'deliveryMode' | 'status' | 'scheduledAt'>,
  now: Date,
): boolean {
  return (
    post.deliveryMode === 'manual' &&
    post.status === 'scheduled' &&
    post.scheduledAt !== null &&
    post.scheduledAt.getTime() <= now.getTime()
  );
}

/**
 * 状態遷移の可否。
 *
 * ```text
 * draft ──→ scheduled ──→ published
 *   │           │
 *   └───────────┴──→ failed
 * ```
 *
 * **`published` と `failed` からは戻せない。** 起きた事実は書き換えない。
 * 「配信した」を「下書き」に戻せると、記録が信用できなくなる。
 */
const ALLOWED_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ['draft', 'scheduled', 'published', 'failed'],
  scheduled: ['scheduled', 'draft', 'published', 'failed'],
  published: ['published'],
  failed: ['failed'],
};

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isPostStatus(value: string): value is PostStatus {
  return (POST_STATUSES as readonly string[]).includes(value);
}

export function isAccountStatus(value: string): value is AccountStatus {
  return (ACCOUNT_STATUSES as readonly string[]).includes(value);
}
