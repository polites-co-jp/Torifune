/**
 * 手順書（ヘルプ）の表示文言（041-plugin-help-docs 設計 §7.7）。
 *
 * **部品の中に直書きしない**（`02_画面デザイン方針.md` §5）。
 * ヘルプボタン・手順書の画面・設定画面で同じ言い方を使い、差し替える場所を 1 つにする。
 */

/** ヘルプボタンの前置き。 */
export const HELP_LINK_PREFIX = '手順書：';

/** 新しいタブの注記（ヘルプボタンの下）。 */
export const HELP_NEW_TAB_NOTE = '新しいタブで開きます。入力中の内容はこの画面に残ります。';

/** 新しいタブの読み上げ（視覚的に隠す）。 */
export const HELP_NEW_TAB_SR = '（新しいタブで開きます）';

/** 手順書の画面の小見出し。 */
export function helpDocSubtitle(pluginName: string, pluginId: string, version: string): string {
  return `${pluginName}（${pluginId} ${version}）の手順書`;
}

/** 同梱の注記。 */
export const HELP_BUNDLED_NOTE =
  'この手順書は Plugin に同梱された文書です。外部サービスの画面の名前や手順は変わることがあります。';

/** 読み込まれていない Plugin の注記。 */
export const HELP_PLUGIN_NOT_LOADED = 'この Plugin はいま有効になっていません。';

/** 同じ Plugin の手順書の一覧の見出し。 */
export const HELP_SIBLINGS_HEADING = 'この Plugin の手順書';

/** 一覧の画面の h1。 */
export function helpIndexHeading(pluginName: string): string {
  return `${pluginName} の手順書`;
}

/** 本文が読めないとき。理由のコード・パスは出さない（設計 §7.3.5）。 */
export const HELP_READ_FAILED =
  'この手順書を読み込めませんでした。Plugin の配布物に手順書のファイルが含まれているか、管理者に確かめてください。';

/** 画像の代わりに出す文字（設計 §7.3.2）。 */
export function imagePlaceholder(alt: string | undefined): string {
  return alt === undefined || alt === '' ? '［画像］' : `［画像：${alt}］`;
}

/** 設定画面の手順書の見出し。 */
export const HELP_SETTINGS_HEADING = '手順書';

/** 設定を持たない Plugin の設定画面。 */
export const HELP_NO_SETTINGS = 'この Plugin には、この画面で変える設定がありません。';

/** 手順書の画面の末尾。 */
export const HELP_BACK_TO_SETTINGS = 'プラグインの設定へ戻る';

/** パンくず。 */
export const HELP_BREADCRUMB_PLUGINS = 'プラグイン';
export const HELP_BREADCRUMB_HELP = '手順書';
