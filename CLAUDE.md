# Torifune（とりふね）— OSS本体

## このリポジトリの立ち位置

Torifuneは、Webサイト・SNS等のマーケティング活動を一元管理する**オープンソースアプリケーション**。
**公開リポジトリ**であり、書いたコード・コメント・コミットメッセージはすべて第三者の目に触れる。

同じワークスペースに `../TorifuneHub`（プライベート）があるが、**このリポジトリはTorifuneHubの存在を一切前提にしない**。
Torifuneは単体でインストール・起動・利用できなければならない。

## 呼称の統一（重要）

* **Torifune**（日本語表示：「とりふね」）= このOSS本体
* **TorifuneHub**（日本語表示：「とりふねHub」）= SaaS側（別リポジトリ、非公開）

`docs/仕様書/` 内の一部（および TorifuneHub 側の仕様書）に **「MarketingHub OSS」** という
旧称が残っている。これはすべて **Torifune** を指す。新規に書く文書・コードでは旧称を使わず、
既存記述を編集する機会があれば **Torifune** に直す。

## 絶対に守る境界

Torifuneに**入れてはならない**もの（これらはすべて TorifuneHub 側の責務）：

* SaaSとしてのユーザー登録・ユーザー管理
* テナント管理、マルチテナント前提のデータ分割
* ユーザーごとのデータベース払い出し・管理
* コンテナ管理、デプロイ基盤
* 課金・契約管理
* 特定のクラウド／SaaS運営基盤への依存

これらが必要になった場合は、**Torifune本体に実装せず、Plugin APIの拡張ポイントとして提供する**。
「今回だけ」の例外を作らない。判断に迷ったら `boundary-guardian` サブエージェントに掛ける。

## アーキテクチャの原則

`docs/仕様書/01_アーキテクチャ設計.md` が正典。要点：

* レイヤ責務を混在させない：`Presentation → Application → Domain → Infrastructure`
* **Domain層は特定のDB製品・認証サービス・外部APIに依存しない**
* 認証は `Authentication Provider`、DB接続は `Database Provider` として抽象化する。
  本体のビジネスロジックが具体的な認証方式・接続方式を意識してはならない
* Pluginは本体の内部クラス／内部DB構造／内部サービスに直接依存しない。公開Plugin APIのみを使う
* **Pluginは原則としてTorifuneのデータベースへ直接SQLを発行しない**
* Plugin APIの後方互換性を最優先する。破壊的変更は明示的な判断と記録を要する
* 外部サービス連携（SNS・広告・アクセス解析等）は可能な限りPluginとして実装する

## 技術スタック

* **TypeScript / Next.js フルスタック**（画面とAPIを Next.js に集約。App Router）
* **PostgreSQL**（標準構成では 1インスタンス = 1データベース）
* パッケージマネージャは **pnpm**（workspace）
* DBアクセスは **node-postgres + Kysely**。ORMは使わない
* マイグレーションは **連番SQL + 自前ランナー**（`schema_migrations` + advisory lock）
* バリデーションは **Zod**。OpenAPI はZodスキーマから生成する
* UIは **Tailwind CSS + 自前ミニマルコンポーネント**。UIライブラリは導入しない
* テストは Vitest（ユニット・結合）、E2E は Playwright
* Node.js は 22 以上

> 選定理由と却下した案は `docs/実装計画/001-Torifune単体稼働/00_決定事項.md` に記録してある。
> **設計書側でこれを蒸し返さない。** 新たな選定が必要になったら、実装を始める前に
> `docs/設計/` へ選定理由を残してから進める。

### コマンド

```bash
pnpm install
pnpm dev            # 開発サーバ
pnpm build          # 全ワークスペースのビルド
pnpm start          # ビルド済みアプリの起動
pnpm lint           # ESLint（レイヤ境界の検査を含む）
pnpm format         # Prettier（検査のみは format:check）
pnpm typecheck      # 型検査
pnpm test           # ユニット・結合テスト
pnpm test:e2e       # E2E
pnpm migrate        # DBマイグレーション

docker compose up -d postgres   # 開発用PostgreSQL
```

## ディレクトリ構成

pnpm workspace。**公開Plugin APIを独立パッケージに切り出し、依存の向きをビルドで守る。**

```text
docs/仕様書/          上位仕様（システム全体の設計。安定した基盤。勝手に変えない）
docs/設計/            機能単位の詳細設計（機能ごとに1ディレクトリ。開発の起点）
docs/実装計画/        スプリント分解と技術選定
apps/web/             Next.jsアプリ本体
packages/plugin-api/  公開Plugin API（型とインターフェースのみ。将来npm公開）
packages/cli/         torifune CLI（migrate 等）
plugins/              ローカルPluginの配置先
migrations/           DBマイグレーション（連番SQL。順番に適用できる状態を保つ）
```

`apps/web/src/` 配下は仕様書の責務分離に従う：
`api / application / domain / infrastructure / plugin / authentication / database / ui`

各ディレクトリの `README.md` に責務を書いてある。迷ったらそれを読む。

### 依存の向き（ESLintで検査している）

* `packages/plugin-api` → **本体へ依存しない**（一方向）
* `domain/` → DB製品（`pg` / `kysely`）へ依存しない。Infrastructure・API・UIへ依存しない
* `ui/` `app/` → DB製品へ直接依存しない。Application層を経由する

### 認可を書く場所

**Permissionチェックは Application層（UseCase）で行う。** API Layerに置かない。
画面は Server Component から UseCase を直接呼び、更新系は `/api/v1` を叩くため、
API Layerに置くと経路ごとに漏れる。

## 開発フロー（テスト先行 / TDD）

