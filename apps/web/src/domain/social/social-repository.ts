import type { Connection } from '../../database/provider';
import type { PublishVerdict, SkipVerdict } from './publishing';
import type {
  AccountStatus,
  DeliveryMode,
  PostMedia,
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
  readonly deliveryMode?: DeliveryMode | undefined;
  readonly media?: readonly PostMedia[] | undefined;
  readonly link?: string | null | undefined;
  readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
  readonly externalRef?: string | null | undefined;
  /** 登録した API Token。セッションからの登録は null。 */
  readonly createdByTokenId?: string | null | undefined;
}

export interface SocialPostUpdate {
  readonly body?: string | undefined;
  readonly scheduledAt?: Date | null | undefined;
  readonly status?: PostStatus | undefined;
  readonly publishedAt?: Date | null | undefined;
  readonly failedAt?: Date | null | undefined;
  readonly failureReason?: string | null | undefined;
  readonly deliveryMode?: DeliveryMode | undefined;
  readonly media?: readonly PostMedia[] | undefined;
  readonly link?: string | null | undefined;
  readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
  readonly externalId?: string | null | undefined;
  readonly externalUrl?: string | null | undefined;
  /**
   * 再試行・後ろへ送った予定（035-social-publishing 設計 §5.1.1）。
   *
   * 予約し直したときに引きずらせないため、UseCase から NULL へ戻せるようにする。
   */
  readonly nextAttemptAt?: Date | null | undefined;
  readonly skipCount?: number | undefined;
  readonly skipReason?: string | null | undefined;
}

export interface SocialPostListQuery {
  readonly page: number;
  readonly perPage: number;
  readonly socialAccountId: string | null;
  /**
   * 絞り込む状態。空なら全部。
   *
   * **単一指定と配列指定の2通りを残さない。** `CampaignListQuery.statuses` と
   * 同じ形にそろえ、UseCase 側で「単一 → 配列」に畳む。
   */
  readonly statuses: readonly PostStatus[];
  /**
   * 並び順。
   *
   * `delivered` は配信結果が確定した順（`published_at` / `failed_at`）。
   * 履歴画面が使う。作成順とは一致しない。
   */
  readonly orderBy: 'created' | 'delivered';
}

export interface SocialPostPage {
  readonly items: readonly SocialPost[];
  readonly total: number;
}

/**
 * 中断として `failed` に落とした行（035-social-publishing 設計 §6.5.4）。
 *
 * イベント `social.post.failed` の payload に要るぶんだけ返す。
 */
export interface InterruptedPost {
  readonly id: string;
  readonly socialAccountId: string;
}

/**
 * 取り出しの読み進め位置（035-social-publishing 設計 §6.5.3）。
 *
 * **`(scheduled_at, id)` のキーセット。** 直前に見た行の値をそのまま持つ。
 */
export interface DueCursor {
  readonly scheduledAt: Date;
  readonly id: string;
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
  /**
   * 資格情報を、保存されている版が expectedVersion のときだけ置き換える（039 設計 §6.1）。
   * 置き換えたら true。版が違う（その間に人が変えた・消した）、アカウントが無い、id の形が不正なら false で、何も変えない。
   *
   * **読みと書きを 1 つの操作で行う。** 読み直してから書く 2 段にすると、その間の人の変更を上書きする。
   */
  replaceCredentialIfUnchanged(
    connection: Connection,
    id: string,
    expectedVersion: string,
    encryptedCredential: string,
  ): Promise<boolean>;

