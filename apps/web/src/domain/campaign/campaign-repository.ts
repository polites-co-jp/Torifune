import type { Connection } from '../../database/provider';
import type { Campaign, CampaignStatus } from './campaign';

export interface NewCampaign {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: CampaignStatus;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteIds: readonly string[];
  readonly socialPostIds: readonly string[];
  readonly createdBy: string | null;
}

/** 部分更新。undefined の項目は変えない。 */
export interface CampaignUpdate {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: CampaignStatus | undefined;
  readonly startsOn?: string | undefined;
  readonly endsOn?: string | null | undefined;
  /**
   * 対象サイト。**指定したら丸ごと置き換える。**
   * 差分で受け取ると「消す」を表現できない。
   */
  readonly siteIds?: readonly string[] | undefined;
  /** 紐づくSNS投稿。**指定したら丸ごと置き換える**（`siteIds` と同じ）。 */
  readonly socialPostIds?: readonly string[] | undefined;
}

export interface CampaignListQuery {
  readonly page: number;
  readonly perPage: number;
  /** 絞り込む状態。未指定なら `DEFAULT_LISTED_CAMPAIGN_STATUSES`。 */
  readonly statuses: readonly CampaignStatus[];
  /** 名前・説明の部分一致。 */
  readonly keyword: string | null;
  /** この日に実施中のものだけを返す（`YYYY-MM-DD`）。 */
  readonly activeOn: string | null;
  /** 対象サイトで絞る。 */
  readonly siteId: string | null;
  readonly sort: readonly { field: string; direction: 'asc' | 'desc' }[];
}

export interface CampaignPage {
  readonly items: readonly Campaign[];
  readonly total: number;
}

export interface CampaignRepository {
  list(connection: Connection, query: CampaignListQuery): Promise<CampaignPage>;
  findById(connection: Connection, id: string): Promise<Campaign | null>;
  insert(connection: Connection, campaign: NewCampaign): Promise<Campaign>;
  update(connection: Connection, id: string, patch: CampaignUpdate): Promise<Campaign | null>;
  /** 削除できたら true。存在しなければ false。 */
  delete(connection: Connection, id: string): Promise<boolean>;
}
