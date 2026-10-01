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

/**
 * 投稿の状態。**並びは状態の進む順**（下書き → 承認待ち → 予約 → 結果）。
 *
 * `awaiting_approval`（承認待ち）は 048-social-post-approval で足した。「配信してよいと誰もまだ言っていない」
 * という事実は既存の列の組み合わせから導けないため（048 設計 §2）。
 */
export const POST_STATUSES = [
  'draft',
  'awaiting_approval',
  'scheduled',
  'published',
  'failed',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * 登録の時点での配信の時機（048-social-post-approval 設計 §6.1）。
 *
 * `deliveryMode`（誰が SNS へ出すか）とは別の軸。`now`＝即投稿、`scheduled`＝`scheduledAt` の時刻に投稿、
 * `after_approval`＝人の確認（承認）を待ってから投稿。
 */
export const PUBLISH_TIMINGS = ['now', 'scheduled', 'after_approval'] as const;
export type PublishTiming = (typeof PUBLISH_TIMINGS)[number];

/** 承認するときに選べる時機（048-social-post-approval 設計 §6.4）。 */
export const APPROVAL_TIMINGS = ['now', 'scheduled'] as const;
export type ApprovalTiming = (typeof APPROVAL_TIMINGS)[number];

/**
 * 配信の方法（035-social-publishing 設計 §5.6.1）。
 *
 * `auto` はジョブが Plugin を通して送る。`manual` は人が SNS 側で投稿し、
 * 結果を画面から記録する。**状態（`PostStatus`）は増やさない**（§5.8）。
 * ただし 048-social-post-approval で承認待ちを 1 つ足した（承認待ちは既存の列から導けないため）。
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
  /**
   * 承認して予約にした時刻。承認を経ていなければ null（048-social-post-approval 設計 §5.2）。
   * 誰が承認したかは監査ログが持つ。
   */
  readonly approvedAt: Date | null;
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
 * **状態は増やさない**（035-social-publishing 設計 §5.8。048 で承認待ちを 1 つ足したが、それは導出できないため）。
 * 「手動投稿待ち」は `manual` かつ `scheduled` かつ予約時刻が来たことから導く。承認待ちの行は拾わない。
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
 *
 * **承認待ち（`awaiting_approval`）から予約・配信の結果へは `PATCH` で進めない**
 * （048-social-post-approval 設計 §6.6.2）。予約にするのは承認の操作（`canApprove`）だけ。
 * 差し戻し（`draft`）と内容の修正（`awaiting_approval` のまま）はできる。
 */
const ALLOWED_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ['draft', 'awaiting_approval', 'scheduled', 'published', 'failed'],
  awaiting_approval: ['awaiting_approval', 'draft'],
  scheduled: ['scheduled', 'draft', 'awaiting_approval', 'published', 'failed'],
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

// ---------------------------------------------------------------------------
// 承認待ち（048-social-post-approval）
// ---------------------------------------------------------------------------

/**
 * 承認できる状態か（048-social-post-approval 設計 §6.6.2）。
 *
 * `awaiting_approval → scheduled` は `canTransition` では偽で、承認の操作だけが行う。
 */
export function canApprove(status: PostStatus): boolean {
  return status === 'awaiting_approval';
}

export interface CreateTimingInput {
  /** 送られた登録の時機。送られなければ undefined（今の振る舞い。裁定 1）。 */
  readonly publishTiming: PublishTiming | undefined;
  /** 送られた状態。`publishTiming` と同時には来ない（HTTP のスキーマが断る）。 */
  readonly status: PostStatus | undefined;
  readonly scheduledAt: Date | null;
  /** その provider が「手動投稿しかできない配信 Plugin」か（設計 §6.7）。 */
  readonly manualOnly: boolean;
  readonly now: Date;
}

export type CreateTimingResult =
  | {
      readonly ok: true;
      readonly status: PostStatus;
      readonly scheduledAt: Date | null;
      /** 手動投稿しかできない配信 Plugin のために承認待ちに変えたか（監査に残す。裁定 5）。 */
      readonly approvalForced: boolean;
    }
  | { readonly ok: false; readonly field: 'scheduledAt'; readonly message: string };

const SCHEDULED_AT_REQUIRED_MESSAGE = '予約するときは予約日時を指定してください。';

/**
 * 登録の `status` / `scheduledAt` の実効値を決める（048-social-post-approval 設計 §6.2.2・§6.2.3）。
 *
 * * `publishTiming` を送らない要求は今の振る舞い（`status` の省略は `draft`）。**`manualOnly` を効かせない**（裁定 8）
 * * `now` の `scheduledAt` は「いま」。`scheduled` は日時が要る（過去も可）。`after_approval` は承認待ち（日時は希望日時）
 * * 表の解決の**後**に裁定 5 の上書きを掛ける：`publishTiming` を送っていて `manualOnly` なら承認待ち
 *   （`scheduledAt` は `now` なら null、それ以外は送った値）。表の段階の誤りは provider によらず同じに返す
 */
export function resolveCreateTiming(input: CreateTimingInput): CreateTimingResult {
  const { publishTiming, scheduledAt, now } = input;

  if (publishTiming === undefined) {
    const status = input.status ?? 'draft';
    if (status === 'scheduled' && scheduledAt === null) {
      return { ok: false, field: 'scheduledAt', message: SCHEDULED_AT_REQUIRED_MESSAGE };
    }
    return { ok: true, status, scheduledAt, approvalForced: false };
  }

  if (publishTiming === 'scheduled' && scheduledAt === null) {
    return { ok: false, field: 'scheduledAt', message: SCHEDULED_AT_REQUIRED_MESSAGE };
  }

  if (input.manualOnly) {
    return {
      ok: true,
      status: 'awaiting_approval',
      scheduledAt: publishTiming === 'now' ? null : scheduledAt,
      approvalForced: true,
    };
  }

  switch (publishTiming) {
    case 'now':
      return { ok: true, status: 'scheduled', scheduledAt: now, approvalForced: false };
    case 'scheduled':
      return { ok: true, status: 'scheduled', scheduledAt, approvalForced: false };
    case 'after_approval':
      return { ok: true, status: 'awaiting_approval', scheduledAt, approvalForced: false };
  }
}

export interface ApprovalScheduleInput {
  readonly requested: ApprovalTiming;
  /** 要求の `scheduledAt`。送られなければ undefined。 */
  readonly scheduledAtInput: Date | null | undefined;
  /** 登録された希望日時。 */
  readonly registered: Date | null;
  readonly manualOnly: boolean;
  readonly now: Date;
}

export type ApprovalScheduleResult =
  | {
      readonly ok: true;
      readonly timing: ApprovalTiming;
      readonly scheduledAt: Date;
      /** 手動投稿しかできない配信 Plugin のために即投稿へ読み替えたか（裁定 5）。 */
      readonly approvalForced: boolean;
    }
  | { readonly ok: false; readonly field: 'scheduledAt'; readonly message: string };

/**
 * 承認のときの配信の時刻を決める（048-social-post-approval 設計 §6.4.5。裁定 4・5）。
 *
 * **過ぎた日時を即投稿に読み替えない。** 承認する人は「指定の時間に投稿」を明示して選んでいる。
 * 決めた日時が「いま」以前（等しいときも）なら 422 で、即投稿か日時の指定し直しを求める。
 */
export function resolveApprovalSchedule(input: ApprovalScheduleInput): ApprovalScheduleResult {
  const { requested, now } = input;

  if (input.manualOnly) {
    return { ok: true, timing: 'now', scheduledAt: now, approvalForced: requested === 'scheduled' };
  }
  if (requested === 'now') {
    return { ok: true, timing: 'now', scheduledAt: now, approvalForced: false };
  }

  const fromInput = input.scheduledAtInput ?? null;
  if (fromInput !== null && !isValidScheduledAt(fromInput)) {
    return {
      ok: false,
      field: 'scheduledAt',
      message: '0001-01-01T00:00:00Z から 9999-12-31T23:59:59.999Z までの日時を指定してください。',
    };
  }
  const scheduledAt = fromInput ?? input.registered;
  if (scheduledAt === null) {
    return {
      ok: false,
      field: 'scheduledAt',
      message: '承認して予約するときは日時を指定してください。',
    };
  }
  if (scheduledAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      field: 'scheduledAt',
      message: '指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。',
    };
  }
  return { ok: true, timing: 'scheduled', scheduledAt, approvalForced: false };
}

