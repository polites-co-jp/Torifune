import { getConnection } from '../database/registry';
import type { Connection } from '../database/provider';

/**
 * トランザクション境界を張るための入口。
 *
 * **トランザクションの境界は Application 層（UseCase）が決める**
 * （01_アーキテクチャ設計.md §5）。Repository や API Layer が勝手に張らない。
 * 境界が散らばると、どこまでが一括で取り消されるのかが追えなくなる。
 *
 * 使い方:
 *
 * ```ts
 * await withTransaction(async (tx) => {
 *   await userRepository.insert(tx, user);
 *   await auditLogRepository.insert(tx, log);
 * });
 * ```
 */
export async function withTransaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T> {
  const connection = await getConnection();
  return connection.transaction(fn);
}

/** トランザクションを張らずに接続だけを使う（読み取り専用の処理向け）。 */
export async function withConnection<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = await getConnection();
  return fn(connection);
}
