# コンテナの更新と同梱 Plugin

Torifune のコンテナイメージ（リポジトリの `Dockerfile`）で動かしている場合に、
**新しいイメージへ更新したとき Plugin がどう扱われるか**と、ログの読み方・運用者がすることをまとめる。
設計は [`docs/設計/050-bundled-plugin-sync/設計.md`](../設計/050-bundled-plugin-sync/設計.md)。

## 前提：plugins は Volume にある

イメージは `/app/plugins` を Volume にしている（`VOLUME ["/app/plugins"]`）。運用では名前付き Volume を付ける。
Docker がイメージの中身を Volume へ写すのは **Volume を初めて作ったときだけ**で、後から新しいイメージで
起動しても、Volume の中身はそのまま残る。

そこでイメージは、同梱 Plugin（イメージをビルドしたときに `plugins/` にあった Plugin）の写しを
Volume の外（`/app/.torifune-bundled-plugins`）に持ち、起動のたびに Volume へ反映する。

| 用語 | 意味 |
| --- | --- |
| 同梱 Plugin | イメージの `plugins/` に入っていた Plugin。写しのトップレベルにある、名前が `.` で始まらないディレクトリ |
| 利用者の Plugin | 管理画面から Plugin Package・Registry で導入したもの、`plugins/` へ手で置いたもの |
| 印（`.torifune-bundled`） | 同期が同梱 Plugin のフォルダの直下に置くファイル。同期が書いた時点の中身のハッシュを持つ |

## イメージを更新したときに起きること

コンテナを起動するたびに、アプリが動く前に次の 2 つが順に走る（`docker/entrypoint.sh`）。

1. **同梱 Plugin の同期。** 同梱 Plugin のフォルダだけを、イメージの写しで更新する。
   **利用者が導入した Plugin、利用者が中身を変えた同梱 Plugin、同梱より新しい版を入れた同梱 Plugin には触れない。**
   同期が失敗しても起動は止めない（失敗した Plugin は前の中身のまま動く）
2. **起動時の突き合わせ。** Volume の Plugin のソースと、いま入っているビルドが作られたソースを指紋（ハッシュ）で比べる。
   食い違えば、**起動の前に 1 回だけ再ビルドする**

コンテナを作り直す（新しいイメージへの更新、`docker compose up --force-recreate`、`down` → `up`）と、
ビルド（`.next`）はイメージに焼かれたもの、つまり同梱 Plugin だけで作ったビルドに戻る。
利用者の Plugin がある環境では、2 の突き合わせが食い違いを見つけて再ビルドし、利用者の Plugin を
ビルドへ戻す。**同梱 Plugin だけの環境では、同期の後の Volume がイメージと同じになるので再ビルドしない。**

`docker restart` のように同じコンテナを起こし直す場合は、前回のビルドが残っているので、通常は再ビルドしない。

## ログの読み方

同期は同梱 Plugin ごとに 1 行と、最後に要約を 1 行出す。`docker logs` で読む。

```text
[torifune] bundled plugins: example-plugin unchanged
[torifune] bundled plugins: sns-bluesky updated: legacy (backup: .torifune-bundled-backup/sns-bluesky)
[torifune] bundled plugins: sns-threads restored
[torifune] bundled plugins: sns-x-manual skipped: modified
[torifune] bundled plugins: old-bundled kept: no longer bundled
[torifune] bundled plugins: summary updated=1 restored=1 adopted=0 unchanged=1 skipped=1 kept=1 failed=0 untouched=2
```

