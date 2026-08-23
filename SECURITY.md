# Security Policy

## 脆弱性の報告 / Reporting a vulnerability

**脆弱性を公開 Issue へ投稿しないでください。**
**Please do not report security vulnerabilities through public GitHub issues.**

報告には GitHub の **Private vulnerability reporting** を利用してください。

Use GitHub's **Private vulnerability reporting**:

1. <https://github.com/polites-co-jp/Torifune/security/advisories/new> を開く
2. 再現手順、影響範囲、想定される攻撃者の権限を書く
3. 送信する

<!--
TODO: メールでの報告経路を用意する場合、ここに専用アドレスを記載する。
個人のメールアドレスは公開しないこと。
-->

### 報告に含めてほしい情報

- 影響を受けるバージョン / コミット
- 再現手順
- 攻撃者に必要な前提（未認証か、認証済みか、どの Permission を持つか）
- 想定される影響（情報漏洩・権限昇格・データ破壊など）

### 対応の流れ

1. 受領を確認します
2. 再現と影響範囲の評価を行います
3. 修正と公開のタイミングを報告者と調整します
4. 修正リリース後、GitHub Security Advisory として公開します

修正が公開されるまで、脆弱性の詳細を公開しないでください。

---

## Torifune のセキュリティモデルで前提としていること

報告の判断材料として、設計上の前提を明示します。

### Plugin は信頼されたコードである

**Plugin のインストールは、Torifune へ追加のコードを導入する操作**です。
Plugin はサンドボックスで隔離されません。
特に Authentication Provider と Database Provider は高い権限を持ちます。

したがって、「悪意のある Plugin をインストールすると危険である」ことは
**設計上の前提であり、脆弱性ではありません**。

一方で、以下は脆弱性として扱います。

- Plugin が宣言していない Permission を実質的に取得できてしまう
- Plugin のインストール時に、要求 Permission が正しく表示されない
- Plugin が他の Plugin のデータへ意図せず到達できてしまう

### 管理者は信頼された役割である

`system.manage` 等の管理権限を持つユーザーが、意図的にシステムを壊せることは前提です。

一方で、**権限を持たないユーザーが管理操作へ到達できる**ことは脆弱性です。

### 特に関心のある報告

- 認証・セッションの不備（セッション固定、ログアウト後の再利用、CSRF）
- 認可の抜け（ID の差し替えによる他ユーザーのデータへの到達、UI でのみ制限された操作）
- Secret の漏洩（API レスポンス・画面・ログへの平文出力）
- SQL インジェクション、XSS
- 初回セットアップ（`/setup`）が閉じられた後に再度到達できる経路

---

## サポート対象バージョン / Supported versions

開発初期のため、まだ安定版はありません。
`main` ブランチを対象とします。

There is no stable release yet. Reports against `main` are in scope.
