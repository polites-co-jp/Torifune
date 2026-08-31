import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { Connection } from '../database/provider';
import type { Schema } from '../database/schema';
import type { NewUser, User, UserStatus } from '../domain/user';
import type {
  UserListQuery,
  UserPage,
  UserRepository,
  UserUpdate,
} from '../domain/user-repository';

interface UserRow {
  id: string;
  login_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    loginId: row.login_id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    status: row.status as UserStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

const COLUMNS = [
  'id',
  'login_id',
  'email',
  'display_name',
  'password_hash',
  'status',
  'created_at',
  'updated_at',
  'last_login_at',
] as const;

/**
 * `LIKE` のワイルドカードを打ち消す。
 *
 * 利用者が入力した `%` や `_` をそのまま渡すと、意図しない広さで一致する。
 */
function escapeLikePattern(keyword: string): string {
  return keyword.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** UUID の形をしているか。不正な値で 500 にせず、見つからない扱いにする。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function listConditions(
  eb: ExpressionBuilder<Schema, 'users'>,
  query: UserListQuery,
): Expression<SqlBool>[] {
  const conditions: Expression<SqlBool>[] = [];

  if (query.status !== null) {
    conditions.push(eb('status', '=', query.status));
  }

  const keyword = query.keyword?.trim() ?? '';
  if (keyword !== '') {
    const pattern = `%${escapeLikePattern(keyword)}%`;
    conditions.push(
      sql<SqlBool>`(login_id ILIKE ${pattern} ESCAPE '\\' OR display_name ILIKE ${pattern} ESCAPE '\\' OR email ILIKE ${pattern} ESCAPE '\\')`,
    );
  }

  return conditions;
}

export const userRepository: UserRepository = {
  async findById(connection: Connection, id: string): Promise<User | null> {
    // **UUID の形でなければ問い合わせない。**
    // PostgreSQL の uuid 型へ不正な文字列を渡すと 22P02 で落ち、500 になる。
    // 「見つからない」で返すのが正しい（05_API設計.md §9）。
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const row = await connection.db
      .selectFrom('users')
      .select(COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toUser(row as UserRow);
  },

  async findByLoginId(connection: Connection, loginId: string): Promise<User | null> {
    // 大文字小文字を区別しない。lower() の式インデックスに合わせる。
    const row = await connection.db
      .selectFrom('users')
      .select(COLUMNS)
      .where(sql<boolean>`lower(login_id) = lower(${loginId})`)
      .executeTakeFirst();
    return row === undefined ? null : toUser(row as UserRow);
  },

  async findByEmail(connection: Connection, email: string): Promise<User | null> {
    const row = await connection.db
      .selectFrom('users')
      .select(COLUMNS)
      .where(sql<boolean>`lower(email) = lower(${email})`)
      .executeTakeFirst();
    return row === undefined ? null : toUser(row as UserRow);
  },

  async insert(connection: Connection, user: NewUser): Promise<User> {
    const row = await connection.db
      .insertInto('users')
      .values({
        id: user.id,
        login_id: user.loginId,
        email: user.email,
        display_name: user.displayName,
        password_hash: user.passwordHash,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toUser(row as UserRow);
  },

  async updatePasswordHash(
    connection: Connection,
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await connection.db
      .updateTable('users')
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where('id', '=', userId)
      .execute();
  },

  async touchLastLogin(connection: Connection, userId: string, at: Date): Promise<void> {
    await connection.db
      .updateTable('users')
      .set({ last_login_at: at, updated_at: at })
      .where('id', '=', userId)
      .execute();
  },

  async countByRoleForUpdate(connection: Connection, roleName: string): Promise<number> {
    // roles の該当行をロックしてから数える。
    // 「0人であることを確認してから作る」を同時実行しても直列化させるため
    // （設計: 初回セットアップの競合対策）。
    await connection.db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', roleName)
      .forUpdate()
      .execute();

    const result = await connection.db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('roles.name', '=', roleName)
      .executeTakeFirstOrThrow();

    return Number(result.count);
  },

  async assignRole(connection: Connection, userId: string, roleName: string): Promise<void> {
    const role = await connection.db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', roleName)
      .executeTakeFirstOrThrow();

    await connection.db
      .insertInto('user_roles')
      .values({ user_id: userId, role_id: role.id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  },

  async countActiveByRoleForUpdate(connection: Connection, roleName: string): Promise<number> {
    // 「最後の管理者を消せない」の判定に使う。
    // **数えてから更新するまで、他の要求に割り込ませない。**
    // 割り込まれると、2つの要求が同時に来たときに管理者が0人になる。
    await connection.db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', roleName)
      .forUpdate()
      .execute();

    const result = await connection.db
      .selectFrom('user_roles')
      .innerJoin('roles', 'roles.id', 'user_roles.role_id')
      .innerJoin('users', 'users.id', 'user_roles.user_id')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('roles.name', '=', roleName)
      // 無効化された管理者は「居る」に数えない。
      .where('users.status', '=', 'active')
      .executeTakeFirstOrThrow();

    return Number(result.count);
  },

  async removeRole(connection: Connection, userId: string, roleName: string): Promise<void> {
    const role = await connection.db
      .selectFrom('roles')
      .select('id')
      .where('name', '=', roleName)
      .executeTakeFirst();

    if (role === undefined) {
      return;
    }

    await connection.db
      .deleteFrom('user_roles')
      .where('user_id', '=', userId)
      .where('role_id', '=', role.id)
      .execute();
  },

  async list(connection: Connection, query: UserListQuery): Promise<UserPage> {
    let rowsQuery = connection.db
      .selectFrom('users')
      .select(COLUMNS)
      .where((eb) => eb.and(listConditions(eb, query)));

    const countQuery = connection.db
      .selectFrom('users')
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

    return {
      items: rows.map((row) => toUser(row as UserRow)),
      total: Number(counted.count),
    };
  },

  async update(connection: Connection, id: string, patch: UserUpdate): Promise<User | null> {
    if (!UUID_PATTERN.test(id)) {
      return null;
    }

    const values: Record<string, unknown> = { updated_at: new Date() };
    if (patch.displayName !== undefined) values['display_name'] = patch.displayName;
    if (patch.email !== undefined) values['email'] = patch.email;
    if (patch.status !== undefined) values['status'] = patch.status;

    const row = await connection.db
      .updateTable('users')
      .set(values)
      .where('id', '=', id)
      .returning(COLUMNS)
      .executeTakeFirst();

    return row === undefined ? null : toUser(row as UserRow);
  },

  async deleteById(connection: Connection, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) {
      return false;
    }
    const result = await connection.db.deleteFrom('users').where('id', '=', id).executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  },
};
