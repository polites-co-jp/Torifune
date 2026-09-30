# Plugin 開発ガイド

Torifune（とりふね）の Plugin の作り方。
題材は `plugins/example-plugin/`。このガイドの内容はすべてそこに実物がある。

> Plugin API の型定義は `packages/plugin-api/`。
> **Plugin はこのパッケージだけを見る。** 本体（`apps/web`）の中身は見ない。

---

## 1. 最小の Plugin

```text
plugins/
└── my-plugin/          ← ディレクトリ名 = Plugin ID
    ├── plugin.json
    └── index.ts        （index.tsx でもよい）
```

`plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "私のPlugin",
  "version": "1.0.0",
  "apiVersion": 1
}
```

`index.ts`:

```ts
import type { Plugin } from '@torifune/plugin-api';

const plugin: Plugin = {
  activate(context) {
    context.logger.info('動いた');
  },
};

export default plugin;
```

置いたら管理画面（`/plugins`）に「検出済み」として出る。
**置いただけでは動かない。** 導入して有効化する。

### 守ること

| 決まり | 理由 |
| --- | --- |
| ディレクトリ名と `id` を一致させる | 食い違うと、ファイルを見てどの Plugin か分からない |
| `id` は英小文字・数字・ハイフンで 2〜64 文字 | ルート・名前空間・設定キーに使う |
| `version` は Semantic Versioning | 依存関係の解決に使う |
| `activate` を持つオブジェクトを default export する | 本体はこの形だけを読み込む |

---

## 2. ライフサイクル

```text
（ファイルを置く） ──導入──→ installed ──有効化──→ enabled
                                 ▲                    │
                                 └───────無効化───────┘
```

| 呼ばれるもの | いつ |
| --- | --- |
| `activate(context)` | 有効化されたとき。**UI とイベントの登録はここで行う** |
| `deactivate(context)` | 無効化されたとき。自前の後始末だけ |
| `install(context)` | 導入時に1度だけ。初期データの投入など |
| `uninstall(context)` | 削除時 |

**`deactivate` で UI やイベントの後始末を書かなくてよい。**
`activate` で登録したメニュー・ページ・Widget・拡張点・イベント購読・Permission は、
本体が無効化時にまとめて取り下げる。

**`activate` が例外を投げると、その Plugin は `disabled` へ落ちる。**
本体は起動を続ける。Plugin ひとつの不具合で Torifune 全体が使えなくなるのは重すぎる。

---

## 3. 画面を足す

### 3.1 メニューとページ

```ts
context.ui.registerMenu({
  label: '私のPlugin',
  route: '/plugins/my-plugin',
  order: 50, // 小さいほど上。Core の項目のあとに並ぶ
});

context.ui.registerPage({
  route: '/plugins/my-plugin',
  component: MyPage,
  permission: 'site.read', // 任意
});
```

ページのルートは `/plugins/<plugin-id>/…` の名前空間に置く。
ただし `/plugins/<plugin-id>/settings`（§6）と `/plugins/<plugin-id>/help`（§6.1）は Core が使う。
登録しても Core の画面が出る（登録そのものは拒否されない）。
**`/plugins/<plugin-id>/help` とその 1 段下（`/plugins/<plugin-id>/help/<x>`）は Core が受ける。**
`help` を宣言しない Plugin でも Core が 404 を返し、Plugin のページには届かない。
2 段下（`/plugins/<plugin-id>/help/<x>/<y>`）から先だけが Plugin のページ（`registerPage`）に届く。
**Core が受けるのは上に挙げたパスだけで、それ以外のパスは Plugin のページに届く**（登録が無ければ 404）。
`/plugins/<plugin-id>/settings` も同じで、Core が受けるのは `/plugins/<plugin-id>/settings` ちょうどだけ。
その下（例：`/plugins/<plugin-id>/settings/<x>`）は Plugin のページに届く（既存の挙動）。
前方一致で最も長いものが選ばれるため、`/plugins/my-plugin/reports` を登録すれば
`/plugins/my-plugin/reports/123` もそこへ届く。

**`permission` は画面を隠すだけではない。** URL を直接叩かれても本体が止める。

### 3.2 ページに渡るもの

```tsx
export async function MyPage(props: Record<string, unknown>) {
  const data = props['data'] as PluginDataApi; // この要求の Data API
  const sites = await data.sites.list({ page: 1, perPage: 5 });
  return <div>{sites.total} 件</div>;
}
```

| プロパティ | 中身 |
| --- | --- |
| `pluginId` | 自分の ID |
| `route` | 解決されたルート |
| `data` | **その要求の Data API**。見ているユーザーの権限を通る |

> **`activate` で受け取った `context.data` を画面で使わない。**
> それは「起動したときのユーザー」の権限に縛られている。
> 画面では必ず、渡された `data` を使う。

### 3.3 Widget・Action・拡張点

```ts
// ダッシュボードなどに置く枠
context.ui.registerWidget({ location: 'dashboard', component: MyWidget });

// 一覧画面の操作列
context.ui.registerAction({
  location: 'site.list.actions',
  label: '同期',
  component: MyAction,
  // 対象リソース（06_画面設計.md §26）。任意。
  // 書かない Action は「リソースを問わない」として扱われ、
  // リソースで絞り込む場面でも消えない。
  resource: 'site',
});

// 既存画面の決められた差し込み口
context.ui.registerExtension({ point: 'site.edit.sidebar', component: MySidebar });

// 自分の画面に差し込み口を作り、他の Plugin へ公開する
context.ui.defineExtensionPoint('my-plugin.page.footer');
```

