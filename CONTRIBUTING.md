# Contributing to Torifune

Torifune への貢献を歓迎します。
Thank you for considering a contribution to Torifune.

このドキュメントは日本語を主とし、要点は英語を併記します。

---

## 1. 開発環境 / Development environment

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm dev
```

必要なものは Node.js 22 以上、pnpm、PostgreSQL 17（compose に同梱）です。

---

## 2. 何を Core に入れ、何を Plugin にするか

Torifune の価値は**汎用性**にあります。新しい機能を追加する前に、次の順で検討してください。

```text
1. Core 機能として必要か？  ── Yes ─→ Core へ実装
                            └─ No
2. Plugin として実装できるか？ ── Yes ─→ Plugin
                            └─ No
3. Core に拡張ポイントを追加し、Plugin として実装する
```

**Core に入れてはならないもの**（特定の運用形態に依存するため）:

- 特定の SaaS 基盤・クラウドサービスへの依存
- マルチテナント前提のデータ分割
- 課金・契約管理
- 特定の外部サービス連携（SNS・広告・アクセス解析は Plugin として実装する）

---

## 3. アーキテクチャの決まりごと

`docs/仕様書/01_アーキテクチャ設計.md` が正典です。特に：

- レイヤ責務を混在させない：`Presentation → Application → Domain → Infrastructure`
- **Domain 層は特定の DB 製品・認証サービス・外部 API に依存しない**（ESLint で検査しています）
- 認証は Authentication Provider、DB 接続は Database Provider として抽象化する
- Plugin は本体の内部実装ではなく、公開された Plugin API のみを使う
- **Plugin API の後方互換性を最優先する**

### import の書き方

ワークスペースによって拡張子の扱いが違います。Turbopack が相対 import の
`.js` → `.ts` を解決しないためです。

| 場所         | 書き方                             | 例                                                 |
| ------------ | ---------------------------------- | -------------------------------------------------- |
| `apps/web/`  | 拡張子なし、または `@/` エイリアス | `from './provider'` / `from '@/database/registry'` |
| `packages/*` | `.js` を付ける（Node ESM）         | `from './loader.js'`                               |

---

## 4. テストは実装より先に書く

Torifune はテスト先行で開発します。

```text
設計 → 実装プラン → テスト（失敗する状態で確定）→ 実装 → 検証
```

テストが実装の都合に合わせて書き換えられていないことを重視します。
テストの前提が設計と食い違うと気づいたときは、テストを直す前にその食い違いを報告してください。

### 必ず書くテスト

- **Permission**：権限あり → 200 / 権限なし → 403 / 未認証 → 401
- **リソース所有**：ID を差し替えるだけで他ユーザーのデータへ到達できないこと
- 異常系、境界値、バリデーションエラー

---

## 5. セキュリティ上の前提

- Secret（`.env`、API Token、鍵、証明書）を**絶対にコミットしない**
- パスワード・トークン・Cookie・セッションIDを**ログへ出さない**
- 内部例外の詳細・Stack Trace・SQL を**API レスポンスへ返さない**
- UI 上でボタンを隠すことを**認可対策として扱わない**。サーバー側で必ず検証する
- クライアントから送られた User ID / Role をそのまま信頼しない

---

## 6. ブランチとコミット / Branches and commits

```text
feature/<slug>    機能追加
fix/<slug>        不具合修正
refactor/<slug>   リファクタリング
docs/<slug>       ドキュメントのみ
chore/<slug>      設定・ビルド周り
```

コミットメッセージのプレフィックス：`feat:` `fix:` `refactor:` `docs:` `test:` `chore:`

1 コミットには可能な限り 1 つの論理的変更を含めてください。
Commit messages may be written in Japanese or English.

---

## 7. Pull Request

PR には最低限以下を書いてください。

- 変更内容 / What changed
- 変更理由 / Why
- 影響範囲 / Impact
- テスト内容 / How it was tested
- **Breaking Change の有無**

以下の変更は Breaking Change として扱う可能性があります。

- Public API / Plugin API の変更
- Database Provider / Authentication Provider Interface の変更
- UI Extension Point の削除
- Event Payload の変更
- Permission 仕様の変更

Breaking Change を行う場合は移行手順を添えてください。

---

## 8. 提出前のチェック

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Plugin の読み込み・配置・再ビルドに関わる変更では、これに加えて
**本番と同じイメージでの確認**を行う（Docker が要る。数分かかる）。

```bash
./scripts/verify-container-rebuild.sh
```

`import.meta` はビルドで書き換わるため、**dev と Vitest では動くのに
本番ビルドでだけ壊れる**ことがある。CI の `container` ジョブが同じものを走らせる。

---

## 9. 脆弱性の報告 / Reporting a vulnerability

**公開 Issue に投稿しないでください。**
[`SECURITY.md`](SECURITY.md) の手順に従ってください。
