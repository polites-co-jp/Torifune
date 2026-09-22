# SNS投稿の外部連携（外部アプリから投稿を登録する）

Torifune は、**外部のアプリが API で登録した投稿を、指定した時刻に SNS へ流す。**
この文書は、その外部アプリを作る人向けの手順書。

```text
外部アプリ ──POST /api/v1/social/accounts──▶ SNSアカウントを登録（資格情報を預ける）
外部アプリ ──POST /api/v1/social/posts   ──▶ 投稿を登録（本文・予約時刻・冪等キー）
                                             │ 予約時刻が来る
                                             ▼
                          Torifune の定期実行（既定 1 分ごと）が配信
                                             │
                                             ▼
                          GET /api/v1/social/posts で結果を確かめる
```

> **実際に SNS を叩くのは Plugin。** provider ごとの配信 Plugin（`extensions: ['social']`）を
> 入れておく必要がある。Plugin の作り方は [`Plugin開発ガイド.md`](../Plugin開発ガイド.md) §9。
> **Plugin がまだ無くても投稿の登録は断られない**（§4）。

## 全体の流れ

```text
1. APIトークンを発行する        管理画面 → 設定 → API（Scope は social.read と social.write）
2. SNSアカウントを登録する      POST /api/v1/social/accounts
3. 投稿を登録する               POST /api/v1/social/posts
4. 再送してよい形にする          externalRef を付ける。2回目は 200 で同じ投稿が返る
5. 結果を見る                   GET /api/v1/social/posts/{id} の status / failureReason
6. 定期実行を止めている場合      POST /api/v1/social/publish を cron から叩く
```

### 要る権限

| 操作 | 要る Scope（＝所有者が持つ Permission） |
| --- | --- |
| SNSアカウントの登録・更新、投稿の登録・更新 | `social.write` |
| 投稿・アカウントの参照 | `social.read` |
| APIトークンの発行 | `token.manage`（**画面から。トークン認証では発行できない**） |
| `POST /api/v1/social/publish`（配信の手動実行） | `system.manage` |

---

## 1. APIトークンを発行する

管理画面 → **設定** → **API** タブ（`/settings?tab=api`）。`token.manage` が要る。

| 項目 | 値 |
| --- | --- |
| 名前 | `my-app` など、**どの外部アプリか分かる名前** |
| Scope | `social.read` と `social.write` |
| 有効期限 | 期限を切るなら、切れる前に貼り替える運用とセットで |

**平文のトークンは発行直後に一度しか表示されない。** その場で控える。

```http
Authorization: Bearer tfp_xxxxxxxxxxxxxxxxxxxx
```

### トークン 1 本 = 外部アプリ 1 つ

Torifune には「アプリケーション ID」のような登録は無い。
**どのトークンで登録したかが、そのまま「どのアプリが登録したか」になる。**

* 投稿には登録したトークンが記録される（応答には出ない）
* 冪等キー（§4）は**トークンごとに分かれる。** 別のアプリが同じ `externalRef` を送っても別の投稿になる
* **アプリごとに別のトークンを発行する。** 使い回すと冪等キーが衝突する
* トークンを失効させても、そのトークンが登録した投稿は残る

> 実効的な権限は「所有者の権限 ∩ トークンの Scope」。
> 所有者が `social.write` を失うと、そのトークンでも投稿を登録できなくなる。

---

## 2. SNSアカウントを登録する

投稿は SNSアカウントに紐づく。まずアカウントを作る。

```bash
curl -X POST https://torifune.example.com/api/v1/social/accounts \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "provider": "bluesky",
        "displayName": "広報アカウント",
        "handle": "@example",
        "status": "connected",
        "credentials": { "identifier": "example.bsky.social", "appPassword": "xxxx-xxxx" }
      }'
```

| 項目 | 説明 |
| --- | --- |
| `provider` | 配信 Plugin が登録している provider と同じ値（`^[a-z][a-z0-9_]{0,31}$`）。Torifune が知らない値も登録できる |
| `displayName` | 画面で見分けるための名前（必須） |
| `handle` | SNS 側の表示上の ID。任意 |
| `status` | `connected` / `disconnected` / `error`。既定は `disconnected` |
| `credentials` | **資格情報。** 項目は配信 Plugin が宣言している（下記） |

応答（201）。

```json
{ "data": { "id": "…", "provider": "bluesky", "displayName": "広報アカウント",
            "handle": "@example", "status": "connected", "credentialConfigured": true,
            "createdAt": "…", "updatedAt": "…" } }
```

### `credentials` に何を入れるか

**何が要るかを決めるのは配信 Plugin。** 例えば Bluesky なら
`identifier` と `appPassword`、X（OAuth 1.0a）なら 4 値、という具合に provider ごとに違う。
**入れるべきキーは、使う Plugin の README を見る。**

