/**
 * Plugin の CSS を自分の描画範囲へ閉じるための補助（07_開発者向けガイド.md §31）。
 *
 * Torifune は Plugin の描画を `[data-torifune-plugin="<id>"]` の要素で囲む。
 * そのセレクタを組み立てて、他の Plugin と本体へ影響しないスタイルを書けるようにする。
 *
 * ```ts
 * const scope = pluginScope('com.example.hello');
 * const css = `${scope} .card { border: 1px solid red; }`;
 * ```
 *
 * **これは隔離ではない。** Plugin は本体と同じ DOM・同じ React ツリーで動く。
 * iframe や Shadow DOM で隔離すれば衝突は起きないが、そうすると共通コンポーネントも
 * 拡張点も使えなくなり、拡張性のために隔離を捨てるほうが妥当だと判断した
 * （docs/設計/022-hardening/設計.md §3.4）。
 *
 * したがってこれは**事故を減らす仕組みであって、悪意あるコードを止める仕組みではない**。
 * Plugin は信頼されたコードとして扱う、という前提は変わらない。
 */

/** CSS セレクタとして安全に使えるか。Plugin ID の形式と同じ制約。 */
const SAFE_PLUGIN_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export class PluginScopeError extends Error {
  constructor(pluginId: string) {
    super(`CSS セレクタに使えない Plugin ID: ${pluginId}`);
    this.name = 'PluginScopeError';
  }
}

/**
 * その Plugin の描画範囲を指す CSS セレクタを返す。
 *
 * 属性値を素の文字列で埋めるため、セレクタを壊せる文字が混ざらないことを確かめる。
 * 混ざったまま出すと、Plugin ID の書き方ひとつで本体全体へ効くセレクタを作れてしまう。
 */
export function pluginScope(pluginId: string): string {
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    throw new PluginScopeError(pluginId);
  }
  return `[data-torifune-plugin="${pluginId}"]`;
}

/**
 * その Plugin に閉じたクラス名を返す。
 *
 * セレクタで囲うより、クラス名そのものを分けるほうが確実な場面がある
 * （インラインの `className` など）。
 */
export function pluginClassName(pluginId: string, name: string): string {
  if (!SAFE_PLUGIN_ID.test(pluginId)) {
    throw new PluginScopeError(pluginId);
  }
  return `tf-p-${pluginId.replace(/\./g, '-')}-${name}`;
}
