import type { Connection } from '../database/provider';

export interface LoginAttemptRepository {
  record(connection: Connection, id: string, key: string, at: Date): Promise<void>;
  /** `since` 以降の失敗件数を数える。 */
  countSince(connection: Connection, key: string, since: Date): Promise<number>;
  /** そのキーの失敗記録を消す。 */
  clear(connection: Connection, key: string): Promise<void>;
}
