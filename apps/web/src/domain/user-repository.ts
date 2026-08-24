import type { Connection } from '../database/provider';
import type { NewUser, User } from './user';

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
  assignRole(connection: Connection, userId: string, roleName: string): Promise<void>;
}
