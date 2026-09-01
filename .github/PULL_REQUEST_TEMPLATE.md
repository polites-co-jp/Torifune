<!--
CONTRIBUTING.md §8 に沿って書いてください。
公開リポジトリです。内部的な事情をここへ書かないでください。
-->

## 変更内容 / What changed

## 変更理由 / Why

<!-- 何を解決するのか。実装の説明ではなく、解決したい問題を書いてください。 -->

## 影響範囲 / Impact

<!-- 触った層、壊れうる経路。無いなら「無し」と書いてください。 -->

## テスト内容 / How it was tested

<!-- どのテストを足したか。手で確かめただけならそう書いてください。 -->

## Breaking Change

- [ ] 無し / None
- [ ] 有り / Yes（下に移行手順を書く）

<!--
以下は Breaking Change として扱う可能性があります（CONTRIBUTING.md §8）。
- Public API / Plugin API の変更
- Database Provider / Authentication Provider Interface の変更
- UI Extension Point の削除
- Event Payload の変更
- Permission 仕様の変更
-->

## 提出前のチェック / Checklist

- [ ] `pnpm lint` `pnpm format:check` `pnpm typecheck` `pnpm test` `pnpm build` が通る
- [ ] テストを実装より先に書いた（CONTRIBUTING.md §4）
- [ ] Secret・トークン・接続文字列を含めていない
- [ ] Plugin の読み込み・配置・再ビルドに関わる変更なら
      `./scripts/verify-container-rebuild.sh` を実行した
