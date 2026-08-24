/**
 * Plugin ごとの Key-Value Store。
 *
 * Plugin が必要とするデータの形は、Core には決められない。
 * 設定と少量のデータのために毎回マイグレーションを書かせるのは重いので、
 * ここを既定の置き場にする（03_プラグイン設計.md §18-19）。
 *
 * **Plugin は自分の名前空間しか触れない。**
 * `pluginId` は `PluginContext` が閉じ込め、Plugin から指定させない。
 * 指定できると、他の Plugin の資格情報を読めてしまう。
 */

/** キーの形式。パス風の階層を許す（`oauth/access-token` など）。 */
export const STORE_KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

export function isValidStoreKey(key: string): boolean {
  return STORE_KEY_PATTERN.test(key);
}

/** 1つの値の上限（JSON 化した後のバイト数）。 */
export const MAX_VALUE_BYTES = 256 * 1024;

export interface PluginStore {
  /** 値を取り出す。無ければ `null`。 */
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  /** キーの一覧。接頭辞で絞り込める。**Secret のキーも含む（値は含まない）。** */
  keys(prefix?: string): Promise<string[]>;

  /**
   * Secret として保存する。
   *
   * 暗号化して保存され、`get()` では取り出せない。
   * 設定画面や一覧にも平文で出ない（05_API設計.md §25）。
   */
  setSecret(key: string, value: string): Promise<void>;
  /** Secret を取り出す。**自分の名前空間のみ。** */
  getSecret(key: string): Promise<string | null>;
  /** 設定済みかどうかだけを見る。平文を取らずに済ませたいとき。 */
  hasSecret(key: string): Promise<boolean>;
}

export class PluginStoreError extends Error {
  constructor(
    message: string,
    readonly key: string,
  ) {
    super(message);
    this.name = 'PluginStoreError';
  }
}
