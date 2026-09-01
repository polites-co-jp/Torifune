import type { PluginAuthenticationApi } from './authentication';
import type { PluginDataApi } from './data';
import type { PluginDatabaseApi } from './database';
import type { PluginEventApi } from './events';
import type { PluginStore } from './store';
import type { PluginUiApi } from './ui';

/**
 * Plugin へ渡す唯一の入口。
 *
 * **Plugin は本体の内部モジュールを import しない**（03_プラグイン設計.md §2.3）。
 * ここから取れるものだけを使う。
 */

export interface PluginLogger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly apiVersion: number;

  /** この Plugin 専用の Key-Value Store。他の Plugin の領域は見えない。 */
  readonly store: PluginStore;

  /** Torifune のデータ。呼び出し元 Plugin の Permission を通る。 */
  readonly data: PluginDataApi;

  readonly ui: PluginUiApi;
  readonly events: PluginEventApi;

  /**
   * データベース接続方式の差し替え（01_アーキテクチャ設計.md §9）。
   *
   * **高権限の拡張点。** Manifest で `extensions: ['database']` を
   * 宣言していなければ使えない。
   */
  readonly database: PluginDatabaseApi;

  /**
   * 認証方式の差し替え（04_認証設計.md §15）。
   *
   * **高権限の拡張点。** Manifest で `extensions: ['authentication']` を
   * 宣言していなければ使えない。
   *
   * **セッションの発行は Core に残る。** Provider が決めるのは「誰か」まで。
   */
  readonly authentication: PluginAuthenticationApi;

  /** ログ。**Secret を渡しても平文は出ない。** */
  readonly logger: PluginLogger;

  /**
   * いま操作している利用者（00_システム概要.md §8）。
   *
   * **認証前は `null`。** `login.methods` 拡張点はログイン画面で描かれるため、
   * ここを `null` にできないとログイン画面が落ちる。
   *
   * **`data.users` では代わりにならない。** あちらは「誰が居るか」を引く口で、
   * 「いま見ているのが誰か」は分からない。「誰がやったか」を出す Plugin に要る。
   */
  readonly currentUser: PluginCurrentUser | null;
}

/**
 * Plugin へ渡す、いまの利用者。
 *
 * **メールアドレスとパスワードハッシュを型として持たせない。**
 * 存在しなければ、うっかり足すこともできない（`PluginUserView` と同じ方針）。
 */
export interface PluginCurrentUser {
  readonly userId: string;
  readonly loginId: string;
  readonly displayName: string;
  /**
   * この利用者が持つ Permission。
   *
   * **見せてよい。** Plugin が呼ぶ Data API はどのみちこの権限で絞られる。
   * 先に分かれば、押しても 403 になるボタンを出さずに済む。
   */
  readonly permissions: readonly string[];
}

/**
 * Plugin のエントリポイント。
 *
 * `plugins/<id>/index.ts` が既定でこの形を export する。
 */
export interface Plugin {
  /** 有効化されたときに呼ばれる。UI やイベントの登録はここで行う。 */
  activate(context: PluginContext): void | Promise<void>;
  /** 無効化されたときに呼ばれる。後始末が要ればここで行う。 */
  deactivate?(context: PluginContext): void | Promise<void>;
  /** 導入時に1度だけ呼ばれる。初期データの投入など。 */
  install?(context: PluginContext): void | Promise<void>;
  /** 削除時に呼ばれる。**データの削除は明示的な確認を経てから**（03 §12.5）。 */
  uninstall?(context: PluginContext): void | Promise<void>;
}
