# plugins

ローカル Plugin の配置先。

ここに置かれた Plugin はビルド時に走査され、レジストリへ登録される
（`pnpm generate:plugins`）。**置いただけでは動かない。**
管理画面（`/plugins`）から導入して有効化する。

```text
plugins/
└── my-plugin/          ← ディレクトリ名 = Plugin ID
    ├── plugin.json
    └── index.ts        （index.tsx でもよい）
```

作り方は `docs/Plugin開発ガイド.md`。
実物の例は `example-plugin/`（Plugin API の拡張点を1つずつ使ってみせる）。

`.torifune-quarantine` があるディレクトリは読み込まれない。
ビルドを失敗させた Plugin へ本体が置くマークで、
消してから導入し直すと再び読み込まれる。
