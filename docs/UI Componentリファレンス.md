# UI Component リファレンス

Plugin が使える共通UIコンポーネントの一覧（`06_画面設計.md` §32、`07_開発者向けガイド.md` §57）。

正典は `apps/web/src/ui/components/index.ts` と各コンポーネントの型定義。
**この文書と食い違ったらコードが正しい。**

## 前提

* **Plugin は `ui/components` の入口だけを見る。** 個別ファイルへ直接 import すると、
  内部の再編で Plugin が壊れる。
* **UIライブラリを導入していない。** これらは自前の最小コンポーネントで、
  外部のUIフレームワークは入っていない（CLAUDE.md の技術スタック）。
* **色・寸法を直接書かない。** デザイントークン（CSS 変数 `--tf-*`）を使う。
  生の hex 値と px の直書きが無いことはテストで固定してある
  （`ui-shell.test.ts`「デザイントークン」）。

## 一覧

### 基本要素

| Component | 用途 | 主な Props |
| --- | --- | --- |
| `Button` | 押せるもの | `variant`（`ButtonVariant`）、標準の button 属性 |
| `Input` | 1行の入力 | 標準の input 属性 |
| `Textarea` | 複数行の入力 | 標準の textarea 属性 |
| `Select` | 選択 | 標準の select 属性 |
| `Checkbox` | 真偽の入力 | `CheckboxProps` |
| `Card` | 区切られた面 | `CardProps` |
| `Alert` | 伝達（`AlertTone` で調子を変える） | `AlertProps` |
| `Spinner` | 処理中 | — |

### フォーム

| Component | 用途 | 主な Props |
| --- | --- | --- |
| `FormField` | ラベル・説明・エラーを1項目にまとめる | `FormFieldProps` |
| `DateField` | 日付の入力 | `DateFieldProps` |

### 一覧・表示

| Component | 用途 | 主な Props |
| --- | --- | --- |
| `Table` | 表。`Column<T>` で列を宣言する | `TableProps<T>` |
| `Pagination` | ページ送り | `PaginationProps` |
| `Tabs` | タブ（`TabItem` で項目を宣言） | `TabsProps` |
| `Chart` | 折れ線（`ChartPoint` の並びを渡す） | `ChartProps` |
| `EmptyState` | 「まだ何も無い」の表示 | `EmptyStateProps` |

### 重ねるもの

| Component | 用途 | 主な Props |
| --- | --- | --- |
| `Modal` | 重ねて出す | `ModalProps` |
| `ConfirmDialog` | 危険な操作の確認（`06_画面設計.md` §37） | `ConfirmDialogProps` |
| `Toast` | 一時的な通知（`ToastMessage`） | `ToastProps` |
| `SecretField` | Secret の表示（`06_画面設計.md` §38） | `SecretFieldProps` |

## `SecretField` について

**Secret の平文を画面へ出さない。** `SecretField` は「設定済みかどうか」を見せ、
値そのものは見せない。Plugin が自分でフォームを書くと、
この扱いが Plugin ごとに変わり、どこかで平文が表に出る。

Plugin の設定項目は、**フォームを自分で書かずに宣言する**
（`PluginSettingsField` の `type: 'secret'`）。描画と保存は本体が行う。

## `Table` の使い方

`Column<T>` の `render` に関数を渡せる。**その場合、その画面は Client Component にする。**
Server Component から関数を Client Component へ渡すことはできず、
実行時に落ちる（実際にアナリティクス画面がこれで 500 になった）。

## レスポンシブ

幅375pxで破綻しないところまでを保証している（`06_画面設計.md` §31）。

**広い表はページではなく表の中でスクロールさせる。** `.tf-table-scroll` で包む。
包まないとページ全体が横に伸び、縦に読むだけの操作でも横へずれる。
