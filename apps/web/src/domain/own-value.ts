/**
 * 辞書の自分のプロパティだけを返す。継承したもの（`constructor`・`toString` など）は `undefined`。
 *
 * 素のオブジェクトは `Object.prototype` を継承するので、`obj['constructor']` は
 * 辞書に無くても `Object` 関数を返す。**外から影響を受けるキー**（HTTP の入力、
 * HTTP で書ける DB の値、運用者が DB に直接書ける値、Registry の配信内容）で
 * 辞書を引くときは、`obj[key]`・`obj?.[key]`・`key in obj` で直接引かずにこれを通す。
 * 辞書を作るときは `Map` に積むか `Object.fromEntries` で作る
 * （047-prototype-key-sweep 設計 §4.1）。
 *
 * **Domain 層の純関数。** 何にも依存しない。
 */
export function ownValue<T>(
  dictionary: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (dictionary === undefined) return undefined;
  return Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
}
