/**
 * Torifune Plugin API — 公開契約。
 *
 * **このパッケージは Torifune 本体（`apps/web`）へ一切依存しない。**
 * 依存の向きが逆転すると、Plugin 作者が本体の内部実装に縛られる。
 *
 * Plugin はこの入口だけを見る。個別ファイルへの直接 import は、
 * 内部の再編で壊れる。
 */

export { PLUGIN_API_VERSION, SUPPORTED_API_VERSIONS, isSupportedApiVersion } from './version';
export type { PluginApiVersion } from './version';

export {
  PLUGIN_EXTENSION_KINDS,
  isValidPluginId,
  isValidPluginVersion,
  validateManifest,
} from './manifest';
export type {
  ManifestProblem,
  ManifestValidation,
  PluginExtensionKind,
  PluginManifest,
} from './manifest';

export { MAX_VALUE_BYTES, PluginStoreError, STORE_KEY_PATTERN, isValidStoreKey } from './store';
export type { PluginStore } from './store';

export { CORE_EXTENSION_POINTS } from './ui';
export type {
  ActionRegistration,
  ExtensionPointRegistration,
  MenuRegistration,
  PageRegistration,
  PluginComponent,
  PluginUiApi,
  WidgetRegistration,
} from './ui';

export { CORE_EVENTS } from './events';
export type {
  CoreEventName,
  EventHandler,
  PluginEventApi,
  SiteEventPayload,
  SocialAccountEventPayload,
  SocialPostEventPayload,
} from './events';

export { PluginPermissionError } from './data';
export type {
  ListOptions,
  Page,
  PluginDataApi,
  SiteInput,
  SiteView,
  SocialAccountView,
  SocialPostView,
} from './data';

export type {
  PluginAuthenticationContext,
  PluginAuthenticationProvider,
  PluginAuthenticationResult,
  PluginCredentials,
  PluginUserIdentity,
} from './authentication';

export type { PluginDatabaseConnection, PluginDatabaseProvider } from './database';

export type { Plugin, PluginContext, PluginLogger } from './context';
