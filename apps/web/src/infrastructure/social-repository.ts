import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import { decryptSecret } from './crypto/cipher';
import type {
  AccountStatus,
  DeliveryMode,
  PostStatus,
  SocialAccount,
  SocialAccountWithCredential,
  SocialPost,
} from '../domain/social/social';
import type { PublishVerdict } from '../domain/social/publishing';
import type {
  InterruptedPost,
  NewSocialAccount,
  NewSocialPost,
  SocialAccountListQuery,
  SocialAccountPage,
  SocialAccountUpdate,
  SocialPostListQuery,
  SocialPostPage,
  SocialPostUpdate,
  SocialRepository,
} from '../domain/social/social-repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface AccountRow {
  id: string;
  provider: string;
  display_name: string;
  handle: string;
  credential: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * 行を Entity へ変換する。
 *
 * **`credential` の平文をここへ載せない。** 設定済みかどうかだけを持たせる。
 * 平文が要る処理は `findAccountWithCredential` を使う。
 */
function toAccount(row: AccountRow): SocialAccount {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    handle: row.handle,
    credentialConfigured: row.credential !== null && row.credential !== '',
    status: row.status as AccountStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ACCOUNT_COLUMNS = [
  'id',
  'provider',
  'display_name',
  'handle',
  'credential',
  'status',
  'created_at',
  'updated_at',
] as const;

interface PostRow {
  id: string;
  social_account_id: string;
  body: string;
  scheduled_at: Date | null;
  status: string;
  published_at: Date | null;
  failed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
  delivery_mode: string;
  media: readonly { url: string; alt: string | null }[];
  link: string | null;
  provider_options: Record<string, unknown>;
  external_ref: string | null;
  created_by_token_id: string | null;
  external_id: string | null;
  external_url: string | null;
  publish_started_at: Date | null;
  attempt_count: number;
  next_attempt_at: Date | null;
}

function toPost(row: PostRow): SocialPost {
  return {
    id: row.id,
    socialAccountId: row.social_account_id,
    body: row.body,
    scheduledAt: row.scheduled_at,
    status: row.status as PostStatus,
    publishedAt: row.published_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveryMode: row.delivery_mode as DeliveryMode,
    media: row.media.map((item) => ({ url: item.url, alt: item.alt ?? null })),
    link: row.link,
    providerOptions: row.provider_options,
    externalRef: row.external_ref,
    createdByTokenId: row.created_by_token_id,
    externalId: row.external_id,
    externalUrl: row.external_url,
    publishStartedAt: row.publish_started_at,
    // integer の列だが、ドライバの設定によっては文字列で返りうる。
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: row.next_attempt_at,
  };
}

const POST_COLUMNS = [
  'id',
  'social_account_id',
  'body',
  'scheduled_at',
  'status',
  'published_at',
  'failed_at',
  'failure_reason',
  'created_at',
  'updated_at',
  'delivery_mode',
  'media',
  'link',
  'provider_options',
  'external_ref',
  'created_by_token_id',
  'external_id',
  'external_url',
  'publish_started_at',
  'attempt_count',
  'next_attempt_at',
] as const;

/**
 * 配信結果が確定した時刻。
 *
 * `failed_at` はこの列を足す前の行では空。**遡って埋めない**（無かった記録を
 * 後から作らない）ので、読み出し側で `updated_at` まで落とす。
 * `018_campaign_social_posts.sql` の部分索引と同じ式にそろえてある。
 */
const DELIVERED_AT = sql<Date>`COALESCE(published_at, failed_at, updated_at)`;

/** 冪等な登録の試行回数。同時要求の相手がコミットするのを待つぶん。 */
const IDEMPOTENT_INSERT_ATTEMPTS = 3;

function postInsertValues(post: NewSocialPost): Record<string, unknown> {
  return {
    id: post.id,
    social_account_id: post.socialAccountId,
    body: post.body,
    scheduled_at: post.scheduledAt,
    status: post.status,
    // 省略された項目は DB の既定値（'auto' / [] / {}）に任せる。
    ...(post.deliveryMode === undefined ? {} : { delivery_mode: post.deliveryMode }),
    ...(post.media === undefined ? {} : { media: JSON.stringify(post.media) }),
    ...(post.link === undefined ? {} : { link: post.link }),
    ...(post.providerOptions === undefined
      ? {}
      : { provider_options: JSON.stringify(post.providerOptions) }),
    ...(post.externalRef === undefined ? {} : { external_ref: post.externalRef }),
    ...(post.createdByTokenId === undefined ? {} : { created_by_token_id: post.createdByTokenId }),
  };
}

export const socialRepository: SocialRepository = {
  async listAccounts(
    connection: Connection,
    query: SocialAccountListQuery,
  ): Promise<SocialAccountPage> {
    const conditions = (eb: ExpressionBuilder<Schema, 'social_accounts'>): Expression<SqlBool>[] =>
      query.provider === null ? [] : [eb('provider', '=', query.provider)];

    const rows = await connection.db
      .selectFrom('social_accounts')
      .select(ACCOUNT_COLUMNS)
      .where((eb) => eb.and(conditions(eb)))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage)
      .execute();

    const counted = await connection.db
      .selectFrom('social_accounts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where((eb) => eb.and(conditions(eb)))
      .executeTakeFirstOrThrow();

    return {
      items: rows.map((row) => toAccount(row as AccountRow)),
      total: Number(counted.count),
    };
  },

  async findAccountById(connection: Connection, id: string): Promise<SocialAccount | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await connection.db
      .selectFrom('social_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toAccount(row as AccountRow);
  },

  async findAccountWithCredential(
    connection: Connection,
    id: string,
  ): Promise<SocialAccountWithCredential | null> {
    if (!UUID_PATTERN.test(id)) return null;

    const row = await connection.db
      .selectFrom('social_accounts')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();

    if (row === undefined) return null;

    const typed = row as AccountRow;
    const account = toAccount(typed);

    if (typed.credential === null || typed.credential === '') {
      return { ...account, credential: null };
    }

    const decrypted = decryptSecret(typed.credential);
    // 復号できない資格情報は「無い」として扱う。
    // 例外にすると、鍵を入れ替えた直後に一覧すら開けなくなる。
    return { ...account, credential: decrypted.ok ? decrypted.secret : null };
  },

  async insertAccount(connection: Connection, account: NewSocialAccount): Promise<SocialAccount> {
    const row = await connection.db
      .insertInto('social_accounts')
      .values({
        id: account.id,
        provider: account.provider,
        display_name: account.displayName,
        handle: account.handle,
        credential: account.encryptedCredential,
        status: account.status,
      })
      .returning(ACCOUNT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toAccount(row as AccountRow);
  },

  async updateAccount(
    connection: Connection,
    id: string,
    patch: SocialAccountUpdate,
  ): Promise<SocialAccount | null> {
    if (!UUID_PATTERN.test(id)) return null;

    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.displayName !== undefined) values['display_name'] = patch.displayName;
    if (patch.handle !== undefined) values['handle'] = patch.handle;
    if (patch.status !== undefined) values['status'] = patch.status;
    // undefined は「変えない」、null は「消す」。区別する。
    if (patch.encryptedCredential !== undefined) {
      values['credential'] = patch.encryptedCredential;
    }

    const row = await connection.db
      .updateTable('social_accounts')
      .set(values as never)
      .where('id', '=', id)
      .returning(ACCOUNT_COLUMNS)
      .executeTakeFirst();

    return row === undefined ? null : toAccount(row as AccountRow);
  },

  async deleteAccount(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    const result = await connection.db
      .deleteFrom('social_accounts')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  },

  async listPosts(connection: Connection, query: SocialPostListQuery): Promise<SocialPostPage> {
    const conditions = (eb: ExpressionBuilder<Schema, 'social_posts'>): Expression<SqlBool>[] => {
      const list: Expression<SqlBool>[] = [];
      if (query.socialAccountId !== null && UUID_PATTERN.test(query.socialAccountId)) {
        list.push(eb('social_account_id', '=', query.socialAccountId));
      }
      if (query.statuses.length > 0) {
        list.push(eb('status', 'in', [...query.statuses]));
      }
      return list;
    };

    let rowsQuery = connection.db
      .selectFrom('social_posts')
      .select(POST_COLUMNS)
      .where((eb) => eb.and(conditions(eb)));

    rowsQuery =
      query.orderBy === 'delivered'
        ? rowsQuery.orderBy(DELIVERED_AT, 'desc')
        : rowsQuery.orderBy('created_at', 'desc');

    const rows = await rowsQuery
      // 並び順が同値のとき順序が揺れないよう、最後に id を足す。
      .orderBy('id', 'asc')
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage)
      .execute();

    const counted = await connection.db
      .selectFrom('social_posts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where((eb) => eb.and(conditions(eb)))
      .executeTakeFirstOrThrow();

    return { items: rows.map((row) => toPost(row as PostRow)), total: Number(counted.count) };
  },

  async findPostById(connection: Connection, id: string): Promise<SocialPost | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await connection.db
      .selectFrom('social_posts')
      .select(POST_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toPost(row as PostRow);
  },

  async findPostsByIds(
    connection: Connection,
    ids: readonly string[],
  ): Promise<readonly SocialPost[]> {
    // 形の壊れたIDは問い合わせる前に落とす。uuid 列との比較で例外になる。
    const valid = [...new Set(ids)].filter((id) => UUID_PATTERN.test(id));
    if (valid.length === 0) {
      return [];
    }

    const rows = await connection.db
      .selectFrom('social_posts')
      .select(POST_COLUMNS)
      .where('id', 'in', valid)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .execute();

    return rows.map((row) => toPost(row as PostRow));
  },

  async insertPost(connection: Connection, post: NewSocialPost): Promise<SocialPost> {
    const row = await connection.db
      .insertInto('social_posts')
      .values(postInsertValues(post) as never)
      .returning(POST_COLUMNS)
      .executeTakeFirstOrThrow();
    return toPost(row as PostRow);
  },

  async insertPostIdempotent(
    connection: Connection,
    post: NewSocialPost,
  ): Promise<{ post: SocialPost; created: boolean }> {
    const tokenId = post.createdByTokenId ?? null;
    const externalRef = post.externalRef ?? null;

    // 冪等キーが揃っていない投稿は部分一意索引の対象外。ただの INSERT と同じ。
    if (tokenId === null || externalRef === null) {
      return { post: await socialRepository.insertPost(connection, post), created: true };
    }

    // 同時に来た要求の相手がまだコミットしていないと、INSERT が 0 行でも
    // 既存を引けないことがある。**数回だけ繰り返す**（無限には回さない）。
    for (let attempt = 0; attempt < IDEMPOTENT_INSERT_ATTEMPTS; attempt += 1) {
      const row = await connection.db
        .insertInto('social_posts')
        .values(postInsertValues(post) as never)
        .onConflict((oc) =>
          oc
            .columns(['created_by_token_id', 'external_ref'])
            // 部分一意索引（022_social_publishing.sql）の述語にそろえる。
            .where('created_by_token_id', 'is not', null)
            .where('external_ref', 'is not', null)
            .doNothing(),
        )
        .returning(POST_COLUMNS)
        .executeTakeFirst();

      if (row !== undefined) {
        return { post: toPost(row as PostRow), created: true };
      }

      const existing = await socialRepository.findByExternalRef(connection, tokenId, externalRef);
      if (existing !== null) {
        return { post: existing, created: false };
      }
    }

    throw new Error('冪等な登録が確定しなかった');
  },

  async findByExternalRef(
    connection: Connection,
    createdByTokenId: string,
    externalRef: string,
  ): Promise<SocialPost | null> {
    if (!UUID_PATTERN.test(createdByTokenId)) return null;

    const row = await connection.db
      .selectFrom('social_posts')
      .select(POST_COLUMNS)
      .where('created_by_token_id', '=', createdByTokenId)
      .where('external_ref', '=', externalRef)
      .executeTakeFirst();

    return row === undefined ? null : toPost(row as PostRow);
  },

  async updatePost(
    connection: Connection,
    id: string,
    patch: SocialPostUpdate,
  ): Promise<SocialPost | null> {
    if (!UUID_PATTERN.test(id)) return null;

    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.body !== undefined) values['body'] = patch.body;
    if (patch.scheduledAt !== undefined) values['scheduled_at'] = patch.scheduledAt;
    if (patch.status !== undefined) values['status'] = patch.status;
    if (patch.publishedAt !== undefined) values['published_at'] = patch.publishedAt;
    if (patch.failedAt !== undefined) values['failed_at'] = patch.failedAt;
    if (patch.failureReason !== undefined) values['failure_reason'] = patch.failureReason;
    if (patch.deliveryMode !== undefined) values['delivery_mode'] = patch.deliveryMode;
    if (patch.media !== undefined) values['media'] = JSON.stringify(patch.media);
    if (patch.link !== undefined) values['link'] = patch.link;
    if (patch.providerOptions !== undefined) {
      values['provider_options'] = JSON.stringify(patch.providerOptions);
    }
    if (patch.externalId !== undefined) values['external_id'] = patch.externalId;
    if (patch.externalUrl !== undefined) values['external_url'] = patch.externalUrl;

    const row = await connection.db
      .updateTable('social_posts')
      .set(values as never)
      .where('id', '=', id)
      .returning(POST_COLUMNS)
      .executeTakeFirst();

    return row === undefined ? null : toPost(row as PostRow);
  },

  async deletePost(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    const result = await connection.db
      .deleteFrom('social_posts')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  },

  async listManualPending(connection: Connection, limit: number): Promise<SocialPostPage> {
    // 既存の `(status, scheduled_at)` 索引に乗る条件（設計 §6.6）。
    const conditions = (eb: ExpressionBuilder<Schema, 'social_posts'>): Expression<SqlBool>[] => [
      eb('status', '=', 'scheduled'),
      // 自動配信はジョブが送る。人が押す列には並べない。
      eb('delivery_mode', '=', 'manual'),
      // 022 より前に作られた「予約日時の無い予約」は、これまでどおり誰も取り出さない。
      eb('scheduled_at', 'is not', null),
      eb('scheduled_at', '<=', sql<Date>`now()`),
    ];

    const rows = await connection.db
      .selectFrom('social_posts')
      .select(POST_COLUMNS)
      .where((eb) => eb.and(conditions(eb)))
      .orderBy('scheduled_at', 'asc')
      // 並び順が同値のとき順序が揺れないよう、最後に id を足す。
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    // **`total` は打ち切る前の全件数。** ダッシュボードは `limit: 1` でこれだけを取る（設計 §7.6）。
    const counted = await connection.db
      .selectFrom('social_posts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where((eb) => eb.and(conditions(eb)))
      .executeTakeFirstOrThrow();

    return { items: rows.map((row) => toPost(row as PostRow)), total: Number(counted.count) };
  },

  async failInterrupted(
    connection: Connection,
    reason: string,
  ): Promise<readonly InterruptedPost[]> {
    const rows = await connection.db
      .updateTable('social_posts')
      .set({
        status: 'failed',
        failed_at: sql<Date>`now()`,
        failure_reason: reason,
        // **必ず NULL へ戻す。** 「非 NULL ⇔ 進行中」が不変条件（設計 §5.8）。
        publish_started_at: null,
        updated_at: sql<Date>`now()`,
      } as never)
      .where('status', '=', 'scheduled')
      .where('delivery_mode', '=', 'auto')
      .where('publish_started_at', 'is not', null)
      .returning(['id', 'social_account_id'])
      .execute();

    return rows.map((row) => ({
      id: (row as { id: string }).id,
      socialAccountId: (row as { social_account_id: string }).social_account_id,
    }));
  },

  async listDue(connection: Connection, limit: number): Promise<readonly SocialPost[]> {
    const rows = await connection.db
      .selectFrom('social_posts')
      .select(POST_COLUMNS)
      .where('status', '=', 'scheduled')
      // 手動投稿はジョブが一切触らない（設計 §6.5.3）。
      .where('delivery_mode', '=', 'auto')
      .where('publish_started_at', 'is', null)
      // 022 より前に作られた「予約日時の無い予約」は、これまでどおり誰も取り出さない。
      .where('scheduled_at', 'is not', null)
      .where('scheduled_at', '<=', sql<Date>`now()`)
      .where((eb) =>
        eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', sql<Date>`now()`)]),
      )
      .orderBy('scheduled_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => toPost(row as PostRow));
  },

  async claimForPublish(connection: Connection, id: string): Promise<SocialPost | null> {
    if (!UUID_PATTERN.test(id)) return null;

    // **自分のトランザクションでコミットしてから返す**（設計 §6.5.4、実装プラン §7 の 5）。
    return connection.transaction(async (tx) => {
      const row = await tx.db
        .updateTable('social_posts')
        .set({
          publish_started_at: sql<Date>`now()`,
          attempt_count: sql<number>`attempt_count + 1`,
          next_attempt_at: null,
          updated_at: sql<Date>`now()`,
        } as never)
        .where('id', '=', id)
        .where('status', '=', 'scheduled')
        .where('publish_started_at', 'is', null)
        .returning(POST_COLUMNS)
        .executeTakeFirst();

      return row === undefined ? null : toPost(row as PostRow);
    });
  },

  async recordOutcome(
    connection: Connection,
    id: string,
    verdict: PublishVerdict,
  ): Promise<number> {
    if (!UUID_PATTERN.test(id)) return 0;

    const values: Record<string, unknown> = {
      updated_at: sql<Date>`now()`,
      // 成功・失敗・再試行のいずれでも着手印は外す（設計 §5.8）。
      publish_started_at: null,
    };

    if (verdict.kind === 'published') {
      values['status'] = 'published';
      values['published_at'] = sql<Date>`now()`;
      values['external_id'] = verdict.externalId;
      values['external_url'] = verdict.externalUrl;
      values['failure_reason'] = null;
      values['next_attempt_at'] = null;
    } else if (verdict.kind === 'retry') {
      // **`status` は `scheduled` のまま。** 「再試行待ち」は状態を増やさずに表す（設計 §5.8）。
      values['next_attempt_at'] = verdict.nextAttemptAt;
      values['failure_reason'] = verdict.reason;
    } else {
      values['status'] = 'failed';
      values['failed_at'] = sql<Date>`now()`;
      values['failure_reason'] = verdict.reason;
      values['next_attempt_at'] = null;
    }

    const result = await connection.transaction(async (tx) =>
      tx.db
        .updateTable('social_posts')
        .set(values as never)
        .where('id', '=', id)
        // **着手印が立っている間だけ書き戻せる。** 外から消されていたら記録しない。
        .where('status', '=', 'scheduled')
        .where('publish_started_at', 'is not', null)
        .executeTakeFirst(),
    );

    return Number(result.numUpdatedRows);
  },
};
