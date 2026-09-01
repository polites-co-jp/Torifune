# Torifune（とりふね）

Torifune is an open source application for managing marketing activities — websites and
social media — in one place. It runs standalone and is extended through a first-class
plugin system.

Torifune（とりふね）は、WebサイトやSNSなどのマーケティング活動を
一元管理するオープンソースアプリケーションです。単体で動作し、プラグイン機構によって
機能を拡張できます。

> **Status: 開発初期。** まだ動作する機能はほとんどありません。
> 進行中の計画は [`docs/実装計画/`](docs/実装計画/) を参照してください。

## 主な機能 / Features

|                    |                                                                    |
| ------------------ | ------------------------------------------------------------------ |
| マーケティング管理 | Webサイト、SNSアカウント・投稿の管理                               |
| プラグイン機構     | 画面・メニュー・ウィジェット・イベント・データアクセスを拡張できる |
| 認証の差し替え     | Authentication Provider によって認証方式を差し替えられる           |
| DB接続の差し替え   | Database Provider によって接続方式を差し替えられる                 |
| 単体で動作         | 特定のクラウド・SaaS基盤・ユーザー管理サービスに依存しない         |

## 動作要件 / Requirements

- Node.js 22 以上
- pnpm
- PostgreSQL 17（開発時は同梱の `compose.yaml` を利用できます）

## 導入 / Installation

Torifune を自分のサーバーで動かす手順です。開発したい場合は次節へ。

```bash
git clone https://github.com/polites-co-jp/Torifune.git
cd Torifune
pnpm install

cp .env.example .env
```

`.env` に最低限これらが要ります。

| 変数                         | 内容                                               |
| ---------------------------- | -------------------------------------------------- |
| `DATABASE_URL`               | PostgreSQL への接続文字列                          |
| `TORIFUNE_ENCRYPTION_KEY`    | SNS の資格情報とプラグインの Secret を暗号化する鍵 |
| `TORIFUNE_ENCRYPTION_KEY_ID` | 鍵の世代識別子（例: `k1`）                         |

暗号化鍵は次で生成します。

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

> **鍵はデータベースに保存されません。** 鍵を失うと、暗号化して保存した値は
> データベースが無事でも復号できません。バックアップは
> [`docs/運用/バックアップとリストア.md`](docs/運用/バックアップとリストア.md) を参照してください。

スキーマを作り、ビルドして起動します。

```bash
pnpm migrate
pnpm build
pnpm start
```

ブラウザで開くと `/setup` へ誘導され、最初の管理者を作成できます。

HTTPS で公開してください。HTTP のままでは、セッション Cookie に `Secure` が付かず、
HSTS も送られません。

管理者のパスワードが分からなくなった場合は、下の
「[パスワードの復旧](#パスワードの復旧--password-recovery)」を参照してください。

## 開発環境の構築 / Development Setup

```bash
git clone https://github.com/polites-co-jp/Torifune.git
cd Torifune

pnpm install
cp .env.example .env          # 必要な値を埋める

docker compose up -d postgres # 開発用 PostgreSQL
pnpm dev                      # http://localhost:3000
```

初回起動時、管理者が1人もいない状態では `/setup` で最初の管理者を作成します。

### コマンド

```bash
pnpm dev            # 開発サーバ
pnpm build          # 全ワークスペースのビルド
pnpm start          # ビルド済みアプリの起動
pnpm lint           # ESLint
pnpm format         # Prettier（--check は format:check）
pnpm typecheck      # 型検査
pnpm test           # ユニット・結合テスト（Vitest）
pnpm test:e2e       # E2E（Playwright）
pnpm migrate        # DB マイグレーション
```

### テスト用データベース

結合テストと E2E には PostgreSQL が要ります。

```bash
docker compose up -d postgres-test
```

- **結合テスト**（`pnpm test`）は `TORIFUNE_TEST_DATABASE_URL` を見ます。
  テストごとに使い捨てのデータベースを作るので、既存のデータは触りません。
- **E2E**（`pnpm test:e2e`）は `DATABASE_URL` を見て、**そのデータベースの行を
  全部消してから**開始します。E2E 専用のデータベースを指してください。

```bash
# 初回だけ
docker compose exec postgres-test psql -U torifune -d postgres -c 'CREATE DATABASE torifune_e2e;'

DATABASE_URL=postgres://torifune:torifune@localhost:21701/torifune_e2e pnpm migrate
DATABASE_URL=postgres://torifune:torifune@localhost:21701/torifune_e2e pnpm test:e2e
```

名前に `test` / `e2e` を含まないデータベースへ向けると E2E は中止します。
開発用の `.env` を読んだまま実行して、開発中のデータを消さないためです。

### パスワードの復旧 / Password recovery

画面からのパスワードリセットはメールでトークンを配ります。
メール送信を設定していない構成では使えないため、
**サーバーへ入れる人だけが実行できる復旧経路**を CLI に用意しています。

```bash
# 新しいパスワードを標準入力から渡す
printf %s "$NEW_PASSWORD" | torifune reset-password --login-id=admin

# パスワードを生成して1度だけ表示する
torifune reset-password --login-id=admin --generate
```

パスワードは引数では受け取りません。引数はシェルの履歴と `ps` に平文で残るためです。
再設定すると、そのユーザーの有効なセッションはすべて失効します。

## プラグイン / Plugins

プラグインは `plugins/<plugin-id>/` に配置します。
公開 API の契約は [`packages/plugin-api`](packages/plugin-api/) にあり、
プラグインは Torifune 本体の内部実装へ直接依存しません。

```text
plugins/
└── my-plugin/
    ├── plugin.json      # 必須。ディレクトリ名と id を一致させる
    ├── index.tsx        # 必須（index.ts でも可）。Plugin を default export する
    └── README.md
```

`plugin.json` と `index.ts`/`index.tsx` だけが必須です。
それ以外のファイル・ディレクトリの構成は自由です。
プラグインのデータは Plugin Store（`context.store`）へ保存します。
プラグインが独自のテーブルやマイグレーションを持つ方式は提供していません。

> **注意：プラグインは信頼されたコードとして扱われます。**
> インストールは、実質的に Torifune へ追加のコードを導入する操作です。
> 導入元の信頼性を確認してください。

## ドキュメント / Documentation

|                                                                          |                                     |
| ------------------------------------------------------------------------ | ----------------------------------- |
| [`docs/仕様書/`](docs/仕様書/)                                           | システム全体の上位仕様              |
| [`docs/設計/`](docs/設計/)                                               | 機能単位の詳細設計                  |
| [`docs/実装計画/`](docs/実装計画/)                                       | スプリント分解と技術選定            |
| [`docs/運用/`](docs/運用/)                                               | バックアップなど運用手順            |
| [`docs/移行手引き/`](docs/移行手引き/)                                   | 破壊的変更の移行手順                |
| [`docs/Plugin開発ガイド.md`](docs/Plugin開発ガイド.md)                   | Plugin の作り方                     |
| [`docs/UI Componentリファレンス.md`](docs/UI%20Componentリファレンス.md) | Plugin が使える共通UIコンポーネント |
| [`docs/Eventリファレンス.md`](docs/Eventリファレンス.md)                 | Core が発火するイベント             |

API リファレンスは起動後に `/api/v1/openapi.json` から取得できます（Zod スキーマから自動生成）。

## 貢献 / Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) を参照してください。
脆弱性の報告は公開 Issue ではなく [`SECURITY.md`](SECURITY.md) の手順に従ってください。

## ライセンス / License

[MIT](LICENSE)