Core の拡張点は `CORE_EXTENSION_POINTS` にある。
ここに無い名前も使ってよい（Plugin が定義したもの）。
Core が扱うリソース名は `CORE_ACTION_RESOURCES` にあるが、これも閉じた集合ではない。

**ここにあるものはすべて実際に描画される。** 登録すれば必ずどこかに出る。

`login.methods` だけは認証前の画面なので、**Data API が渡らない**。
権限は空集合として扱われるため、`permission` を指定した登録は描画されない。

### 描画が失敗したとき

**Plugin の描画が例外を投げても、その枠だけが落ちる。** 画面全体は残り、
その位置に「表示できませんでした」とだけ出る。例外の内容は画面へ出ない
（サーバーのログには残る）。

そのため、**Plugin の不具合で Torifune 全体が使えなくなることはない。**
ただし利用者からは黙って欠けたように見えるので、失敗しうる処理は
自分で捕まえて意味のある表示を出すほうがよい。

実際の壊れ方は `plugins/example-plugin` の
「わざと壊れるページ」（`/plugins/example-plugin/broken`）で見られる。

### 3.4 見た目

**Torifune のデザイントークンに寄せる。**
独自の色や余白を持ち込むと、画面全体の統一感が崩れる。

```tsx
<div style={{
  background: 'var(--tf-color-bg)',
  border: '1px solid var(--tf-color-border)',
  borderRadius: 'var(--tf-radius-md)',
  padding: 'var(--tf-space-4)',
}} />
```

---

## 4. データを読む・書く

**Plugin は Torifune のデータベースへ直接 SQL を発行しない。**
Data API を通す。データベース構造が変わっても Plugin が壊れないようにするため。

```ts
const page = await data.sites.list({ page: 1, perPage: 20 });
const site = await data.sites.get(id);
await data.sites.create({ name: '…', url: 'https://…' });
```

呼び出しは **2つの認可** を通る。

1. Plugin が `plugin.json` の `permissions` で宣言しているか
2. 操作しているユーザーがその Permission を持っているか

宣言していない操作は `PluginPermissionError` になる。

```json
{ "permissions": ["site.read"] }
```

Data API の例外（`PluginPermissionError`・`PluginDataInputError` など）を捕まえなかったときは、
Plugin の描画ならその枠だけが「表示できませんでした」になり、イベントのハンドラならログ（`event handler failed`）に残るだけで発火元は成功する。

`permissions` には**本体の Permission** か、**自分の名前空間**（`my-plugin.…`）を書く。
他の Plugin の名前空間は名乗れない。`system.*` は本体の予約。

### 一覧の引数

**`page` / `perPage` は例外にせず丸める。** `page` は 1 以上、`perPage` は 1〜100。
小数は切り捨て、数にならない値（`NaN` など）は省略と同じ（1 / 20）に扱う。
採った値は戻り値の `page` / `perPage` に返る。1 回で返るのは 100 件までなので、
**全件が要るときは `total` までページを送る。**

```ts
const posts = await data.socialPosts.list({ accountId: account.id, perPage: 100 });
const campaigns = await data.campaigns.list({ siteId: site.id });
```

`socialPosts.list` の `accountId` と `campaigns.list` の `siteId` は**UUID の形（8-4-4-4-12 の 16 進）で渡す。**
形が違えば（空文字を含む）、返す `Promise` が `PluginDataInputError` で reject される。誤っていた引数の名前は `field` で分かる。判定は `error.name === 'PluginDataInputError'`（`name` は固定）か `instanceof PluginDataInputError` で行う（`instanceof` は `@torifune/plugin-api` の実体が Core と同じ 1 つであることを前提とするので、`name` での判定のほうが将来も確実）
（渡した値は例外に載らない）。**絞らないときは空文字ではなく省略する。** UUID の形で存在しない ID なら空の一覧が返る。

検査は `PluginPermissionError`（宣言）→ 利用者の Permission → `PluginDataInputError` の順で、権限の無い呼び出しには入力の誤りを返さない。

### 作成・更新の引数

`campaigns.create` / `campaigns.update` の `siteIds` / `socialPostIds` は、**UUID の形（8-4-4-4-12 の 16 進）で、存在するサイト／SNS 投稿の ID を 1000 件まで**渡す。
大文字・小文字は同じ ID として扱い、戻り値は小文字・重複なし・昇順になる。
省略（`undefined`）は、作成では「紐づけない」、更新では「変えない」。
満たさなければ（`null` を含む配列でない値・形の誤り・存在しない ID・1001 件以上）、返す `Promise` が `error.name === 'ValidationError'` の例外で reject され、何も書き込まれない。誤っていた項目は `field`（`'siteIds'` / `'socialPostIds'`）で分かる（渡した値は例外に載らない）。

`sites.create` / `sites.update`・`campaigns.create` / `campaigns.update` の `status` は列挙の値だけを渡す。列挙外の値は `ValidationError`（`field` は `'status'`）になる。

### 文字列の引数

作成・更新・検索の文字列の引数（`sites` の `name`・`url`・`description`、`campaigns` の `name`・`description`、`analytics.list` の `source`・`key`、
`socialPosts.markPublished` の `externalId`・`externalUrl`、`markFailed` の `reason` など）に **NUL（U+0000）か対になっていないサロゲート**を含むと、
返す `Promise` が `error.name === 'ValidationError'` の例外で reject され、何も書き込まれない。誤っていた項目は `field` で分かる（`markFailed` の `reason` は `'failureReason'`。渡した値は例外に載らない）。
どちらもデータベースに保存できない文字である。対になっていないサロゲートは、文字列を UTF-16 の長さで切って絵文字を半分にしたときに生じることが多いので、**コードポイント単位で切る**。
絵文字（対になったサロゲート）はそのまま使える。`analytics.record` の `key` は、NUL を含めこれまでどおり制御文字を断り（`内訳キーの形式が不正です。`）、対になっていないサロゲートも断る。
ID の引数はこの規則の外で、これまでどおり ID の形の検査が扱う（`get(id)` は `null` を返し、`socialPosts.list` の `accountId`・`campaigns.list` の `siteId` は `PluginDataInputError` で reject される）。

