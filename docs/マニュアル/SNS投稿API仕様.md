# SNS投稿 API 仕様（外部アプリ向けリファレンス）

外部アプリから Torifune の HTTP API を叩いて、**どの SNS（アカウント）に・どんな本文・いつ・どの配信方法で
投稿するか**を登録するための仕様書。言語を問わず、HTTP と JSON が扱えれば実装できる。

* **この文書は「何を送れば何が返るか」のリファレンス。** API トークンの発行、SNS アカウントと
  資格情報の登録、運用の流れは [`SNS投稿の外部連携.md`](SNS投稿の外部連携.md)（手順書）を先に読む
* 記述はすべて **コード（`apps/web/src/app/api/v1/social/**`・`apps/web/src/api/**`・
  `apps/web/src/application/social/*`・`apps/web/src/domain/social/*`・`plugins/sns-*`）から起こした**。
  設計書と食い違うところはコードに合わせ、§10 に書き出した
* 機械可読な仕様は `GET /api/v1/openapi.json`（§3.7）。この文書はその補足で、OpenAPI に書けない
  振る舞い（SNS ごとの規則・冪等性・状態遷移）を扱う

---

## 1. 概要と前提

### 1.1 Torifune がやること・やらないこと

```text
外部アプリ ──POST /api/v1/social/posts──▶ Torifune に投稿を「登録」する（ここで検査して 422 を返す）
                                            │ 予約日時（scheduledAt）が来る
                                            ▼
                         Torifune の定期実行（既定 1 分ごと）が配信 Plugin を呼んで SNS へ送る
                                            │
外部アプリ ◀─GET /api/v1/social/posts/{id}── 結果（status / failureReason / externalUrl）を読む
          ◀─Webhook（social.post.published / failed）── または通知で受け取る
```

* **SNS へ直接投稿する同期 API は無い。** 外部アプリがするのは「投稿の登録」で、実際の送信は
  Torifune の定期実行が行う。「すぐ出したい」ときは `scheduledAt` に現在時刻（か過去）を入れて
  `status: "scheduled"` で登録する。次の定期実行（既定の間隔は 1 分）で配信される
* **SNS の指定は「SNS アカウントの ID」で行う。** 投稿の本文に provider を書く欄は無い。
  投稿先 SNS は `socialAccountId` が指すアカウントの `provider` で決まる（§4.2 で引く）
* 実際に SNS を叩くのは provider ごとの**配信 Plugin**。登録時の文字数・媒体・リンクの規則も
  Plugin が宣言する（§5）

### 1.2 ベース URL とバージョン

| 項目 | 値 |
| --- | --- |
| ベース URL | `https://<Torifune のホスト>/api/v1` |
| バージョン | パスの `v1`。破壊的変更は新しいバージョン（`/api/v2`）で出す方針（`docs/仕様書/05_API設計.md` §6・§41） |
| 非推奨の告知 | 非推奨になったエンドポイントは応答に `Deprecation` / `Sunset` ヘッダが付き、OpenAPI に `deprecated: true` が出る（`apps/web/src/api/route.ts`）。**いまの SNS API に非推奨のものは無い** |
| 通信 | 本番は HTTPS で公開する前提。以下の例のホスト名は `torifune.example.com` |

### 1.3 文字コードと Content-Type

* 要求・応答とも **JSON（UTF-8）**。本文を送る要求には `Content-Type: application/json` を付ける
* **壊れた JSON は 400 ではなく 422 になる。** 本文が JSON として読めないと「空のオブジェクト」を
  送ったものとして検証され、必須項目の欠落として 422 が返る（`apps/web/src/api/route.ts`）
* **知らない項目は無視される**（エラーにならない）。将来の項目を送っても壊れない代わりに、
  **項目名の綴りを間違えても黙って無視される**ので注意する（例：`scheduled_at` は無視され、
  `scheduledAt` が未指定の扱いになる）

### 1.4 時刻の形式とタイムゾーン

| 向き | 形式 |
| --- | --- |
| 応答 | **ISO 8601 の UTC、ミリ秒付き**（例 `2026-10-01T00:00:13.000Z`）。`Date#toISOString()` の出力そのもの |
| 要求（`scheduledAt`） | JavaScript の `new Date(値)` で解釈できる値を受け付ける（Zod の `z.coerce.date()`） |

**要求では必ず UTC オフセット付きの ISO 8601 で送る**（`2026-10-01T09:00:00+09:00` か
`2026-10-01T00:00:00Z`）。オフセットを省いた `2026-10-01T09:00:00` は**サーバのローカル時刻**として
解釈され、コンテナの設定次第で 9 時間ずれる。数値を送るとエポックミリ秒として解釈される。
Torifune の画面の「基準タイムゾーン」設定は API の時刻解釈に**関係しない**。

---

## 2. 認証

### 2.1 API トークン

```http
Authorization: Bearer tfp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

* トークンは `tfp_` で始まる文字列（`apps/web/src/domain/api-token.ts`）。発行は管理画面から行う
  （**API からは発行できない**）。手順は [手順書 §1](SNS投稿の外部連携.md#1-apiトークンを発行する)
* ヘッダは `Authorization: Bearer <トークン>`（`Bearer` の大文字・小文字は問わない）
* **トークン認証の要求では CSRF トークンは要らない。** `Authorization` ヘッダが付いていれば
  CSRF の検証を行わない（ブラウザが自動送信しないため）。要求本文の `csrfToken` 項目は画面用で、
  外部アプリは送らなくてよい
* `Authorization` とセッション Cookie の両方があると、**トークンのほうで認証する**

次のときは **401 `UNAUTHENTICATED`** になる。

* `Authorization` ヘッダが無い（かつセッションも無い）
* トークンが存在しない・失効している・有効期限が切れている
* トークンの所有者が無効化されている

### 2.2 スコープ（必要な権限）

トークンの実効的な権限は**「所有者のいまの Permission」と「トークンの Scope」の共通部分**。
所有者が権限を失えば、そのトークンでもできなくなる。権限が足りないと **403 `FORBIDDEN`**
（応答に「どの権限が足りないか」は書かれない）。

| エンドポイント | 必要な権限 |
| --- | --- |
| `GET /social/accounts`・`GET /social/accounts/{id}` | `social.read` |
| `POST /social/accounts`・`PATCH /social/accounts/{id}` | `social.write` |
| `DELETE /social/accounts/{id}` | `social.delete` |
| `GET /social/posts`・`GET /social/posts/{id}` | `social.read` |
| `POST /social/posts`・`PATCH /social/posts/{id}` | `social.write` |
| `DELETE /social/posts/{id}` | `social.delete` |
| `POST /social/publish`（配信の手動実行） | `system.manage` |

投稿を登録して結果を読むだけの外部アプリなら **`social.read` + `social.write`** で足りる。

### 2.3 トークンは名前空間であって、分離境界ではない

* 冪等キー `externalRef`（§3.5）は**トークンごと**に分かれる。**外部アプリごとに別のトークンを発行する**
* ただし**データの見え方はトークンで分かれない。** `social.read` があれば他のアプリが登録した投稿も
  本文ごと読め、`social.write` があれば書き換えられる。**信頼できない第三者にトークンを渡さない**

詳細は [手順書 §1「トークンは名前空間であって、分離境界ではない」](SNS投稿の外部連携.md#トークンは名前空間であって分離境界ではない)。

### 2.4 ブラウザから直接呼ぶ場合（CORS）

CORS は**既定で無効**。許可する Origin を運用者が `TORIFUNE_CORS_ORIGINS` で明示したときだけ
CORS ヘッダが付く（`*` は指定できない）。ただし **API トークンをブラウザのコードに埋め込むと
誰でも読める**ので、原則はサーバ側（バックエンド・バッチ）から呼ぶ。

---

## 3. 共通仕様

### 3.1 成功応答の形

```jsonc
// 単体（GET /{id}・POST・PATCH）
{ "data": { "id": "…", … } }