* 宣言に無いキーを送ると 422（`credentials` に「`<key>` は指定できません」）
* 足りないと 422（`credentials` に「`<key>` を指定してください」）
* 値は**文字列だけ**。数値・入れ子のオブジェクトは 422
* JSON にして 4096 文字を超えると 422
* **その provider の配信 Plugin がまだ入っていない場合は、検証されずそのまま保存される。**
  Plugin を後から入れても、キーが合っていればそのまま使える

### 資格情報は読み出せない

**登録した資格情報は、どの API からも取り出せない。**
応答に入るのは `credentialConfigured`（設定済みかどうか）だけで、
どのキーが設定されているかも返さない。
値は暗号化して保存され、配信のたびに Torifune が復号して配信 Plugin へ渡す
（その 1 回の呼び出しの間だけ）。読み出しは監査ログに残る。

**したがって「登録した値が合っているか」は API では確かめられない。**
誤りに気づくのは配信が失敗したとき（§5）になる。

### 更新・削除

```bash
# 資格情報を差し替える（他の項目はそのまま）
curl -X PATCH https://torifune.example.com/api/v1/social/accounts/$ACCOUNT_ID \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "credentials": { "identifier": "example.bsky.social", "appPassword": "yyyy-yyyy" } }'
```

* `credentials` を**省略すると変わらない**
* `"credentials": {}` を送ると**資格情報が消える**（`credentialConfigured` が `false` になる）

---

## 3. 投稿を登録する

```bash
curl -X POST https://torifune.example.com/api/v1/social/posts \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "socialAccountId": "'"$ACCOUNT_ID"'",
        "body": "新しい記事を公開しました。",
        "status": "scheduled",
        "scheduledAt": "2026-10-01T09:00:00+09:00",
        "deliveryMode": "auto",
        "externalRef": "article-1234",
        "link": "https://example.com/articles/1234",
        "media": [{ "url": "https://example.com/ogp/1234.png", "alt": "記事のサムネイル" }]
      }'
```

| 項目 | 既定 | 説明 |
| --- | --- | --- |
| `socialAccountId` | — | §2 で作ったアカウントの `id`（必須） |
| `body` | — | 本文（必須） |
| `status` | `draft` | `draft` なら下書き。**配信するなら `scheduled`** |
| `scheduledAt` | `null` | 配信する時刻（ISO 8601）。**`scheduled` のときは必須**（無いと 422） |
| `deliveryMode` | `auto` | `auto` = Torifune が配信する。`manual` = 人が投稿画面から投稿する（§6） |
| `externalRef` | なし | 外部アプリ側の ID。**再送のための冪等キー**（§4）。1〜200 文字 |
| `link` | `null` | 添える URL。**https だけ**、2048 文字以内 |
| `media` | `[]` | 添える媒体。最大 10 件。`url` は **https だけ**、`alt` は 1000 文字以内 |
| `providerOptions` | `{}` | provider 固有の追加項目（返信先の ID など）。JSON にして 4096 バイト以内。**中身を検証するのは配信 Plugin** |

応答は 201。`{ "data": { "id": "…", "status": "scheduled", "deliveryMode": "auto", … } }`。

### 媒体（`media`）はファイルを預からない

**Torifune は画像・動画のファイルを保管しない。** `media` に入れるのは
**取りに行ける URL** で、そこから取得して SNS へ上げるのは配信 Plugin である。

* **配信時刻まで URL が生きていること。** 消えていると配信が失敗する
* 認証の要る URL は使えない（Plugin が素で取りに行く）
* `alt`（代替テキスト）は付けられるときは付ける

### 登録時に弾かれるもの（422）

`{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": { "body": ["…"] } } }`
の形で返る。`details` のキーが送った項目名に対応する。

| キー | 主な理由 |
| --- | --- |
| `body` | 空、上限超過、**配信 Plugin の `limits.bodyMaxLength` 超過**、Plugin の `validate()` が返した問題 |
| `scheduledAt` | `status: "scheduled"` なのに指定が無い |
| `media` | 11 件以上、`http://` の URL、**Plugin の `mediaMax` 超過**、`mediaRequired` の provider で空 |
| `link` / `externalUrl` | `https` でない |
| `providerOptions` | 4096 バイト超、Plugin の `validate()` が返した問題 |
| `externalRef` | 空文字、201 文字以上、**セッション認証（Cookie）で指定した** |
| `deliveryMode` | 列挙にない値、**`manual` なのにその provider が手動投稿に対応していない** |