アナリティクスの値にはほかに次の規則がある。

* `analytics.list` の `from` / `to`、`analytics.record` の `metricDate` は `0001-01-01`〜`9999-12-31` の実在する日付（西暦 0 年は `ValidationError`。`field` は `'to'` / `'metricDate'`）
* `analytics.record` の `siteId` は UUID の形で、存在するサイトの ID（形が違えば `UUID の形で指定してください。`、無ければ `存在しないWebサイトです。`。`field` は `'siteId'`）
* `analytics.record` の `value` は 0 以上で、切り捨てた後に `Number.MAX_SAFE_INTEGER`（9007199254740991）以下（超えれば `field` は `'value'`）

これらは以前は Postgres の `DatabaseError` がそのまま reject されていた（または対になっていないサロゲートが U+FFFD に置き換わって黙って保存されていた）。

---

## 5. データを保存する

Plugin ごとに分かれた Key-Value Store がある。**他の Plugin の領域は見えない。**

```ts
await context.store.set('last-run', new Date().toISOString());
const value = await context.store.get<string>('last-run');
await context.store.delete('last-run');
const keys = await context.store.keys('report.');
```

### 保存できない文字

`set` の値（入れ子の文字列とオブジェクトのキーを含む）に **NUL（U+0000）か対になっていないサロゲート**を含むと、
返す `Promise` が `PluginStoreError`（`key` はその key。`message` に値は載らない）で reject され、保存されない（前の値が残る）。
`keys(prefix)` の `prefix` に NUL か対になっていないサロゲートを含むと空の配列が返る（キーに使える文字ではない）。
`setSecret` は暗号化して保存するので、NUL を含む値もそのまま保存でき、`getSecret` で同じ値が返る。

### Secret

資格情報は `setSecret` で保存する。暗号化され、`get()` では取り出せない。

```ts
await context.store.setSecret('api-token', token);
const token = await context.store.getSecret('api-token');
const configured = await context.store.hasSecret('api-token');
```

**自分だけで使う資格情報は、自分の名前空間の Secret に置く。**
外部サービスへ自分で繋ぐ Plugin は、上のように `setSecret` / `getSecret` で持つ。

**ただし SNS の配信 Plugin は、資格情報を自分で持たない。**
`social_accounts` に登録されたものが `publish()` の引数として、
**その呼び出しの間だけ**渡る（§9「SNS 配信（`social`）」）。
受け取った値を `setSecret` へ写さない。二重に持つと、どちらが正かが分からなくなる。

### 置ける範囲

**Plugin 専用のテーブルや Migration は提供していない**（`03_プラグイン設計.md` §19）。
Key-Value Store が扱えるのは、設定と少量のデータまで。

| 置ける | 置けない |
| --- | --- |
| キーで引くデータ、接頭辞での一覧 | 任意の項目での検索・並べ替え・集計 |
| Secret（暗号化して保存される） | 一意制約、外部キー、複数行にまたがる整合の保証 |
| 1値あたり 256KiB まで | それを超える値 |

行数が増えるデータや検索が要るデータを扱いたい場合は、**先に Issue で用途を挙げてほしい。**
使われる形が分かる前に仕組みを固めると、要らない制約を押し付けることになる。

---

## 6. 設定画面

**項目を宣言するだけでよい。** 画面と保存は本体が行う。

```ts
context.ui.registerSettings({
  fields: [
    { key: 'greeting', label: 'あいさつ', kind: 'text' },
    { key: 'api-token', label: 'APIトークン', kind: 'secret' },
  ],
  validate: (values) =>
    (values['greeting']?.length ?? 0) > 40 ? { greeting: '40文字以内で。' } : null,
});
```

`/plugins/<plugin-id>/settings` に出る。`plugin.manage` が要る。

* `kind: 'secret'` は暗号化して保存し、**画面に平文を出さない**。「設定済み」だけを見せる
* Secret の入力欄を空のまま保存すると**変更しない**。空で上書きすると、
  保存し直すたびに資格情報が消える
* 宣言していないキーは保存できない

値は通常の Key-Value Store に入る。`context.store` から読める。

**`/plugins` のカードの「設定」は、設定（`registerSettings`）か手順書（§6.1 の `help`）を持つ、
有効で読み込まれた Plugin にだけ出る。** 行き先は `/plugins/<plugin-id>/settings`。
手順書だけを持つ Plugin の設定画面には、手順書の一覧と「この画面で変える設定がありません」の注記が出る。
設定も手順書も持たない Plugin には「設定」が出ない（独自のページはメニュー（§3.1）から開く）。

### 6.1 手順書（`help`）

**Plugin は、利用者向けの手順書を Markdown で同梱し、Torifune の画面で読ませられる。**
外部サイトへのリンクで済ませず、Plugin のフォルダの中に置いて `plugin.json` の `help` で宣言する。
コードを書く必要は無い。

```text
plugins/
└── my-plugin/
    ├── plugin.json
    ├── index.ts
    └── help/
        ├── credentials.md
        └── troubleshooting.md
```

