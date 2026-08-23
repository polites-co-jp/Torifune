import { sql } from 'kysely';
import type { Connection } from '../database/provider';
import type { NewUser, User, UserStatus } from '../domain/user';
import type { UserRepository } from '../domain/user-repository';

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

export const userRepository: UserRepository = {
  async findById(connection: Connection, id: string): Promise<User | null> {
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
};
