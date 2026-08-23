import type { Connection } from '../../database/provider';
import type {
  AccountStatus,
  PostStatus,
  SocialAccount,
  SocialAccountWithCredential,
  SocialPost,
} from './social';

export interface NewSocialAccount {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  /** **暗号化済みの文字列**。平文を渡さない。 */
  readonly encryptedCredential: string | null;
  readonly status: AccountStatus;
}

export interface SocialAccountUpdate {
  readonly displayName?: string | undefined;
  readonly handle?: string | undefined;
  readonly status?: AccountStatus | undefined;
  /**
   * `undefined` なら既存の資格情報を変えない。
   * `null` を明示すると消す。**「指定しない」と「消す」を区別する。**
   */
  readonly encryptedCredential?: string | null | undefined;
}

export interface SocialAccountListQuery {
  readonly page: number;
  readonly perPage: number;
  readonly provider: string | null;
}

export interface SocialAccountPage {
  readonly items: readonly SocialAccount[];
  readonly total: number;
}

export interface NewSocialPost {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: Date | null;
  readonly status: PostStatus;
}

export interface SocialPostUpdate {
  readonly body?: string | undefined;
  readonly scheduledAt?: Date | null | undefined;
  readonly status?: PostStatus | undefined;
  readonly publishedAt?: Date | null | undefined;
  readonly failureReason?: string | null | undefined;
}

export interface SocialPostListQuery {
  readonly page: number;
  readonly perPage: number;
  readonly socialAccountId: string | null;
  readonly status: PostStatus | null;
}

export interface SocialPostPage {
  readonly items: readonly SocialPost[];
  readonly total: number;
}

export interface SocialRepository {
  listAccounts(connection: Connection, query: SocialAccountListQuery): Promise<SocialAccountPage>;
  findAccountById(connection: Connection, id: string): Promise<SocialAccount | null>;
  /**
   * 資格情報つきで取得する。
   *
   * **呼び出し箇所を限る。** 平文が必要な処理だけが使う。
   */
  findAccountWithCredential(
    connection: Connection,
    id: string,
  ): Promise<SocialAccountWithCredential | null>;
  insertAccount(connection: Connection, account: NewSocialAccount): Promise<SocialAccount>;
  updateAccount(
    connection: Connection,
    id: string,
    patch: SocialAccountUpdate,
  ): Promise<SocialAccount | null>;
  deleteAccount(connection: Connection, id: string): Promise<boolean>;

  listPosts(connection: Connection, query: SocialPostListQuery): Promise<SocialPostPage>;
  findPostById(connection: Connection, id: string): Promise<SocialPost | null>;
  insertPost(connection: Connection, post: NewSocialPost): Promise<SocialPost>;
  updatePost(
    connection: Connection,
    id: string,
    patch: SocialPostUpdate,
  ): Promise<SocialPost | null>;
  deletePost(connection: Connection, id: string): Promise<boolean>;
}