`plugin.json`:

```json
{
  "id": "my-plugin",
  "name": "私のPlugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "help": [
    { "id": "credentials", "title": "API キーの発行手順", "path": "help/credentials.md" },
    { "id": "troubleshooting", "title": "うまく動かないとき", "path": "help/troubleshooting.md" }
  ]
}
```

| 項目 | 規則 |
| --- | --- |
| `help` | 配列。`[]` は宣言なしと同じ。最大 10 件（`PLUGIN_HELP_LIMITS.maxDocs`）。**並びが画面の並びで、先頭が「最初に読む手順書」** |
| `id` | URL の一部（`/plugins/<plugin-id>/help/<id>`）。英小文字・数字・ハイフンで 1〜64 文字、先頭は英小文字か数字。`help` の中で重複しない |
| `title` | 画面に出す題名。前後の空白を除いて 1〜80 文字 |
| `path` | Plugin のフォルダからの `/` 区切りの相対パスで、小文字の `.md` で終わる（200 文字まで）。`..`・`.` で始まる名前（隠しファイル）・先頭の `/`・`\`・ドライブ名・URL は書けない。`help` の中で重複しない |

要素に未知のキーを足しても拒まれない（後から項目を足せるように）。
型と上限は `@torifune/plugin-api` の `PluginHelpDoc` と `PLUGIN_HELP_LIMITS`。

**形が誤っていても Plugin は読み込まれる。** `help` の規則を 1 つでも破ると、`help` 全体が無いものとして扱われ、
読み込みのたびにログへ警告（`plugin manifest has warnings`、`fields: ['help']`）が出る。
手順書が画面に出ないときは、まずこの警告を探す。zip の導入（§10）も `help` の誤りでは止まらない。

#### どこに出るか

| 場所 | 出るもの |
| --- | --- |
| `/social` の「SNSアカウントを追加」と「資格情報を設定」の Modal | その provider の publisher を登録した Plugin の**先頭の手順書**を開くヘルプボタン（資格情報の欄を宣言した publisher、または `credentialFields: []` の publisher のとき）。**SNS 配信 Plugin は資格情報の手順書を先頭に置く** |
| 設定画面 `/plugins/<plugin-id>/settings` | 「手順書」の欄に、宣言の順ですべての手順書へのリンク（設定のフォームより上） |
| `/plugins/<plugin-id>/help` | 手順書の一覧 |
| `/plugins/<plugin-id>/help/<id>` | 手順書の本文 |

* ヘルプボタンと設定画面のリンクは**新しいタブ**で開く（入力中のフォームを消さないため）
* `/plugins` のカードには手順書を出さない
* **有効で読み込まれた Plugin の手順書は、ログインしていれば誰でも読める**（資格情報を入れる人の多くは `plugin.manage` を持たない）。
  有効にする前の Plugin の手順書は、**ビルドに取り込まれた後（導入の再ビルドの後）から**、`plugin.manage` を持つ管理者だけが URL で読める（他の人には 404。画面からの入口は無い）。
  `plugins/` に置いただけで再ビルドしていない Plugin は、登録簿に無いので 404 になる。
  **有効にする前に読ませたい手順書は、README に `/plugins/<plugin-id>/help/<id>` の URL を書く**

#### ファイル

* Plugin のフォルダの中に置く。シンボリックリンクで外を指すと読まれない
* **UTF-8**（先頭の BOM は除かれる）、**256 KiB 以下**（`PLUGIN_HELP_LIMITS.maxFileBytes`）
* 本文は**要求のたびにファイルから読む**（埋め込みもキャッシュもしない）。
  **本文の直しは再起動が要らない。** `help` の宣言を足す・変えたときは、Manifest の他の項目と同じく
  `pnpm generate:plugins` と再起動が要る
* 読めないとき（ファイルが無い・大きすぎる・UTF-8 でない）、画面は「読み込めませんでした」と出し、
  理由はログ（`plugin help could not be read`）にだけ残る

#### 描かれるもの・描かれないもの

GitHub と同じ Markdown（GFM：表・チェックリスト・打ち消し線を含む）を、サーバの上で描く。

| 書いたもの | Torifune での描かれ方 |
| --- | --- |
| 先頭の `# 題名` | **描かない**（画面の見出しは `title` が持つ）。GitHub で読んでも題名が出るように、`title` と同じ文言の `#` で書き始める。2 つ目以降の `#` は 1 段下の見出しで描く |
| 見出しのアンカー | GitHub と同じ規則の `id` に `help-` を前に付けたもの。**目次は `[手順 1：…](#手順-1…)` と GitHub のとおりに書けば Torifune でも動く** |
| 表・コードの囲み | 狭い画面では枠の中で横に動く。コードの色付けはしない |
| 画像 `![説明](…)` | **描かない。** 「［画像：説明］」の文字になる（スクリーンショットは載せず、画面の名前を文字で書く） |
| 生の HTML（`<script>`・`<br>` など） | **解釈しない。** 文字としてそのまま見える |

#### リンク

| 書いたもの | 描かれ方 |
| --- | --- |
| `https://…` / `http://…` | 新しいタブで開く外部リンク（`rel="noopener noreferrer"`） |
| 宣言した別の手順書への相対パス（`./troubleshooting.md`、`#断片` つきも可） | 同じタブでその手順書の画面へ |
| `#断片` | 同じ手順書の中の見出しへ |
| `/` で始まる Torifune の中のパス | 同じタブで開く |
| それ以外（`javascript:`・`data:`・`mailto:`・`//…`・宣言していない `.md`（`README.md` を含む）・フォルダの外） | **リンクにしない**（文字だけ） |