| 結果 | 意味 | 運用者がすること |
| --- | --- | --- |
| `unchanged` | イメージと同じ。何もしていない | 無い |
| `adopted` | 中身はイメージと同じで、印だけを付けた（新しい Volume の最初の起動など） | 無い |
| `updated` | 前回の同期が書いたまま誰も触っていなかったので、新しいイメージの版で置き換えた | 無い |
| `updated: legacy (backup: …)` | 印の無い古い写しを、イメージの版で置き換えた。置き換える前の中身を退避した | 手で直していたなら退避から取り出す（下の「退避」） |
| `restored` | フォルダが無かったので、イメージの写しを置いた | 無い（消したつもりの Plugin なら、下の「同梱から外れた Plugin・消した同梱 Plugin」） |
| `skipped: modified` | 前回の同期の後に中身が変わっている（Registry・Package での更新、手での編集）。利用者のものとして触らない | 同梱の版へ戻したいなら下の「同梱の版へ戻したいとき」 |
| `skipped: newer version <版> installed` | 印が無く、同梱より新しい版が入っている。利用者が更新したものとして触らない | 無い |
| `skipped: unreadable manifest` | 印が無く、`plugin.json` が読めない。判断できないので触らない | フォルダを確かめる。同梱の版でよければフォルダを消して再起動する |
| `skipped: quarantined` | 隔離マーク（`.torifune-quarantine`）がある。原因を調べるために残している | 原因を調べ、マークを消して再起動すると通常の扱いに戻る |
| `kept: no longer bundled` | 以前は同梱だったが、新しいイメージには無い。使い続けているかもしれないので残す | 不要なら管理画面から削除する |
| `FAILED: <理由>`（標準エラー） | ファイル操作に失敗した。その Plugin は前の中身のまま。`ENOTDIR` は Volume の `<plugin-id>` がディレクトリでない（ファイル・リンク）、`unreadable bundled manifest` はイメージの写しの `plugin.json` が読めない（イメージの誤り） | 理由（`ENOSPC` などの OS のエラーコード）を見て直し、再起動する |

要約の `untouched` は、利用者の Plugin の数（名前は出さない）。

行の名前が Plugin ID の形（英小文字で始まる、英小文字・数字・`-` の 2〜64 文字）でないときは、
`"Not An Id"` のように JSON の文字列として引用して出す（改行などを含む名前で偽の行を作らせないため）。
`skipped: newer version <版> installed` の版も、版の形（英数字・`.`・`-`・`+`）でなければ同じく引用して出す。

同期の後の突き合わせで食い違えば、次の行が出て再ビルドが始まる。

```text
[torifune] plugin sources differ from the build - rebuilding before start
[torifune] rebuilding after plugin change...
[torifune] rebuild succeeded
```

指紋を計算できなかったときは `could not fingerprint plugins - startup rebuild check skipped, starting with the current build` を出し、
再ビルドせずにいまのビルドで起動する。

## 環境変数

| 変数 | 値 | 扱い |
| --- | --- | --- |
| `TORIFUNE_BUNDLED_PLUGINS_DIR` | `/app/.torifune-bundled-plugins` | **イメージ（`Dockerfile`）が宣言する。** 同梱 Plugin の写しの場所。空にすると同期しない。運用者が設定するものではない |
| `TORIFUNE_PLUGINS_DIR` | `/app/plugins` | **`/app/plugins` から変えない。** レジストリの生成（ビルド）は常にイメージの中の `/app/plugins` を読むが、Plugin の導入・同期・起動時の指紋はこの変数の場所を使う。別の場所へ向けると、導入した Plugin がビルドに入らず、指紋もビルドの中身を表さなくなる（起動時の突き合わせが正しく働かない）。Volume は `/app/plugins` に付ける |

## 同梱 Plugin を自分で直したいとき

Volume の中の同梱 Plugin のフォルダを直接編集すると、**以後その Plugin は自動では更新されなくなる**
（ログは `skipped: modified`）。新しいイメージの修正も入らなくなるので、直すなら Plugin を自分の ID で作り直すか、
イメージを自分でビルドする（`plugins/` に入れてビルドしたものは、そのイメージの同梱 Plugin になる）。

## 同梱の版へ戻したいとき

Registry・Package で更新した、または手で編集した同梱 Plugin を、イメージの版へ戻したいときは、
**Volume の中のそのフォルダを消して、コンテナを再起動する。** 次の起動で同期がイメージの写しを置く（`restored`）。
導入状態（データベースの行）は変わらないので、有効だったものは有効のまま動く。

```bash
docker exec <コンテナ> rm -rf /app/plugins/<plugin-id>
docker restart <コンテナ>
```

## 退避

`updated: legacy` で置き換える前の中身は、Volume の中の `.torifune-bundled-backup/<plugin-id>/` に残る。
**Plugin ごとに最新の 1 つだけ**を残す。名前が `.` で始まるので、ビルドにも突き合わせにも入らない。

手で直していた中身があれば、ここから取り出して直し直す。取り出し終えた、または手で直していなかったと
分かっている（同梱の版のままでよい）なら、消してよい。

```bash
docker exec <コンテナ> rm -rf /app/plugins/.torifune-bundled-backup
```

## 起動時の再ビルドにかかる時間

