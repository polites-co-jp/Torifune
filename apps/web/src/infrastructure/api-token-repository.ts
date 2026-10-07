import type { Connection } from '../database/provider';
import type { ApiToken } from '../domain/api-token';
import type { PermissionName } from '../domain/permission';
import { NotFoundError } from '../domain/repository';

/**
 * API Token の保存（05_API設計.md §37）。
 *
 * **平文は扱わない。** 呼び出し側がハッシュにしてから渡す。
 */

interface Row {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  site_id: string | null;
  site_scoped: boolean;
}

function toApiToken(row: Row): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as PermissionName[],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    siteId: row.site_id,
    siteScoped: row.site_scoped,
  };
}

const COLUMNS = [
  'id',
  'user_id',
  'name',
  'prefix',
  'scopes',
  'expires_at',
  'last_used_at',
  'revoked_at',
  'created_at',
  'site_id',
  'site_scoped',
] as const;

export interface InsertApiTokenInput {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly prefix: string;
  readonly scopes: readonly PermissionName[];
  readonly expiresAt: Date | null;
  /**
   * 紐づけるサイト。省略・null は共通のトークン（053 設計 §8.5.1）。
   * 値があれば `site_scoped = true` で書く（`026` の CHECK `api_tokens_site_scoped_check`）。
   */
  readonly siteId?: string | null;
}

/** UUID の形をしているか。不正な値で 500 にせず、見つからない扱いにする。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgreSQL の外部キー違反（23503）で、制約名が `constraint` のものか。 */
function isForeignKeyViolationOf(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { code, constraint: name } = error as { code?: unknown; constraint?: unknown };
  return code === '23503' && name === constraint;
}

export const apiTokenRepository = {
  /**
   * 挿入する。`siteId` のサイトが無ければ（外部キー違反）`NotFoundError('Site')` を投げる
   * （呼び出し側が 422 に写す。053 設計 §8.5.1 の 4）。
   */
  async insert(connection: Connection, input: InsertApiTokenInput): Promise<ApiToken> {
    const siteId = input.siteId ?? null;
    try {
      const row = await connection.db
        .insertInto('api_tokens')
        .values({
          id: input.id,
          user_id: input.userId,
          name: input.name,
          token_hash: input.tokenHash,
          prefix: input.prefix,
          scopes: [...input.scopes],
          expires_at: input.expiresAt,
          site_id: siteId,
          site_scoped: siteId !== null,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();

      return toApiToken(row as Row);
    } catch (error) {
      if (siteId !== null && isForeignKeyViolationOf(error, 'api_tokens_site_id_fkey')) {
        throw new NotFoundError('Site', siteId);
      }
      throw error;
    }
  },

  /** ハッシュで引く。**失効・期限の判定は呼び出し側**（Domain の `isUsable`）。 */
  async findByHash(connection: Connection, tokenHash: string): Promise<ApiToken | null> {
    const row = await connection.db
      .selectFrom('api_tokens')
      .select(COLUMNS)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    return row === undefined ? null : toApiToken(row as Row);
  },

  async listByUser(connection: Connection, userId: string): Promise<readonly ApiToken[]> {
    const rows = await connection.db
      .selectFrom('api_tokens')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();

    return rows.map((row) => toApiToken(row as Row));
  },

  async findById(connection: Connection, id: string): Promise<ApiToken | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }
    const row = await connection.db
      .selectFrom('api_tokens')
      .select(COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? null : toApiToken(row as Row);
  },

  /**
   * 失効させる。**行は消さない。** 消すと監査が追えない。
   *
   * すでに失効しているものの時刻は書き換えない。
   */
  async revoke(connection: Connection, id: string, now: Date): Promise<boolean> {
    const result = await connection.db
      .updateTable('api_tokens')
      .set({ revoked_at: now })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  },

  async touch(connection: Connection, id: string, now: Date): Promise<void> {
    await connection.db
      .updateTable('api_tokens')
      .set({ last_used_at: now })
      .where('id', '=', id)
      .execute();
  },
};
