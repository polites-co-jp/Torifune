import type { CampaignStatus } from '@/domain/campaign/campaign';

/**
 * キャンペーン画面の表示文言。
 *
 * **コンポーネントの中に直書きしない**（`02_画面デザイン方針.md` §5）。
 * 一覧と分析で同じ状態に別の言い方をすると、同じものだと分からなくなる。
 */
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: '下書き',
  running: '実施中',
  finished: '終了',
  cancelled: '中止',
};

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABEL[status as CampaignStatus] ?? status;
}
