/**
 * 手動投稿の子ウィンドウの開き方（035-social-publishing 設計 §7.2、055-social-pending-tab 設計 §9.3.4・§9.5.2）。
 *
 * 送信待ちの表の行と一括投稿の順に投稿（057）が使う。**`window.open` を呼ぶのはここだけ**
 * （055 #39）。呼ぶ側は**クリックの同期処理の中で**呼ぶ。外で呼ぶとポップアップとして扱われずブロックされる
 * ため、押してから publisher に問い合わせることはできない（URL は Server Component が描画時に作る）。
 */

/**
 * 窓の名前（035 設計 §7.2）。
 *
 * **`noopener` を付けて開くので、名前による窓の再利用は効かない。** 2 件目を開くと毎回新しい窓が開く
 * （`window.opener` を断つ代わりに、同じ名前の既存の窓を見つけられない。安全側の振る舞いなのでそのままにしている）。
 */
export const MANUAL_WINDOW_NAME = 'torifune-manual-post';

/**
 * 子ウィンドウの開き方（035 設計 §7.2）。
 *
 * **`noopener` を付ける。** 開いた先は外部 SNS の画面で、`window.opener` から
 * とりふねの画面へ戻れる状態にしない。`noreferrer` も付け、URL を Referer で渡さない。
 * その代わり `window.open` は `null` を返し、ブロックされたか判別できないので、
 * 呼ぶ側は同じ URL のリンク（「別のタブで開く」）を併置する。
 */
export const MANUAL_WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';

/** 子ウィンドウを開く口（`window.open` と同じ引数）。 */
export type OpenManualWindow = (url: string, name: string, features: string) => unknown;

/**
 * 投稿画面を子ウィンドウで開く。`open` は差し替えの口で、既定は `window.open`
 * （単体テストの環境 `environment: 'node'` には `window` が無い。035 実装プラン §8 の 10）。
 */
export function openManualWindow(url: string, open?: OpenManualWindow): unknown {
  if (open === undefined) {
    return window.open(url, MANUAL_WINDOW_NAME, MANUAL_WINDOW_FEATURES);
  }
  return open(url, MANUAL_WINDOW_NAME, MANUAL_WINDOW_FEATURES);
}