手順書から README へはリンクできないので、手順書は README に頼らず完結させる。
README には要約と手順書へのリンクを置き、詳しい手順は手順書だけに書く（同じ内容を 2 か所に持つと片方だけ直されて食い違う）。

見本は `plugins/example-plugin/help/`（`usage.md` は本物の手順書と同じ見出しの順の短い見本、
`markdown.md` は使える書き方と描かれないものの見本）。
同梱の SNS 配信 Plugin（`sns-bluesky` など）の `help/credentials.md` が実物である。

---

## 7. イベント

```ts
context.events.subscribe('site.created', (payload) => {
  // payload の型は自動で付く
  context.logger.info('作られた', { siteId: payload.siteId });
});

await context.events.emit('my-plugin.done', { at: '…' });
```

* **ハンドラが例外を投げても、発火元は成功する。** Plugin の不具合で
  「サイトが作れない」といった壊れ方をしない
* **Core のイベント名は発火できない。** 騙れると他の Plugin を誤作動させられる
* 自分のイベント名は `<plugin-id>.` で始める

Core が発火するイベントは `CORE_EVENTS` にある。

---

## 8. 依存

```json
{ "dependencies": { "base-plugin": "^1.0.0" } }
```

* 依存先が導入されていない・無効・バージョンが範囲外なら、有効化できない
* 循環依存は検出して拒否する
* **依存先を無効化すると、依存元も無効化される**

範囲の書き方は `^1.2.3` / `~1.2.3` / `1.2.3` / `*`。
`^0.x.y` は 0.x 系に留まる（0 系は互換性が保証されないため）。

---

## 9. 高権限の拡張点

### Database Provider

データベース接続方式そのものを差し替える。

```json
{ "extensions": ["database"] }
```

```ts
context.database.registerProvider({
  id: 'my-plugin.provider',
  async connect() { /* … */ },
  async disconnect() { /* … */ },
  async healthCheck() { return true; }, // 例外を投げない
});
```

**宣言していなければ使えない**（`PluginExtensionNotDeclaredError`）。
差し替えると本体のすべてのデータアクセスがこの Provider を通る。
実物の例は `plugins/example-plugin/database.ts`（ログを出すだけのダミー）。

> 差し替えは**元へ戻らない**。戻すには再起動が要る。
> 動いている最中に接続方式を差し替えると、走っている処理が道連れになるため。

### Authentication Provider

認証方式そのものを差し替える。**最も高い権限の拡張点。**

```json
{ "extensions": ["authentication"] }
```

```ts
context.authentication.registerProvider({
  id: 'my-plugin.oidc',
  async authenticate(credentials, context) {
    // 外部へ問い合わせ、Torifune のユーザーへ結び付ける
    return { ok: true, identity: { userId, loginId, displayName, email,
      providerId: 'my-plugin.oidc', externalUserId } };
  },
  async getIdentity() { return null; },
  async logout() { /* … */ },
  async refresh() { /* … */ },
});
```

**宣言していなければ使えない**（`PluginExtensionNotDeclaredError`）。

守られている境界が2つある。

* **セッションは Torifune が発行する。** Provider が決めるのは「誰か」まで。
  セッションの発行・ハッシュ保存・ログイン時の再生成・有効期限・
  アイドルタイムアウトは Core に残る（`04_認証設計.md` §22）
* **`userId` は Torifune に実在するユーザーの ID でなければならない。**
  実在しなければログインは資格情報の誤りとして扱われる。
  返した `displayName` / `email` / `providerId` は採用されず、
  本体が持つユーザー情報と、登録された Provider の ID が使われる

`POST /api/v1/auth/login` の `loginId`・`password` に NUL（U+0000）か対になっていないサロゲートを含む要求は、
Core が 422 で先に断るので `authenticate()` には届かない（`046` 設計 §6.3）。`authenticate()` の契約は変わらず、
Provider の側で同じ検査を持っていても害は無い（Core を経ずに呼ばれることは無いが、古い Core で動くときの守りになる）。

外部の利用者を初回ログインで自動作成する仕組み（JIT プロビジョニング）は、
まだ提供していない。新規ユーザーへどのロールを与えるかが決まっていないため。
必要な場合は Issue で用途を挙げてほしい。

実物の例は `plugins/example-plugin/authentication.ts`。
`EXAMPLE_PLUGIN_AUTH_USER_ID` に実在するユーザーの ID を渡したときだけ差し替わる。

> 差し替えは**元へ戻らない**。戻すには再起動が要る。
> 認証中のセッションを持つ利用者が居るところへ差し戻すと、
> 誰が認証済みなのかの判定が途中で変わる。

#### リダイレクト往復（OIDC / SAML / SNS ログイン）

`authenticate()` は「ID とパスワードを受け取って照合する」形しか表せない。
**ブラウザを外部の認可エンドポイントへ送り出して戻ってくる**方式では、
次の2つを**任意実装**として足す。

```ts
context.authentication.registerProvider({
  id: 'my-plugin.oidc',
  // authenticate / getIdentity / logout / refresh は同じ

  async startAuthorization(context) {
    // **state / nonce / redirect_uri は自分で作らない。** Torifune が渡す。
    const url = new URL('https://idp.example/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('redirect_uri', context.redirectUri);
    url.searchParams.set('state', context.state);
    url.searchParams.set('nonce', context.nonce);
    return { ok: true, authorizationUrl: url.toString() };
  },

  async completeAuthorization(callback) {
    // 1. callback.params.code を Token Exchange する（callback.redirectUri を使う）
    // 2. ID Token の iss / aud / exp / 署名 / Claim を検証する
    // 3. ID Token の nonce Claim が callback.nonce と一致することを確かめる
    // **state の照合は Torifune が済ませてある。** ここでやり直さない
    return { ok: true, identity: { /* … */ } };
  },
});
```

