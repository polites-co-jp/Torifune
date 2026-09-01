import type { Connection } from '../database/provider';
import type { ApiToken } from '../domain/api-token';
import type { PermissionName } from '../domain/permission';

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
] as const;

export interface InsertApiTokenInput {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly prefix: string;
  readonly scopes: readonly PermissionName[];
  readonly expiresAt: Date | null;
}

export const apiTokenRepository = {
  async insert(connection: Connection, input: InsertApiTokenInput): Promise<ApiToken> {
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
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();

    return toApiToken(row as Row);
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
