import type { Plugin, PluginContext } from '@torifune/plugin-api';
import { createDummyAuthenticationProvider } from './authentication';
import { createDummyDatabaseProvider } from './database';
import {
  ExampleBrokenPage,
  ExampleLoginMethod,
  ExampleSettingsTab,
  ExampleSiteAction,
  ExampleSiteSidebar,
  ExampleWidget,
} from './ui/components';
import { ExamplePage } from './ui/pages';

/**
 * サンプル Plugin。
 *
 * Plugin API の拡張点を1つずつ使ってみせる。
 * **Torifune 本体（`apps/web`）のモジュールを一切 import しない。**
 * `@torifune/plugin-api` だけを見る。
 *
 * 手引き: `docs/Plugin開発ガイド.md`
 */

/** 設定のキー。Key-Value Store の名前空間は Plugin ごとに分かれている。 */
const GREETING_KEY = 'greeting';
const API_TOKEN_KEY = 'api-token';

/**
 * ダミーの Database Provider を差し替えるかどうか。
 *
 * **既定では差し替えない。** 差し替えると本体のすべてのデータアクセスが
 * このダミーを通り、何も読めなくなる。
 * 差し替えが成立することを確かめるときだけ有効にする。
 */
function shouldReplaceDatabase(): boolean {
  return process.env['EXAMPLE_PLUGIN_REPLACE_DATABASE'] === '1';
}

/**
 * ダミーの Authentication Provider を差し替えるかどうか。
 *
 * **既定では差し替えない。** 差し替えると、以後のログインがこのダミーを通る。
 * `EXAMPLE_PLUGIN_AUTH_USER_ID` に実在するユーザーの ID を渡すこと。
 */
function dummyAuthenticationUserId(): string | null {
  const userId = process.env['EXAMPLE_PLUGIN_AUTH_USER_ID'];
  return userId === undefined || userId === '' ? null : userId;
}

const plugin: Plugin = {
  async activate(context: PluginContext): Promise<void> {
    const { ui, events, store, logger } = context;

    // --- 画面 ------------------------------------------------------------
    ui.registerMenu({
      label: 'サンプルPlugin',
      route: '/plugins/example-plugin',
      order: 50,
    });

    ui.registerPage({
      route: '/plugins/example-plugin',
      title: 'サンプルPlugin',
      component: ExamplePage,
      // 画面を隠すだけでは認可にならない。本体が到達時にも検証する。
      permission: 'site.read',
    });

    ui.registerWidget({
      location: 'dashboard',
      component: ExampleWidget,
      order: 50,
    });

    ui.registerAction({
      location: 'site.list.actions',
      label: 'サンプルPluginで見る',
      component: ExampleSiteAction,
    });

    ui.registerExtension({
      point: 'site.edit.sidebar',
      component: ExampleSiteSidebar,
      order: 50,
    });

    // 設定画面とログイン画面への差し込み。
    ui.registerExtension({ point: 'settings.tabs', component: ExampleSettingsTab, order: 50 });
    ui.registerExtension({ point: 'login.methods', component: ExampleLoginMethod, order: 50 });

    // **わざと例外を投げるページ。** Error Boundary が枠だけを落とすことを見せる。
    // 実装の見本ではない（`docs/Plugin開発ガイド.md` §3）。
    ui.registerPage({
      route: '/plugins/example-plugin/broken',
      title: 'わざと壊れるページ',
      component: ExampleBrokenPage,
      permission: 'site.read',
    });

    // 自分の画面に拡張点を作り、他の Plugin へ公開する。
    ui.defineExtensionPoint('example-plugin.page.footer');

    // --- 設定 ------------------------------------------------------------
    // 項目を宣言するだけ。フォームの描画と保存は本体が行う。
    ui.registerSettings({
      fields: [
        {
          key: GREETING_KEY,
          label: 'あいさつ',
          description: 'ダッシュボードの Widget に出す文言。',
          kind: 'text',
          placeholder: 'こんにちは',
        },
        {
          key: API_TOKEN_KEY,
          label: 'APIトークン',
          description: '暗号化して保存され、画面には平文が出ません。',
          kind: 'secret',
        },
      ],
      validate: (values) => {
        const greeting = values[GREETING_KEY];
        if (greeting !== undefined && greeting.length > 40) {
          return { [GREETING_KEY]: '40文字以内で入力してください。' };
        }
        return null;
      },
    });

    // --- イベント --------------------------------------------------------
    events.subscribe('site.created', (payload) => {
      // **ここで例外を投げても、Webサイトの作成は成功する**（本体が握る）。
      logger.info('Webサイトが作られた', { siteId: payload.siteId });
    });

    // 自分の名前空間のイベントは発火できる。Core のイベント名は騙れない。
    await events.emit('example-plugin.activated', { at: new Date().toISOString() });

    // --- Key-Value Store -------------------------------------------------
    // 初回だけ既定値を入れる。上書きすると、利用者の設定が毎回消える。
    if ((await store.get<string>(GREETING_KEY)) === null) {
      await store.set(GREETING_KEY, 'こんにちは');
    }

    // --- Database Provider ----------------------------------------------
    if (shouldReplaceDatabase()) {
      // 高権限の拡張点。Manifest で extensions: ['database'] を宣言していないと使えない。
      context.database.registerProvider(createDummyDatabaseProvider(logger));
      logger.warn('Database Provider をダミーへ差し替えた');
    }

    // --- Authentication Provider ----------------------------------------
    const authUserId = dummyAuthenticationUserId();
    if (authUserId !== null) {
      // 高権限の拡張点。extensions: ['authentication'] の宣言が要る。
      // **セッションの発行は Torifune が続ける。** ここが決めるのは「誰か」まで。
      context.authentication.registerProvider(
        createDummyAuthenticationProvider({
          logger,
          userId: authUserId,
          passphrase: process.env['EXAMPLE_PLUGIN_AUTH_PASSPHRASE'] ?? 'example-passphrase',
        }),
      );
      logger.warn('Authentication Provider をダミーへ差し替えた');
    }

    logger.info('サンプルPlugin を有効化した');
  },

  deactivate(context: PluginContext): void {
    // UI の登録・イベントの購読・Permission は本体が自動で取り下げる。
    // ここでは自前の後始末だけを行う。**保存したデータは消さない**
    // （消すかどうかは削除時に利用者が決める）。
    context.logger.info('サンプルPlugin を無効化した');
  },
};

export default plugin;