利用者の Plugin がある環境では、**コンテナを作り直した後の最初の起動に、再ビルドの時間（数分）がかかる。**
メモリもビルドの分（1〜2GB）が要る。Plugin の導入・削除のときの再ビルドと同じ資源で足りる。

再ビルドの間、アプリはヘルスチェック（`/api/health`）に応答しない。オーケストレーターや監視で
ヘルスチェックを使っているなら、**開始猶予（Docker なら `start_period`）を再ビルドの時間に合わせて長く取る。**
猶予が短いと、再ビルドの途中でコンテナが殺され、作り直しのたびに同じことを繰り返す。

## 起動時の再ビルドが失敗し続けるとき

起動時の再ビルドが失敗すると、直前の成功ビルド（作り直した直後ならイメージに焼かれたビルド）へ戻して起動する。
Torifune は使えるが、利用者の Plugin はビルドに入らず動かない。ログに次が出る。

```text
[torifune] rebuild FAILED - rolling back to the last good build
```

指紋は食い違ったままなので、**次の起動でもう一度試す**（起動のたびに 1 回。落ち続けるループにはならない）。
毎回失敗するなら、ビルドを壊している利用者の Plugin を探す。Torifune 本体を更新した後なら、
新しい本体に合わなくなった Plugin が疑わしい。

1. ログのビルドのエラーから原因の Plugin を探す
2. その Plugin のフォルダに隔離マークを置く（`touch /app/plugins/<plugin-id>/.torifune-quarantine`）か、
   フォルダを Volume の外へ移す
3. コンテナを再起動する。隔離した Plugin を除いて再ビルドされる
4. 原因を直したら、マークを消して導入し直す

起動時の再ビルドの失敗では、本体は Plugin を自動で隔離しない（どの Plugin が壊したかを起動時には特定できないため）。

## 同じ Volume を複数のコンテナで共有しない

plugins の Volume 1 つにコンテナ 1 つで動かす。Plugin の導入・削除の再ビルドも、この前提で作られている。
2 つのコンテナが同じ Volume を同時に使うと、両方の同期が同じフォルダを入れ替える。
新しいイメージへ切り替えるときは、古いコンテナを止めてから新しいコンテナを起動する。

## 同梱から外れた Plugin・消した同梱 Plugin

* **新しいイメージで同梱から外れた Plugin は、Volume に残る**（`kept: no longer bundled`）。利用者が有効にして
  使い続けているかもしれないため。以後は利用者の Plugin として扱う。不要なら管理画面から削除する
* **管理画面で削除した同梱 Plugin は、次の起動でフォルダが戻り、「検出済み」に出る**（`restored`）。
  データベースに導入の行が無いので動かない。同梱 Plugin はイメージに焼かれたビルドに必ず入っているので、
  フォルダが無くても作り直せば「検出済み」に出る（050 より前からそうだった）。使わないなら導入しなければよい

## `050` より前の Volume を使っている場合

**`050` 以降のイメージへ普通に更新すれば直る。手での復旧は要らない。**

`050` より前のイメージで作った Volume には印が無く、同梱 Plugin は Volume を作ったときの古い写しのまま残っている
（手順書が「この手順書を読み込めませんでした」になる、Plugin の導入・削除の再ビルドで同梱 Plugin が古い版へ戻る、などの症状が出る）。

* 最初の起動で、古い同梱 Plugin がイメージの版に置き換わる（`updated: legacy`）。置き換える前の中身は
  `.torifune-bundled-backup/<plugin-id>/` に残る
* 版を上げて入れた同梱 Plugin（Registry・Package での更新）は、版で見分けて触らない（`skipped: newer version`）
* `050` より前に同梱 Plugin のファイルを手で直していた場合は、置き換わるので、退避から取り出して直し直す
* 手で Volume を直していた場合も、その状態から正しく引き継ぐ。中身が同梱と同じなら印を付けるだけ（`adopted`）
* 利用者の Plugin がある環境では、最初の起動で 1 回再ビルドする（上の「起動時の再ビルドにかかる時間」）

## 関連

* [`バックアップとリストア.md`](バックアップとリストア.md) — `plugins/` を戻したときの扱い
* [`plugins/README.md`](../../plugins/README.md) — `.torifune-bundled`・`.torifune-quarantine` の意味
* [`docs/Plugin開発ガイド.md`](../Plugin開発ガイド.md) §10 — 導入と再ビルド