機能開発は必ず以下の順で進める。`/feature <機能名>` で一連の流れを起動できる。

```text
1. design-writer     設計書を書く          → docs/設計/<ID>-<slug>/設計.md
2. impl-planner      実装プランを立てる    → docs/設計/<ID>-<slug>/実装プラン.md
3. test-writer       テストコードを書く    → 失敗する状態で確定させる
4. implementer       実装コードを書く      → テストを通す
5. spec-verifier     設計書との整合を検証  → docs/設計/<ID>-<slug>/検証レポート.md
   boundary-guardian 責務境界・API互換を検証
   security-reviewer セキュリティを検証
```

**エージェント間の受け渡しは `docs/設計/<ID>-<slug>/` のファイルを介して行う。**
後続のエージェントは、前段の成果物ファイルを唯一の入力とみなす。会話履歴には依存しない。

`<ID>` は3桁連番（`001`, `002`, ...）、`<slug>` は英小文字ケバブケース。

### この順序に関する不可侵のルール

* **テストは実装より先に書く。** test-writer は実装の都合を知らずに、設計書だけを見て書く
* **implementer はテストを書き換えて通してはならない。** テストが間違っていると判断した場合は、
  勝手に直さず「テストの前提が設計書のどこと食い違うか」を報告して止まる
* **spec-verifier は実装もテストも書き換えない。** 判定と指摘だけを返す
* 3つの検証エージェント（spec-verifier / boundary-guardian / security-reviewer）は
  互いの結果を見ずに独立して判断する

## セキュリティ上の前提

* **Pluginは信頼されたコードとして扱う。** 特に Authentication Provider と Database Provider は
  高い権限を持つ。Pluginのインストールは実質的にアプリへのコード導入である
* Permission は「権限あり→200 / 権限なし→403 / 未認証→401」を必ずテストする
* IDを差し替えるだけで他ユーザーのデータが取れないことを必ずテストする
* Secret を Git にコミットしない。`.env.example` で必要な環境変数を明示する
* 認証情報を JavaScript から直接参照できる状態にしない（セッションCookieは `HttpOnly`）

## Git 運用

### 基本方針：区切りがついたら自分でコミット・プッシュする

作業が一区切りついたら、**ユーザーの指示を待たずにコミットしてプッシュする。**
「一区切り」とは例えば以下：

* 設定ファイル・ドキュメントの整備が一通り終わったとき
* `/feature` の1機能が 設計 → プラン → テスト → 実装 → 検証 まで通ったとき
* スプリント単位で分けた処理について、実装・テストコード・検証が揃ったとき
* ユーザーから依頼された修正が完了し、テストが通ったとき

作業途中・テストが落ちている状態・検証で重大な指摘が残っている状態ではコミットしない。
まず直してからコミットする。

### main / master へ直接プッシュしない（最重要）

**作業を始める前に必ずカレントブランチを確認する。**

```bash
git branch --show-current
```

* **カレントが `main` または `master` の状態で修正・実装の指示を受けたら、
  コードに手を付ける前にユーザーへ確認する。**

  > 現在 `main` ブランチです。新しいブランチを作りますか？（例：`feature/xxx-yyy`）

  ブランチ名の案を必ず添えること。ユーザーが承諾したらブランチを切ってから作業を始める。
* ユーザーが「このまま main で作業してよい」と明示した場合はそれに従うが、
  **その場合でも `main` へのプッシュはしない。** コミットまでに留め、プッシュの可否を改めて確認する。
* 既に feature ブランチ上にいる場合は、確認せずそのまま作業を続けてよい。

### 初回コミットの例外

**リポジトリにコミットが1つも無い場合に限り、`main` へ直接コミット・プッシュしてよい。**
`main` に実体が無いと、分岐元も差分の比較対象も存在しないため。
初回コミットが済んだ以降は、上記のルールを常に適用する。

### ブランチ名

```text
feature/<slug>    機能追加
fix/<slug>        不具合修正
refactor/<slug>   リファクタリング
docs/<slug>       ドキュメントのみ
chore/<slug>      設定・ビルド周り
```

対応する設計書がある場合は、そのIDを含める（例：`feature/001-plugin-manager`）。

### コミット

* 1コミット = 1論理変更
* メッセージのプレフィックス：`feat:` `fix:` `refactor:` `docs:` `test:` `chore:`
* **コミット前に必ず `git status` と `git diff --staged` を確認し、
  意図しないファイル（`.env`、Secret、鍵、ビルド生成物、`node_modules/`）が
  含まれていないことを確かめる**
* `git add -A` を無自覚に使わない。何を追加するかを把握したうえでステージする

### プッシュ

```bash
git push -u origin <branch>
```

* **`--force` / `--force-with-lease` は使わない。** 履歴の書き換えが必要だと判断した場合は、
  実行せずユーザーに相談する
* プッシュ後、ユーザーへ「ブランチ名」「コミット内容の要約」「変更ファイル数」を伝える

### マージ

* **feature ブランチから `main` へのマージは、ユーザーが内容を確認しながら行う。**
  AI はマージしない。`git merge` / `gh pr merge` を実行しない
* Pull Request の作成は、ユーザーから指示があったときだけ行う

### このリポジトリ固有の注意

* **公開リポジトリである。** ブランチ名・コミットメッセージ・PR本文はすべて第三者が読む。
  内部的な事情や TorifuneHub（SaaS側）の都合をそこに書かない

## 文書の言語

仕様書・設計書・コミットメッセージは日本語。
コード内の識別子は英語、コードコメントは日本語でよい。
ただし**公開リポジトリなので、README・CONTRIBUTING・公開API のドキュメントは英語併記を検討する**。
