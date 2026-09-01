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
}

export interface SiteInput {
  readonly name: string;
  readonly url: string;
  readonly description?: string;
  readonly status?: string;
}

export interface PluginDataApi {
  readonly sites: {
    list(options?: ListOptions): Promise<Page<SiteView>>;
    get(id: string): Promise<SiteView | null>;
    create(input: SiteInput): Promise<SiteView>;
    update(id: string, input: Partial<SiteInput>): Promise<SiteView>;
    delete(id: string): Promise<void>;
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
