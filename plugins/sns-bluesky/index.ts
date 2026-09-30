import type { Plugin, PluginContext } from '@torifune/plugin-api';
import { pdsSettingsRegistration } from './settings';
import { createBlueskyPublisher } from './social';

/**
 * Bluesky 配信 Plugin（036-sns-bluesky）。
 *
 * **Torifune 本体（`apps/web`）のモジュールを一切 import しない。**
 * `@torifune/plugin-api` と自分のファイルだけを見る。
 *
 * 画面部品を1つも持たない。`/plugins/sns-bluesky/settings` は
 * `registerSettings` の宣言から Core が描く（設計 §7）。
 */
const plugin: Plugin = {
  activate(context: PluginContext): void {
    // PDS の URL の入力欄。宣言するだけで、描画と保存は Core が行う。
    context.ui.registerSettings(pdsSettingsRegistration);

    // 高権限の拡張点。Manifest の `extensions: ['social']` が要る。
    // **既定の `fetch` と時刻を使う。** 差し替えるのはテストだけ（設計 §10.1）。
    context.social.registerPublisher(createBlueskyPublisher({ store: context.store }));
  },
};

export default plugin;
