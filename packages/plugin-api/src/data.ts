/**
 * Data API（03_プラグイン設計.md §5、05_API設計.md §22）。
 *
 * **Plugin は Torifune のデータベースへ直接 SQL を発行しない**（同 §5）。
 * データベース構造の変更による Plugin への影響を抑えるため。
 *
 * **呼び出しは、Plugin が Manifest で宣言した Permission を通る。**
 * 宣言していない操作は失敗する。
 */

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
}

export interface ListOptions {
  readonly page?: number;
  readonly perPage?: number;
}

export interface SiteView {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SocialAccountView {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  readonly status: string;
  /**
   * 資格情報が設定されているか。
   *
   * **平文は渡さない。** Plugin は自分の資格情報を
   * `store.setSecret()` / `store.getSecret()` で管理する
   * （`docs/設計/010-plugin-api/設計.md` §5）。
   */
  readonly credentialConfigured: boolean;
}

export interface SocialPostView {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  /**
   * 配信に失敗した理由。
   *
   * `markFailed(id, reason)` で記録したものが返る。
   * **以前はここが無く、渡した理由を読み返せなかった。**
   */
  readonly failureReason: string | null;
}

export interface SiteInput {
  readonly name: string;
  readonly url: string;
  readonly description?: string;
  readonly status?: string;
}

export interface CampaignView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  /** 開始日。`YYYY-MM-DD`。時刻は持たない。 */
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteIds: readonly string[];
  /** 紐づくSNS投稿（06_画面設計.md §14）。 */
  readonly socialPostIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CampaignInput {
  readonly name: string;
  readonly description?: string;
  readonly status?: string;
  readonly startsOn: string;
  readonly endsOn?: string | null;
  readonly siteIds?: readonly string[];
  /** 紐づくSNS投稿。**指定したら丸ごと置き換える**（`siteIds` と同じ）。 */
  readonly socialPostIds?: readonly string[];
}

export interface AnalyticsPointView {
  readonly siteId: string;
  readonly metricDate: string;
  readonly source: string;
  /**
   * 指標名。Torifune 自身の `sessions` は 30 分無操作で区切ったセッション数
   * （以前は `visitors` と同値だった）。
   */
  readonly metric: string;
  /**
   * 内訳キー（パス・参照元ホスト・時間帯など）。キーを持たない指標は `''`。
   *
   * 指標名は開いた集合であり、Torifune 自身の指標も増える
   * （`path_pageviews` / `referrer` / `bounces` など）。知らない指標は無視してよい。
   */
  readonly key: string;
  readonly value: number;
}

export interface AnalyticsQuery {
  readonly siteId?: string;
  readonly from: string;
  readonly to: string;
  /** 出所で絞る。省略すると全部。 */
  readonly source?: string;
  /** 指標名で絞る。省略すると全指標。 */
  readonly metric?: string;
  /**
   * 内訳キーで絞る。`''` を渡すとキー無しの行だけになる。省略すると全 key
   * （キー付きの行も含む。日次の値だけが要るなら `''` を渡す）。
   */
  readonly key?: string;
}

export interface AnalyticsInput {
  readonly siteId: string;
  readonly metricDate: string;
  readonly metric: string;
  /** 内訳キー。省略すると `''`（キーを持たない指標）。500 文字以内、制御文字は不可。 */
  readonly key?: string;
  readonly value: number;
}

export interface PluginDataApi {
  readonly sites: {
    list(options?: ListOptions): Promise<Page<SiteView>>;
    get(id: string): Promise<SiteView | null>;
    create(input: SiteInput): Promise<SiteView>;
    update(id: string, input: Partial<SiteInput>): Promise<SiteView>;
    delete(id: string): Promise<void>;
  };

  /** キャンペーン（05_API設計.md §22、017-campaigns）。 */
  readonly campaigns: {
    list(options?: ListOptions & { siteId?: string }): Promise<Page<CampaignView>>;
    get(id: string): Promise<CampaignView | null>;
    create(input: CampaignInput): Promise<CampaignView>;
    update(id: string, input: Partial<CampaignInput>): Promise<CampaignView>;
    delete(id: string): Promise<void>;
  };

  /**
   * アクセス・分析データ（05_API設計.md §22、018-analytics）。
   *
   * **生ログは出さない。** 個人の行動に近く、出す理由が「一覧したい」しか
   * 無い割に危険が大きい。集計値の読み書きだけを許す。
   */
  readonly analytics: {
    list(query: AnalyticsQuery): Promise<readonly AnalyticsPointView[]>;
    /** 外部サービスから取り込んだ値を入れる。**出所は自分の Plugin ID になる。** */
    record(point: AnalyticsInput): Promise<void>;
  };

  readonly socialAccounts: {
    list(options?: ListOptions): Promise<Page<SocialAccountView>>;
    get(id: string): Promise<SocialAccountView | null>;
  };

  readonly socialPosts: {
    list(options?: ListOptions & { accountId?: string }): Promise<Page<SocialPostView>>;
    get(id: string): Promise<SocialPostView | null>;
    /** 配信結果を記録する。**実際の配信は Plugin が行う。** */
    markPublished(id: string): Promise<SocialPostView>;
    markFailed(id: string, reason: string): Promise<SocialPostView>;
  };

  /**
   * ユーザー（05_API設計.md §22）。
   *
   * **読み取りだけ。** Plugin がユーザーを作れると、Plugin の導入が
   * そのまま管理者の追加になりうる。
   * 「誰がやったか」を表示するために要る、という用途に限る。
   */
  readonly users: {
    list(options?: ListOptions): Promise<Page<UserView>>;
    get(id: string): Promise<UserView | null>;
  };
}

/**
 * Plugin から見えるユーザー。
 *
 * **`passwordHash` を型として持たせない。** 存在しなければ、うっかり足すこともできない。
 * メールアドレスも出さない。表示に要らず、出せば漏洩の面が増える。
 */
export interface UserView {
  readonly id: string;
  readonly loginId: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
}

/** Plugin が宣言していない Permission の操作を試みた。 */
export class PluginPermissionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly permission: string,
  ) {
    super('Plugin が宣言していない権限の操作');
    this.name = 'PluginPermissionError';
  }
}
