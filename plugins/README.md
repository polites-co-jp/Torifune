# plugins

ローカル Plugin の配置先。

ここに置かれた Plugin はビルド時に走査され、レジストリへ登録される。
有効化・無効化は管理画面から行う（再ビルドを伴わない）。

実装は `011-plugin-runtime` / `012-plugin-manager` で行う。
