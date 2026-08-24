import type {
  PluginContext,
  PluginEventApi,
  PluginManifest,
  PluginUiApi,
} from '@torifune/plugin-api';
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
  };

  const events: PluginEventApi = {
    subscribe(eventName, handler) {
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

  return {
    pluginId,
    apiVersion: PLUGIN_API_VERSION,
    store: createPluginStore({ connection, pluginId }),
    data: createPluginDataApi({
      pluginId,
      declaredPermissions: new Set(manifest.permissions ?? []),
      context: authorization,
    }),
    ui,
    events,
    logger: createPluginLogger(pluginId),
  };
}
