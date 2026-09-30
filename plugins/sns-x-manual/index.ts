import type { Plugin, PluginContext } from '@torifune/plugin-api';
import { createXManualPublisher } from './social';

/**
 * X 配信 Plugin・無料版（037-sns-x）。X の投稿画面（Web Intent）での手動投稿だけを持つ。
 *
 * **Torifune 本体（`apps/web`）のモジュールを一切 import しない。**
 * `@torifune/plugin-api` と自分のファイルだけを見る。
 *
 * 画面部品も設定も持たない。状態を 1 つも持たない（設計 §5.3）。
 * `sns-x-api` と同じ provider（`x`）を登録するので、同時には有効にできない（設計 §7.2）。
 */
const plugin: Plugin = {
  activate(context: PluginContext): void {
    // 高権限の拡張点。Manifest の `extensions: ['social']` が要る。
    context.social.registerPublisher(createXManualPublisher());
  },
};

export default plugin;