**上限や文言は provider ごとに違う。** 配信 Plugin が宣言した上限を Torifune が適用し、
Plugin の `validate()` が返した文言をそのまま返す。
だから「登録が通った」ことは、その provider の制約を満たしていることを意味する。

> **`status: "draft"` でも上限の検査は掛かる。** 下書きのまま上限超過の本文を溜めても、
> 予約した瞬間に弾かれるだけなので、早い段階で知らせる。

---

## 4. 再送してよい形にする（`externalRef`）

ネットワークが切れて応答を受け取り損ねたとき、外部アプリは同じ登録をもう一度送りたくなる。
**`externalRef` を付けておけば、そのまま再送してよい。**

```text
1回目  POST /social/posts  { "externalRef": "article-1234", … }  → 201  { "id": "A", … }
2回目  POST /social/posts  { "externalRef": "article-1234", … }  → 200  { "id": "A", … }
```

* **同じトークン・同じ `externalRef` なら、2 回目以降は既存の投稿を `200` で返す。**
  新しい投稿は作られない
* **`201` なら作られた、`200` なら既にあった。** ステータスコードで見分ける
* 2 回目で `body` などを変えて送っても、**保存されている内容は 1 回目のまま。**
  内容を変えたいときは `PATCH /api/v1/social/posts/{id}`
* イベント（`social.post.created`）も 1 回目だけ発火する
* **`externalRef` はトークンごとに独立。** 別のアプリが同じ値を送れば別の投稿になる
* `externalRef` を付けないと再送は別の投稿になる。**二重投稿になるので、必ず付ける**

`externalRef` には、外部アプリ側で一意に決まる値（記事 ID、ジョブ ID など）を使う。

---

## 5. 結果を見る

```bash
curl -H "Authorization: Bearer $TORIFUNE_TOKEN" \
  https://torifune.example.com/api/v1/social/posts/$POST_ID
```

```json
{ "data": { "id": "…", "status": "published",
            "publishedAt": "2026-10-01T00:00:13.000Z",
            "externalId": "3kabc…", "externalUrl": "https://bsky.app/profile/…/post/3kabc…",
            "attemptCount": 1, "nextAttemptAt": null,
            "failedAt": null, "failureReason": null, … } }
```

### 状態の読み方

投稿の状態は 4 つしかない（`draft` / `scheduled` / `published` / `failed`）。
**配信の進み具合は、状態と他の項目の組み合わせで読む。**

| 見たいこと | 条件 |
| --- | --- |
| 配信待ち | `status: "scheduled"` で `attemptCount: 0` |
| 再試行待ち | `status: "scheduled"` で `nextAttemptAt` が入っている（`failureReason` に前回の理由） |
| 配信済み | `status: "published"`。`publishedAt` と、Plugin が返せば `externalId` / `externalUrl` |
| 失敗 | `status: "failed"`。`failedAt` と `failureReason` |

* `attemptCount` は**着手した回数**。再試行は 1 → 2 → 4 → 8 分の間隔で、**最大 5 回**で打ち切る
* `externalUrl` は https のときだけ記録される。手動投稿（§6）では人が貼るとは限らないので空になりうる

### 失敗の理由（`failureReason`）

`failureReason` は**そのまま人に見せてよい文**。配信 Plugin が返した理由か、
Torifune が付けた理由が入る。資格情報が混じらないよう、既知の値は伏せてある。

| 理由の趣旨 | 何が起きたか | 対処 |
| --- | --- | --- |
| 「結果不明」を含む | 配信 Plugin が例外を投げた／30 秒以内に応答しなかった／配信の途中で処理が中断した | **SNS 側に投稿されているか人が確かめる。** 自動では再送しない |
| 「再試行の上限」を含む | 5 回試しても送れなかった | 原因（回線・Rate Limit）を解いてから登録し直す |
| 「資格情報の形式が配信 Plugin の要求（…）と合いません」 | 登録済みの資格情報のキーが Plugin の要求と違う | §2 の形で登録し直す |
| 「資格情報を復号できません」 | 暗号化鍵が変わった | 鍵を確かめるか、資格情報を登録し直す |
| Plugin が返した文言 | 認証エラー、本文の拒否など | Plugin の README に従う |

> **`failed` と `published` は終端の状態で、そこから戻せない。**
> 原因を直したら**新しい投稿として登録し直す**（`externalRef` も新しい値にする。
> 同じ値では既存の `failed` の投稿が 200 で返るため）。

### 予約がいつまでも `scheduled` のまま動かないとき

**配信の支度が整っていない予約は、失敗させずに待たされる。**
次のどちらかのとき、定期実行はその投稿を**飛ばして**次の周期へ回す
（`attemptCount` も `status` も動かない）。

* その provider の配信 Plugin が入っていない（または `publish()` を実装していない）
* そのアカウントの資格情報がまだ登録されていない（`credentialConfigured: false`）

