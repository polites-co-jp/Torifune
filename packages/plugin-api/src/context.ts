import type { PluginDataApi } from './data';
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

  /** ログ。**Secret を渡しても平文は出ない。** */
  readonly logger: PluginLogger;
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
