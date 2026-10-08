# plugins

ローカル Plugin の配置先。

ここに置かれた Plugin はビルド時に走査され、レジストリへ登録される
（`pnpm generate:plugins`）。**置いただけでは動かない。**
管理画面（`/plugins`）から導入して有効化する。

```text
plugins/
└── my-plugin/          ← ディレクトリ名 = Plugin ID
    ├── plugin.json
    ├── index.ts        （index.tsx でもよい）
    └── help/           （任意）利用者向けの手順書（Markdown）。plugin.json の help で宣言する
```

作り方は `docs/Plugin開発ガイド.md`。
実物の例は `example-plugin/`（Plugin API の拡張点を1つずつ使ってみせる）。

`.torifune-quarantine` があるディレクトリは読み込まれない。
ビルドを失敗させた Plugin へ本体が置くマークで、
消してから導入し直すと再び読み込まれる。

名前が `.` で始まるディレクトリも読み込まれない（Plugin ID は `.` で始まれない）。
本体が作業用・退避に使う。

## コンテナでの同梱と起動時の反映

コンテナイメージ（リポジトリの `Dockerfile`）では、ここにある Plugin がイメージに**同梱**される。
`/app/plugins` は Volume で、イメージを更新しても中身は変わらないため、起動のたびに
同梱 Plugin をイメージの写しから Volume へ反映する。**利用者が導入した Plugin・中身を変えた
同梱 Plugin には触れない。**

`.torifune-bundled` は、その反映（同期）が同梱 Plugin のフォルダに置く印。同期が書いた時点の
中身のハッシュを持ち、中身がそれと違えば利用者が変えたものとして以後は更新しない。
`.torifune-quarantine` と同じく本体のファイルで、Plugin は読まない・書かない。

運用者向けの説明は `docs/運用/コンテナの更新と同梱Plugin.md`。
