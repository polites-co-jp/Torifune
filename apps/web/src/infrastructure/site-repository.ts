import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import type { Site, SiteStatus } from '../domain/site/site';
import type {
  NewSite,
  SiteListQuery,
  SitePage,
  SiteRepository,
  SiteUpdate,
} from '../domain/site/site-repository';

interface SiteRow {
  id: string;
  name: string;
  url: string;
  description: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description,
    status: row.status as SiteStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

const COLUMNS = [
  'id',
  'name',
  'url',
  'description',
  'status',
  'created_at',
  'updated_at',
  'created_by',
] as const;

/**
 * `LIKE` のワイルドカードを打ち消す。
 *
 * 利用者が入力した `%` や `_` をそのまま渡すと、意図しない広さで一致する。
 * 「`%` を含む名前を探す」ができなくなるほうが問題。
 */
function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** UUID の形をしているか。不正な値で 500 にせず、見つからない扱いにする。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 一覧と件数で使う共通の条件。
 *
 * 片方だけ直すと「1件も出ないのに total が 100」のような食い違いが起きる。
 */
function listConditions(
  eb: ExpressionBuilder<Schema, 'sites'>,
  query: SiteListQuery,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [];

  if (query.statuses.length > 0) {
    conditions.push(eb('status', 'in', [...query.statuses]));
  }

  const keyword = query.keyword?.trim() ?? '';
  if (keyword !== '') {
    const pattern = `%${escapeLikePattern(keyword)}%`;
    conditions.push(
      sql<SqlBool>`(name ILIKE ${pattern} ESCAPE '\\' OR url ILIKE ${pattern} ESCAPE '\\')`,
    );
  }

  return conditions;
}

export const siteRepository: SiteRepository = {
  async list(connection: Connection, query: SiteListQuery): Promise<SitePage> {
    let rowsQuery = connection.db
      .selectFrom('sites')
      .select(COLUMNS)
      .where((eb) => eb.and(listConditions(eb, query)));

    const countQuery = connection.db
      .selectFrom('sites')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where((eb) => eb.and(listConditions(eb, query)));

    for (const order of query.sort) {
      rowsQuery = rowsQuery.orderBy(order.field as 'created_at', order.direction);
    }
    // 並び順が同値のとき順序が揺れないよう、最後に id を足す。
    // 揺れるとページ送りで同じ行が2回出たり、抜けたりする。
    rowsQuery = rowsQuery.orderBy('id', 'asc');

    const offset = (query.page - 1) * query.perPage;
    const rows = await rowsQuery.limit(query.perPage).offset(offset).execute();
    const counted = await countQuery.executeTakeFirstOrThrow();

    return {
      items: rows.map((row) => toSite(row as SiteRow)),
      total: Number(counted.count),
    };
  },

  async findById(connection: Connection, id: string): Promise<Site | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const row = await connection.db
      .selectFrom('sites')
      .select(COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toSite(row as SiteRow);
  },

  async insert(connection: Connection, site: NewSite): Promise<Site> {
    const row = await connection.db
      .insertInto('sites')
      .values({
        id: site.id,
        name: site.name,
        url: site.url,
        description: site.description,
        status: site.status,
        created_by: site.createdBy,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toSite(row as SiteRow);
  },

  async update(connection: Connection, id: string, patch: SiteUpdate): Promise<Site | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) values['name'] = patch.name;
    if (patch.url !== undefined) values['url'] = patch.url;
    if (patch.description !== undefined) values['description'] = patch.description;
    if (patch.status !== undefined) values['status'] = patch.status;

    const row = await connection.db
      .updateTable('sites')
      .set(values as never)
      .where('id', '=', id)
      .returning(COLUMNS)
      .executeTakeFirst();

    return row === undefined ? null : toSite(row as SiteRow);
  },

  async updatePublicKey(connection: Connection, id: string, publicKey: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    // 変えるのは公開キーだけ。`updated_at` は `Site` として見える項目の更新に限る。
    const result = await connection.db
      .updateTable('sites')
      .set({ public_key: publicKey })
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  },

  async delete(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    const result = await connection.db.deleteFrom('sites').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  },
};