// 一覧（GET /social/accounts・GET /social/posts）
{ "data": [ { … }, { … } ], "meta": { "page": 1, "perPage": 20, "total": 57 } }
```

* `meta.total` は**そのページの件数ではなく、条件に合う全件数**
* `DELETE` の成功は **204（本文なし）**

### 3.2 エラー応答の形

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "入力内容を確認してください。",
    "details": {
      "body": ["X の本文は280（半角換算）以内にしてください（…）。いまは 312 です。"]
    }
  }
}
```

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `error.code` | string | **プログラムで分岐に使う固定値**（下表） |
| `error.message` | string | 表示用の固定文（日本語）。分岐に使わない |
| `error.details` | object（任意） | **422 のときだけ付く。** キー＝問題のある項目名、値＝理由の文字列の配列 |

`details` のキーの規則。

* キーは**送った項目名**（`body`・`scheduledAt`・`media`・`link`・`deliveryMode`・`socialAccountId`・
  `externalRef`・`providerOptions`・`status`・`externalUrl`・`externalId`・`credentials`・`provider`・
  `displayName` など）
* **`media` の要素ごとの問題も `media` 1 つにまとめる**（`media.0.url` のように分岐させない）
* **配信 Plugin の検査（§5）は `providerOptions.<キー>` の形のキーを返すことがある**
  （例：`providerOptions.langs`）。Plugin が返したキーが英数字と `_` `.` の 64 文字以内の形でなければ
  `providerOptions` に丸められる
* 要求本文が JSON のオブジェクトでない（配列・文字列など）ときは、項目に紐づかない問題として `_` に入る
* 理由の文字列は**そのまま人に見せてよい日本語**が基本だが、型違い・必須項目の欠落・列挙外の値など
  入力の形の誤りは**検証ライブラリ（Zod）の既定の英文**（例 `Invalid input: expected string, received undefined`・
  `Invalid option: expected one of "auto"|"manual"`）になる。**文字列の中身で分岐しない。キーで分岐する**

### 3.3 エラーコード一覧

| HTTP | `code` | いつ |
| ---: | --- | --- |
| 401 | `UNAUTHENTICATED` | 認証が無い・トークンが無効（§2.1） |
| 403 | `FORBIDDEN` | 権限（Scope）が足りない（§2.2） |
| 403 | `CSRF_FAILED` | セッション（Cookie）認証で CSRF トークンが無い。**トークン認証では起きない** |
| 404 | `NOT_FOUND` | `{id}` の投稿・アカウントが無い（**UUID の形でない ID も 404**） |
| 409 | `CONFLICT` | `POST /social/publish` で他の配信処理が実行中（`Retry-After: 10` が付く） |
| 422 | `VALIDATION_ERROR` | 入力の検査に落ちた（§3.2 の `details` を見る） |
| 429 | `TOO_MANY_ATTEMPTS` | Rate Limit を超えた（§3.4。`Retry-After` が付く） |
| 500 | `INTERNAL_ERROR` | 想定外のエラー。配信 Plugin の事前検査が例外・5 秒超過になったときもこれ（§5.1） |

**400 `BAD_REQUEST` は SNS API では返らない**（壊れた JSON も 422）。

### 3.4 Rate Limit

| 項目 | 値（`apps/web/src/api/rate-limit.ts` の `DEFAULT_RATE_LIMIT`） |
| --- | --- |
| 上限 | **60 秒あたり 300 回**（直近 60 秒の窓で数える） |
| 数える単位 | **エンドポイント（operationId）× 送信元 IP ごと**。`GET /social/posts` と `POST /social/posts` は別枠。トークンごとではない |
| 超えたとき | **429 `TOO_MANY_ATTEMPTS`** と **`Retry-After: <秒>`**（窓の最古の要求が外れるまでの秒数。切り上げ） |
| 残り回数のヘッダ | **無い**（`X-RateLimit-*` は返さない） |
| 認証との順序 | Rate Limit は認証より**前**に数える。401 になる要求も枠を消費する |

* 数える場所はサーバのメモリ（プロセスごと）。複数プロセスで動かしている構成では枠がプロセスごとになる
* **429 を受けたら `Retry-After` の秒数だけ待ってから同じ要求を送り直す。** `POST /social/posts` を
  送り直すときは `externalRef` を付けたままにする（§3.5）

### 3.5 冪等性（`externalRef`）

`POST /social/posts` は **`externalRef` を付ければ、何度送っても投稿は 1 つしかできない。**

| 1 回目 | 2 回目以降（同じトークン・同じ `externalRef`） |
| --- | --- |
| **201**、新しい投稿を返す | **200**、**既存の投稿をそのまま**返す（新しい投稿は作らない） |

* 冪等キーは **「登録したトークン」と `externalRef` の組**。別のトークンから同じ値を送ると別の投稿になる
* 値は前後の空白を取り除いてから比べる（`" a-1 "` と `"a-1"` は同じ）。1〜200 文字
* **2 回目で本文などを変えて送っても、保存されている内容は 1 回目のまま**（200 で 1 回目の内容が返る）。
  内容を変えるのは `PATCH`
* 2 回目の要求でも、**要求全体の形の検査（§4.4 の表）と、本文が空でないこと・`socialAccountId` のアカウントが
  存在することの検査は掛かる。** 形が壊れた再送は 422 になる。SNS ごとの規則（§5）は再送では検査しない
* 既存の投稿が `failed` / `published` でも 200 で返る。**失敗した投稿を出し直すときは新しい `externalRef`
  で登録する**
* 既存の投稿を `DELETE` で消した後に同じ `externalRef` を送ると、新しい投稿として 201 で作られる
* 同時に同じ `externalRef` を 2 本送っても 1 つにまとまる（DB の一意索引で守る）
* `social.post.created` イベント（Webhook）は**作ったときだけ**発火する。再送では発火しない
* **`externalRef` で投稿を検索する GET は無い。** 応答の `id` を外部アプリ側に保存する。
  保存し損ねたときは、同じ `externalRef` で再送すれば 200 で `id` が返る
* **セッション（Cookie）認証の要求で `externalRef` を付けると 422**（`details.externalRef`）

### 3.6 ページングと絞り込み

一覧 API（`GET /social/accounts`・`GET /social/posts`）はオフセット方式のページングを持つ。

| クエリ | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `page` | 整数 | `1` | 1 始まり |
| `perPage` | 整数 | `20` | 1 ページの件数。**1〜100 の範囲で指定する**（§10 の 2） |

* 並び順は**作成日時の新しい順**（同じ時刻は `id` の昇順）。並び順を変えるクエリは無い
* 整数でない値は 422（`details.page` / `details.perPage`）

### 3.7 OpenAPI

`GET /api/v1/openapi.json` が OpenAPI 3.1.0 の文書を返す（**認証不要**。Zod スキーマから自動生成）。

* SNS API の 11 操作（`listSocialAccounts`・`createSocialAccount`・`getSocialAccount`・`updateSocialAccount`・
  `deleteSocialAccount`・`listSocialPosts`・`createSocialPost`・`getSocialPost`・`updateSocialPost`・
  `deleteSocialPost`・`publishSocialPosts`）がすべて載る
* 必要な権限は各操作の拡張項目 **`x-required-permission`** に書かれている
* 認証方式は `session`（Cookie）と `bearer`（API トークン）の 2 つが宣言されている
* **OpenAPI に載らないこと**（この文書で補う）
  * `POST /social/posts` の**再送が 200 を返すこと**（成功は 201 だけが宣言されている）
  * 404・409 の応答（宣言されているのは 401・403・422・429・500）
  * SNS ごとの規則（§5）と、配信 Plugin が返す 422 の `details` のキー
  * `perPage` の推奨範囲（§3.6）