**両方を実装するか、両方とも実装しないか。** 片方だけでは往復が閉じず、
「認可画面へは飛ぶがログインは決して成立しない」という気づきにくい壊れ方になる。

ログイン画面へボタンを出すには、`login.methods` 拡張点へリンクを1つ差し込む。

```tsx
import { AUTHORIZATION_START_PATH } from '@torifune/plugin-api';

ui.registerExtension({
  point: 'login.methods',
  component: () => <a href={AUTHORIZATION_START_PATH}>SSOでログイン</a>,
});
```

**パスを直書きしない。** 外部 Provider へ登録する Redirect URI は
`AUTHORIZATION_CALLBACK_PATH`（`/api/v1/auth/callback`）である。

Torifune 側が受け持つのは次のとおり（`04_認証設計.md` §27 の表）。

* State の発行・保管・照合・有効期限（10分）・**使い捨て**
* Nonce の発行と State への束縛（**Claim との照合は Plugin**）
* Redirect URI の決定と、コールバック時の照合
* コールバックの正当性（通常の CSRF 検証は外部からのリダイレクトに効かないため、
  State 検証がその役目を担う）
* ログイン後の遷移先の検証（Open Redirect 対策）
* セッションの発行と監査ログ

Plugin が受け持つのは、認可要求の組み立て・Token Exchange・Token 検証・
外部の識別子から Torifune のユーザーを引くところまで。

実物の例は `plugins/example-plugin/authentication.ts` の
`startAuthorization` / `completeAuthorization`。
**外部サービスへ繋がず、コールバックへそのまま戻る**（0ホップの IdP）。
短絡しているのは「外部 Provider が居るかどうか」だけで、
State の発行と照合・使い捨て・セッション発行は本番と同じ経路を通る。

### SNS 配信（`social`）

SNS への実際の投稿を受け持つ。**Plugin が書くのは「1 回配信する関数」と
「投稿画面の URL を返す関数」だけ。** いつ送るか・再試行・記録・画面は Torifune が持つ。

```json
{ "extensions": ["social"] }
```

