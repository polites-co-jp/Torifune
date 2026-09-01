import type {
  PluginAuthenticationApi,
  PluginContext,
  PluginDatabaseApi,
  PluginEventApi,
  PluginManifest,
  PluginUiApi,
} from '@torifune/plugin-api';
import { PluginExtensionNotDeclaredError } from '@torifune/plugin-api';
import {
  getAuthenticationProvider,
  setAuthenticationProvider,
  setAuthenticationProviderId,
} from '@/authentication/registry';
import { setDatabaseProvider } from '@/database/registry';
import { adaptPluginAuthenticationProvider } from './authentication-adapter';
import { adaptPluginDatabaseProvider } from './database-adapter';
import { PLUGIN_API_VERSION } from '@torifune/plugin-api';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { emit, subscribe } from '@/application/events';
import { CORE_EVENTS } from '@torifune/plugin-api';
import type { Connection } from '@/database/provider';
import { createPluginDataApi } from './data-api';
import { createPluginLogger } from './logger';
import { registrationsOf } from './registry';
import { createPluginStore } from './store';

/**
 * `PluginContext` の組み立て。
 *
 * **Plugin へ渡る唯一の入口。** ここから取れるもの以外へは到達できない。
 *
 * `pluginId` はここで束縛する。Plugin が指定する余地を作らない。
 */

export interface BuildContextDeps {
  readonly manifest: PluginManifest;
  readonly connection: Connection;
  /** 実行時の認可文脈。Data API の呼び出しに使う。 */
  readonly authorization: AuthorizationContext;
}

/** Plugin が発火できないイベント名。Core のイベントを騙れないようにする。 */
const CORE_EVENT_NAMES = new Set<string>(CORE_EVENTS);

export function buildPluginContext(deps: BuildContextDeps): PluginContext {
  const { manifest, connection, authorization } = deps;
  const pluginId = manifest.id;
  const registrations = registrationsOf(pluginId);

  const ui: PluginUiApi = {
    registerMenu(registration) {
      registrations.menus.push(registration);
    },
    registerPage(registration) {
      registrations.pages.push(registration);
    },
    registerWidget(registration) {
      registrations.widgets.push(registration);
    },
    registerAction(registration) {
      registrations.actions.push(registration);
    },
    registerExtension(registration) {
      registrations.extensions.push(registration);
    },
    defineExtensionPoint(point) {
      registrations.definedPoints.add(point);
    },
    registerSettings(registration) {
      registrations.settings = registration;
    },
  };

  const events: PluginEventApi = {
    // 多重定義（overload）を持つメンバーは、実装側で型を明示する。
    subscribe(eventName: string, handler: (payload: never) => void | Promise<void>) {
      // 解除関数を控えておく。無効化時にまとめて外す。
      // 外さないと、無効化したはずの Plugin がイベントに反応し続ける。
      const unsubscribe = subscribe(eventName, handler as (payload: unknown) => void);
      registrations.unsubscribers.push(unsubscribe);
      return unsubscribe;
    },

    async emit(eventName, payload) {
      if (CORE_EVENT_NAMES.has(eventName)) {
        // Core のイベントを騙れると、他の Plugin を誤作動させられる。
        throw new Error(`Core のイベントは Plugin から発火できない: ${eventName}`);
      }
      if (!eventName.startsWith(`${pluginId}.`)) {
        // 名前空間を守らせる。他の Plugin のイベント名も騙らせない。
        throw new Error(`イベント名は Plugin ID を接頭辞にする（${pluginId}.… ）: ${eventName}`);
      }
      await emit(eventName, payload);
    },
  };

  const declaredExtensions = new Set(manifest.extensions ?? []);

  const database: PluginDatabaseApi = {
    registerProvider(provider) {
      // **宣言していなければ差し替えさせない。**
      // 宣言なしに差し替えられると、Plugin を入れた側が
      // 「何がデータアクセスを握っているか」を知らないまま運用することになる。
      if (!declaredExtensions.has('database')) {
        throw new PluginExtensionNotDeclaredError(pluginId, 'database');
      }
      registrations.databaseProviders.push(provider.id);
      setDatabaseProvider(adaptPluginDatabaseProvider(provider));
    },
  };

  const authentication: PluginAuthenticationApi = {
    registerProvider(provider) {
      // **宣言していなければ差し替えさせない。** database と同じ扱い。
      // 認証を握るのは最も高い権限であり、宣言なしに差し替えられると、
      // Plugin を入れた側が誰の認証を通しているか分からなくなる。
      if (!declaredExtensions.has('authentication')) {
        throw new PluginExtensionNotDeclaredError(pluginId, 'authentication');
      }
      registrations.authenticationProviders.push(provider.id);

      // **セッション発行は差し替え前の Provider のものを使い続ける。**
      // ここを Plugin へ渡すと、Session Fixation 対策と失効の責任が
      // Plugin ごとにばらける（`04_認証設計.md` §22）。
      setAuthenticationProvider(
        adaptPluginAuthenticationProvider({
          provider,
          sessionIssuer: getAuthenticationProvider(),
        }),
      );
      // 設定画面に「いま何で認証しているか」を出すため。
      setAuthenticationProviderId(`${pluginId}:${provider.id}`);
    },
  };

  return {
    pluginId,
    apiVersion: PLUGIN_API_VERSION,
    database,
    authentication,
    store: createPluginStore({ connection, pluginId }),
    data: createPluginDataApi({
      pluginId,
      declaredPermissions: new Set(manifest.permissions ?? []),
      context: authorization,
    }),
    ui,
    events,
    logger: createPluginLogger(pluginId),

    // **認証前は null。** `login.methods` はログイン画面で描かれるため、
    // ここを null にできないとログイン画面が落ちる。
    //
    // **メールアドレスを渡さない。** 表示に要らず、出せば漏洩の面が増える
    // （`PluginUserView` と同じ方針）。
    currentUser:
      authorization.identity === null
        ? null
        : {
            userId: authorization.identity.userId,
            loginId: authorization.identity.loginId,
            displayName: authorization.identity.displayName,
            permissions: [...authorization.permissions],
          },
  };
}