---

## 4. エンドポイント

以下、パスはすべて `/api/v1` からの相対。**`{id}` はすべて UUID の文字列。**

### 4.1 エンドポイント一覧

| メソッド | パス | 用途 | 権限 | 成功 |
| --- | --- | --- | --- | --- |
| GET | `/social/accounts` | アカウント一覧（投稿先の ID を引く） | `social.read` | 200 |
| GET | `/social/accounts/{id}` | アカウント 1 件 | `social.read` | 200 |
| POST | `/social/accounts` | アカウントの登録 | `social.write` | 201 |
| PATCH | `/social/accounts/{id}` | アカウントの更新・資格情報の差し替え | `social.write` | 200 |
| DELETE | `/social/accounts/{id}` | アカウントの削除（**そのアカウントの投稿もすべて消える**） | `social.delete` | 204 |
| GET | `/social/posts` | 投稿一覧 | `social.read` | 200 |
| GET | `/social/posts/{id}` | 投稿 1 件（結果の確認） | `social.read` | 200 |
| POST | `/social/posts` | **投稿の登録** | `social.write` | 201（再送は 200） |
| PATCH | `/social/posts/{id}` | 投稿の更新・取りやめ・手動投稿の結果の記録 | `social.write` | 200 |
| DELETE | `/social/posts/{id}` | 投稿の削除 | `social.delete` | 204 |
| POST | `/social/publish` | 期限の来た投稿の配信を今すぐ回す（運用向け） | `system.manage` | 200 |

### 4.2 SNS アカウント

#### アカウントの形（応答）

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `id` | string（UUID） | **投稿の `socialAccountId` に入れる値** |
| `provider` | string | どの SNS か（`bluesky` / `x` / `instagram` / `threads` など。§5） |
| `displayName` | string | 画面で見分けるための名前 |
| `handle` | string | SNS 側の表示上の ID（任意。空文字のことがある） |
| `status` | `connected` / `disconnected` / `error` | **表示用の目印。配信の可否には使われない** |
| `credentialConfigured` | boolean | 資格情報が設定済みか。**値そのものはどの API からも返らない** |
| `createdAt` / `updatedAt` | string（ISO 8601 UTC） | |

#### GET `/social/accounts` — 投稿先のアカウントを探す

| クエリ | 型 | 説明 |
| --- | --- | --- |
| `page` / `perPage` | 整数 | §3.6 |
| `provider` | string（32 文字以内） | その provider のアカウントだけに絞る（完全一致） |

```bash
curl -H "Authorization: Bearer $TORIFUNE_TOKEN" \
  'https://torifune.example.com/api/v1/social/accounts?provider=x&perPage=100'
```

```json
{
  "data": [
    {
      "id": "0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23",
      "provider": "x",
      "displayName": "広報アカウント（X）",
      "handle": "@example",
      "status": "connected",
      "credentialConfigured": true,
      "createdAt": "2026-09-20T02:11:05.412Z",
      "updatedAt": "2026-09-20T02:11:05.412Z"
    }
  ],
  "meta": { "page": 1, "perPage": 100, "total": 1 }
}
```

外部アプリは、この `id` を設定値として持っておき、投稿のたびに `socialAccountId` へ入れる。
同じ provider のアカウントが複数あるときは `displayName` / `handle` で選ぶ。

#### GET `/social/accounts/{id}`

1 件を返す。無ければ 404。

#### POST `/social/accounts` / PATCH `/social/accounts/{id}`

