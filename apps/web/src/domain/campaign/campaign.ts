/**
 * マーケティングキャンペーン（02_データベース設計.md §5.7、06_画面設計.md §14）。
 *
 * **Domain 層。** DB 製品も HTTP も知らない。
 *
 * 設計は docs/設計/017-campaigns/設計.md。
 * 予算・目標値・実績は持たない。何を指標にするかは利用者ごとに違い、
 * 決め打つと合わない人が使えなくなる。必要なら Plugin が持つ。
 */

export const CAMPAIGN_STATUSES = ['draft', 'running', 'finished', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: CampaignStatus;
  /** 開始日。`YYYY-MM-DD`。 */
  readonly startsOn: string;
  /** 終了日。終わりを決めずに始める運用があるため null を許す。 */
  readonly endsOn: string | null;
  /** 対象の Webサイト。多対多。 */
  readonly siteIds: readonly string[];
  /**
   * 紐づくSNS投稿。多対多。
   *
   * 仕様（06_画面設計.md §14）が求める「キャンペーンとWebサイト、SNS投稿等を
   * 関連付けられる構造」。`siteIds` と同じ扱いにする。
   */
  readonly socialPostIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: string | null;
}

export const CAMPAIGN_NAME_MAX_LENGTH = 200;

export function isValidCampaignName(value: string): boolean {
  return value.trim() !== '' && value.length <= CAMPAIGN_NAME_MAX_LENGTH;
}

export function isCampaignStatus(value: string): value is CampaignStatus {
  return (CAMPAIGN_STATUSES as readonly string[]).includes(value);
}

/**
 * `YYYY-MM-DD` として妥当か。
 *
 * `new Date()` に任せない。`2026-02-31` のような存在しない日付を
 * 前後の月へ丸めてしまい、利用者の入力と違う値が保存される。
 */
export function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * 期間として成立するか。
 *
 * **逆転を許さない。** 許すと、一覧の並びも期間の計算も壊れる。
 * 同じ日（1日だけのキャンペーン）は許す。
 */
export function isValidPeriod(startsOn: string, endsOn: string | null): boolean {
  if (!isValidDateOnly(startsOn)) {
    return false;
  }
  if (endsOn === null) {
    return true;
  }
  return isValidDateOnly(endsOn) && endsOn >= startsOn;
}

/** 一覧の既定で `cancelled` を隠す。「やらなかった記録」は既定で邪魔になる。 */
export const DEFAULT_LISTED_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'draft',
  'running',
  'finished',
];