支度が整えば、次の周期でそのまま配信される。登録し直す必要は無い。
気づく手段は管理画面側にある（`/social` の警告と、設定 → 一般「定期実行」の `skipped` の件数）ので、
**外部アプリから何日も `scheduled` のままの投稿が見えたら、運用者に確認してもらう。**

### イベント・Webhook で受け取る

結果をポーリングせずに受け取りたい場合は Webhook を使う
（`social.post.published` / `social.post.failed`）。
**Payload に理由は載らない**（`{ postId, accountId, status }` だけ）ので、
理由が要るときは `GET /api/v1/social/posts/{id}` で引く。
詳しくは [`Eventリファレンス.md`](../Eventリファレンス.md)。

---

## 6. API で流せない SNS（手動投稿）

無料枠の制限などで API から投稿できない SNS のために、
**`deliveryMode: "manual"` で登録できる。**

```json
{ "socialAccountId": "…", "body": "…", "status": "scheduled",
  "scheduledAt": "2026-10-01T09:00:00+09:00", "deliveryMode": "manual" }
```

* 予約時刻が来ると、管理画面 `/social` の「手動投稿待ち」に並ぶ
* 人が「投稿画面を開く」を押すと、本文を反映した SNS の投稿画面が開く
* 人が投稿してから「投稿した」を押すと `published` になる（「取りやめ」なら `draft` に戻る）
* **定期実行は手動投稿に一切触らない。** `attemptCount` は 0 のまま

外部アプリ側から見た注意点。

* **その provider の配信 Plugin が手動投稿に対応していないと 422**（`details` の `deliveryMode`）。
  対応の有無は Plugin による
* **`media` は付けられない**（422）。媒体は人が投稿画面で添付する
* 人が押すまで `scheduled` のまま残る。**自動では終わらない**

---

## 7. 定期実行を止めている場合

Torifune は既定で **1 分ごと**に配信を回す。止めている構成
（`TORIFUNE_SCHEDULER=off`）では、外部から配信を叩く。

```bash
# 1分ごとに配信を回す
* * * * * curl -fsS -X POST https://torifune.example.com/api/v1/social/publish \
  -H "Authorization: Bearer $TORIFUNE_ADMIN_TOKEN" >/dev/null
```

* **`system.manage` が要る**（投稿登録用のトークンとは別に発行する）
* 応答は件数だけ。

  ```json
  { "data": { "interrupted": 0, "due": 3, "skipped": 0, "attempted": 3,
              "published": 3, "retried": 0, "failed": 0, "unrecorded": 0 } }
  ```

  | キー | 意味 |
  | --- | --- |
  | `interrupted` | 前回の実行が途中で死んでいた投稿（`failed`（結果不明）に落とした） |
  | `due` | 期限が来ていた投稿の件数（1 回あたり最大 20 件） |
  | `skipped` | 配信の支度が整わず**飛ばした**件数（§5 の最後） |
  | `attempted` | 配信を試みた件数 |
  | `published` / `retried` / `failed` | 成功・再試行に回した・失敗した件数 |
  | `unrecorded` | 結果を書き戻せなかった件数（**SNS 側に出ている可能性がある**） |

* 定期実行と同じロックに載るので、**同時に走って二重投稿になることは無い。**
  他の実行が終わるのを最大 10 秒待ち、空かなければ `409 CONFLICT` と `Retry-After: 10` を返す
* 間隔を変えるだけなら `TORIFUNE_SOCIAL_PUBLISH_INTERVAL_MINUTES`（分。1〜1440）

---

## 二重投稿について

**SNS の投稿は取り消せない。** Torifune は「送ったかもしれない」ときに再送しない。

* 配信の着手印を先に記録してから Plugin を呼ぶ。途中でプロセスが落ちた投稿は、
  次の実行で**再送せず** `failed`（結果不明）にする
* 再試行するのは、Plugin が「**送る前に失敗した**」と明言したときだけ
* 複数プロセスで動かしても、同時に走るのは 1 プロセスだけ（ジョブごとのロック）

その代わり、**「実際には投稿されているのに `failed` になる」ことは起こりうる。**
`failureReason` に「結果不明」と書かれた投稿は、登録し直す前に SNS 側を確かめること。

## 関連

* Plugin の作り方：[`Plugin開発ガイド.md`](../Plugin開発ガイド.md) §9「SNS 配信（`social`）」
* イベントと Webhook：[`Eventリファレンス.md`](../Eventリファレンス.md)
* API 仕様：`docs/仕様書/05_API設計.md` §18（SNS API）・§37（API Token）
* 設計：`docs/設計/035-social-publishing/設計.md`