アカウントと資格情報の登録は通常、運用者が画面から行う。API で行う場合の項目は次のとおり
（`credentials` に何を入れるかは §5.6、運用上の注意は
[手順書 §2](SNS投稿の外部連携.md#2-snsアカウントを登録する)）。

| 項目 | 型 | 作成 | 更新 | 制約 |
| --- | --- | --- | --- | --- |
| `provider` | string | **必須** | 変更不可 | `^[a-z][a-z0-9_]{0,31}$`（違反は 422 `provider`）。Plugin が無い provider も登録できる |
| `displayName` | string | **必須** | 任意 | 前後の空白を除いて 1〜200 文字 |
| `handle` | string | 任意（既定 `""`） | 任意 | 200 文字以内 |
| `status` | enum | 任意（既定 `disconnected`） | 任意 | `connected` / `disconnected` / `error` |
| `credentials` | object | 任意 | 任意 | 値はすべて文字列。キーは配信 Plugin の宣言どおり（§5.6）。JSON にして 4096 文字以内。**更新で `{}` を送ると消える。省略すると変わらない** |
| `credential` | string | 任意 | 任意 | 旧形式（1 つの文字列）。4096 文字以内。**`credentials` と同時に送ると 422**。更新で `""` を送ると消える |

* 応答は §4.2 のアカウントの形（作成 201・更新 200）。資格情報は返らない
* `credentials` のキーの過不足・型違いは **422 `credentials`**。**その provider の配信 Plugin が
  入っていないときはキーを検証せずに保存する**

#### DELETE `/social/accounts/{id}`

204。**そのアカウントに紐づく投稿もすべて削除される**（予約中のものも含む）。

### 4.3 投稿の形（応答）

`GET` / `POST` / `PATCH` の `data`（一覧では `data[]` の各要素）。

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `id` | string（UUID） | 投稿の ID |
| `socialAccountId` | string（UUID） | 投稿先のアカウント |
| `body` | string | 本文（**`link` は含まない**。SNS ごとの組み立ては §5） |
| `scheduledAt` | string \| null | 予約日時（UTC） |
| `status` | `draft` / `scheduled` / `published` / `failed` | §6 |
| `deliveryMode` | `auto` / `manual` | 配信の方法 |
| `media` | `{ url: string, alt: string \| null }[]` | 添える画像 |
| `link` | string \| null | 添える URL |
| `providerOptions` | object | provider 固有の追加項目（§5） |
| `externalRef` | string \| null | 冪等キー（§3.5） |
| `publishedAt` | string \| null | `published` になった時刻 |
| `failedAt` | string \| null | `failed` になった時刻 |
| `failureReason` | string \| null | 失敗・再試行待ちの理由（人に見せてよい日本語。§6.4） |
| `externalId` | string \| null | SNS 側の投稿 ID（配信 Plugin が返したとき） |
| `externalUrl` | string \| null | SNS 側の投稿の URL（https のときだけ記録） |
| `attemptCount` | number | 配信に着手した回数（最大 5） |
| `nextAttemptAt` | string \| null | 次に配信を試みる時刻（再試行待ち・支度待ちのとき） |
| `skipCount` | number | 支度が整わず飛ばされた回数（§6.3） |
| `skipReason` | `no_publisher` / `credential_missing` / `account_missing` / null | 飛ばされた理由 |
| `createdAt` / `updatedAt` | string | |

**応答に出ないもの**：どのトークンが登録したか・配信の進行中の印・資格情報。

### 4.4 POST `/social/posts` — 投稿を登録する

#### 要求項目

| 項目 | 型 | 必須 | 既定 | 制約（違反は 422。`details` のキーはその項目名） |
| --- | --- | --- | --- | --- |
| `socialAccountId` | string | **必須** | — | 存在するアカウントの `id`。無ければ 422 `socialAccountId`（404 ではない） |
| `body` | string | **必須** | — | 1〜10000 文字（UTF-16 の長さ）。空白だけは不可。**SNS ごとの上限は §5** |
| `status` | enum | 任意 | `draft` | `draft`（下書き。配信しない）/ `scheduled`（予約。配信する）。`published` / `failed` も形式上は受け付けるが、配信されず `publishedAt` / `failedAt` も入らない。外部アプリは使わない |
| `scheduledAt` | string \| null | `scheduled` のとき必須 | `null` | §1.4 の形式。`status: "scheduled"` で無ければ 422 `scheduledAt`。**過去の時刻も可**（次の定期実行で配信） |
| `deliveryMode` | enum | 任意 | `auto` | `auto`（Torifune が配信）/ `manual`（人が SNS の投稿画面から投稿。§6.5）。provider によって使えない値がある（§5） |
| `media` | array | 任意 | `[]` | 最大 10 件。各要素 `{ "url": string, "alt"?: string \| null }`。`url` は **https のみ**・2048 文字以内・`user:pass@` を含まない。`alt` は 1000 文字以内。**`manual` では 1 件も付けられない**。SNS ごとの枚数・形式は §5 |
| `link` | string \| null | 任意 | `null` | 添える URL。**https のみ**・2048 文字以内・`user:pass@` を含まない。空文字は不可（消すなら `null`）。SNS ごとの扱いは §5 |
| `providerOptions` | object | 任意 | `{}` | JSON にして 4096 バイト以内。**中身は配信 Plugin が検査する**。いまの Plugin で受け付けるキーは Bluesky の `langs` だけ（§5） |
| `externalRef` | string | 任意（**付けることを強く推奨**） | なし | 1〜200 文字（前後の空白は除く）。§3.5 |

#### 要求例

```bash
curl -X POST https://torifune.example.com/api/v1/social/posts \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "socialAccountId": "0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23",
        "body": "新しい記事を公開しました。",
        "link": "https://example.com/articles/1234",
        "media": [{ "url": "https://cdn.example.com/ogp/1234.jpg", "alt": "記事のサムネイル" }],
        "status": "scheduled",
        "scheduledAt": "2026-10-01T09:00:00+09:00",
        "deliveryMode": "auto",
        "externalRef": "article-1234"
      }'
```

#### 応答例（201。再送なら同じ形で 200）

```json
{
  "data": {
    "id": "0192c1f3-8e2a-7d44-b0a1-6f3e2c9d7a10",
    "socialAccountId": "0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23",
    "body": "新しい記事を公開しました。",
    "scheduledAt": "2026-10-01T00:00:00.000Z",
    "status": "scheduled",
    "publishedAt": null,
    "failedAt": null,
    "failureReason": null,
    "createdAt": "2026-09-24T03:15:42.118Z",
    "updatedAt": "2026-09-24T03:15:42.118Z",
    "deliveryMode": "auto",
    "media": [{ "url": "https://cdn.example.com/ogp/1234.jpg", "alt": "記事のサムネイル" }],
    "link": "https://example.com/articles/1234",
    "providerOptions": {},
    "externalRef": "article-1234",
    "externalId": null,
    "externalUrl": null,
    "attemptCount": 0,
    "nextAttemptAt": null,
    "skipCount": 0,
    "skipReason": null
  }
}
```

#### 検査の順序と 422 の出方

検査は次の順に行い、**2〜7 は最初に見つかった 1 つだけを返す**（8 だけは複数のキーを同時に返しうる）。

| 順 | 検査 | 422 の `details` のキー |
| ---: | --- | --- |
| 1 | 要求全体の形（型・必須・長さ・https・件数・列挙値）。**違反はまとめて返る** | 各項目名 |
| 2 | 本文が空白だけでない | `body` |
| 3 | `socialAccountId` のアカウントが存在する | `socialAccountId` |
| 4 | `externalRef` をトークン認証で付けている | `externalRef` |
| — | （`externalRef` が既存と一致したら、ここで 200 を返して終わる） | — |
| 5 | `status: "scheduled"` なら `scheduledAt` がある | `scheduledAt` |
| 6 | `deliveryMode: "manual"` なら `media` が空 | `media` |
| 7 | `deliveryMode: "manual"` なら、その provider の配信 Plugin が手動投稿に対応している（**Plugin が入っていない provider の `manual` も 422**） | `deliveryMode` |
| 8a | 配信 Plugin が宣言した上限（本文の長さ・媒体の最大数・媒体の必須） | `body` / `media` |
| 8b | 配信 Plugin の検査（`validate()`。SNS ごとの数え方・リンク・`providerOptions` など） | `body` / `media` / `link` / `deliveryMode` / `providerOptions.<キー>` など（§5） |

* **8a・8b は `status: "draft"` でも掛かる**（作成時）
* **その provider の配信 Plugin が入っていなければ 8a・8b は行わない。** `auto` の予約は断られずに保存され、
  配信の時刻に「支度待ち」になる（§6.3）
* 8b の配信 Plugin の検査が例外を投げた・5 秒以内に終わらなかったときは **500 `INTERNAL_ERROR`**
  （外部アプリの入力の問題ではない。時間をおいて同じ `externalRef` で再送してよい）

### 4.5 GET `/social/posts` — 投稿一覧

| クエリ | 型 | 説明 |
| --- | --- | --- |
| `page` / `perPage` | 整数 | §3.6 |
| `accountId` | string | そのアカウントの投稿だけに絞る。**UUID の形でない値は絞り込みが無視され、全件が返る**（§10 の 3） |
| `status` | enum | `draft` / `scheduled` / `published` / `failed` のどれか 1 つ。列挙外は 422 `status` |

並びは作成日時の新しい順。応答は §3.1 の一覧の形で、各要素は §4.3。

**他のアプリ（別トークン）が登録した投稿も含めて返る**（§2.3）。自分の投稿だけを見たいときは、
保存しておいた `id` で `GET /social/posts/{id}` を引くか、`externalRef` で見分ける。

### 4.6 GET `/social/posts/{id}` — 結果を確かめる

1 件を返す。無ければ 404。状態の読み方は §6。

### 4.7 PATCH `/social/posts/{id}` — 更新・取りやめ・結果の記録

**送った項目だけが変わる。** 省略した項目は変わらない。`null` を送れる項目は `null` で消える。

| 項目 | 型 | 制約・意味 |
| --- | --- | --- |
| `body` | string | 1〜10000 文字。空白だけは不可 |
| `scheduledAt` | string \| null | §1.4。**未来の時刻にすると支度待ちの待ち時刻（`nextAttemptAt`）が消える**（§6.3） |
| `status` | enum | 遷移の規則（§6.1）に従う。`draft` へ戻す＝**取りやめ** |
| `deliveryMode` | enum | `auto` / `manual`。`manual` へ変えるときは provider の対応を検査する |
| `media` | array | §4.4 と同じ |
| `link` | string \| null | §4.4 と同じ。`null` で消す |
| `providerOptions` | object | §4.4 と同じ |
| `externalId` | string \| null | SNS 側の投稿 ID。200 文字以内（**手動投稿の結果を記録するとき**に使う） |
| `externalUrl` | string \| null | SNS 側の投稿の URL。**https のみ**・2048 文字以内 |
| `failureReason` | string \| null | 失敗の理由。2000 文字を超えた分は切り詰めて保存（エラーにしない）。空文字は `null` 扱い |

* `socialAccountId` と `externalRef` は**変えられない**（送っても無視される）
* **配信の最中（`auto` の予約で Torifune が SNS へ送っている間）は、`body`・`media`・`link`・
  `providerOptions`・`scheduledAt`・`deliveryMode`・`status` を変えられない**（422 `status`
  「配信を開始しているため変更できません。」）。長くても数十秒で外れる
* 変更後の値に対して §4.4 の 5〜8 と同じ検査を掛ける。ただし
  * 5・6（予約日時・手動投稿の媒体）は**変更後が `draft` / `scheduled` のときだけ**
  * 7（手動投稿の対応）は **`deliveryMode: "manual"` を送ったときだけ**
  * 8a・8b（SNS ごとの規則）は**変更後が `scheduled` のときだけ**。`draft` への取りやめ、
    `published` / `failed` の記録は配信 Plugin の都合で断られない
* `status` を `published` にすると `publishedAt` が、`failed` にすると `failedAt` が記録され、
  それぞれ `social.post.published` / `social.post.failed` イベントが発火する

```bash
# 予約を取りやめる（下書きへ戻す）
curl -X PATCH https://torifune.example.com/api/v1/social/posts/$POST_ID \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "status": "draft" }'

# 手動投稿を人が SNS で出した後、結果を記録する
curl -X PATCH https://torifune.example.com/api/v1/social/posts/$POST_ID \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "status": "published", "externalUrl": "https://x.com/i/status/1840000000000000000" }'
```

### 4.8 DELETE `/social/posts/{id}`

204。`social.delete` が要る（`social.read` + `social.write` だけのトークンでは 403）。
予約を止めるだけなら、削除ではなく `PATCH { "status": "draft" }`（取りやめ）でよい。

### 4.9 POST `/social/publish` — 配信を今すぐ回す（運用向け）

期限の来た `auto` の予約を今すぐ配信する。**通常の外部アプリは呼ばない。** Torifune は既定で
1 分ごとに同じ処理を自分で回している。定期実行を止めた構成（`TORIFUNE_SCHEDULER=off`）で
外部の cron から叩くためのもので、`system.manage` が要る。要求本文は不要。

応答は件数だけ（`interrupted`・`due`・`skipped`・`skipFailed`・`attempted`・`published`・`retried`・
`failed`・`unrecorded`）。他の実行が 10 秒以上続いていれば **409 `CONFLICT`**（`details.job`、
`Retry-After: 10`）。各キーの意味は [手順書 §7](SNS投稿の外部連携.md#7-定期実行を止めている場合)。

---

## 5. SNS ごとの仕様

### 5.1 前提

* **規則を決めるのは、その provider を担当する配信 Plugin。** 登録時（§4.4 の 8a・8b）と、
  配信の直前にもう一度、同じ規則で検査する。登録を通った投稿が配信の時刻に規則で落ちることは基本的に無い
* **Plugin が入っていない provider には SNS ごとの規則が掛からない**（Core の規則だけ）
* **provider `x` の Plugin は 2 種類あり、同時には有効にできない**（先に有効になったほうが担当する）。
  どちらが有効かで使える配信モードが変わる。**外部アプリからどちらが有効かを問い合わせる API は無い**
  ので、運用者に確かめるか、`auto` で登録して 422 `deliveryMode` が返るかで判断する
* 以下の「上限」は登録時に 422 で断られる条件。「配信時の失敗」は登録を通った後に SNS 側の都合で
  `failed` / 再試行になる条件

### 5.2 一覧表

| | Bluesky | X（`sns-x-api`：X API 版） | X（`sns-x-manual`：無料版） | Threads | Instagram |
| --- | --- | --- | --- | --- | --- |
| `provider` | `bluesky` | `x` | `x` | `threads` | `instagram` |
| `deliveryMode: auto` | ○ | ○ | **×**（422 `deliveryMode`） | ○ | ○ |
| `deliveryMode: manual` | ○ | ○ | ○ | ○ | **×**（422 `deliveryMode`） |
| 本文の上限 | **300 grapheme** かつ **3000 UTF-8 バイト**（別に Core が UTF-16 長 3000 で先に見る） | **重み付き 280**（§5.3） | **重み付き 280**（§5.3） | **500**（§5.4） | **2200**（UTF-16 の長さ） |
| 本文のその他の上限 | — | 対になっていないサロゲートは不可 | 同左 | リンクは**異なる URL 5 本まで**。対になっていないサロゲートは不可 | ハッシュタグ 30 個・メンション 20 件まで |
| `link` の扱い（`auto`） | **リンクカード**（本文には足さない。カードの見出しはホスト名） | **本文の末尾に改行して足す**（長さに含む） | —（`auto` 不可） | **本文の末尾に改行して足す**（長さ・本数に含む） | **指定不可**（422 `link`） |
| `link` の扱い（`manual`） | 本文の末尾に改行して足す（長さに含む） | 同左 | 同左 | 同左 | — |
| `media` の枚数 | 0〜4 | 0〜4 | —（`manual` のみのため 0） | 0〜10（2 枚以上はカルーセル） | **1〜10 必須**（0 枚は 422 `media`） |
| `media` の形式・大きさ | PNG・JPEG・GIF・WebP、**1 MB（1,000,000 バイト）まで** | JPEG・PNG・WebP、**5 MB（5,000,000 バイト）まで** | — | JPEG・PNG、8 MB まで（Threads 側の条件。登録時は検査しない） | **JPEG のみ**（Instagram 側の条件。登録時は検査しない） |
| 画像を取りに行くのは | **Torifune のサーバ** | **Torifune のサーバ** | — | **Threads（Meta）のサーバ** | **Instagram（Meta）のサーバ** |
| `media` と `link` の併用 | **不可**（`auto` で 422 `link`） | 可 | — | 可 | —（`link` 不可） |
| `alt` | 送る（1000 grapheme まで。超えると 422 `media`） | **送らない**（無視） | — | 送る（`alt_text`） | **送らない**（無視） |
| `providerOptions` | `langs` だけ受け付ける（言語コードの配列・3 件まで・各 2〜16 文字。例 `{"langs":["ja"]}`）。他のキーは 422 `providerOptions.<キー>` | どのキーも 422 `providerOptions.<キー>` | 同左 | 同左 | 同左 |
| 手動投稿の URL の上限 | **登録時に検査しない**（§5.5・§10 の 5） | intent URL 2048 文字（422 `body`） | 同左 | intent URL 2048 文字（422 `body`） | — |
| 配信後の `externalUrl` | `https://bsky.app/profile/<handle>/post/<rkey>` | `https://x.com/i/status/<id>` | —（人が PATCH で記録） | Threads が返す投稿の URL | Instagram が返す投稿の URL |

**手動投稿（`manual`）では `media` を 1 件も付けられない**（全 SNS 共通。422 `media`）。
画像は人が SNS の投稿画面で添付する。

### 5.3 X の本文の数え方（重み付き 280）

`sns-x-api` と `sns-x-manual` は同じ数え方（`plugins/sns-x-*/x-text.ts`。2 つは同一内容）。
**数えるのは「本文 + 改行 + `link`」**（`link` が無ければ本文だけ）。

1. NFC に正規化する
2. `http://` / `https://` から ASCII の表示文字（`!`〜`~`）が続く限りを 1 つの URL とみなし、
   末尾の `. , ; : ! ? ) ]` を外す。**URL は長さによらず 1 本 23** と数える。
   URL は空白・日本語などの非 ASCII 文字・次の `http(s)://` の直前で終わる
3. 残りを grapheme（見た目の 1 文字）に分け、**絵文字の grapheme は 2**、それ以外はコードポイントごとに
   **U+0000〜U+10FF・U+2000〜U+200D・U+2010〜U+201F・U+2032〜U+2037 は 1、それ以外（日本語など）は 2**
4. 合計が 280 以下なら通る

目安：**日本語だけなら 140 文字**。`link` を付けると「改行 1 + 23」の 24 を使う。
`https://` の無い `example.com` は URL として数えない（1 文字ずつ数える。X 本体の数え方より多めか少なめに
ずれうる）。

### 5.4 Threads の本文の数え方（500）

`plugins/sns-threads/threads-text.ts`。**数えるのは「本文 + 改行 + `link`」**。

1. 正規化しない
2. grapheme に分け、**絵文字を含む grapheme はその grapheme の UTF-8 のバイト数**、
   それ以外は UTF-16 の長さ（日本語 1 文字 = 1）で数える。多くの絵文字は 1 つで 4 以上になる
3. 合計が 500 以下なら通る

リンクの本数は、X と同じ切り出し方で見つけた URL のうち**文字列として異なるもの**を数え、5 本まで
（大文字・小文字や末尾の `/` の違いも別の URL として数える）。

### 5.5 手動投稿の URL の長さ

手動投稿では、Torifune が SNS の投稿画面の URL（Web Intent）に本文を埋め込む。
この URL は **2048 文字まで**（Core の規則）で、日本語 1 文字は URL の中で 9 文字（`%E3%81%82`）になる。

| SNS | 投稿画面の URL の先頭 | 日本語だけの本文で入る目安 | 登録時の検査 |
| --- | --- | --- | --- |
| X | `https://x.com/intent/tweet?text=` | 約 224 文字（ただし重み付き 280 の上限＝日本語 140 文字が先に効く） | あり（422 `body`「投稿画面の URL が長くなりすぎます…」） |
| Threads | `https://www.threads.com/intent/post?text=` | **約 223 文字**（本文の上限 500 より先に効く） | あり（422 `body`） |
| Bluesky | `https://bsky.app/intent/compose?text=` | 約 223 文字 | **無い**。超えると登録は通るが、画面の「投稿画面を開く」が失敗する（§10 の 5） |

改行は 3 文字（`%0A`）、英数字は 1 文字として数える。`link` も本文に含めて埋め込まれる。

### 5.6 `credentials` のキー（アカウント登録用）

アカウントを API で登録する場合に `credentials` へ入れるキー（`credentialFields` の宣言）。
値の取り方は各 Plugin のヘルプと [手順書 §2](SNS投稿の外部連携.md#credentials-に何を入れるか)。

| Plugin | キー |
| --- | --- |
| `sns-bluesky` | `identifier`（ハンドルまたはメールアドレス）、`appPassword`（`xxxx-xxxx-xxxx-xxxx` の App Password。**ログイン用パスワードは配信時に送らずに止める**） |
| `sns-x-api` | `apiKey`、`apiKeySecret`、`accessToken`、`accessTokenSecret`（OAuth 1.0a） |
| `sns-x-manual` | なし（資格情報を使わない） |
| `sns-threads` | `threadsUserId`（数字）、`accessToken`（長期トークン）、`accessTokenExpiresAt`（ISO 8601 か `unknown`） |
| `sns-instagram` | `igUserId`（数字か `auto`）、`accessToken`（長期トークン）、`accessTokenExpiresAt`（ISO 8601 か `unknown`） |

### 5.7 画像（`media`）の URL の条件

* **Torifune は画像ファイルを預からない。** `media[].url` に入れるのは取りに行ける URL
* **配信時刻まで同じ URL で取得できること。** 消えていれば配信が失敗する
* **認証の要る URL・転送（3xx）される URL は使えない。** Bluesky / X では Torifune のサーバが
  転送を追わずに取りに行く。Threads / Instagram では Meta のサーバが取りに行くので、
  **インターネットから直接取得できる公開 URL** でなければならない
* 形式・大きさ（§5.2）は**登録時には検査しない**（URL の形だけを見る）。守られていないと配信時に失敗する

### 5.8 配信時に失敗・再試行になりうる条件（登録後）

| 起きること | 結果 |
| --- | --- |
| 資格情報の誤り・失効（トークン切れ、権限不足、App Password の形でない値など） | `failed`。`failureReason` に直し方が入る |
| 画像が取れない・大きすぎる・形式が違う・転送される | 一時的なら再試行、URL を直す必要があれば `failed` |
| SNS 側の Rate Limit（429） | 再試行（SNS が返した待ち時間に従う） |
| SNS が内容を拒否（重複した連投、ポリシー違反など） | `failed` |
| 送った後に応答が分からない（接続断・タイムアウト・5xx） | **`failed`（結果不明）。再試行しない**（二重投稿を避けるため。§8.1） |
| Instagram の 24 時間あたりの公開数の上限 | `failed` |

---

## 6. 状態遷移と結果の受け取り

### 6.1 状態（`status`）と遷移

```text
draft ──→ scheduled ──→ published
  │  ◀──────┘  │
  └────────────┴──→ failed
```

| 現在 | 変えられる先 |
| --- | --- |
| `draft` | `draft` / `scheduled` / `published` / `failed` |
| `scheduled` | `scheduled` / `draft`（取りやめ）/ `published` / `failed` |
| `published` | `published` のみ（**終端**） |
| `failed` | `failed` のみ（**終端**） |

終端から動かそうとすると 422 `status`（「published から draft へは変更できません。」など）。
**失敗した投稿を出し直すときは、新しい投稿として（新しい `externalRef` で）登録する。**

### 6.2 進み具合の読み方

状態は 4 つだけで、配信の進み具合は他の項目との組み合わせで読む。

| 見たいこと | 条件 |
| --- | --- |
| 配信待ち | `status: "scheduled"`・`deliveryMode: "auto"`・`attemptCount: 0`・`nextAttemptAt: null` |
| 再試行待ち | `status: "scheduled"`・`nextAttemptAt` あり・`failureReason` あり（前回の理由） |
| 支度待ち | `status: "scheduled"`・`nextAttemptAt` あり・**`skipCount` が 1 以上**・`failureReason: null`（§6.3） |
| 手動投稿待ち | `status: "scheduled"`・`deliveryMode: "manual"`・`scheduledAt` が現在以前（§6.5） |
| 配信済み | `status: "published"`・`publishedAt`・（返れば）`externalId` / `externalUrl` |
| 失敗 | `status: "failed"`・`failedAt`・`failureReason` |

再試行は**送る前に失敗したと配信 Plugin が明言したときだけ**行い、間隔は 1 → 2 → 4 → 8 分
（SNS が指定した待ち時間のほうが長ければそちら。上限 24 時間）、**着手は最大 5 回**。
配信 Plugin が 30 秒以内に応答しなければ `failed`（結果不明）。

### 6.3 支度待ち（`skipCount` / `skipReason`）

配信の時刻に支度が整っていない予約は、すぐには失敗させずに後ろへ送る。

| `skipReason` | 何が足りないか |
| --- | --- |
| `no_publisher` | その provider の配信 Plugin が無い（または自動配信を実装していない） |
| `credential_missing` | アカウントの資格情報が未設定（`credentialConfigured: false`） |
| `account_missing` | 投稿の指すアカウントが無い |

* 飛ばすたびに待ち時刻を後ろへ送る（1 回目の後 1 時間、2 回目の後 23 時間）。
  **同じ理由で 3 回飛ばすと `failed`**（予約日時から約 24 時間）。理由が変われば 1 から数え直す
* **予約し直し（未来の `scheduledAt` への PATCH）で待ち時刻は消えるが、`skipCount` は減らない。**
  支度を整えてから日時を直す。配信に着手できた時点で 0 に戻る
* 回数と間隔は版で変わりうる。**`skipCount` の具体的な値で分岐しない**

詳しい運用は [手順書 §5](SNS投稿の外部連携.md#予約がいつまでも-scheduled-のまま動かないとき)。

### 6.4 `failureReason`

**そのまま人に見せてよい日本語の文。** 配信 Plugin の文言か Torifune の文言が入り、資格情報の値は伏せてある。
文の中身で分岐しないこと（文言は版で変わる）。目安として「**結果不明**」を含むものは、
SNS 側に投稿されている可能性があるので**人が SNS を確かめてから**登録し直す。

### 6.5 手動投稿（`deliveryMode: "manual"`）

* 予約日時が来ると、管理画面 `/social` の「手動投稿待ち」に並ぶ。人が「投稿画面を開く」を押すと、
  本文（と `link`）を入れた SNS の投稿画面が開き、人が投稿する
* **Torifune の定期実行は手動投稿に一切触らない。** `attemptCount` は 0 のまま、人が記録するまで
  `scheduled` のまま残る
* 結果の記録は画面の「投稿した」「取りやめ」、または API の `PATCH`（§4.7）で行う
  * 投稿した：`{ "status": "published", "externalUrl": "https://…", "externalId": "…" }`
    （`externalUrl` / `externalId` は任意）
  * 取りやめ：`{ "status": "draft" }`
* **外部アプリが投稿画面の URL を API で受け取る口は無い**（画面専用）

### 6.6 イベントと Webhook

ポーリングの代わりに Webhook で受け取れる。登録は `POST /api/v1/webhooks`（`system.manage` が要る。
運用者が行う）で、`events` に購読するイベント名を並べる。

| イベント | いつ |
| --- | --- |
| `social.post.created` | 投稿を作った（`externalRef` の再送では発火しない） |
| `social.post.published` | 定期実行が配信に成功した／`PATCH` で `published` にした |
| `social.post.failed` | 定期実行が失敗・取りやめ・中断と判定した／`PATCH` で `failed` にした |

Webhook の本文は `{ "event": "<イベント名>", "data": { "postId": "…", "accountId": "…", "status": "…" } }`。
**理由・本文・URL は載らない**ので、必要なら `GET /social/posts/{postId}` で引く。

| ヘッダ | 内容 |
| --- | --- |
| `X-Torifune-Event` | イベント名 |
| `X-Torifune-Delivery` | 配信 ID。**再試行でも変わらない**ので、受け手はこれで二重処理を避ける |
| `X-Torifune-Timestamp` | 送った時刻（UNIX 秒） |
| `X-Torifune-Signature` | `sha256=<HMAC-SHA256(secret, "<timestamp>.<本文>") の 16 進>` |

受け手は署名を定数時間比較で検証し、`X-Torifune-Timestamp` が現在から離れすぎていないことを確かめる
（リプレイ対策は受け手の責任）。2xx 以外は失敗とみなされ、最大 5 回まで間隔を広げて送り直される。
Payload の定義は [`Eventリファレンス.md`](../Eventリファレンス.md)。

---

## 7. 実装例

流れ：**アカウント一覧から投稿先を選ぶ → `externalRef` 付きで投稿を登録 → 結果をポーリング。**
422 は直して出し直す（自動で再送しない）、429 は `Retry-After` だけ待って同じ要求を再送、
5xx・通信エラーは同じ `externalRef` のまま再送する。

### 7.1 curl

```bash
BASE=https://torifune.example.com/api/v1
AUTH="Authorization: Bearer $TORIFUNE_TOKEN"

# 1. 投稿先（X のアカウント）の id を引く
curl -sS -H "$AUTH" "$BASE/social/accounts?provider=x" | jq -r '.data[] | "\(.id)\t\(.displayName)"'

# 2. 投稿を登録する（-i でステータスコードを見る。201=作った / 200=既にあった）
curl -sS -i -X POST "$BASE/social/posts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"socialAccountId":"'"$ACCOUNT_ID"'","body":"本日のお知らせです。",
       "status":"scheduled","scheduledAt":"2026-10-01T09:00:00+09:00",
       "deliveryMode":"auto","externalRef":"notice-2026-10-01"}'

# 3. 結果を見る
curl -sS -H "$AUTH" "$BASE/social/posts/$POST_ID" \
  | jq '.data | {status, failureReason, externalUrl, attemptCount, nextAttemptAt, skipCount}'
```

### 7.2 TypeScript（Node.js 18 以上の `fetch`）

```ts
const BASE = 'https://torifune.example.com/api/v1';
const TOKEN = process.env.TORIFUNE_TOKEN ?? ''; // コードに直接書かない

type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, string[]> };
};

class TorifuneValidationError extends Error {
  constructor(readonly details: Record<string, string[]>) {
    super('Torifune が入力を受け付けませんでした');
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 1 回の API 呼び出し。429 は Retry-After だけ待って、5xx と通信エラーは間隔を広げて、同じ要求を送り直す。
 * POST /social/posts は externalRef を付けて呼ぶこと（送り直しても投稿は 1 つにしかならない）。
 */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt >= 5) throw error;
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (response.status === 429 && attempt < 5) {
      const seconds = Number(response.headers.get('Retry-After') ?? '60');
      await sleep((Number.isFinite(seconds) ? seconds : 60) * 1000);
      continue;
    }
    if (response.status >= 500 && attempt < 5) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (response.status === 204) {
      return { status: 204, data: undefined as T };
    }

    const json = (await response.json()) as { data: T } | ErrorBody;
    if ('error' in json) {
      if (json.error.code === 'VALIDATION_ERROR') {
        // 422 は入力の問題。送り直しても同じ結果になる。
        throw new TorifuneValidationError(json.error.details ?? {});
      }
      throw new Error(`Torifune API ${response.status} ${json.error.code}`);
    }
    return { status: response.status, data: json.data };
  }
}

type Account = { id: string; provider: string; displayName: string; handle: string };
type Post = {
  id: string;
  status: 'draft' | 'scheduled' | 'published' | 'failed';
  deliveryMode: 'auto' | 'manual';
  failureReason: string | null;
  externalUrl: string | null;
  skipCount: number;
};

async function main(): Promise<void> {
  // 1. 投稿先を選ぶ
  const accounts = await call<Account[]>('GET', '/social/accounts?provider=bluesky&perPage=100');
  const account = accounts.data[0];
  if (account === undefined) throw new Error('bluesky のアカウントが登録されていません');

  // 2. 登録する。externalRef は外部アプリ側で一意に決まる値にする
  let post: Post;
  try {
    const created = await call<Post>('POST', '/social/posts', {
      socialAccountId: account.id,
      body: '新しい記事を公開しました。',
      link: 'https://example.com/articles/1234',
      status: 'scheduled',
      scheduledAt: new Date().toISOString(), // いますぐ（次の定期実行で配信）
      deliveryMode: 'auto',
      providerOptions: { langs: ['ja'] }, // Bluesky だけが受け付ける
      externalRef: 'article-1234',
    });
    post = created.data;
    console.log(created.status === 201 ? '登録しました' : '登録済みでした', post.id);
  } catch (error) {
    if (error instanceof TorifuneValidationError) {
      // キーで分岐する。値の文言はそのまま人に見せてよい
      for (const [field, messages] of Object.entries(error.details)) {
        console.error(`${field}: ${messages.join(' / ')}`);
      }
      return;
    }
    throw error;
  }

  // 3. 結果を待つ。published / failed が終端
  for (;;) {
    const { data } = await call<Post>('GET', `/social/posts/${post.id}`);
    if (data.status === 'published') {
      console.log('配信されました', data.externalUrl);
      return;
    }
    if (data.status === 'failed') {
      console.error('配信に失敗しました', data.failureReason);
      return;
    }
    if (data.deliveryMode === 'manual') {
      console.log('人が投稿するのを待っています（手動投稿）');
      return;
    }
    await sleep(30_000); // 定期実行は既定 1 分ごと。詰めすぎない
  }
}

void main();
```

### 7.3 Python（requests）

```python
import os
import time

import requests

BASE = "https://torifune.example.com/api/v1"
TOKEN = os.environ["TORIFUNE_TOKEN"]  # コードに直接書かない


class TorifuneValidationError(Exception):
    def __init__(self, details):
        super().__init__("Torifune が入力を受け付けませんでした")
        self.details = details


def call(method, path, body=None):
    """429 は Retry-After だけ待って、5xx と通信エラーは間隔を広げて、同じ要求を送り直す。"""
    for attempt in range(1, 6):
        try:
            response = requests.request(
                method,
                BASE + path,
                headers={"Authorization": f"Bearer {TOKEN}"},
                json=body,
                timeout=30,
            )
        except requests.RequestException:
            if attempt == 5:
                raise
            time.sleep(2**attempt)
            continue

        if response.status_code == 429 and attempt < 5:
            time.sleep(int(response.headers.get("Retry-After", "60")))
            continue
        if response.status_code >= 500 and attempt < 5:
            time.sleep(2**attempt)
            continue
        if response.status_code == 204:
            return 204, None

        payload = response.json()
        if "error" in payload:
            if payload["error"]["code"] == "VALIDATION_ERROR":
                raise TorifuneValidationError(payload["error"].get("details", {}))
            raise RuntimeError(f"Torifune API {response.status_code} {payload['error']['code']}")
        return response.status_code, payload["data"]
    raise RuntimeError("unreachable")


# 1. 投稿先を選ぶ
_, accounts = call("GET", "/social/accounts?provider=x&perPage=100")
account = accounts[0]

# 2. 登録する（X の無料版 Plugin なら deliveryMode は manual にする）
try:
    status, post = call(
        "POST",
        "/social/posts",
        {
            "socialAccountId": account["id"],
            "body": "本日のお知らせです。",
            "link": "https://example.com/news/20261001",
            "status": "scheduled",
            "scheduledAt": "2026-10-01T09:00:00+09:00",
            "deliveryMode": "auto",
            "externalRef": "notice-2026-10-01",
        },
    )
    print("登録しました" if status == 201 else "登録済みでした", post["id"])
except TorifuneValidationError as error:
    for field, messages in error.details.items():
        print(f"{field}: {' / '.join(messages)}")
    raise SystemExit(1)

# 3. 結果を待つ
while True:
    _, current = call("GET", f"/social/posts/{post['id']}")
    if current["status"] == "published":
        print("配信されました", current["externalUrl"])
        break
    if current["status"] == "failed":
        print("配信に失敗しました", current["failureReason"])
        break
    if current["deliveryMode"] == "manual":
        print("人が投稿するのを待っています（手動投稿）")
        break
    time.sleep(60)
```

---

## 8. 実装上の注意

### 8.1 二重投稿を避ける

* **`POST /social/posts` には必ず `externalRef` を付ける。** 付けないと、応答を受け取り損ねて再送したときに
  投稿が 2 つでき、SNS に同じ内容が 2 回出る
* `externalRef` は**外部アプリ側で一意に決まる値**（記事 ID・ジョブ ID など）にし、再送では**同じ値**を使う。
  乱数を毎回作り直すと冪等にならない
* **トークンを差し替えると冪等キーの名前空間が変わる。** 応答を受け取れていない登録が残っている間は
  差し替えない（[手順書 §4](SNS投稿の外部連携.md#トークンを差し替えるとき)）
* Torifune は「送ったかもしれない」ときに再送しない。その代わり、**実際には投稿されているのに
  `failed`（結果不明）になる**ことがある。自動で登録し直さず、人が SNS 側を確かめる

### 8.2 時刻

* `scheduledAt` は**オフセット付きの ISO 8601** で送る（§1.4）
* 配信は予約日時ちょうどではなく、**その後の最初の定期実行**（既定 1 分ごと）で行われる。
  1 回の実行で送るのは最大 20 件なので、同じ時刻に大量に予約すると後ろのものは次の周期へずれる
* 過去の時刻で登録すると次の定期実行で配信される

### 8.3 秘密の扱い

* API トークンは環境変数やシークレットストアから読み、**ソースコード・ログ・URL に書かない**
* 資格情報（`credentials`）は書き込み専用で、どの API からも読み出せない。外部アプリ側に控えが要るなら、
  外部アプリ側の秘密の保管場所に置く
* `media[].url`・`link` に署名付き URL などの秘密を含めない。投稿の応答として `social.read` を持つ誰にでも見える

### 8.4 手動投稿

* 手動投稿は**人が画面で操作するまで終わらない。** 外部アプリの処理を手動投稿の完了で待たせない
* 使えるかは provider と、X の場合はどちらの Plugin が有効かで決まる（§5.2）。
  使えないと 422 `deliveryMode`
* 本文は投稿画面の URL に埋め込まれるので、日本語で約 220 文字を超えると開けなくなる（§5.5）

### 8.5 そのほか

* 投稿先 SNS の規則は Plugin の版で変わりうる。**文字数の事前チェックを外部アプリ側に持つ場合も、
  最終判断は Torifune の 422 に任せる**（`details` のキーを見て利用者へ返す）
* 他のアプリが登録した投稿も一覧に出る（§2.3）。一覧を処理するときは自分の `externalRef` の形で絞る

---

## 9. 変更履歴・関連文書

### 変更履歴

| 日付 | 内容 |
| --- | --- |
| 2026-09-24 | 初版。コード（Core の SNS API と `sns-bluesky` / `sns-x-api` / `sns-x-manual` / `sns-threads` / `sns-instagram` の 5 Plugin）から起こした |

### 関連文書

* 運用手順（トークン発行・アカウント登録・結果の読み方）：[`SNS投稿の外部連携.md`](SNS投稿の外部連携.md)
* イベントと Webhook：[`Eventリファレンス.md`](../Eventリファレンス.md)
* 配信 Plugin の作り方：[`Plugin開発ガイド.md`](../Plugin開発ガイド.md) §9
* API の全体方針：`docs/仕様書/05_API設計.md`（§10・§11 形式、§18 SNS API、§33 ページング、§36 Rate Limit、§37・§38 API Token）
* 設計：`docs/設計/035-social-publishing/設計.md`、各 SNS は `036-sns-bluesky` / `037-sns-x` /
  `038-sns-instagram` / `040-sns-threads`

---

## 10. 設計書・手順書とコードの食い違い、未確定の点

この文書はコードに合わせた。以下は設計書・手順書の記述と違う、またはコードの振る舞いとして注意が要る点。

1. **`providerOptions` の例**：手順書 §3 は「返信先の ID など」と書くが、**いまの 5 Plugin で受け付けるキーは
   Bluesky の `langs` だけ**で、他はすべて 422。返信・引用などはできない
2. **一覧の `perPage` に上限・下限が無い**：他の一覧 API（`api/query.ts` の `paginationSchema`）は 1〜100 に丸めるが、
   SNS の一覧（`api/schemas/social.ts`）は整数であることしか検査しない。`05_API設計.md` §33 の方針と揃っていない。
   100 を超える値や 0 以下の値の振る舞いは保証しないので、**1〜100 で送る**
3. **`GET /social/posts?accountId=` に UUID の形でない値を渡すと、絞り込みが黙って外れて全件が返る**
   （`infrastructure/social-repository.ts` の `listPosts`）。422 にも空の結果にもならない
4. **OpenAPI の不足**：`createSocialPost` の再送（200）と、404・409 の応答が文書に載らない（§3.7）
5. **Bluesky の手動投稿だけ、投稿画面の URL の長さを登録時に検査しない**：X と Threads は 2048 文字を超える
   本文を 422 で断るが、Bluesky（本文の上限 300 grapheme）は日本語で約 223 文字を超えると
   登録は通り、画面で「投稿画面を開く」が失敗する（`plugins/sns-bluesky/social.ts` の `validateDraft`）
6. **`05_API設計.md` §18 のエンドポイント例**には `GET` / `PATCH /social/accounts/{id}` と `POST /social/publish` が無い。
   実装にはある（§4.1）
7. **Threads の画像の形式・大きさ（JPEG・PNG、8 MB）と Instagram の JPEG のみ**は、Plugin の失敗時の文言から読んだ
   各 SNS 側の条件で、Torifune のコードでは検査していない。SNS 側の仕様変更で変わりうる
