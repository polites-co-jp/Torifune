import type { Plugin, PluginContext } from '@torifune/plugin-api';
import { createInstagramPublisher } from './social';

/**
 * Instagram 配信 Plugin（038-sns-instagram）。
 *
 * **Torifune 本体（`apps/web`）のモジュールを一切 import しない。**
 * `@torifune/plugin-api` と自分のファイルだけを見る。
 *
 * 画面部品も設定も持たない。状態を1つも持たない（設計 §5.3）。
 */
const plugin: Plugin = {
  activate(context: PluginContext): void {
    // 高権限の拡張点。Manifest の `extensions: ['social']` が要る。
    // **引数を与えない。** 既定の HTTP・時計・待ちを使う。差し替えるのはテストだけ（設計 §10.1）。
    context.social.registerPublisher(createInstagramPublisher());
  },
};

export default plugin;