  listPosts(connection: Connection, query: SocialPostListQuery): Promise<SocialPostPage>;
  findPostById(connection: Connection, id: string): Promise<SocialPost | null>;
  /**
   * IDでまとめて引く。
   *
   * キャンペーンに紐づく投稿のように「IDは判っている」場面で使う。
   * 1件ずつ引くと件数分の往復になる。
   */
  findPostsByIds(connection: Connection, ids: readonly string[]): Promise<readonly SocialPost[]>;
  insertPost(connection: Connection, post: NewSocialPost): Promise<SocialPost>;
  /**
   * 冪等に登録する（035-social-publishing 設計 §6.1.3）。
   *
   * `createdByTokenId` と `externalRef` の組が既にあれば**新しく作らず既存を返す**。
   * 同じ要求が同時に 2 本来ても行は 1 つで、`created` だけが分かれる。
   * どちらも持たない投稿は、ただの `insertPost` と同じ（`created` は常に true）。
   */
  insertPostIdempotent(
    connection: Connection,
    post: NewSocialPost,
  ): Promise<{ readonly post: SocialPost; readonly created: boolean }>;
  /** 冪等キーで引く。**Token をまたいで引けない**（名前空間は Token ごと）。 */
  findByExternalRef(
    connection: Connection,
    createdByTokenId: string,
    externalRef: string,
  ): Promise<SocialPost | null>;
  updatePost(
    connection: Connection,
    id: string,
    patch: SocialPostUpdate,
  ): Promise<SocialPost | null>;
  deletePost(connection: Connection, id: string): Promise<boolean>;

  /**
   * 手動投稿待ちを引く（035-social-publishing 設計 §6.6）。
   *
   * **状態を増やさずに導出する**（§5.8）：`status = 'scheduled'` かつ
   * `delivery_mode = 'manual'` かつ予約日時が来ているもの。`scheduled_at` の古い順。
   *
   * `total` は `limit` で切る前の全件数（ダッシュボードの件数に使う。§7.6）。
   */
  listManualPending(connection: Connection, limit: number): Promise<SocialPostPage>;

  // -------------------------------------------------------------------------
  // 配信ジョブ（035-social-publishing 設計 §6.5.3 / §6.5.4 / §6.5.6）
  // -------------------------------------------------------------------------

  /**
   * 前回の実行が途中で死んだ行を `failed` に落とす（§6.5.4）。
   *
   * **ジョブの最初に呼ぶ。** 着手印が残っている行は、正常に終われば必ず NULL に
   * 戻るはずのものなので、残っていれば前回が `publish()` の途中で死んでいる。
   * **再送しない**（二重投稿より未投稿のほうがまし）。
   */
  failInterrupted(connection: Connection, reason: string): Promise<readonly InterruptedPost[]>;

  /**
   * 期限の来た自動配信の投稿を `scheduled_at` の古い順に**1 ページぶん**引く（§6.5.3）。
   *
   * `after` を渡すと、その位置より後ろだけを読む（**キーセット**）。
   * **`OFFSET` は使えない。** 走査中に、飛ばした行は `next_attempt_at` が付いて条件から外れ、
   * 着手した行は `publish_started_at` が付いて条件から外れる。`OFFSET` だと
   * 外れた行の数だけ後ろの行を読み飛ばす（見ていない行が静かに残る）。
   *
   * 並びは `ORDER BY scheduled_at ASC, id ASC` で一意に決まるので、キーセットで漏れなく読める。
   */
  listDue(
    connection: Connection,
    limit: number,
    after?: DueCursor | null,
  ): Promise<readonly SocialPost[]>;

  /**
   * 配信できない予約を後ろへ送る（§6.5.2.1）。
   *
   * **着手印は書かない。** `attempt_count` も触らない（あれは `publish()` を呼んだ回数で、
   * 飛ばした行では 0 のままという約束がある）。`deferred` なら `next_attempt_at` を置いて
   * 次に見る時刻まで候補から外し、`failed` なら順番待ちから外す。
   *
   * **更新できた行数を返す。** 0 ならその間に人が触っているので、次の周期で判定し直す。
   */
  deferSkipped(connection: Connection, id: string, verdict: SkipVerdict): Promise<number>;

  /**
   * 着手印を立てる（§6.5.4）。
   *
   * **自分のトランザクションを開いてコミットしてから返す。** `publish()` と
   * 同じトランザクションに入れると、プロセスが死んだときに印がロールバックされ、
   * 次の実行が同じ投稿をもう一度送る。
   *
   * 誰かが先に触っていれば `null`（更新 0 行）。
   */
  claimForPublish(connection: Connection, id: string): Promise<SocialPost | null>;

  /**
   * 配信の結果を書き戻す（§6.5.6）。
   *
   * **更新できた行数を返す。** 0 なら着手印が外から消されており、
   * 結果を記録できていない（`unrecorded`）。イベントを出してはならない。
   */
  recordOutcome(connection: Connection, id: string, verdict: PublishVerdict): Promise<number>;
}
