import type { Kysely } from 'kysely';
import type { Schema } from './schema';

/**
 * データベース接続の抽象。
 *
 * Repository はこの `Connection` を受け取る。実体が Pool 由来かトランザクション由来かを
 * Repository は知らない。そのため、同じ Repository がトランザクションの内外どちらでも動く。
 *
 * `010-plugin-api` で Plugin へ公開するときは、`db` を露出しない別の型に絞る。
 * 一般 Plugin へ自由な SQL 実行権限を与えない（05_API設計.md §27）。
 */
export interface Connection {
  /** Torifune 本体の内部利用に限る。Plugin へ渡してはならない。 */
  readonly db: Kysely<Schema>;

  /**
   * トランザクション境界を張る。
   *
   * 呼び出した関数が例外を投げたらロールバックし、正常終了したらコミットする。
   * 入れ子にした場合、外側が失敗すれば内側の変更も取り消される。
   */
  transaction<T>(fn: (tx: Connection) => Promise<T>): Promise<T>;
}

/**
 * データベース接続方式の抽象（02_データベース設計.md §8）。
 *
 * ビジネスロジックは、この Provider がどのように接続先を決めているかを知らない。
 * 標準構成では固定の1データベースへ接続するが、Plugin が差し替えることで
 * 別の接続方式を実装できる（01_アーキテクチャ設計.md §9）。
 *
 * signature に `pg` / `kysely` の型を出さないこと。
 * ここは `010-plugin-api` でそのまま公開契約になる。
 */
export interface DatabaseProvider {
  /** 接続を取得する。取得に失敗したら例外を投げる。 */
  connect(): Promise<Connection>;

  /** 保持している接続をすべて解放する。二度呼んでも例外を投げない。 */
  disconnect(): Promise<void>;

  /**
   * 接続できるかを確認する。
   *
   * **例外を投げない。** Readiness プローブから呼ぶため、
   * 落ちているかどうかを真偽値で返せる必要がある。
   */
  healthCheck(): Promise<boolean>;
}
