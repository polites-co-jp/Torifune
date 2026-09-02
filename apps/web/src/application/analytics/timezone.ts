import { isValidTimeZone } from '@/domain/analytics/day';
import { log } from '@/infrastructure/logging';

/**
 * 集計の「1日の境目」を決めるタイムゾーン。
 *
 * **インスタンス単位の設定にする**（`TORIFUNE_TIMEZONE`）。
 * サイトごとやユーザーごとにすると、同じ集計値が見る人によって
 * 違う日に属することになり、保存した日次の値を説明できなくなる。
 *
 * 既定は `UTC`。設定していない環境の意味を変えないため。
 *
 * **変えたら、過去の期間はロールアップを流し直す必要がある。**
 * 保存済みの `analytics.metric_date` は前の境目で畳まれている。
 */

const DEFAULT_TIME_ZONE = 'UTC';

let warned = false;

export function analyticsTimeZone(): string {
  const configured = process.env['TORIFUNE_TIMEZONE']?.trim();

  if (configured === undefined || configured === '') {
    return DEFAULT_TIME_ZONE;
  }

  if (!isValidTimeZone(configured)) {
    // **落とさない。** 設定の誤りでアクセス記録まで止まると被害が大きい。
    // ただし黙って既定へ落ちると、ずれた集計の原因が分からなくなる。
    if (!warned) {
      warned = true;
      log.warn('TORIFUNE_TIMEZONE が不正なため UTC で集計する', { value: configured });
    }
    return DEFAULT_TIME_ZONE;
  }

  return configured;
}

/** テスト用。警告を1度しか出さない状態を戻す。 */
export function resetTimeZoneWarning(): void {
  warned = false;
}
