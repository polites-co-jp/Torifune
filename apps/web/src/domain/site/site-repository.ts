import type { Connection } from '../../database/provider';
import type { Site, SiteStatus } from './site';

export interface NewSite {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly status: SiteStatus;
  readonly createdBy: string | null;
}

/** 部分更新。undefined の項目は変えない。 */
export interface SiteUpdate {
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: SiteStatus | undefined;
}

export interface SiteListQuery {
  readonly page: number;
  readonly perPage: number;
  /** 絞り込む状態。未指定なら `DEFAULT_LISTED_STATUSES`。 */
  readonly statuses: readonly SiteStatus[];
  /** 名前・URL の部分一致。 */
  readonly keyword: string | null;
  readonly sort: readonly { field: string; direction: 'asc' | 'desc' }[];
}

export interface SitePage {
  readonly items: readonly Site[];
  readonly total: number;
}

export interface SiteRepository {
  list(connection: Connection, query: SiteListQuery): Promise<SitePage>;
  findById(connection: Connection, id: string): Promise<Site | null>;
  insert(connection: Connection, site: NewSite): Promise<Site>;
  update(connection: Connection, id: string, patch: SiteUpdate): Promise<Site | null>;
  /**
   * 公開キーを差し替える。更新できたら true。存在しなければ false。
   *
   * `update` とは分ける。公開キーは `Site` にも `SiteUpdate` にも出さず、
   * 利用者が任意の値を指定できる項目にしない。
   */
  updatePublicKey(connection: Connection, id: string, publicKey: string): Promise<boolean>;
  /** 削除できたら true。存在しなければ false。 */
  delete(connection: Connection, id: string): Promise<boolean>;
}
