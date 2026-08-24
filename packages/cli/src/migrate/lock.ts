import type pg from 'pg';

/**
 * マイグレーション用の advisory lock キー。
 *
 * PostgreSQL の advisory lock はデータベース単位の名前空間を持つ 64bit 整数。
 * Torifune のマイグレーション以外と衝突しないよう、固定値を1つ決めておく。
 * （文字列 "torifune:migrations" から導出した任意の定数）
 */
const MIGRATION_LOCK_KEY = 8_312_744_016_055_297n;

/**
 * マイグレーション用のロックを取得し、処理が終わったら必ず解放する。
 *
 * `pg_try_advisory_lock` ではなく `pg_advisory_lock` を使い、**待つ**。
 * デプロイ時に複数インスタンスが同時に起動する状況では、
 * 先行するプロセスの完了を待って「適用済みなので何もしない」に落ち着くのが正しい。
 * 「取れなかったので何もしない」で抜けると、マイグレーション未適用のまま起動してしまう。
 *
 * ロックはセッションレベルで取る。各マイグレーションを個別のトランザクションで
 * 実行するため、トランザクションをまたいで保持する必要がある。
 */
export async function withMigrationLock<T>(
  client: pg.ClientBase,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
  try {
    return await fn();
  } finally {
    // 解放に失敗しても、接続を閉じればロックは落ちる。元のエラーを隠さない。
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()])
      .catch(() => undefined);
  }
}
