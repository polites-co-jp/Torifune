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

/** トークンのサイトの変更（053 設計 §8.5.6）。値は UseCase が `resolveTokenSiteChange` で決めたもの。 */
export interface ChangeApiTokenSiteInput {
  readonly id: string;
  /** 所有者。他人のトークンには書かない。 */
  readonly userId: string;
  /** 変更後のサイト。null は共通。 */
  readonly siteId: string | null;
  readonly siteScoped: boolean;
  /** 変更後の Scope（今の Scope の部分集合）。 */
  readonly scopes: readonly PermissionName[];
}

export interface ChangedApiTokenSite {
  readonly token: ApiToken;
  /** `origin_*` を書き換えた投稿（そのトークンが登録したもの）の数。 */
  readonly movedPosts: number;
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

  /**
   * サイトに紐づいた失効していないトークンを失効させ、失効させた数を返す（053 設計 §8.6 の 3）。
   *
   * `revoked_at` だけを書く。既に失効しているものの時刻は変えず、`site_id` / `site_scoped` には触れない
   * （サイトの削除で `site_id` は外部キーが NULL にし、`site_scoped` は残る）。
   */
  async revokeBySite(connection: Connection, siteId: string, now: Date): Promise<number> {
    const result = await connection.db
      .updateTable('api_tokens')
      .set({ revoked_at: now })
      .where('site_id', '=', siteId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0n);
  },

  /**
   * トークンのサイトを変える（053 設計 §8.5.6・§7.3。裁定 7・10）。**呼び出し側のトランザクションの中で呼ぶ。**
   *
   * 1. トークンの行の `site_id` / `site_scoped` / `scopes` を書き換える。自分のトークンで失効していないものだけ
   *    （当たらなければ null。呼び出し側が読み直して 404 / 422 に分ける）
   * 2. そのトークンが登録した投稿（`created_by_token_id`。アカウントが共通かどうかを問わない）の
   *    `origin_site_id` / `origin_site_scoped` を変更後の値に書き換える（投稿はトークンと一緒に移る）
   *
   * **`api_tokens` の `site_id` / `site_scoped` / `scopes` と `social_posts` の `origin_*` を書き換えるのはここだけ**
   * （受け入れ条件 #60）。登録はトークンの行を `FOR SHARE` で読むので、1 の後に開いたままの間に来た登録は
   * このコミットを待って変更後の値を書く（受け入れ条件 #89）。
   * 変更後のサイトが無ければ（外部キー違反）`NotFoundError('Site')` を投げる（呼び出し側が 422 に写す）。
   */
  async changeSite(
    connection: Connection,
    input: ChangeApiTokenSiteInput,
  ): Promise<ChangedApiTokenSite | null> {
    if (!UUID_PATTERN.test(input.id) || !UUID_PATTERN.test(input.userId)) {
      return null;
    }
    let row: Row | undefined;
    try {
      row = (await connection.db
        .updateTable('api_tokens')
        .set({ site_id: input.siteId, site_scoped: input.siteScoped, scopes: [...input.scopes] })
        .where('id', '=', input.id)
        .where('user_id', '=', input.userId)
        .where('revoked_at', 'is', null)
        .returning(COLUMNS)
        .executeTakeFirst()) as Row | undefined;
    } catch (error) {
      if (input.siteId !== null && isForeignKeyViolationOf(error, 'api_tokens_site_id_fkey')) {
        throw new NotFoundError('Site', input.siteId);
      }
      throw error;
    }
    if (row === undefined) {
      return null;
    }

    const moved = await connection.db
      .updateTable('social_posts')
      .set({ origin_site_id: input.siteId, origin_site_scoped: input.siteScoped })
      .where('created_by_token_id', '=', input.id)
      .executeTakeFirst();

    return { token: toApiToken(row), movedPosts: Number(moved.numUpdatedRows ?? 0n) };
  },

  async touch(connection: Connection, id: string, now: Date): Promise<void> {
    await connection.db
      .updateTable('api_tokens')
      .set({ last_used_at: now })
      .where('id', '=', id)
      .execute();
  },
};
