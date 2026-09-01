import type {
  ActionRegistration,
  ExtensionPointRegistration,
  MenuRegistration,
  PageRegistration,
  SettingsRegistration,
  Plugin,
  PluginManifest,
  WidgetRegistration,
} from '@torifune/plugin-api';
import { processState } from '@/infrastructure/process-state';

/**
 * 読み込まれた Plugin と、その登録内容の保持。
 *
 * **有効化された Plugin だけがここに入る。**
 * `plugins/` にファイルがあっても、DB に行が無ければ入らない。
 */

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly plugin: Plugin;
}

interface Registrations {
  readonly menus: MenuRegistration[];
  readonly pages: PageRegistration[];
  readonly widgets: WidgetRegistration[];
  readonly actions: ActionRegistration[];
  readonly extensions: ExtensionPointRegistration[];
  readonly definedPoints: Set<string>;
  /** イベント購読の解除関数。無効化時に呼ぶ。 */
  readonly unsubscribers: (() => void)[];
  /** この Plugin が登録した Permission。無効化時に取り下げる。 */
  readonly permissions: string[];
  /**
   * この Plugin が差し替えた Database Provider の ID。
   *
   * **記録するだけで、無効化しても元へは戻さない。**
   * 動いている最中に接続方式を差し替えると、走っている処理が道連れになる。
   * 元へ戻すには再起動が要る（Provider の差し替えは高権限の拡張点）。
   */
  readonly databaseProviders: string[];
  /**
   * この Plugin が差し替えた Authentication Provider の ID。
   *
   * `databaseProviders` と同じく**記録するだけで、無効化しても元へは戻さない。**
   * 認証中のセッションを持つ利用者が居るところへ差し戻すと、
   * 誰が認証済みなのかの判定が途中で変わる。元へ戻すには再起動が要る。
   */
  readonly authenticationProviders: string[];
  /** 宣言された設定項目。**1 Plugin につき1つ。** */
  settings: SettingsRegistration | null;
}

function emptyRegistrations(): Registrations {
  return {
    menus: [],
    pages: [],
    widgets: [],
    actions: [],
    extensions: [],
    definedPoints: new Set(),
    unsubscribers: [],
    permissions: [],
    databaseProviders: [],
    authenticationProviders: [],
    settings: null,
  };
}

// **プロセスに1つ。** モジュールの変数に置くと、Next.js のバンドル分割で
// Route Handler と Server Component が別の実体を見てしまい、
// 「API で無効化したのに画面から消えない」という壊れ方をする。
const loaded = processState('registry.loaded', () => new Map<string, LoadedPlugin>());
const registrations = processState(
  'registry.registrations',
  () => new Map<string, Registrations>(),
);

export function registerLoadedPlugin(entry: LoadedPlugin): void {
  loaded.set(entry.manifest.id, entry);
  registrations.set(entry.manifest.id, emptyRegistrations());
}

export function registrationsOf(pluginId: string): Registrations {
  const existing = registrations.get(pluginId);
  if (existing !== undefined) {
    return existing;
  }
  const created = emptyRegistrations();
  registrations.set(pluginId, created);
  return created;
}

export function loadedPlugins(): readonly LoadedPlugin[] {
  return [...loaded.values()];
}

export function loadedPlugin(pluginId: string): LoadedPlugin | null {
  return loaded.get(pluginId) ?? null;
}

export function isLoaded(pluginId: string): boolean {
  return loaded.has(pluginId);
}

/**
 * Plugin の登録内容をすべて取り消す。
 *
 * **イベント購読も解除する。** 解除しないと、無効化したはずの Plugin が
 * イベントに反応し続ける。
 */
export function unregisterPlugin(pluginId: string): readonly string[] {
  const entry = registrations.get(pluginId);
  const permissions = entry?.permissions ?? [];

  for (const unsubscribe of entry?.unsubscribers ?? []) {
    try {
      unsubscribe();
    } catch {
      // 解除に失敗しても、他の後始末は続ける。
    }
  }

  registrations.delete(pluginId);
  loaded.delete(pluginId);
  return permissions;
}

/** テスト用。 */
export function resetPluginRegistry(): void {
  for (const pluginId of [...registrations.keys()]) {
    unregisterPlugin(pluginId);
  }
  loaded.clear();
  registrations.clear();
}