/** 承認を外すかを決めるのに比べる項目（048-social-post-approval 設計 §6.3.3）。 */
export interface ApprovalSubject {
  readonly status: PostStatus;
  readonly approvedAt: Date | null;
  readonly body: string;
  readonly media: readonly PostMedia[];
  readonly link: string | null;
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly deliveryMode: DeliveryMode;
  readonly scheduledAt: Date | null;
}

/** キーを再帰的に整列した JSON（キーの順序に依らずに比べる）。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function sameMedia(a: readonly PostMedia[], b: readonly PostMedia[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => item.url === b[index]?.url && item.alt === b[index]?.alt)
  );
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

/**
 * 承認済みの予約を書き換えると承認待ちへ戻すか（048-social-post-approval 設計 §6.3.3。裁定 10）。
 *
 * 承認を経た予約（`approvedAt` あり）が、変更後も `scheduled` のまま、内容・日時・配信方法のどれかが
 * **値として変わる**とき真。送っただけで値が同じなら偽（編集フォームは変えていない項目も送る）。
 * `media` は要素の順序込みで、`providerOptions` はキーの順序に依らず、`scheduledAt` はミリ秒で比べる。
 */
export function revokesApproval(current: ApprovalSubject, next: ApprovalSubject): boolean {
  if (current.status !== 'scheduled' || current.approvedAt === null) {
    return false;
  }
  if (next.status !== 'scheduled') {
    return false;
  }
  return (
    current.body !== next.body ||
    !sameMedia(current.media, next.media) ||
    current.link !== next.link ||
    canonicalJson(current.providerOptions) !== canonicalJson(next.providerOptions) ||
    current.deliveryMode !== next.deliveryMode ||
    !sameTime(current.scheduledAt, next.scheduledAt)
  );
}

/**
 * 手動投稿しかできない配信 Plugin か（048-social-post-approval 設計 §6.7.2。裁定 7）。
 *
 * **provider 名で分岐しない。** Application が登録簿から「`publish` があるか・`manual` があるか」を
 * 取り出して渡す（Domain は Plugin API を知らない）。配信 Plugin が無ければ偽。
 */
export function isManualOnlyPublisher(
  publisher: { readonly publish: boolean; readonly manual: boolean } | null,
): boolean {
  return publisher !== null && publisher.manual && !publisher.publish;
}

/**
 * 承認の競合（048-social-post-approval 設計 §6.4.3）。
 *
 * 承認の要求の `expectedUpdatedAt` が投稿の `updatedAt` と合わない＝画面で見た後に内容が変わった。
 * API は 409 `CONFLICT` と `details.expectedUpdatedAt` に写す。**`ConflictError` を継承しない**
 * （既定文言の 409 と取り違えない）。
 */
export class StaleSocialPostError extends Error {
  constructor(readonly postId: string) {
    super('投稿の内容が変わっています');
    this.name = 'StaleSocialPostError';
  }
}
