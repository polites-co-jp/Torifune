import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import type { Campaign, CampaignStatus } from '../domain/campaign/campaign';
import type {
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
 *
 * **`toISOString()` を使わない。** node-postgres は `date` を
 * **ローカルタイムゾーンの0時**として `Date` にする。`toISOString()` は
 * それを UTC へ直すので、UTC より東のタイムゾーンでは**1日前になる**
 * （JST で `2026-04-01` を保存して `2026-03-31` が返る）。
 * ローカルの年月日をそのまま取り出す。
 */
function toDateOnly(value: Date | string): string {
  if (typeof value === 'string') {
    return value.slice(0, 10);
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toCampaign(row: CampaignRow, siteIds: readonly string[]): Campaign {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as CampaignStatus,
    startsOn: toDateOnly(row.starts_on),
    endsOn: row.ends_on === null ? null : toDateOnly(row.ends_on),
    siteIds,
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

    const sites = await siteIdsOf(
      connection,
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) => toCampaign(row as CampaignRow, sites.get(row.id) ?? [])),
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
    return toCampaign(row as CampaignRow, sites.get(id) ?? []);
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

    return toCampaign(row as CampaignRow, [...new Set(campaign.siteIds)].sort());
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

    const sites = await siteIdsOf(connection, [id]);
    return toCampaign(row as CampaignRow, sites.get(id) ?? []);
  },

  async delete(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    // campaign_sites は ON DELETE CASCADE で消える。
    const result = await connection.db
      .deleteFrom('campaigns')
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  },
};
