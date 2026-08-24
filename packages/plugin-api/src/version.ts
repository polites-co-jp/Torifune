/**
 * Plugin API のバージョン。
 *
 * Torifune 本体のバージョンとは独立して管理する（03_プラグイン設計.md §16）。
 * Plugin は Manifest の `apiVersion` にこの値を宣言する。
 *
 * **足すことは破壊的変更ではない。** 常に「足せる形」で設計する。
 * 破壊的変更の判断基準は `docs/設計/010-plugin-api/設計.md` §9。
 */
export const PLUGIN_API_VERSION = 1 as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;

/** この本体が受け入れる Plugin API バージョン。 */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

export function isSupportedApiVersion(version: number): boolean {
  return SUPPORTED_API_VERSIONS.includes(version);
}
