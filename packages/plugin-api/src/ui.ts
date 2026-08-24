/**
 * UI Extension（06_画面設計.md §22-27）。
 *
 * **Plugin は Torifune の共通 Component を利用する**（同 §32）。
 * 独自の見た目を持ち込むと、画面全体の統一感が崩れる。
 *
 * 型だけをここに置く。実装は `011-plugin-runtime`。
 */

/** React のコンポーネントを、React に依存せずに表す。 */
export type PluginComponent = (props: Record<string, unknown>) => unknown;

export interface MenuRegistration {
  readonly label: string;
  /** `/plugins/<plugin-id>/...` の名前空間に置く（06_画面設計.md §20）。 */
  readonly route: string;
  readonly icon?: string;
  /** 必要な Permission。持たないユーザーには表示しない。 */
  readonly permission?: string;
  /** 並び順。小さいほど上。 */
  readonly order?: number;
}

export interface PageRegistration {
  readonly route: string;
  readonly component: PluginComponent;
  /**
   * 必要な Permission。
   * **画面を隠すだけでは認可にならない。** サーバー側でも検証する（同 §24, §30）。
   */
  readonly permission?: string;
  readonly title?: string;
}

export interface WidgetRegistration {
  /** 置き場所。既定では `dashboard`。 */
  readonly location: string;
  readonly component: PluginComponent;
  readonly permission?: string;
  readonly order?: number;
}

export interface ActionRegistration {
  /** 差し込む先の Extension Point。 */
  readonly location: string;
  readonly label: string;
  readonly component: PluginComponent;
  readonly permission?: string;
}

export interface ExtensionPointRegistration {
  /** 差し込む先の Extension Point 名。 */
  readonly point: string;
  readonly component: PluginComponent;
  readonly permission?: string;
  readonly order?: number;
}

/**
 * Core が提供する Extension Point。
 *
 * **Plugin は自身の画面に Extension Point を定義し、他の Plugin へ公開できる。**
 * ここに無い名前を使ってよい（`docs/仕様書/改訂履歴.md` 2026-08-24）。
 */
export const CORE_EXTENSION_POINTS = [
  'dashboard.before',
  'dashboard.after',
  'site.edit.sidebar',
  'site.list.actions',
  'social.edit.sidebar',
  'social.list.actions',
  'settings.tabs',
  'login.methods',
] as const;

/**
 * 設定項目（06_画面設計.md §27, §38）。
 *
 * **Plugin は項目を宣言するだけ。** 画面の描画と保存は本体が行う。
 * Plugin ごとにフォームを書かせると、Secret の扱いが Plugin ごとに変わり、
 * どこかで平文が表に出る。
 */
export interface PluginSettingsField {
  /** Key-Value Store のキーになる。 */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  /**
   * `secret` は暗号化して保存し、**画面には平文を出さない**。
   * 「設定済み」かどうかだけを見せる（同 §38）。
   */
  readonly kind: 'text' | 'secret';
  readonly placeholder?: string;
}

export interface SettingsRegistration {
  readonly fields: readonly PluginSettingsField[];
  /**
   * 保存の前に呼ばれる検証。問題があればメッセージを返す。
   *
   * ここで例外を投げても保存は止まる。**返すほうが利用者に理由が伝わる。**
   */
  readonly validate?: (
    values: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string>> | null | Promise<Readonly<Record<string, string>> | null>;
}

export interface PluginUiApi {
  registerMenu(registration: MenuRegistration): void;
  registerPage(registration: PageRegistration): void;
  registerWidget(registration: WidgetRegistration): void;
  registerAction(registration: ActionRegistration): void;
  /** 既存画面の拡張点へ差し込む。 */
  registerExtension(registration: ExtensionPointRegistration): void;
  /** 自分の画面に拡張点を作り、他の Plugin へ公開する。 */
  defineExtensionPoint(point: string): void;
  /**
   * 設定項目を宣言する。
   *
   * 画面（`/plugins/<id>/settings`）と保存は本体が受け持つ。
   */
  registerSettings(registration: SettingsRegistration): void;
}