// ---------------------------------------------------------------------------
// 収集
// ---------------------------------------------------------------------------

function allowed(permission: string | undefined, permissions: ReadonlySet<string>): boolean {
  return permission === undefined || permissions.has(permission);
}

function byOrder<T extends { order?: number }>(a: T, b: T): number {
  return (a.order ?? 100) - (b.order ?? 100);
}

/**
 * 表示してよいメニューを集める。
 *
 * **これは表示制御であって認可ではない**（06_画面設計.md §29）。
 * ページへの到達はサーバー側で別途検証する。
 */
export function collectMenus(permissions: ReadonlySet<string>): readonly MenuRegistration[] {
  return [...registrations.values()]
    .flatMap((entry) => entry.menus)
    .filter((menu) => allowed(menu.permission, permissions))
    .sort(byOrder);
}

/**
 * 収集したものに「どの Plugin のものか」を添える。
 *
 * **描画側が Plugin ごとの Data API を組み立てるために要る。**
 * 誰の登録か分からないと、その要求のユーザー権限で読む口を渡せない。
 */
export interface Owned<T> {
  readonly pluginId: string;
  readonly registration: T;
}

function ownedEntries<T>(pick: (entry: Registrations) => readonly T[]): Owned<T>[] {
  const result: Owned<T>[] = [];
  for (const [pluginId, entry] of registrations) {
    for (const registration of pick(entry)) {
      result.push({ pluginId, registration });
    }
  }
  return result;
}

function byOwnedOrder<T extends { order?: number }>(a: Owned<T>, b: Owned<T>): number {
  return byOrder(a.registration, b.registration);
}

export function collectWidgets(
  location: string,
  permissions: ReadonlySet<string>,
): readonly Owned<WidgetRegistration>[] {
  return ownedEntries((entry) => entry.widgets)
    .filter(
      ({ registration }) =>
        registration.location === location && allowed(registration.permission, permissions),
    )
    .sort(byOwnedOrder);
}

/**
 * 差し込む Action を集める。
 *
 * `resource` を渡すと、そのリソースを対象にした Action へ絞る
 * （06_画面設計.md §26）。**`resource` を宣言していない登録は落とさない。**
 * 落とすと、任意項目として足したはずの `resource` が、
 * 書いていない既存の Plugin を画面から消してしまう。
 */
export function collectActions(
  location: string,
  permissions: ReadonlySet<string>,
  resource?: string,
): readonly Owned<ActionRegistration>[] {
  return ownedEntries((entry) => entry.actions).filter(
    ({ registration }) =>
      registration.location === location &&
      allowed(registration.permission, permissions) &&
      (resource === undefined ||
        registration.resource === undefined ||
        registration.resource === resource),
  );
}

export function collectExtensions(
  point: string,
  permissions: ReadonlySet<string>,
): readonly Owned<ExtensionPointRegistration>[] {
  return ownedEntries((entry) => entry.extensions)
    .filter(
      ({ registration }) =>
        registration.point === point && allowed(registration.permission, permissions),
    )
    .sort(byOwnedOrder);
}

/** その Plugin の設定項目。宣言していなければ null。 */
export function settingsOf(pluginId: string): SettingsRegistration | null {
  return registrations.get(pluginId)?.settings ?? null;
}

/** Plugin が定義した拡張点。Core のものと合わせて一覧できる。 */
export function definedExtensionPoints(): readonly string[] {
  const points = new Set<string>();
  for (const entry of registrations.values()) {
    for (const point of entry.definedPoints) {
      points.add(point);
    }
  }
  return [...points].sort();
}

/**
 * ルートに対応するページを探す。
 *
 * 完全一致を優先し、無ければ前方一致のうち最も長いものを返す
 * （`/plugins/seo/reports/1` が `/plugins/seo/reports` に当たるように）。
 */
export function findPage(pluginId: string, route: string): PageRegistration | null {
  const pages = registrations.get(pluginId)?.pages ?? [];

  const exact = pages.find((page) => page.route === route);
  if (exact !== undefined) {
    return exact;
  }

  const prefixed = pages
    .filter((page) => route.startsWith(`${page.route}/`))
    .sort((a, b) => b.route.length - a.route.length);

  return prefixed[0] ?? null;
}