```ts
context.social.registerPublisher({
  provider: 'bluesky',            // social_accounts.provider と同じ値
  label: 'Bluesky',               // 画面の表示名。Torifune の対応表より優先される
  credentialFields: [
    { key: 'identifier', label: 'ハンドル', kind: 'text' },
    { key: 'appPassword', label: 'App Password', kind: 'secret' },
  ],
  limits: { bodyMaxLength: 300, mediaMax: 4 },

  validate({ post, account }) {
    // 登録時の事前検査。問題が無ければ空配列
    return post.body.length > 300 ? [{ field: 'body', message: '300文字以内で。' }] : [];
  },

  async publish({ post, account, credential, attempt, signal, logger }) {
    // credential は credentialFields で宣言したキーがそのまま入る
    const id = await postToBluesky(post, credential, signal);
    return { ok: true, externalId: id, externalUrl: `https://bsky.app/…/${id}` };
  },

  manual({ post, account }) {
    return { url: 'https://bsky.app/intent/compose?text=' + encodeURIComponent(post.body) };
  },
});
```

本文を URL に埋め込む `manual()` は、URL が 2048 文字を超えうる（日本語 1 文字は URL の中で 9 文字）。
**`validate()` で手動投稿のときに URL の長さを確かめ、登録時に断る**（`/` で始まる Torifune 内のパスも 2048 文字以内に収める）。

**宣言していなければ使えない**（`PluginExtensionNotDeclaredError`）。
登録した provider の資格情報が `publish()` の引数として渡るため、
Plugin を入れる側が「どの Plugin が資格情報を受け取るか」を導入時に見られるようにしてある。

> **Manifest の `extensions` は、導入前の Plugin マネージャ（`/plugins`）に表示される。**
> `social` は「SNS配信（SNSアカウントの資格情報を受け取ります）」として、
> 要求 Permission の隣に並ぶ（`database` / `authentication` / `data` / `events` / `ui` も同じ場所に出る）。
> **入れる前に何を握るかが読まれる**という前提で宣言すること。
> 有効化した後は、その Plugin が登録した provider も同じ一覧に出る。

| 項目 | 役割 |
| --- | --- |
| `credentialFields` | **資格情報の形の宣言だけ。** 入力欄の描画・形式検証・暗号化・保存・再表示しないことは Torifune が持つ。`kind: 'secret'` は打ち込むときに伏せる項目という意味で、保存はどの項目も暗号化される。空なら資格情報なしで `publish()` が呼ばれる（`credential` は `{}`）。**空なら `/social` に資格情報の欄を出さない**（アカウント追加にも、行の「資格情報を設定」にも出ない）。各項目の `description` は `/social` の欄の下に説明として出る（入力の時点で読ませたいこと、たとえばどこで・どの権限で発行するかを書く）。**`description` は 1〜2 文の要点にとどめ、発行の手順の全体は手順書（§6.1 の `help`）に書く**（`/social` にその手順書を開くヘルプボタンが出る）。空の publisher の provider で画面から作ったアカウントは `status: 'connected'`、`credentialConfigured` は通常 `false` になる。**どちらも資格情報の有無の約束ではない**（`status` は画面の表示のため、`credentialConfigured` は保存されているかだけ） |
| `limits` | `bodyMaxLength` / `mediaRequired` / `mediaMax`。**適用するのは Torifune**（投稿の登録時に 422 で弾く）。文字数の数え方は SNS ごとに違うので、ここは早く弾くための粗い上限 |
| `validate` | 事前検査。`field` は要求のフィールド名（`body` / `media` / `link` / `providerOptions.<key>`）。返した文言がそのまま 422 の `details` と投稿フォームに出る |
| `publish` | 自動配信。**1 回送るだけ。** 再試行の回数・間隔・打ち切りは Torifune が決める |
| `manual` | 手動投稿。投稿内容を反映した**投稿画面の URL**（Web Intent）を返すだけ。資格情報は渡らない。**https の URL は 2048 文字以内**（超えると手動投稿待ちの行が「Plugin が返した URL を開けません」になる） |

#### 呼ばれる場面と制限時間

**`limits` と `validate()` は、登録時だけでなく配信直前にももう一度掛かる。**
配信 Plugin が無い間に登録された投稿は登録時の検査を一度も通っていないので、
**その投稿にとっては配信直前が唯一の判定機会**になる。

| 関数 | いつ呼ばれるか | 制限時間 | 超えたら |
| --- | --- | --- | --- |
| `validate` | 投稿の登録・更新時と、**配信直前**（`publish()` の直前） | **5 秒** | 登録時は 500、配信直前は `failed`（**未送信**。「結果不明」ではない） |
| `publish` | 予約時刻が来たとき | 30 秒（`signal` が発火する） | `failed`（結果不明） |
| `manual` | `/social` の「手動投稿待ち」を描くとき | **2 秒** | その行は「Plugin でエラーが起きました」になる（画面は止まらない） |

配信直前の検査に通らなかった投稿は、**`publish()` を呼ばずに `failed`** になる。
再試行はしない（宣言に合わない投稿は、時間が経っても合うようにはならない）。

* **`validate()` を重くしない。** 外部サービスへ問い合わせる実装にすると、5 秒を超えて登録が 500 になる
* `manual()` は 1 画面で最大 50 行ぶん呼ばれる。**同期で待たない**
* いずれも打ち切りは `Promise.race` なので、**同期の無限ループは止められない**

#### `retryable` の基準

```ts
return { ok: false, reason: '送信できませんでした。', retryable: true, retryAfterMs: 300_000 };
```

**「送る前に失敗した」なら `true`、「届いたか分からない」なら `false`。**

| 起きたこと | `retryable` |
| --- | --- |
| 送信前のネットワーク断、429、（まだ送っていない）認証エラー | `true` |
| 5xx、タイムアウト、応答の解釈に失敗した | `false` |
| 迷ったとき | `false`（二重投稿より未投稿のほうがまし） |

**SNS の投稿は取り消せない。** だから `true` は「絶対に届いていない」と言えるときだけにする。

* `reason` は利用者に見せる理由（履歴画面に出る）。**資格情報を含めない**
* `retryAfterMs` は Torifune の既定（1 → 2 → 4 → 8 分）より長いときだけ使われる（上限 24 時間）

#### 例外は「結果不明」になる

**`publish()` が例外を投げると、その投稿は再試行されずに `failed`（結果不明）になる。**
タイムアウト（30 秒）も同じ。届いたかどうかを Torifune が判断できないためで、
`retryable: true` のつもりで例外を投げても再送はされない。
**送る前の失敗は、必ず `{ ok: false, retryable: true }` で返す。**

`signal` は 30 秒で発火する。以後の処理は打ち切ってよい。

#### 資格情報の更新（`rotatedCredential`）

トークンの期限が延びたときなどは、**自分で保存し直さない。**

```ts
return { ok: true, externalId: id, rotatedCredential: { ...credential, accessToken: next } };
```

Torifune が暗号化して書き戻し、監査ログにも残す。
キーは `credentialFields` のまま。宣言に合わないものは書き戻されず、警告がログに出る。

**返した値が保存されない場合がある。** 配信の間に運用者が資格情報を変えた・消した場合（同じ値を入れ直した場合を含む）は、返した値は保存されない（運用者の値を優先する。
Torifune は配信の前に読んだ資格情報と、書き戻す時点の資格情報が同じときだけ書き戻す）。`credentialFields` が空の publisher が返した値も保存されない。
どちらも警告がログに出るだけで、投稿の結果は変わらない。

#### 守ること

* **資格情報の値をログに渡さない。** `logger` へ渡した文字列と `reason`・例外のメッセージからは、
  Torifune がその呼び出しで渡した資格情報の値を `***` に伏せる。
  ただし**消せるのは「4 文字以上の値」が「そのままの形で」含まれているときだけ**である。
  値を切った・繋いだ・エスケープした・符号化した（Base64、URL エンコード、JSON の `\"` 混じり）ものは
  **素通りする。3 文字以下の値も伏せられない**（関係のない文字列まで潰してしまうため）。
  **伏せる仕掛けを当てにせず、値を渡さない**
* **受け取った `credential` を保存し直さない。** その呼び出しの間だけ有効な値である
* **自前のタイマーを持たない。** 複数プロセスで動かすと二重投稿になる
* **戻り値に NUL（U+0000）を含む URL を返さない。** `publish()` の `externalUrl` は記録されず（配信の結果は記録される）、
  `manual()` の `url` は「Plugin が返した URL を開けません」になる。
  `reason`・例外の文言・`externalId` の NUL と対になっていないサロゲートは、資格情報の伏せ字の後に U+FFFD に置き換えて記録する
