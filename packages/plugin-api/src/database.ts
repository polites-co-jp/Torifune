/**
 * Database Provider の公開契約（02_データベース設計.md §8）。
 *
 * Plugin がデータベースへの接続方式を差し替えるための入口。
 *
 * **これは高権限の拡張点**（03_プラグイン設計.md §20）。
 * 差し替えると、本体のすべてのデータアクセスがこの Provider を通る。
 *
 * **signature にクエリビルダの型を出さない。**
 * 出すと、本体が使うライブラリの変更が Plugin API の破壊的変更になる。
 */

/** 実行できる操作。一般 Plugin には渡さない（05_API設計.md §27）。 */
export interface PluginDatabaseConnection {
  /**
   * パラメータ化したクエリを実行する。
   *
   * **文字列連結で組み立てない。** 値は必ず `params` で渡す。
   */
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
  transaction<T>(fn: (tx: PluginDatabaseConnection) => Promise<T>): Promise<T>;
}

export interface PluginDatabaseProvider {
  readonly id: string;
  connect(): Promise<PluginDatabaseConnection>;
  disconnect(): Promise<void>;
  /** **例外を投げない。** Readiness プローブから呼ぶため。 */
  healthCheck(): Promise<boolean>;
}
