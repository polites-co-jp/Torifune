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

`permissions` には**本体の Permission** か、**自分の名前空間**（`my-plugin.…`）を書く。
他の Plugin の名前空間は名乗れない。`system.*` は本体の予約。

---

## 5. データを保存する

Plugin ごとに分かれた Key-Value Store がある。**他の Plugin の領域は見えない。**

```ts
await context.store.set('last-run', new Date().toISOString());
const value = await context.store.get<string>('last-run');
await context.store.delete('last-run');
const keys = await context.store.keys('report.');
```

### Secret

資格情報は `setSecret` で保存する。暗号化され、`get()` では取り出せない。

```ts
await context.store.setSecret('api-token', token);
const token = await context.store.getSecret('api-token');
const configured = await context.store.hasSecret('api-token');
```

**Core は Plugin へ資格情報を渡さない。**
SNS の投稿を行う Plugin は、その資格情報を自分の名前空間で持つ。

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
* 資格情報は自分の名前空間の Secret に置き、ログへ出さない
  （`logger` に Secret を渡しても平文は出ないが、頼りにしない）
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