* **`validate()` には NUL・対になっていないサロゲートを含む `body` / `link` は届かない。** Torifune が登録の時点で先に 422 で断る。
  それでも Plugin の側で検査してよい（Torifune の古い版では届く。Plugin は Core の内部の規則に依存しない）
* **同じ `provider` を登録できるのは 1 つの Plugin だけ。**
  別の Plugin が既に登録していると `PluginPublisherConflictError` になり、後から有効化したほうが `disabled` に落ちる
  （同じ Plugin が同じ provider をもう一度登録した場合は置き換わる）

#### Torifune が持つもの

**手動投稿の待ち行列・子ウィンドウ・「投稿した／取りやめ」の操作は Torifune の画面（`/social`）が持つ。**
`manual()` が返すのは URL と注意書きだけで、Plugin は画面を作らない。

配信のスケジュール・排他・着手印（二重投稿の防止）・再試行・結果の記録・
`social.post.published` / `social.post.failed` の発火も Torifune 側にある。
`data.socialPosts.markPublished()` を `publish()` から呼ぶ必要は無い。

`publish()` を実装しない publisher を登録してもよい（手動投稿だけを受け持つ形）。
その場合でも**その provider への自動配信の予約は断られない。**
支度が整うまで定期実行が飛ばして待ち、画面には「配信 Plugin なし」の警告が出る。
逆に `manual()` を実装しなければ、その provider の `deliveryMode: 'manual'` は 422 で断られる。

**ただし、待つのは約 24 時間まで。** 配信 Plugin が有効にならない／アカウントの資格情報が
設定されないまま飛ばされ続けた予約は、**予約時刻からおよそ 24 時間で `failed`** になる
（同じ理由で 3 回飛ばした時点。1 回目の後に 1 時間、2 回目の後に 23 時間あけて見に行く）。
`failed` は終端で、後から Plugin を有効にしても自動では戻らない
（運用者が新しい投稿として登録し直す）。
**Plugin を配る側は、導入してから資格情報が入るまでにこの猶予しかないことを README に書いておくとよい。**

実物の例は `plugins/example-plugin/social.ts`（**外部へ繋がないループバックの publisher**）。
外部アプリから投稿を登録する手順は [`docs/マニュアル/SNS投稿の外部連携.md`](マニュアル/SNS投稿の外部連携.md)。

---

## 10. 導入する

### ローカルに置く

`plugins/<id>/` へ置いて `/plugins` を開く。「検出済み」に出る。
「導入」を押すと要求 Permission が表示され、同意すると導入される。

**導入は再ビルドと再起動を伴う。** Plugin の読み込みはビルド時に固定されるため。
コンテナで動かしていれば自動で再起動する。開発中は `pnpm dev` を再起動する。

### Plugin Package（zip）

```text
my-plugin.zip
└── my-plugin/
    ├── plugin.json
    └── index.ts
```

`/plugins` の「Pluginを追加」から選ぶ。

以下は拒否される。

* `..` を含むパス、絶対パス、シンボリックリンク
* 展開後の合計サイズ・ファイル数が上限を超えるもの
* トップレベルが1ディレクトリでないもの
* すでにある Plugin ID

**ビルドに失敗した Plugin は隔離される**（`.torifune-quarantine` が置かれる）。
本体は直前の成功ビルドへ戻って起動する。原因を直したらマークを消して入れ直す。

---

## 11. 開発の進め方

```bash
pnpm generate:plugins   # plugins/ を走査してレジストリを作る
pnpm dev                # 先に generate:plugins が走る
pnpm lint               # 境界の検査を含む
pnpm typecheck
```

Plugin のコードは本体と同じ TypeScript の設定で検査される。
`@torifune/plugin-api` と `react` はリポジトリのルートから解決される。

### やってはいけないこと

| すること | なぜ |
| --- | --- |
| `@/` や `apps/web` を import する | 本体の再編で Plugin が壊れる |
| `pg` / `kysely` を直接使う | データベース構造の変更が Plugin へ直撃する |
| 他の Plugin の名前空間を名乗る | 権限やイベントを横取りできてしまう |
| `system.*` の Permission を宣言する | システム管理相当の権限を勝手に定義できてしまう |

これらは `plugins/example-plugin` に対する自動テストで実際に検査している
（`apps/web/src/plugin/example-plugin.integration.test.ts`）。

---

## 12. 覚えておくこと

**Plugin の導入は、実質的にアプリへのコード導入である。**
Plugin は信頼されたコードとして動く。特に Database Provider は高い権限を持つ。

だからこそ、

* 要求する Permission は**必要な最小限**を宣言する
* 自分で外部サービスに繋ぐ Plugin の資格情報は自分の名前空間の Secret に、
  SNS アカウントの資格情報は Core の `social_accounts` に置く（受け取るのは `publish()` の引数として、
  その呼び出しの間だけ。§9「SNS 配信（`social`）」）。どちらもログへ出さない
  （`logger` の伏せ字は**完全一致の 4 文字以上**にしか効かないので、頼りにしない。§9）
* 拡張点は宣言したものだけを使う

---

## 参照

| 文書 | 内容 |
| --- | --- |
| `docs/仕様書/03_プラグイン設計.md` | Plugin の全体設計 |
| `docs/仕様書/06_画面設計.md` §17-30 | Plugin と画面 |
| `docs/設計/010-plugin-api/` | 公開契約の設計 |
| `docs/設計/011-plugin-runtime/` | 読み込みとライフサイクル |
| `docs/設計/012-plugin-manager/` | 管理画面と導入 |
| `docs/設計/013-example-plugin/` | このガイドの題材 |
| `docs/設計/041-plugin-help-docs/` | 手順書（`help`）の仕組み |
