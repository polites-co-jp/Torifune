/**
 * Torifune Plugin API — 公開契約。
 *
 * このパッケージは Torifune 本体（`apps/web`）へ一切依存しない。
 * 依存の向きが逆転すると、Plugin 作者が本体の内部実装に縛られる。
 *
 * 契約の中身は 010-plugin-api で実装する。
 */

/**
 * Plugin API のバージョン。
 * Plugin は Manifest の `apiVersion` にこの値を宣言する。
 * Torifune 本体のバージョンとは独立して管理する（`docs/仕様書/03_プラグイン設計.md` §16）。
 */
export const PLUGIN_API_VERSION = 1 as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;
