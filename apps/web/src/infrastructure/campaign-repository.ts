import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import { dateOnly } from '../domain/analytics/day';
import type { Campaign, CampaignStatus } from '../domain/campaign/campaign';
import type {
  CampaignLinks,
  CampaignListQuery,
  CampaignPage,
  CampaignRepository,
  CampaignUpdate,
  NewCampaign,
} from '../domain/campaign/campaign-repository';

/**
 * キャンペーンの保存（017-campaigns）。
 *
 * `site-repository.ts` と同じ形にそろえている。
 * **同じ形のものを違う形で作らない。**
 */

interface CampaignRow {
  id: string;
  name: string;
  description: string;
  status: string;
  starts_on: Date | string;
  ends_on: Date | string | null;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

/**
 * `date` 型を `YYYY-MM-DD` に正規化する。
 *
 * ドライバの設定によって `Date` で返ることも文字列で返ることもある。
 * **`toISOString()` を使わない**（node-postgres は `date` をローカルの 0 時として `Date` にする）。
 * 同じ実装を 2 つ持たず、年を 4 桁にそろえる `dateOnly` を使う（046-input-500-nul-and-ranges 設計 §6.4 の N4）。
 */
const toDateOnly = dateOnly;

function toCampaign(
  row: CampaignRow,
  siteIds: readonly string[],
  socialPostIds: readonly string[],
): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as CampaignStatus,
    startsOn: toDateOnly(row.starts_on),
    endsOn: row.ends_on === null ? null : toDateOnly(row.ends_on),
    siteIds,
    socialPostIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

const COLUMNS = [
  'id',
  'name',
  'description',
  'status',
  'starts_on',
  'ends_on',
  'created_at',
  'updated_at',
  'created_by',
] as const;

function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 対象サイトをまとめて引く。1件ずつ引くと件数分の往復になる。 */
async function siteIdsOf(
  connection: Connection,
  campaignIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (campaignIds.length === 0) {
    return result;
  }

  const rows = await connection.db
    .selectFrom('campaign_sites')
    .select(['campaign_id', 'site_id'])
    .where('campaign_id', 'in', [...campaignIds])
    .orderBy('site_id')
    .execute();

  for (const row of rows) {
    const current = result.get(row.campaign_id) ?? [];
    current.push(row.site_id);
    result.set(row.campaign_id, current);
  }
  return result;
}

/** 紐づくSNS投稿をまとめて引く。`siteIdsOf` と同じ形。 */
async function socialPostIdsOf(
  connection: Connection,
  campaignIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (campaignIds.length === 0) {
    return result;
  }

  const rows = await connection.db
    .selectFrom('campaign_social_posts')
    .select(['campaign_id', 'social_post_id'])
    .where('campaign_id', 'in', [...campaignIds])
    .orderBy('social_post_id')
    .execute();

  for (const row of rows) {
    const current = result.get(row.campaign_id) ?? [];
    current.push(row.social_post_id);
    result.set(row.campaign_id, current);
  }
  return result;
}

/** 対象サイトを丸ごと置き換える。差分では「消す」を表現できない。 */
async function replaceSites(
  connection: Connection,
  campaignId: string,
  siteIds: readonly string[],
): Promise<void> {
  await connection.db.deleteFrom('campaign_sites').where('campaign_id', '=', campaignId).execute();

  const unique = [...new Set(siteIds)];
  if (unique.length === 0) {
    return;
  }

  await connection.db
    .insertInto('campaign_sites')
    .values(unique.map((siteId) => ({ campaign_id: campaignId, site_id: siteId })))
    .execute();
}

/** 紐づくSNS投稿を丸ごと置き換える。`replaceSites` と同じ形。 */
async function replaceSocialPosts(
  connection: Connection,
  campaignId: string,
  socialPostIds: readonly string[],
): Promise<void> {
  await connection.db
    .deleteFrom('campaign_social_posts')
    .where('campaign_id', '=', campaignId)
    .execute();

  const unique = [...new Set(socialPostIds)];
  if (unique.length === 0) {
    return;
  }

  await connection.db
    .insertInto('campaign_social_posts')
    .values(unique.map((postId) => ({ campaign_id: campaignId, social_post_id: postId })))
    .execute();
}

/**
 * 一覧と件数で使う共通の条件。
 *
 * 片方だけ直すと「1件も出ないのに total が 100」のような食い違いが起きる。
 */
function listConditions(
  eb: ExpressionBuilder<Schema, 'campaigns'>,
  query: CampaignListQuery,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [];

  if (query.statuses.length > 0) {
    conditions.push(eb('status', 'in', [...query.statuses]));
  }

  const keyword = query.keyword?.trim() ?? '';
  if (keyword !== '') {
    const pattern = `%${escapeLikePattern(keyword)}%`;
    conditions.push(
      sql<SqlBool>`(name ILIKE ${pattern} ESCAPE '\\' OR description ILIKE ${pattern} ESCAPE '\\')`,
    );
  }

  if (query.activeOn !== null) {
    // 終わりが無いものは「まだ続いている」として含める。
    conditions.push(
      sql<SqlBool>`(starts_on <= ${query.activeOn}::date AND (ends_on IS NULL OR ends_on >= ${query.activeOn}::date))`,
    );
  }

  if (query.siteId !== null && UUID_PATTERN.test(query.siteId)) {
    conditions.push(
      sql<SqlBool>`EXISTS (SELECT 1 FROM campaign_sites cs WHERE cs.campaign_id = campaigns.id AND cs.site_id = ${query.siteId})`,
    );
  }

  return conditions;
}

export const campaignRepository: CampaignRepository = {
  async list(connection: Connection, query: CampaignListQuery): Promise<CampaignPage> {
    let rowsQuery = connection.db
      .selectFrom('campaigns')
      .select(COLUMNS)
      .where((eb) => eb.and(listConditions(eb, query)));

    const countQuery = connection.db
      .selectFrom('campaigns')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where((eb) => eb.and(listConditions(eb, query)));

    for (const order of query.sort) {
      rowsQuery = rowsQuery.orderBy(order.field as 'created_at', order.direction);
    }
    // 並び順が同値のとき順序が揺れないよう、最後に id を足す。
    rowsQuery = rowsQuery.orderBy('id', 'asc');

    const offset = (query.page - 1) * query.perPage;
    const rows = await rowsQuery.limit(query.perPage).offset(offset).execute();
    const counted = await countQuery.executeTakeFirstOrThrow();

    const campaignIds = rows.map((row) => row.id);
    const sites = await siteIdsOf(connection, campaignIds);
    const posts = await socialPostIdsOf(connection, campaignIds);

    return {
      items: rows.map((row) =>
        toCampaign(row as CampaignRow, sites.get(row.id) ?? [], posts.get(row.id) ?? []),
      ),
      total: Number(counted.count),
    };
  },

  async findById(connection: Connection, id: string): Promise<Campaign | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const row = await connection.db
      .selectFrom('campaigns')
      .select(COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    const sites = await siteIdsOf(connection, [id]);
    const posts = await socialPostIdsOf(connection, [id]);
    return toCampaign(row as CampaignRow, sites.get(id) ?? [], posts.get(id) ?? []);
  },

  async insert(connection: Connection, campaign: NewCampaign): Promise<Campaign> {
    const row = await connection.db
      .insertInto('campaigns')
      .values({
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        starts_on: campaign.startsOn,
        ends_on: campaign.endsOn,
        created_by: campaign.createdBy,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();

    await replaceSites(connection, campaign.id, campaign.siteIds);
    await replaceSocialPosts(connection, campaign.id, campaign.socialPostIds);

    return toCampaign(
      row as CampaignRow,
      [...new Set(campaign.siteIds)].sort(),
      [...new Set(campaign.socialPostIds)].sort(),
    );
  },

  async update(
    connection: Connection,
    id: string,
    patch: CampaignUpdate,
  ): Promise<Campaign | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) values['name'] = patch.name;
    if (patch.description !== undefined) values['description'] = patch.description;
    if (patch.status !== undefined) values['status'] = patch.status;
    if (patch.startsOn !== undefined) values['starts_on'] = patch.startsOn;
    if (patch.endsOn !== undefined) values['ends_on'] = patch.endsOn;

    const row = await connection.db
      .updateTable('campaigns')
      .set(values as never)
      .where('id', '=', id)
      .returning(COLUMNS)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    if (patch.siteIds !== undefined) {
      await replaceSites(connection, id, patch.siteIds);
    }
    if (patch.socialPostIds !== undefined) {
      await replaceSocialPosts(connection, id, patch.socialPostIds);
    }

    const sites = await siteIdsOf(connection, [id]);
    const posts = await socialPostIdsOf(connection, [id]);
    return toCampaign(row as CampaignRow, sites.get(id) ?? [], posts.get(id) ?? []);
  },

  async delete(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    // campaign_sites / campaign_social_posts は ON DELETE CASCADE で消える。
    const result = await connection.db
      .deleteFrom('campaigns')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  },

  async lockExistingLinks(connection: Connection, links: CampaignLinks): Promise<CampaignLinks> {
    // FOR KEY SHARE：その行の DELETE（と主キーの更新）だけを、このトランザクションが終わるまで待たせる。
    // 外部キーの検査が内部で取るロックと同じ強さで、名前などの通常の更新は妨げない（045 設計 §6.4）。
    // 先に始まっていた削除があれば、その終わりを待ち、確定していれば行は見つからない（READ COMMITTED）。
    const siteIds =
      links.siteIds.length === 0
        ? []
        : (
            await connection.db
              .selectFrom('sites')
              .select('id')
              .where('id', 'in', [...links.siteIds])
              .orderBy('id')
              .forKeyShare()
              .execute()
          ).map((row) => row.id);

    const socialPostIds =
      links.socialPostIds.length === 0
        ? []
        : (
            await connection.db
              .selectFrom('social_posts')
              .select('id')
              .where('id', 'in', [...links.socialPostIds])
              .orderBy('id')
              .forKeyShare()
              .execute()
          ).map((row) => row.id);

    return { siteIds, socialPostIds };
  },

  async lockForUpdate(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    // FOR NO KEY UPDATE：UPDATE campaigns（主キーを変えない）が取るのと同じロック。
    // 紐づけ先を押さえる前に取ることで、同じキャンペーンへの後の更新は紐づけ先を押さえずに
    // ここで待つ（045 設計 §6.4）。campaign_sites などの外部キーの検査（KEY SHARE）とは衝突しない。
    const row = await connection.db
      .selectFrom('campaigns')
      .select('id')
      .where('id', '=', id)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return row !== undefined;
  },
};
