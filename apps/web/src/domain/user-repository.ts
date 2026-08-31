import type { Connection } from '../database/provider';
import type { NewUser, User, UserStatus } from './user';

/** 部分更新。undefined の項目は変えない。 */
export interface UserUpdate {
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly status?: UserStatus | undefined;
}

export interface UserListQuery {
  readonly page: number;
  readonly perPage: number;
  /** 絞り込む状態。null なら全部。 */
  readonly status: UserStatus | null;
  /** ログインID・表示名・メールの部分一致。 */
  readonly keyword: string | null;
  readonly sort: readonly { field: string; direction: 'asc' | 'desc' }[];
}

export interface UserPage {
  readonly items: readonly User[];
  readonly total: number;
}

/**
 * ユーザーの永続化。
 *
 * 実装は Infrastructure 層に置く。`Connection` を受け取るため、
 * トランザクションの内外どちらでも同じ実装が動く。
 */
export interface UserRepository {
  findById(connection: Connection, id: string): Promise<User | null>;
  /** 大文字小文字を区別せずに探す。 */
  findByLoginId(connection: Connection, loginId: string): Promise<User | null>;
  /** 大文字小文字を区別せずに探す。 */
  findByEmail(connection: Connection, email: string): Promise<User | null>;
  insert(connection: Connection, user: NewUser): Promise<User>;
  updatePasswordHash(connection: Connection, userId: string, passwordHash: string): Promise<void>;
  touchLastLogin(connection: Connection, userId: string, at: Date): Promise<void>;
  /** 指定したロールを持つユーザーの数を数える。行ロックを取る。 */
  countByRoleForUpdate(connection: Connection, roleName: string): Promise<number>;
  /**
   * 指定したロールを持つ**有効な**ユーザーの数を数える。行ロックを取る。
   *
   * 「最後の管理者を消せない」の判定に使う。`countByRoleForUpdate` は
   * 状態を見ないため、無効化された管理者まで数えてしまう。
   */
  countActiveByRoleForUpdate(connection: Connection, roleName: string): Promise<number>;
  assignRole(connection: Connection, userId: string, roleName: string): Promise<void>;
  removeRole(connection: Connection, userId: string, roleName: string): Promise<void>;

  list(connection: Connection, query: UserListQuery): Promise<UserPage>;
  update(connection: Connection, id: string, patch: UserUpdate): Promise<User | null>;
  /** 消えたら true。存在しなければ false。 */
  deleteById(connection: Connection, id: string): Promise<boolean>;
}
