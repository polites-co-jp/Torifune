/**
 * Threads API への要求と、応答の分類（040-sns-threads 設計 §6）。
 *
 * **この Plugin が外へ出す HTTP はここに集める。** 宛先・版・制限時間の定数、
 * エラーの分類、`reason` に出してよい数値の集合も、このファイルの 1 か所に置く（実装プラン G4 以降で足す）。
 * 文言の組み立てと `PublishResult` への変換は `social.ts` が持つ。
 */

/* -------------------------------------------------------------------------- */
/* HTTP の実装の解決（設計 §10.1）                                                */
/* -------------------------------------------------------------------------- */

/**
 * 外部への HTTP の型。
 *
 * ほかのファイルはこの型と `resolveFetch()` を通してしか外へ出られない。
 */
export type FetchImpl = typeof globalThis.fetch;

/**
 * 実際に使う関数を決める。
 *
 * **既定値の解決はここだけ。** 呼び出しはすべて `impl(url, init)` の形で行う。
 * **毎回引き直す。** モジュールの読み込み時に閉じ込めると、差し替えが効かなくなる。
 */
export function resolveFetch(injected?: FetchImpl): FetchImpl {
  return injected ?? globalThis.fetch;
}
