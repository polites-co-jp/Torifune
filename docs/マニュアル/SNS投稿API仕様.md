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
              { publishTiming }             │
                 now / scheduled ──────────┤ 予約日時（scheduledAt）が来る
                 after_approval ──▶ 承認待ち（awaiting_approval）
                                     │ 管理画面 /social で人が内容を確かめて「承認する」
                                     │（即投稿 か 指定の時間に投稿。§4.10）
                                     ▼
                         Torifune の定期実行（既定 1 分ごと）が配信 Plugin を呼んで SNS へ送る
                                            │
外部アプリ ◀─GET /api/v1/social/posts/{id}── 結果（status / failureReason / externalUrl）を読む
          ◀─Webhook（social.post.approved / published / failed）── または通知で受け取る
```

* **SNS へ直接投稿する同期 API は無い。** 外部アプリがするのは「投稿の登録」で、実際の送信は
  Torifune の定期実行が行う。「すぐ出したい」ときは **`publishTiming: "now"`** で登録する（§4.4）。
  次の定期実行（既定の間隔は 1 分）で配信される。`scheduledAt` に現在時刻（か過去）を入れて
  `status: "scheduled"` で登録する従来の方法も使える
* **人が内容を確かめてから出したい**ときは **`publishTiming: "after_approval"`** で登録する。投稿は
  **承認待ち（`awaiting_approval`）**になり、Torifune の管理画面で `social.approve` を持つ人が承認するまで配信されない（§4.10・§6）
* **SNS の指定は「SNS アカウントの ID」で行う。** 投稿の本文に provider を書く欄は無い。
  投稿先 SNS は `socialAccountId` が指すアカウントの `provider` で決まる（§4.2 で引く）
* 実際に SNS を叩くのは provider ごとの**配信 Plugin**。登録時の文字数・媒体・リンクの規則も
  Plugin が宣言する（§5）
* **Web サイトに紐づけたトークン（サイトのトークン）は、そのサイトのアカウントと共通のアカウントだけを使う**（§2.3）

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
* **NUL（U+0000）と対になっていないサロゲートを含む文字列は受け付けない（422）。** 本文のどの項目（入れ子の値・オブジェクトのキー・
  知らない項目・`csrfToken` を含む）とクエリ（値と名前）が対象で、ほかのどの検査よりも先に見る（認証・権限の検査の後）。
  `details` のキーは**その値を含む最上位の項目名**（`media[0].alt` なら `media`、`providerOptions` の中のキーなら `providerOptions`、クエリならその名前）。
  **本文の最上位の項目名やクエリの名前そのもの**に含むときは `_`。
  値は `使用できない文字（NUL）が含まれています。` か `使用できない文字（対になっていないサロゲート）が含まれています。`
  （同じ項目に両方あれば NUL が先の 2 つ）。該当する項目が多いときは、本文 → クエリの順で**先頭の 50 個まで**を返す。
  送った値は応答に載らない。このときは他の項目の誤りは返らない（直して送り直すと返る）
* 対になっていないサロゲートは、**文字列を UTF-16 の長さ（JavaScript の `slice`・`substring`・`length`）で切って絵文字を半分にした**ときに生じる。
  本文を切り詰めるクライアントは**コードポイント単位（`Array.from(text)` など）か grapheme 単位で切る**。絵文字（対になったサロゲート）はそのまま送れる

### 1.4 時刻の形式とタイムゾーン

| 向き | 形式 |
| --- | --- |
| 応答 | **ISO 8601 の UTC、ミリ秒付き**（例 `2026-10-01T00:00:13.000Z`）。`Date#toISOString()` の出力そのもの |
| 要求（`scheduledAt`） | JavaScript の `new Date(値)` で解釈できる値を受け付ける（Zod の `z.coerce.date()`） |

**要求では必ず UTC オフセット付きの ISO 8601 で送る**（`2026-10-01T09:00:00+09:00` か
`2026-10-01T00:00:00Z`）。オフセットを省いた `2026-10-01T09:00:00` は**サーバのローカル時刻**として
解釈され、コンテナの設定次第で 9 時間ずれる。数値を送るとエポックミリ秒として解釈される。
**`scheduledAt` は `0001-01-01T00:00:00Z` から `9999-12-31T23:59:59.999Z` まで**（両端を含む）。範囲外は 422 `scheduledAt`
（`0001-01-01T00:00:00Z から 9999-12-31T23:59:59.999Z までの日時を指定してください。`）。
Torifune の画面の「基準タイムゾーン」設定は API の時刻解釈に**関係しない**。

---

## 2. 認証

### 2.1 API トークン

```http
Authorization: Bearer tfp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

* トークンは `tfp_` で始まる文字列（`apps/web/src/domain/api-token.ts`）。発行は管理画面から行う
  （**API からは発行できない**）。手順は [手順書 §1](SNS投稿の外部連携.md#1-apiトークンを発行する)
* ヘッダは `Authorization: Bearer <トークン>`（`Bearer` の大文字・小文字は問わない）。
  値は正規表現 `/^Bearer\s+(\S+)$/i` で読む（`apps/web/src/domain/api-token.ts` の `bearerTokenOf`）。
  `Bearer` と値の間は空白、値そのものに空白を含めない
* **この形の `Authorization` ヘッダが付いている要求では CSRF の検証を行わない**（ブラウザが自動送信しないため）。
  要求本文の `csrfToken` 項目は画面用で、外部アプリは送らなくてよい
* `Authorization` とセッション Cookie の両方があると、**トークンのほうで認証する**

**CSRF の検証は認証より前に行う**（`apps/web/src/api/route.ts`）。そのため、認証に失敗したときの
応答はメソッドによって変わる。

| 要求 | GET | POST / PATCH / DELETE |
| --- | --- | --- |
| `Authorization` ヘッダが無い（セッションも無い） | 401 `UNAUTHENTICATED` | **403 `CSRF_FAILED`** |
| `Authorization` が上の形に合わない（`Token xxx`・`Bearer` だけ・値に空白を含む など） | 401 `UNAUTHENTICATED` | **403 `CSRF_FAILED`** |
| 形は合っているが、トークンが存在しない・失効している・有効期限が切れている・所有者が無効化されている・**サイトのトークンで、紐づいたサイトが削除された・アーカイブされている**（§2.3） | 401 `UNAUTHENTICATED` | 401 `UNAUTHENTICATED` |

**更新系で 403 `CSRF_FAILED` が返ったら、まず `Authorization` ヘッダの付け方を疑う。**

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
| `POST /social/posts/{id}/approve`（承認。§4.10） | **`social.approve`** |
| `DELETE /social/posts/{id}` | `social.delete` |
| `POST /social/publish`（配信の手動実行） | `system.manage` |

投稿を登録して結果を読むだけの外部アプリなら **`social.read` + `social.write`** で足りる。

**外部アプリに渡すトークンの Scope に `social.approve` を含めない。** 含めると、外部アプリが自分で
承認を依頼した投稿を自分で承認でき、「人が確かめた」という承認の意味が無くなる。`social.approve` は既定で
管理者と編集者のロールに割り当てられており、人は管理画面で承認する（閲覧者のロールには無い）。

**サイトのトークン**（§2.3）に付けられる Scope は SNS の 4 つ（`social.read`・`social.write`・`social.delete`・`social.approve`）だけ。
`POST /social/publish`（`system.manage`）や、サイト・キャンペーンなど SNS 以外の API は呼べない（403）。
サイトのトークンに `social.approve` を付けた場合、承認できるのはそのサイトの区画の投稿だけ（§4.10）。

**トークンのサイトは、運用者が管理画面で後から変えることがある**（トークンの文字列はそのまま）。変わると、
**次の要求から**見える・使える範囲が変わる（§2.3）。サイトに紐づけるときに SNS 以外の Scope は外れる。

### 2.3 トークンの区画

API トークンには、**共通のトークン**（Web サイトに紐づけないトークン。既存のトークンはすべてこれ）と、
**サイトのトークン**（発行時に Web サイトを 1 つ選んだトークン）がある。SNS アカウントも、**共通のアカウント**（`siteId: null`）と
**サイト専用のアカウント**（`siteId` にサイトの ID）に分かれる。トークンから見えるもの・使えるものは、この組み合わせ（**区画**）で決まる。

| アカウント | 共通のトークン | サイト A のトークン |
| --- | --- | --- |
| 共通のアカウント | 見える・投稿先にできる・変えられる（**削除・資格情報の変更は、見えない投稿が載っていれば 403**。下記） | 見える・投稿先にできる。**変更・削除は 403** |
| サイト A 専用のアカウント | **見えない**（404）・投稿先にできない（422） | 見える・投稿先にできる・変えられる |
| サイト B 専用のアカウント | 見えない | **見えない** |

| 投稿 | 共通のトークン | サイト A のトークン |
| --- | --- | --- |
| サイト A 専用のアカウントの投稿（登録したのが誰でも） | 見えない | 見える・変えられる |
| 共通のアカウントの投稿で、サイト A のトークンが登録したもの | **見えない** | 見える・変えられる |
| 共通のアカウントの投稿で、共通のトークン・管理画面が登録したもの | 見える・変えられる（今までどおり） | **見えない** |
| 共通のアカウントの投稿で、削除されたサイトのトークンが登録したもの | 見えない | 見えない |
| サイト B 専用のアカウントの投稿 | 見えない | 見えない |

* 「見えない」ものを `{id}` で指定すると **404**（本文は存在しない ID と同じ）。見えないアカウントを `socialAccountId` にすると
  **422 `socialAccountId`**（存在しない場合と同じ文言）。一覧（`GET /social/accounts`・`GET /social/posts`）と `meta.total` も区画の中だけ
* 投稿は**見えれば変えられる**（`PATCH` / `DELETE` / 承認。Permission は別に要る）
* **共通のトークンどうしは、今までどおり分離境界ではない**（名前空間）。冪等キー `externalRef`（§3.5）は**トークンごと**に分かれるので
  **外部アプリごとに別のトークンを発行する**が、データの見え方はトークンで分かれない。`social.read` があれば共通の区画の他のアプリが
  登録した投稿も本文ごと読め、`social.write` があれば書き換えられる。**信頼できない第三者にトークンを渡さない**
* `social.write` は**アカウントの表示名・`handle`・資格情報の差し替え**（`PATCH /social/accounts/{id}`）も許す。
  資格情報を差し替えても承認済みの予約の承認は外れないので、承認した投稿が別の SNS アカウントから出ることがありうる。
  承認を統制として使う運用では、外部アプリのトークンを持つ相手を信頼できる範囲に限る
* **サイトのトークンは自分の区画に閉じる**：そのサイトのアカウントとその投稿、共通のアカウントへ同じサイトのトークンが登録した投稿だけが見える。
  別のサイトのアプリ・共通のトークンのアプリが登録した投稿は見えない。共通のアカウントは投稿先に使えるが、**変更・削除はできない**（403。
  他の区画の投稿に影響するため）。同じサイトのトークンどうしは分かれない
* **見えない投稿が載ったアカウントは、トークンから削除・資格情報の変更ができない**（403 `FORBIDDEN`）。共通のアカウントには、サイトのトークンが登録した
  投稿（共通のトークンからは見えない）が載ることがある。そのアカウントを共通のトークンで `DELETE` する、または `PATCH` で `credential` / `credentials`
  を送る（消去を含む）と、見えない投稿まで消える・別の SNS アカウントから出ることになるので断る。**表示名・`handle`・`status` の変更は通る**（配信先を変えない）。
  403 の本文は権限不足と同じで、見えない投稿の件数や理由は返さない。見えない投稿が載っていなければ今までどおり（**サイトを使っていない間は起きない**）。
  削除・資格情報の変更が要るときは、管理画面（`/social`）で行う
* **区画を決めるのはトークンだけ。** 要求の値（クエリ・本文）で区画を選ぶ方法は無い。管理画面（人の操作）は区画で絞られない
* 区画が変わるのは運用者の操作のときだけ：**アカウントをサイトに紐づける・付け替える**と、そのアカウントとその投稿は移った先の区画に入る
  （共通のトークンからは 404 / 422 になる）。**トークンのサイトを変える**（§2.2）と、そのトークンが共通のアカウントへ登録した投稿も一緒に移る

詳細は [手順書 §1「トークンは名前空間であって、分離境界ではない」](SNS投稿の外部連携.md#トークンは名前空間であって分離境界ではない)と
[「サイトのトークンは区画に閉じる」](SNS投稿の外部連携.md#サイトのトークンは区画に閉じる)。

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
| `error.details` | object（任意） | **422 と、`POST /social/publish` の 409（`details.job`）・承認の 409（`details.expectedUpdatedAt`。§4.10）・`PATCH /social/posts/{id}` の 409（`details.status`。§4.7）に付く。** キー＝問題のある項目名、値＝理由の文字列の配列 |

`details` のキーの規則。

* キーは**送った項目名**（`body`・`scheduledAt`・`media`・`link`・`deliveryMode`・`socialAccountId`・
  `externalRef`・`providerOptions`・`status`・`publishTiming`・`expectedUpdatedAt`・`externalUrl`・`externalId`・
  `credentials`・`provider`・`displayName`・`siteId` など）
* `media` の問題は**2 種類のキーに分かれる**（`apps/web/src/api/schemas/social.ts` の `mediaSchema`）
  * **`media`**：件数（11 件以上）・URL が https でない／2048 文字超／`user:pass@` を含む・`alt` が 1000 文字超。
    どの要素の問題でも `media` 1 つにまとまる。SNS ごとの規則（§5）の違反もこのキー
  * **`media.<n>.url` / `media.<n>.alt`**（`<n>` は 0 始まりの位置）：要素の**型違い・欠落**
    （`url` が無い、`url` が文字列でない、`alt` が文字列でも `null` でもない など）。
    型の検査に落ちた要求では件数・https の検査は行われない
  * 受け取る側は **`media` で始まるキー**をまとめて `media` の問題として扱うとよい
* **配信 Plugin の検査（§5）は `providerOptions.<キー>` の形のキーを返すことがある**
  （例：`providerOptions.langs`）。Plugin が返したキーが英数字と `_` `.` の 64 文字以内の形でなければ
  `providerOptions` に丸められる
* 要求本文が JSON のオブジェクトでない（配列・文字列など）ときは、項目に紐づかない問題として `_` に入る
* NUL・対になっていないサロゲートの誤り（§1.3）は、値を含む**最上位の項目名**のキーに `使用できない文字（NUL）が含まれています。` /
  `使用できない文字（対になっていないサロゲート）が含まれています。` の 2 つの文言で入る。本文の最上位の**キー**に含むときは `_`
* 理由の文字列は**そのまま人に見せてよい日本語**が基本だが、型違い・必須項目の欠落・列挙外の値など
  入力の形の誤りは**検証ライブラリ（Zod）の既定の英文**（例 `Invalid input: expected string, received undefined`・
  `Invalid option: expected one of "auto"|"manual"`）になる。**文字列の中身で分岐しない。キーで分岐する**

### 3.3 エラーコード一覧

| HTTP | `code` | いつ |
| ---: | --- | --- |
| 401 | `UNAUTHENTICATED` | GET で認証が無い／トークンが無効。更新系で `Bearer <トークン>` の形は合っているがトークンが無効（§2.1）。**サイトのトークンで、紐づいたサイトが削除された・アーカイブされている**（§2.3。アーカイブを戻せば再び使える） |
| 403 | `FORBIDDEN` | 権限（Scope）が足りない（§2.2）。**サイトのトークンで共通のアカウントを変更・削除しようとした**（§2.3）。**トークンから見えない投稿が載ったアカウントを、削除・資格情報の変更しようとした**（§2.3。理由は返さない） |
| 403 | `CSRF_FAILED` | **更新系（POST / PATCH / DELETE）で `Authorization: Bearer <トークン>` の形のヘッダが無い**（ヘッダの欠落・形の誤り）。セッション（Cookie）認証で CSRF トークンが無いときも。形の合ったトークン認証では起きない（§2.1） |
| 404 | `NOT_FOUND` | `{id}` の投稿・アカウントが無い（**UUID の形でない ID も 404**）。**トークンの区画の外（このトークンからは見えない）ものも 404**（§2.3） |
| 409 | `CONFLICT` | `POST /social/publish` で他の配信処理が実行中（`details.job` と `Retry-After: 10` が付く）。承認（§4.10）で、画面や `GET` で読んだ後に投稿の内容が変わっていた（`details.expectedUpdatedAt`）。`PATCH /social/posts/{id}` の処理中に承認・配信の開始などで投稿の状態が変わった（`details.status`。§4.7） |
| 422 | `VALIDATION_ERROR` | 入力の検査に落ちた（§3.2 の `details` を見る） |
| 429 | `TOO_MANY_ATTEMPTS` | Rate Limit を超えた（§3.4。`Retry-After` が付く） |
| 500 | `INTERNAL_ERROR` | 想定外のエラー。配信 Plugin の事前検査が例外・5 秒超過になったとき（§4.4）もこれ |

**400 `BAD_REQUEST` は SNS API では返らない**（壊れた JSON も 422）。

### 3.4 Rate Limit

| 項目 | 値（`apps/web/src/api/rate-limit.ts` の `DEFAULT_RATE_LIMIT`） |
| --- | --- |
| 上限 | **60 秒あたり 300 回**（直近 60 秒の窓で数える） |
| 数える単位 | **エンドポイント（operationId）× 送信元 IP ごと**。`GET /social/posts` と `POST /social/posts` は別枠。トークンごとではない。送信元 IP は **`X-Forwarded-For` の先頭**、無ければ **`X-Real-IP`**（`apps/web/src/api/cookies.ts` の `clientIpOf`） |
| 超えたとき | **429 `TOO_MANY_ATTEMPTS`** と **`Retry-After: <秒>`**（窓の最古の要求が外れるまでの秒数。切り上げ） |
| 残り回数のヘッダ | **無い**（`X-RateLimit-*` は返さない） |
| 認証との順序 | Rate Limit は認証より**前**に数える。401・403 になる要求も枠を消費する |

* 数える場所はサーバのメモリ（プロセスごと）。複数プロセスで動かしている構成では枠がプロセスごとになる
* **リバースプロキシの設定に注意する（運用者向け）。** `X-Forwarded-For` も `X-Real-IP` も届かない構成では、
  送信元 IP が分からず、**すべてのクライアントが `unknown` という 1 つの枠を共有する**（1 分に 300 回を全員で分け合う）。
  逆に、外部からの `X-Forwarded-For` をそのまま通すプロキシでは、クライアントがヘッダを偽って枠を逃れられる。
  プロキシで `X-Forwarded-For` を付け直す（または `X-Real-IP` を設定する）こと
* **429 を受けたら `Retry-After` の秒数だけ待ってから同じ要求を送り直す。** `POST /social/posts` を
  送り直すときは `externalRef` を付けたままにする（§3.5）

### 3.5 冪等性（`externalRef`）

`POST /social/posts` は **`externalRef` を付ければ、何度送っても投稿は 1 つしかできない。**

| 1 回目 | 2 回目以降（同じトークン・同じ `externalRef`） |
| --- | --- |
| **201**、新しい投稿を返す | **200**、**既存の投稿をそのまま**返す（新しい投稿は作らない） |

* 冪等キーは **「登録したトークン」と `externalRef` の組**。別のトークンから同じ値を送ると別の投稿になる
* **`socialAccountId` は比べない。`externalRef` はトークンの中で、全 SNS・全アカウントを通して一意にする。**
  同じ記事を X と Bluesky へ同じ `externalRef` で登録すると、**2 つ目は 200 で 1 つ目（X）の投稿が返り、
  Bluesky の投稿は作られない**（`apps/web/src/application/social/social-use-cases.ts` の再送判定）。
  複数の SNS へ出すときは、投稿先ごとに値を変える

  ```text
  POST /social/posts  { "socialAccountId": "<X のアカウント>",       "externalRef": "article-1234:x" }        → 201
  POST /social/posts  { "socialAccountId": "<Bluesky のアカウント>", "externalRef": "article-1234:bluesky" }  → 201
  （誤り）両方を "article-1234" にすると、2 つ目は 200 で X の投稿が返り、Bluesky には何も登録されない
  ```

  応答の `socialAccountId` が送った値と違えば、この衝突が起きている
* 値は前後の空白を取り除いてから比べる（`" a-1 "` と `"a-1"` は同じ）。1〜200 文字
* **2 回目で本文などを変えて送っても、保存されている内容は 1 回目のまま**（200 で 1 回目の内容が返る）。
  内容を変えるのは `PATCH`
* 2 回目の要求でも、**要求全体の形の検査（§4.4 の表）と、本文が空でないこと・`socialAccountId` のアカウントが
  存在してトークンの区画から見えることの検査は掛かる。** 形が壊れた再送は 422 になる。SNS ごとの規則（§5）は再送では検査しない
* 1 回目の後に運用者がアカウントのサイトを付け替える・トークンのサイトを変えるなどして、**既存の投稿がこのトークンの区画の外に
  なっていたら 422 `externalRef`**（「この externalRef は既に使われています。別の externalRef で登録してください。」）。既存の投稿は見せず、
  新しい投稿も作らない（§2.3）
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
| `page` | 整数 | `1` | 1 始まり。**1 未満は 1 に丸める** |
| `perPage` | 整数 | `20` | 1 ページの件数。**1〜100。範囲外は 1〜100 に丸める** |

* 並び順は**作成日時の新しい順**（同じ時刻は `id` の昇順）。並び順を変えるクエリは無い
* **範囲外の整数は 422 にせず丸める。** 丸めた後の値が `meta.page` / `meta.perPage` に返る

  | 送った値 | 結果 |
  | --- | --- |
  | `page=0`・`page=-3`（1 未満） | `page=1` として返る（`meta.page` は `1`） |
  | `perPage=0`・`perPage=-1`（1 未満） | `perPage=1` として返る（`meta.perPage` は `1`） |
  | `perPage=101`・`perPage=1000`（101 以上） | `perPage=100` として返る（`meta.perPage` は `100`） |
  | `page` が最終ページより先 | 200 で `data` が空（`meta.total` は全件数） |

* 整数でない値（`abc`・`1.5`）は丸めずに 422（`details.page` / `details.perPage`）。
  空文字（`perPage=`）は `0` と解釈され、丸めて `1` になる
* **1 回で取れるのは 100 件まで。全件を取るときは `meta.total` に届くまで `page` を送る**

### 3.7 OpenAPI

`GET /api/v1/openapi.json` が OpenAPI 3.1.0 の文書を返す（**認証不要**。Zod スキーマから自動生成）。

* SNS API の 12 操作（`listSocialAccounts`・`createSocialAccount`・`getSocialAccount`・`updateSocialAccount`・
  `deleteSocialAccount`・`listSocialPosts`・`createSocialPost`・`getSocialPost`・`updateSocialPost`・
  `deleteSocialPost`・`approveSocialPost`・`publishSocialPosts`）がすべて載る
* 必要な権限は各操作の拡張項目 **`x-required-permission`** に書かれている
* 認証方式は `session`（Cookie）と `bearer`（API トークン）の 2 つが宣言されている
* 応答は、成功・401・403・422・429・500 のほかに次が宣言されている
  * `createSocialPost` の **200**（同じ `externalRef` の再送。本文の形は 201 と同じ。§3.5）
  * `{id}` を取る 6 操作（`getSocialAccount`・`updateSocialAccount`・`deleteSocialAccount`・`getSocialPost`・
    `updateSocialPost`・`deleteSocialPost`）の **404**
  * `publishSocialPosts` の **409**（他の配信処理が実行中）
  * `approveSocialPost` の **404**（投稿が無い）と **409**（見た後に内容が変わった。§4.10）
  * `updateSocialPost` の **409**（処理中に投稿の状態が変わった。§4.7）
* アカウントの応答・作成・更新に **`siteId`**（`format: uuid`・`nullable`）がある（§4.2）。`{id}` を取るアカウントと投稿の操作と
  `approveSocialPost` の 404 の `description` に「このトークンからは見えない（別のサイトの区画）ものを含む」とある（§2.3）。
  投稿の応答の形は変わらない
* `createSocialPost` の要求の `status` には `default` が無い（省略時の `draft` はサーバが補う。§4.4）。
  状態の列挙（`status`）に `awaiting_approval` があり、投稿の応答に `approvedAt` がある
* `page` / `perPage` の範囲は、parameter の `description` に書かれている
  （「1 以上。範囲外は 1 に丸める。」「1〜100。範囲外は 1〜100 に丸める。」）。範囲外も断られない（§3.6）ので、
  `minimum` / `maximum` は書かれていない。`accountId` には `format: uuid` と UUID の形の `pattern` が付く（§4.5）。OpenAPI からクライアントを生成している場合、`accountId` の引数が UUID 型（Java の `UUID`、C# の `Guid` など）に変わることがある
* **OpenAPI に載らないこと**（この文書で補う）
  * SNS ごとの規則（§5）と、配信 Plugin が返す 422 の `details` のキー

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
| PATCH | `/social/posts/{id}` | 投稿の更新・取りやめ・承認の依頼と差し戻し・手動投稿の結果の記録 | `social.write` | 200 |
| POST | `/social/posts/{id}/approve` | **承認待ちの投稿を承認して配信に回す**（§4.10。通常は人が管理画面で行う） | **`social.approve`** | 200 |
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
| `siteId` | string（UUID）\| null | **属する Web サイト。`null` は共通のアカウント**（どのサイトのトークンからも使える。§2.3） |
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
      "siteId": null,
      "createdAt": "2026-09-20T02:11:05.412Z",
      "updatedAt": "2026-09-20T02:11:05.412Z"
    }
  ],
  "meta": { "page": 1, "perPage": 100, "total": 1 }
}
```

外部アプリは、この `id` を設定値として持っておき、投稿のたびに `socialAccountId` へ入れる。
同じ provider のアカウントが複数あるときは `displayName` / `handle` で選ぶ。

**返るのはトークンの区画から見えるアカウントだけ**（§2.3。共通のトークンなら共通のアカウント、サイトのトークンならそのサイトと共通のアカウント）。
`meta.total` も区画の中の件数で、`provider` の絞り込みも区画の中で掛かる。

**画面で登録したアカウントの `id` は、管理画面の SNS（`/social`）のアカウント一覧の「アカウントID」列に出ていて、「コピー」で写せる**
（`social.read` があれば見える）。運用者から受け取れば、API で探す必要は無い。

#### GET `/social/accounts/{id}`

1 件を返す。無ければ 404（**区画の外も 404**）。

#### POST `/social/accounts` / PATCH `/social/accounts/{id}`

アカウントと資格情報の登録は通常、運用者が画面から行う。その `id` は一覧の「アカウントID」列から写す（上記）。API で行う場合の項目は次のとおり
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
| `siteId` | string（UUID）\| null | 任意 | 任意 | 属するサイト。UUID の形（違反は 422 `siteId`）。**トークンでは決められる値が限られる**（下表） |

`siteId` の扱い（違反はどれも 422 `siteId`）。

| 送り方 | 作成：共通のトークン | 作成：サイト A のトークン | 更新（どちらのトークンも） |
| --- | --- | --- | --- |
| 省略 | 共通 | **サイト A**（自動で紐づく） | 変わらない |
| `null` | 共通 | 422「サイトに紐づいたトークンでは、そのサイト以外を指定できません。」 | 今と同じ（共通）なら 200、違えば 422 |
| サイト A の ID | 422「APIトークンではアカウントをサイトに紐づけられません。管理画面で紐づけてください。」 | サイト A | 今と同じなら 200（何も変わらない） |
| 別のサイト・存在しないサイトの ID | 同上 | 422（上と同じ文言。サイトの存在は教えない） | 違う値は 422「APIトークンではアカウントのサイトを変えられません。管理画面で変えてください。」 |

* **アカウントのサイトを紐づける・付け替えるのは管理画面（`/social`）だけ**（手順書 §2）。管理画面からは、存在しないサイトだけが 422（「Webサイトが見つかりません。」）
* 更新・削除は、まず区画で対象を決める：区画の外は **404**、サイトのトークンから共通のアカウントは **403**（§2.3）
* `credential` / `credentials` を送る更新（消去を含む）は、そのアカウントに**このトークンから見えない投稿**（別のサイトのトークンが登録したもの）が載っていれば
  **403**（何も変わらない。同じ要求の他の項目も変わらない）。表示名・`handle`・`status` だけの更新は通る（§2.3）
* 応答は §4.2 のアカウントの形（作成 201・更新 200）。資格情報は返らない
* `credentials` のキーの過不足・型違いは **422 `credentials`**。**その provider の配信 Plugin が
  入っていないときはキーを検証せずに保存する**

#### DELETE `/social/accounts/{id}`

204。**そのアカウントに紐づく投稿もすべて削除される**（予約中のものも含む）。区画の外は 404、サイトのトークンから共通のアカウントは 403。
そのアカウントに**このトークンから見えない投稿**が載っていれば 403（アカウントも投稿も残る。§2.3）。

### 4.3 投稿の形（応答）

`GET` / `POST` / `PATCH` の `data`（一覧では `data[]` の各要素）。

| 項目 | 型 | 説明 |
| --- | --- | --- |
| `id` | string（UUID） | 投稿の ID |
| `socialAccountId` | string（UUID） | 投稿先のアカウント |
| `body` | string | 本文（**`link` は含まない**。SNS ごとの組み立ては §5） |
| `scheduledAt` | string \| null | 予約日時（UTC） |
| `status` | `draft` / `awaiting_approval` / `scheduled` / `published` / `failed` | §6。**値は増えうる。** 知らない値は無視するか「その他」として扱う（網羅的に分岐しない） |
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
| `approvedAt` | string \| null | **人が承認して予約にした時刻**（§4.10）。承認を経ていない投稿は `null`（`status: "scheduled"` で直接予約した投稿も `null`）。承認済みの予約の内容・日時・配信方法を書き換えると `null` に戻る（§4.7） |
| `createdAt` / `updatedAt` | string | `updatedAt` は承認の `expectedUpdatedAt` に使う（§4.10） |

**応答に出ないもの**：どのトークンが登録したか・配信の進行中の印・資格情報。

### 4.4 POST `/social/posts` — 投稿を登録する

#### 要求項目

| 項目 | 型 | 必須 | 既定 | 制約（違反は 422。`details` のキーはその項目名） |
| --- | --- | --- | --- | --- |
| `socialAccountId` | string | **必須** | — | 存在するアカウントの `id`（§4.2。画面で登録したアカウントは一覧の「アカウントID」列で写せる）。無ければ 422 `socialAccountId`（404 ではない） |
| `body` | string | **必須** | — | 1〜10000 文字（UTF-16 の長さ）。空白だけは不可。**SNS ごとの上限は §5** |
| `publishTiming` | enum | 任意（**推奨**） | なし | **いつ配信へ回すか**。`now`（即投稿）/ `scheduled`（`scheduledAt` の時刻に投稿）/ `after_approval`（**人の確認を待ってから投稿**＝承認待ち）。下の「`publishTiming` と結果」の表。**省略すると `status` と `scheduledAt` で決まる（従来どおり）**。列挙外は 422 `publishTiming`。`deliveryMode`（誰が SNS へ出すか）とは別の項目で、組み合わせて使う |
| `status` | enum | 任意 | `draft`（`publishTiming` を送らないとき） | `draft`（下書き。配信しない）/ `scheduled`（予約。配信する）/ `awaiting_approval`（承認待ち。`publishTiming: "after_approval"` と同じ結果）。**`publishTiming` と同時に送ると 422 `status`**（値が `draft` でも）。`published` / `failed` も形式上は受け付けるが、配信されず `publishedAt` / `failedAt` も入らない。外部アプリは使わない |
| `scheduledAt` | string \| null | `scheduled`（`publishTiming` か `status`）のとき必須 | `null` | §1.4 の形式。`0001-01-01T00:00:00Z`〜`9999-12-31T23:59:59.999Z`（範囲外は 422 `scheduledAt`）。予約で無ければ 422 `scheduledAt`。**過去の時刻も可**（次の定期実行で配信）。**`publishTiming: "now"` と同時に値を送ると 422 `scheduledAt`**（`null` は可）。`after_approval` では**希望日時**として保存され、承認する人が「指定の時間に投稿」を選んだときの既定になる |
| `deliveryMode` | enum | 任意 | `auto` | `auto`（Torifune が配信）/ `manual`（人が SNS の投稿画面から投稿。§6.5）。provider によって使えない値がある（§5） |
| `media` | array | 任意 | `[]` | 最大 10 件。各要素 `{ "url": string, "alt"?: string \| null }`。`url` は **https のみ**・2048 文字以内・`user:pass@` を含まない。`alt` は 1000 文字以内。**`manual` では 1 件も付けられない**。SNS ごとの枚数・形式は §5 |
| `link` | string \| null | 任意 | `null` | 添える URL。**https のみ**・2048 文字以内・`user:pass@` を含まない。空文字は不可（消すなら `null`）。SNS ごとの扱いは §5 |
| `providerOptions` | object | 任意 | `{}` | JSON にして 4096 バイト以内。**中身は配信 Plugin が検査する**。いまの Plugin で受け付けるキーは Bluesky の `langs` だけ（§5） |
| `externalRef` | string | 任意（**付けることを強く推奨**） | なし | 1〜200 文字（前後の空白は除く）。§3.5 |

#### `publishTiming` と結果

| `publishTiming` | `status` | `scheduledAt` | 結果の `status` | 結果の `scheduledAt` |
| --- | --- | --- | --- | --- |
| 省略 | 省略 | 任意 | `draft` | 送った値（従来どおり） |
| 省略 | `scheduled` | **必須** | `scheduled` | 送った値（従来どおり） |
| 省略 | `awaiting_approval` | 任意 | `awaiting_approval` | 送った値（希望日時） |
| `now` | 送らない | 送らない（`null` は可） | `scheduled` | **サーバのいまの時刻**（応答で読める） |
| `scheduled` | 送らない | **必須**（`null` も不可） | `scheduled` | 送った値（過去も可） |
| `after_approval` | 送らない | 任意 | `awaiting_approval` | 送った値（**希望日時**） |

* **承認待ち（`awaiting_approval`）の投稿は配信されない。** Torifune の管理画面 `/social` の「承認待ち」に並び、
  `social.approve` を持つ人が内容を確かめて「即投稿」か「指定の時間に投稿」を選んで承認すると予約（`scheduled`）になる（§4.10）。
  差し戻されると下書き（`draft`）に戻る。結果は `GET` のポーリングか Webhook の `social.post.approved`（§6.6）で知る
* **手動投稿しかできない配信 Plugin の provider（いまは X の無料版 `sns-x-manual`）では、`publishTiming` を送った登録は
  値によらず常に承認待ちになる**（201 で `status: "awaiting_approval"` が返る。422 にはしない）。`scheduledAt` は `now` なら `null`、
  それ以外は送った値。承認は常に即投稿になる（§5.1・§5.2）。`publishTiming` を送らない `status: "scheduled"` の登録は従来どおり予約になる
* 承認待ちの登録にも配信 Plugin の検査（下の表の 6〜8b）が掛かる。**SNS の規則に反する投稿は承認待ちにもならない**

#### 要求例

```bash
# 人の確認を待ってから投稿する（承認待ち）。希望日時を添える
curl -X POST https://torifune.example.com/api/v1/social/posts \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "socialAccountId": "0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23",
        "body": "新しい記事を公開しました。",
        "link": "https://example.com/articles/1234",
        "media": [{ "url": "https://cdn.example.com/ogp/1234.jpg", "alt": "記事のサムネイル" }],
        "publishTiming": "after_approval",
        "scheduledAt": "2026-10-01T09:00:00+09:00",
        "deliveryMode": "auto",
        "externalRef": "article-1234:x"
      }'

# すぐ出す（次の定期実行で配信）
#   … "publishTiming": "now" …（scheduledAt は送らない）
# 指定の時刻に出す
#   … "publishTiming": "scheduled", "scheduledAt": "2026-10-01T09:00:00+09:00" …
```

#### 応答例（201。再送なら同じ形で 200）

```json
{
  "data": {
    "id": "0192c1f3-8e2a-7d44-b0a1-6f3e2c9d7a10",
    "socialAccountId": "0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23",
    "body": "新しい記事を公開しました。",
    "scheduledAt": "2026-10-01T00:00:00.000Z",
    "status": "awaiting_approval",
    "publishedAt": null,
    "failedAt": null,
    "failureReason": null,
    "createdAt": "2026-09-24T03:15:42.118Z",
    "updatedAt": "2026-09-24T03:15:42.118Z",
    "deliveryMode": "auto",
    "media": [{ "url": "https://cdn.example.com/ogp/1234.jpg", "alt": "記事のサムネイル" }],
    "link": "https://example.com/articles/1234",
    "providerOptions": {},
    "externalRef": "article-1234:x",
    "externalId": null,
    "externalUrl": null,
    "attemptCount": 0,
    "nextAttemptAt": null,
    "skipCount": 0,
    "skipReason": null,
    "approvedAt": null
  }
}
```

#### 検査の順序と 422 の出方

検査は次の順に行い、**2〜7 は最初に見つかった 1 つだけを返す**（8 だけは複数のキーを同時に返しうる）。

| 順 | 検査 | 422 の `details` のキー |
| ---: | --- | --- |
| 0 | NUL・対になっていないサロゲート（§1.3）。**違反はまとめて返り、1 以降は行わない** | 値を含む最上位の項目名 |
| 1 | 要求全体の形（型・必須・長さ・https・件数・列挙値。`publishTiming` の列挙を含む）。**違反はまとめて返る** | 各項目名 |
| 1b | **1 が通ったときだけ**：`publishTiming` と `status` の同時指定 → `status`（「publishTiming と status は同時に指定できません。」）。`publishTiming: "now"` と `scheduledAt` の値 → `scheduledAt`（「publishTiming が now のときは scheduledAt を指定できません。」）。**違反はまとめて返る** | `status` / `scheduledAt` |
| 2 | 本文が空白だけでない。続けて `scheduledAt` の範囲（§1.4） | `body` / `scheduledAt` |
| 3 | `socialAccountId` のアカウントが存在し、**トークンの区画から見える**（§2.3。見えないものは存在しない場合と同じ「SNSアカウントが見つかりません。」） | `socialAccountId` |
| 4 | `externalRef` をトークン認証で付けている | `externalRef` |
| — | （`externalRef` が既存と一致したら、ここで 200 を返して終わる。**`publishTiming` が 1 回目と違っても既存のまま**。既存の投稿が区画の外なら 422 `externalRef`。§3.5） | — |
| 5 | 予約（`publishTiming: "scheduled"` か `status: "scheduled"`）なら `scheduledAt` がある。ここで手動投稿しかできない配信 Plugin の読み替え（承認待ち）も決まる | `scheduledAt` |
| 6 | `deliveryMode: "manual"` なら `media` が空 | `media` |
| 7 | `deliveryMode: "manual"` なら、その provider の配信 Plugin が手動投稿に対応している（**Plugin が入っていない provider の `manual` も 422**） | `deliveryMode` |
| 8a | 配信 Plugin が宣言した上限（本文の長さ・媒体の最大数・媒体の必須）。**違反が複数あっても先頭の 1 つだけ**を返す | `body` / `media` |
| 8b | 配信 Plugin の検査（`validate()`。SNS ごとの数え方・リンク・`providerOptions` など）。**違反をすべて**返す | `body` / `media` / `link` / `deliveryMode` / `providerOptions.<キー>` など（§5） |

* 0 で落ちると 8b の配信 Plugin の検査（`validate()`）は呼ばれない。本文・`link` の対になっていないサロゲートは、
  どの provider でも 0 の Core の文言（キーは送った項目名 `body` / `link`）で返る
* 表の 2〜8a は最初の違反で止まる。**8a で落ちると 8b は走らない**ので、直して送り直すと
  8b の違反が新たに返ることがある。**1 回の 422 に複数の項目のキーが並びうるのは 1・1b と 8b だけ**
* 1b は形の検査なので、`externalRef` の再送でも掛かる
* 6〜8b は 5 で決まった**結果の値**（`status` / `scheduledAt`）に対して掛ける
* **8a・8b は `status: "draft"` でも掛かる**（作成時。承認待ちでも）
* **その provider の配信 Plugin が入っていなければ 8a・8b は行わない。** `auto` の予約は断られずに保存され、
  配信の時刻に「支度待ち」になる（§6.3）
* 8b の配信 Plugin の検査が例外を投げた・5 秒以内に終わらなかったときは **500 `INTERNAL_ERROR`**
  （外部アプリの入力の問題ではない。時間をおいて同じ `externalRef` で再送してよい）
* 検査の後、保存する直前にトークンが失効していた・サイトのトークンのサイトが削除されていたときは **401 `UNAUTHENTICATED`**
  （投稿は作られない。§2.3）

### 4.5 GET `/social/posts` — 投稿一覧

| クエリ | 型 | 説明 |
| --- | --- | --- |
| `page` / `perPage` | 整数 | §3.6 |
| `accountId` | string（UUID） | そのアカウントの投稿だけに絞る。UUID の形（8-4-4-4-12 の 16 進。大文字・小文字を問わない）。**形が違えば（空文字を含む）422 `accountId`**（「UUID の形で指定してください。」）。存在しないアカウント・区画の外のアカウントの UUID は 200 で空 |
| `status` | enum | `draft` / `awaiting_approval` / `scheduled` / `published` / `failed` のどれか 1 つ。列挙外は 422 `status`。`status=awaiting_approval` で承認待ちだけを引ける |

並びは作成日時の新しい順。応答は §3.1 の一覧の形で、各要素は §4.3。

**トークンの区画の投稿を返す**（§2.3）。共通のトークンでは、共通の区画の他のアプリ（別トークン）や人が登録した投稿も含む。
サイトのトークンでは、そのサイトのアカウントの投稿と、同じサイトのトークンが共通のアカウントへ登録した投稿。
自分が承認待ちを使っていなくても、区画の中の他のアプリや人が作った承認待ち（`awaiting_approval`）が含まれうる。自分の投稿だけを見たいときは、
保存しておいた `id` で `GET /social/posts/{id}` を引くか、`externalRef` で見分ける。

### 4.6 GET `/social/posts/{id}` — 結果を確かめる

1 件を返す。無ければ 404（**区画の外も 404**。§2.3）。状態の読み方は §6。

### 4.7 PATCH `/social/posts/{id}` — 更新・取りやめ・結果の記録

**送った項目だけが変わる。** 省略した項目は変わらない。`null` を送れる項目は `null` で消える。

| 項目 | 型 | 制約・意味 |
| --- | --- | --- |
| `body` | string | 1〜10000 文字。空白だけは不可 |
| `scheduledAt` | string \| null | §1.4（`0001-01-01T00:00:00Z`〜`9999-12-31T23:59:59.999Z`。範囲外は 422 `scheduledAt`）。**未来の時刻にすると支度待ちの待ち時刻（`nextAttemptAt`）が消える**（§6.3） |
| `status` | enum | 遷移の規則（§6.1）に従う。`draft` へ戻す＝**取りやめ**（承認待ちなら**差し戻し**）。`awaiting_approval` にする＝**承認を依頼する**（下書き・予約から）。**承認待ちから `scheduled` へは変えられない**（422 `status`「承認待ちの投稿は、承認の操作でだけ予約にできます。」。予約にするのは承認 §4.10 だけ）。承認待ちから `published` / `failed` へも変えられない（422 `status`） |
| `deliveryMode` | enum | `auto` / `manual`。`manual` へ変えるときは provider の対応を検査する |
| `media` | array | §4.4 と同じ |
| `link` | string \| null | §4.4 と同じ。`null` で消す |
| `providerOptions` | object | §4.4 と同じ |
| `externalId` | string \| null | SNS 側の投稿 ID。200 文字以内（**手動投稿の結果を記録するとき**に使う） |
| `externalUrl` | string \| null | SNS 側の投稿の URL。**https のみ**・2048 文字以内 |
| `failureReason` | string \| null | 失敗の理由。**2000 文字以内**（超えると 422 `failureReason`）。前後の空白は取り除き、空文字は `null` 扱い。（2000 文字で切り詰めて保存するのは配信 Plugin の内部経路だけで、この API は切り詰めない） |

* **区画の外の投稿は 404**（何も変わらない。§2.3）
* `socialAccountId` と `externalRef` は**変えられない**（送っても無視される）
* **`publishTiming` は送れない**（どの値でも 422 `publishTiming`「publishTiming は登録のときだけ指定できます。承認を依頼するときは
  status に awaiting_approval を指定してください。」）。`PATCH` では `status` と `scheduledAt` で表す
* **承認済みの予約（`approvedAt` あり）の `body`・`media`（順序込み）・`link`・`providerOptions`・`deliveryMode`・
  `scheduledAt` を値として変えると、承認待ちへ戻る**（応答の `status` が `awaiting_approval`、`approvedAt` が `null`）。
  承認した人が見た内容・時刻と違うものを出さないため。**値が同じなら送っても戻らない**（`providerOptions` のキーの順序だけの違いも同じ値）。
  承認を経ていない予約（`approvedAt: null`）は従来どおり `scheduled` のまま
* **処理中に投稿の状態が変わったら 409 `CONFLICT`**（`details.status`「投稿の状態が変わっています。読み直してからやり直してください。」）。
  典型は、承認待ちの投稿を書き換えている最中に人が承認した場合と、Torifune が配信を始めた場合。**何も変わっていない**ので、`GET` で読み直してからやり直す
  （承認済みになっていれば、書き換えると承認待ちへ戻る）。状態の変わらない書き換えどうしは従来どおり後勝ち
* 承認待ちへ移すと支度待ちの待ち時刻（`nextAttemptAt`）は消える（`skipCount` は減らない）。`draft` / `awaiting_approval` へ移すと
  `approvedAt` は `null` になり、`published` / `failed` の記録では残る
* **配信の最中（`auto` の予約で Torifune が SNS へ送っている間）は、`body`・`media`・`link`・
  `providerOptions`・`scheduledAt`・`deliveryMode`・`status` を変えられない**（422 `status`
  「配信を開始しているため変更できません。」）。通常は配信の結果が記録された時点（配信 Plugin の制限時間 30 秒以内）で外れる。
  **配信の途中で Torifune のプロセスが落ちた場合は、次の定期実行が中断を判定して `failed`（結果不明）にするまで
  （既定の間隔で 1 分以上）残る**。その間は `GET` で状態を見て待つ
* **予約日時を未来へ直す・`deliveryMode` を `manual` に変える・取りやめる `PATCH` が 200 を返したら、その予約は
  Torifune がその周期の配信の順番に並べていても直した内容で扱われる**（直す前の日時・配信方法では送られない）。
  配信の最中（着手の後）は従来どおり 422（上の箇条）
* 変更後の値に対して §4.4 の 5〜8 と同じ検査を掛ける。ただし
  * 5・6（予約日時・手動投稿の媒体）は**変更後が `draft` / `awaiting_approval` / `scheduled` のときだけ**
  * 7（手動投稿の対応）は **`deliveryMode: "manual"` を送ったときだけ**
  * 8a・8b（SNS ごとの規則）は**変更後が `scheduled` / `awaiting_approval` のときだけ**（承認待ちは承認すれば予約になるため）。
    `draft` への取りやめ・差し戻し、`published` / `failed` の記録は配信 Plugin の都合で断られない
* `status` を `published` にすると `publishedAt` が、`failed` にすると `failedAt` が記録され、
  それぞれ `social.post.published` / `social.post.failed` イベントが発火する

```bash
# 予約を取りやめる（下書きへ戻す）。承認待ちの依頼を取り下げるときも同じ
curl -X PATCH https://torifune.example.com/api/v1/social/posts/$POST_ID \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "status": "draft" }'

# 下書きの投稿の承認を依頼する
curl -X PATCH https://torifune.example.com/api/v1/social/posts/$POST_ID \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "status": "awaiting_approval" }'

# 手動投稿を人が SNS で出した後、結果を記録する
curl -X PATCH https://torifune.example.com/api/v1/social/posts/$POST_ID \
  -H "Authorization: Bearer $TORIFUNE_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "status": "published", "externalUrl": "https://x.com/i/status/1840000000000000000" }'
```

### 4.8 DELETE `/social/posts/{id}`

204。`social.delete` が要る（`social.read` + `social.write` だけのトークンでは 403）。区画の外の投稿は 404（残る）。
予約を止めるだけなら、削除ではなく `PATCH { "status": "draft" }`（取りやめ）でよい。

### 4.9 POST `/social/publish` — 配信を今すぐ回す（運用向け）

期限の来た `auto` の予約を今すぐ配信する。**通常の外部アプリは呼ばない。** Torifune は既定で
1 分ごとに同じ処理を自分で回している。定期実行を止めた構成（`TORIFUNE_SCHEDULER=off`）で
外部の cron から叩くためのもので、`system.manage` が要る（サイトのトークンには付けられないので呼べない。§2.2）。要求本文は不要。

応答は件数だけ（`interrupted`・`due`・`skipped`・`skipFailed`・`attempted`・`published`・`retried`・
`failed`・`unrecorded`）。他の実行が 10 秒以上続いていれば **409 `CONFLICT`**（`details.job`、
`Retry-After: 10`）。各キーの意味は [手順書 §7](SNS投稿の外部連携.md#7-定期実行を止めている場合)。

### 4.10 POST `/social/posts/{id}/approve` — 承認待ちの投稿を承認する

承認待ち（`awaiting_approval`）の投稿を**承認して予約（`scheduled`）にする**。権限は **`social.approve`**（§2.2）。
**通常は人が管理画面 `/social` の「承認待ち」で行う**操作で、外部アプリのトークンには `social.approve` を付けない。
承認の操作を API で行うのは、運用者が承認用に作った道具などに限る。

| 項目 | 型 | 必須 | 制約（違反は 422。`details` のキーはその項目名） |
| --- | --- | --- | --- |
| `publishTiming` | `now` / `scheduled` | **必須** | `now`＝即投稿、`scheduled`＝指定の時間に投稿。`after_approval` も 422 `publishTiming` |
| `scheduledAt` | string \| null | 任意 | `scheduled` のときだけ使う（`now` のときは無視する）。省略・`null` なら登録された希望日時を使う。§1.4 の形式と範囲 |
| `expectedUpdatedAt` | string | **必須** | 承認する前に画面か `GET` で読んだ投稿の **`updatedAt`** をそのまま送る（ISO 8601）。欠落・日時として読めない値は 422 `expectedUpdatedAt` |

**応答**：200 で投稿（§4.3）。`status: "scheduled"`、`approvedAt` に承認の時刻、`scheduledAt` に実際に配信へ回る時刻
（`now` ならサーバのいまの時刻）。`nextAttemptAt` は `null` になる（`skipCount` は変わらない）。

| HTTP | `code` | いつ |
| ---: | --- | --- |
| 404 | `NOT_FOUND` | 投稿が無い（UUID の形でない ID・**トークンの区画の外の投稿**も。§2.3） |
| 409 | `CONFLICT` | **読んだ後に投稿の内容が変わっていた**（`expectedUpdatedAt` が投稿の `updatedAt` と合わない）。`details.expectedUpdatedAt`：「投稿の内容が変わっています。内容を確かめてから承認し直してください。」。読み直して内容を確かめてから承認し直す |
| 422 | `VALIDATION_ERROR` | 承認待ちでない（`status`「承認待ちの投稿ではありません（いまの状態：scheduled）。」。**409 より先に判定する**）・日時の誤り（`scheduledAt`）・要求の形・配信 Plugin の規則（§4.4 の 6〜8b を予約として掛ける） |

* **見た内容だけを承認する。** 判定と更新は 1 回の条件付きの更新で行い、同じ投稿を 2 人が同時に承認しても通るのは 1 人だけ
  （もう 1 人は 422 `status` か 409）
* **指定の時間が過ぎていれば 422 `scheduledAt`**（「指定の日時を過ぎています。即投稿を選ぶか、未来の日時を指定してください。」。
  いまと等しい時刻も過ぎた扱い）。**過ぎた日時を即投稿に読み替えない。** 希望日時も要求の日時も無ければ 422 `scheduledAt`
  （「承認して予約するときは日時を指定してください。」）。登録（§4.4）の `scheduled` は過去も許すが、承認は人が選ぶ操作なので扱いが違う
* **手動投稿しかできない配信 Plugin の provider（いまは X の無料版 `sns-x-manual`）では、`publishTiming` が `scheduled` でも即投稿になる**
  （200。`scheduledAt` がいまの時刻）。承認するとすぐ管理画面の「手動投稿待ち」に並ぶ
* 承認を外す操作は無い。予約を止めるときは `PATCH { "status": "draft" }`（取りやめ）か `{ "status": "awaiting_approval" }`（承認待ちへ戻す）
* サイトのトークンに `social.approve` を付けると、そのサイトの区画の投稿だけを承認できる（サイトごとの承認の道具を作れる。区画の外は 404）
* 承認が成功すると `social.post.approved` イベントが 1 回発火し（§6.6）、監査ログに承認した人・時刻・選んだ時機が残る

```bash
curl -X POST https://torifune.example.com/api/v1/social/posts/$POST_ID/approve \
  -H "Authorization: Bearer $APPROVER_TOKEN" -H 'Content-Type: application/json' \
  -d '{ "publishTiming": "scheduled", "expectedUpdatedAt": "2026-09-30T01:12:00.123Z" }'
```

---

## 5. SNS ごとの仕様

### 5.1 前提

* **規則を決めるのは、その provider を担当する配信 Plugin。** 登録時（§4.4 の 8a・8b）と、
  配信の直前にもう一度、同じ規則で検査する。登録を通った投稿が配信の時刻に規則で落ちることは基本的に無い
* **Plugin が入っていない provider には SNS ごとの規則が掛からない**（Core の規則だけ）
* **provider `x` の Plugin は 2 種類あり、同時には有効にできない**（先に有効になったほうが担当する）。
  どちらが有効かで使える配信モードが変わる。**外部アプリからどちらが有効かを問い合わせる API は無い**
  ので、まず運用者に確かめる。API で確かめるなら次の手順にする

  1. **`status: "draft"`**・`deliveryMode: "auto"`・`scheduledAt` なしで、確認用の本文を登録する
     （作成時は `draft` でも §4.4 の 8b が掛かる）。`externalRef` は付けない
  2. 422 `deliveryMode` なら `sns-x-manual`（手動投稿だけ）。201 なら `sns-x-api`（自動配信できる）か、
     X の Plugin が 1 つも有効でない（どちらかは区別できない）
  3. **201 で作られた確認用の投稿は `DELETE /social/posts/{id}` で消す**（`social.delete` が要る。無ければ運用者に頼む）

  **`status: "scheduled"` で試さない。** `sns-x-api` が有効だと、そのまま予約として配信され、X に本当に投稿される
* **X の無料版（`sns-x-manual`）では、`publishTiming` を送った登録は値（`now` / `scheduled` / `after_approval`）によらず常に
  承認待ち（`awaiting_approval`）で返り、承認は常に即投稿になる**（§4.4・§4.10）。判定は「その provider の配信 Plugin が手動投稿しかできない
  （自動配信を実装していない）か」で行うので、同じ形の配信 Plugin を入れた provider でも同じになる。`publishTiming` を送らない
  `status: "scheduled"` の登録は従来どおり予約になり、予約日時に「手動投稿待ち」に並ぶ。`deliveryMode` は従来どおり `manual` を送る
* 以下の「上限」は登録時に 422 で断られる条件。「配信時の失敗」は登録を通った後に SNS 側の都合で
  `failed` / 再試行になる条件

### 5.2 一覧表

| | Bluesky | X（`sns-x-api`：X API 版） | X（`sns-x-manual`：無料版） | Threads | Instagram |
| --- | --- | --- | --- | --- | --- |
| `provider` | `bluesky` | `x` | `x` | `threads` | `instagram` |
| `deliveryMode: auto` | ○ | ○ | **×**（422 `deliveryMode`） | ○ | ○ |
| `deliveryMode: manual` | ○ | ○ | ○ | ○ | **×**（422 `deliveryMode`） |
| `publishTiming` を送った登録 | 送った値どおり | 送った値どおり | **常に承認待ち**（承認は即投稿。§5.1） | 送った値どおり | 送った値どおり |
| 本文の上限 | **300 grapheme** かつ **3000 UTF-8 バイト**（別に Core が UTF-16 長 3000 で先に見る） | **重み付き 280**（§5.3） | **重み付き 280**（§5.3） | **500**（§5.4） | **2200**（UTF-16 の長さ） |
| 本文のその他の上限 | —（対になっていないサロゲートは全 SNS 共通で Core が断る。表の下の注） | 同左 | 同左 | リンクは**異なる URL 5 本まで** | ハッシュタグ 30 個・メンション 20 件まで |
| `link` の扱い（`auto`） | **リンクカード**（本文には足さない。カードの見出しはホスト名） | **本文の末尾に改行して足す**（長さに含む） | —（`auto` 不可） | **本文の末尾に改行して足す**（長さ・本数に含む） | **指定不可**（422 `link`） |
| `link` の扱い（`manual`） | 本文の末尾に改行して足す（長さに含む） | 同左 | 同左 | 同左 | — |
| `media` の枚数 | 0〜4 | 0〜4 | —（`manual` のみのため 0） | 0〜10（2 枚以上はカルーセル） | **1〜10 必須**（0 枚は 422 `media`） |
| `media` の形式・大きさ | PNG・JPEG・GIF・WebP、**1 MB（1,000,000 バイト）まで** | JPEG・PNG・WebP、**5 MB（5,000,000 バイト）まで** | — | JPEG・PNG、8 MB まで（Threads 側の条件。登録時は検査しない） | **JPEG のみ**（Instagram 側の条件。登録時は検査しない） |
| 画像を取りに行くのは | **Torifune のサーバ** | **Torifune のサーバ** | — | **Threads（Meta）のサーバ** | **Instagram（Meta）のサーバ** |
| `media` と `link` の併用 | **不可**（`auto` で 422 `link`） | 可 | — | 可 | —（`link` 不可） |
| `alt` | 送る（Core が先に UTF-16 の長さ 1000 で 422 `media` にするので、Plugin の 1000 grapheme の上限は実際には効かない） | **送らない**（無視） | — | 送る（`alt_text`） | **送らない**（無視） |
| `providerOptions` | `langs` だけ受け付ける（言語コードの配列・3 件まで・各 2〜16 文字。例 `{"langs":["ja"]}`）。他のキーは 422 `providerOptions.<キー>` | どのキーも 422 `providerOptions.<キー>` | 同左 | 同左 | 同左 |
| 手動投稿の URL の上限 | intent URL 2048 文字（422 `body`） | intent URL 2048 文字（422 `body`） | 同左 | intent URL 2048 文字（422 `body`） | — |
| 配信後の `externalUrl` | `https://bsky.app/profile/<handle>/post/<rkey>` | `https://x.com/i/status/<id>` | —（人が PATCH で記録） | Threads が返す投稿の URL | Instagram が返す投稿の URL |

**手動投稿（`manual`）では `media` を 1 件も付けられない**（全 SNS 共通。422 `media`）。
画像は人が SNS の投稿画面で添付する。

**本文・`link` の NUL と対になっていないサロゲートは、すべての provider で Core が先に 422 で断る**（§1.3。キーは `body` / `link`、文言は Core のもの）。
X（`sns-x-api`・`sns-x-manual`）・Threads・Bluesky の手動投稿の配信 Plugin も対になっていないサロゲートを検査するが、Core が先に断るのでその検査の文言
（`本文に扱えない文字が含まれています。`）は返らない。

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

リンクの本数は、本文（と `link`）から URL を切り出し、**文字列として異なるもの**を数えて 5 本まで。
切り出し方は X（§5.3 の 2）と似ているが、次の点が違う。

* スキームの大文字・小文字を区別しない（`HTTPS://` も URL として拾う。X は小文字の `http(s)://` だけ）
* ホスト名の形を確かめない。末尾の句読点を外した後に `https://` だけが残るものを除き、
  `https://` の直後に何か続けば URL として数える（X はホスト名まで揃ったものだけを数える）
* 同じかどうかは文字列の完全一致（大文字・小文字や末尾の `/` の違いも別の URL として数える）

Threads の長さ（500）の数え方では URL を特別扱いしない（X のように 23 に置き換えず、そのままの長さで数える）。

### 5.5 手動投稿の URL の長さ

手動投稿では、Torifune が SNS の投稿画面の URL（Web Intent）に本文を埋め込む。
この URL は **2048 文字まで**（Core の規則）で、日本語 1 文字は URL の中で 9 文字（`%E3%81%82`）になる。

| SNS | 投稿画面の URL の先頭 | 日本語だけの本文で入る目安 | 登録時の検査 |
| --- | --- | --- | --- |
| X | `https://x.com/intent/tweet?text=` | 約 224 文字（ただし重み付き 280 の上限＝日本語 140 文字が先に効く） | あり（422 `body`「投稿画面の URL が長くなりすぎます…」） |
| Threads | `https://www.threads.com/intent/post?text=` | **約 223 文字**（本文の上限 500 より先に効く） | あり（422 `body`） |
| Bluesky | `https://bsky.app/intent/compose?text=` | **約 223 文字**（本文の上限 300 grapheme より先に効く） | あり（422 `body`） |

改行は 3 文字（`%0A`）、英数字は 1 文字として数える。`link` も本文に含めて埋め込まれる。
本文・`link` の対になっていないサロゲートは、この検査より先に Core が 422（`body` / `link`）で断る（§1.3・§5.2）。

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
            ┌──────── 差し戻し・取りやめ（PATCH draft）────────┐
            ▼                                                │
draft ──承認を依頼（PATCH）──▶ awaiting_approval ──承認（approve）──▶ scheduled ──▶ published
  │  ▲                              ▲                         │  │
  │  └──────────── 取りやめ（PATCH draft）───────────────────────┘  │
  │                                 └── 承認待ちへ戻す（PATCH / 承認済みの書き換え）
  └────────────── 予約（PATCH scheduled。承認を経ない）──────────▶ scheduled
  draft / scheduled ──────────────────────────────────────────────▶ failed
```

`PATCH` で変えられる先（承認は別の操作 §4.10）。

| 現在 | 変えられる先 |
| --- | --- |
| `draft` | `draft` / `awaiting_approval`（承認を依頼）/ `scheduled` / `published` / `failed` |
| `awaiting_approval` | `awaiting_approval`（内容の修正）/ `draft`（差し戻し・取りやめ）。**`scheduled` へは承認（§4.10）だけ** |
| `scheduled` | `scheduled` / `draft`（取りやめ）/ `awaiting_approval`（承認待ちへ戻す）/ `published` / `failed` |
| `published` | `published` のみ（**終端**） |
| `failed` | `failed` のみ（**終端**） |

終端から動かそうとすると 422 `status`（「published から draft へは変更できません。」など）。
承認待ちから `published` / `failed` へも 422 `status`（「awaiting_approval から published へは変更できません。」）。
別の手段で SNS へ出してしまったときは、差し戻して（`draft`）から記録する。

**承認は強制ではない。** 承認を待つかは外部アプリが登録ごとに選ぶ（`publishTiming`）。`social.write` を持つ者は承認を経ない予約も
作れる（`status: "scheduled"`）。そうした予約は `approvedAt: null` で、人が承認した予約（`approvedAt` あり）と見分けられる。
**失敗した投稿を出し直すときは、新しい投稿として（新しい `externalRef` で）登録する。**

### 6.2 進み具合の読み方

状態は 5 つだけで、配信の進み具合は他の項目との組み合わせで読む。

| 見たいこと | 条件 |
| --- | --- |
| 承認待ち | `status: "awaiting_approval"`（配信されない。人が管理画面で承認するまで待つ。`scheduledAt` は希望日時） |
| 承認済みの予約 | `status: "scheduled"`・**`approvedAt` あり**（人が承認した。以下の配信待ち・手動投稿待ちなどと組み合わさる） |
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
| `social.post.created` | 投稿を作った（`externalRef` の再送では発火しない）。承認待ちで登録したときは `status: "awaiting_approval"` |
| `social.post.approved` | **承認待ちの投稿が承認されて予約になった**（1 回の承認で 1 回。`status: "scheduled"`）。差し戻し（`draft` へ）と承認が外れたときは発火しない |
| `social.post.published` | 定期実行が配信に成功した／`PATCH` で `published` にした |
| `social.post.failed` | 定期実行が失敗・取りやめ・中断と判定した／`PATCH` で `failed` にした |

Webhook の本文は `{ "event": "<イベント名>", "data": { "postId": "…", "accountId": "…", "status": "…" } }`。
**理由・本文・URL は載らない**ので、必要なら `GET /social/posts/{postId}` で引く（`social.post.approved` の配信の予定時刻と承認の時刻も
`GET` の `scheduledAt` / `approvedAt` で読む。承認した人は載らない）。

| ヘッダ | 内容 |
| --- | --- |
| `X-Torifune-Event` | イベント名 |
| `X-Torifune-Delivery` | 配信 ID。**再試行でも変わらない**ので、受け手はこれで二重処理を避ける |
| `X-Torifune-Timestamp` | 送った時刻（UNIX 秒） |
| `X-Torifune-Signature` | `sha256=<HMAC-SHA256(secret, "<timestamp>.<本文>") の 16 進>` |

受け手は署名を定数時間比較で検証し、`X-Torifune-Timestamp` が現在から離れすぎていないことを確かめる
（リプレイ対策は受け手の責任）。2xx 以外は失敗とみなされ、**初回を含めて最大 5 回**
（送り直しは最大 4 回。間隔は 1 → 2 → 4 → 8 分）送られる。
Payload の定義は [`Eventリファレンス.md`](../Eventリファレンス.md)。

**Webhook はトークンにもサイトにも紐づかず、全サイトのイベントが届く**（Payload にサイトは載らない）。受け手がサイトで振り分けるときは、
Payload の `accountId` をそのサイトのトークンで `GET /social/accounts/{accountId}` する（200 ならそのサイトか共通のアカウント、404 なら区画の外。§2.3）。

---

## 7. 実装例

流れ：**アカウント一覧から投稿先を選ぶ → `externalRef` 付きで投稿を登録 → 結果をポーリング。**
422 は直して出し直す（自動で再送しない）、429 は `Retry-After` だけ待って同じ要求を再送、
5xx・通信エラーは同じ `externalRef` のまま再送する。

### 7.1 curl

```bash
BASE=https://torifune.example.com/api/v1
AUTH="Authorization: Bearer $TORIFUNE_TOKEN"

# 1. 投稿先（X のアカウント）の id を引く。候補を確かめてから 1 つ選ぶ
curl -sS -H "$AUTH" "$BASE/social/accounts?provider=x" | jq -r '.data[] | "\(.id)\t\(.displayName)"'
ACCOUNT_ID=$(curl -sS -H "$AUTH" "$BASE/social/accounts?provider=x" | jq -r '.data[0].id // empty')
[ -n "$ACCOUNT_ID" ] || { echo 'X のアカウントが登録されていません' >&2; exit 1; }

# 2. 投稿を登録する。本文は post.json へ、ステータスコードは標準出力へ（201=作った / 200=既にあった）
STATUS=$(curl -sS -o post.json -w '%{http_code}' -X POST "$BASE/social/posts" \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"socialAccountId":"'"$ACCOUNT_ID"'","body":"本日のお知らせです。",
       "status":"scheduled","scheduledAt":"2026-10-01T09:00:00+09:00",
       "deliveryMode":"auto","externalRef":"notice-2026-10-01:x"}')
echo "HTTP $STATUS"
if [ "$STATUS" != 201 ] && [ "$STATUS" != 200 ]; then
  jq '.error' post.json >&2   # 422 なら .error.details のキーを見て直す
  exit 1
fi
POST_ID=$(jq -r '.data.id' post.json)

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
        body: body === undefined ? null : JSON.stringify(body),
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
  // 値は増えうる。知らない値は「まだ終わっていない」として扱う
  status: 'draft' | 'awaiting_approval' | 'scheduled' | 'published' | 'failed' | (string & {});
  approvedAt: string | null;
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
      publishTiming: 'now', // いますぐ（次の定期実行で配信）。人の確認を待つなら 'after_approval'
      deliveryMode: 'auto',
      providerOptions: { langs: ['ja'] }, // Bluesky だけが受け付ける
      externalRef: 'article-1234:bluesky',
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
    if (data.status === 'draft') {
      console.log('下書きに戻されました（承認待ちが差し戻された・取りやめられた）');
      return;
    }
    if (data.status === 'awaiting_approval') {
      // 人が管理画面で承認するまで進まない。Webhook の social.post.approved を受け取るとポーリングが要らない
      console.log('承認を待っています');
      await sleep(60_000);
      continue;
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
if not accounts:
    raise SystemExit("X のアカウントが登録されていません")
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
            "publishTiming": "scheduled",
            "scheduledAt": "2026-10-01T09:00:00+09:00",
            "deliveryMode": "auto",
            "externalRef": "notice-2026-10-01:x",
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
    if current["status"] == "draft":
        print("下書きに戻されました（承認待ちが差し戻された・取りやめられた）")
        break
    if current["status"] == "awaiting_approval":
        # 人が管理画面で承認するまで進まない（X の無料版では publishTiming を送ると常にこうなる）
        time.sleep(60)
        continue
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
* `externalRef` は**外部アプリ側で一意に決まる値**（記事 ID・ジョブ ID など）にし、再送では**同じ値**を使う。**トークンの中で全 SNS を通して一意**にする（複数の SNS へ出すなら `article-1234:x` のように投稿先ごとに変える。§3.5）。
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
* 承認待ちの投稿は、承認されるまで希望日時を過ぎても配信されない。承認する人は過ぎた希望日時では「指定の時間に投稿」を選べない
  （即投稿を選ぶか日時を指定し直す。§4.10）。時刻に意味のある投稿は早めに登録する

### 8.3 秘密の扱い

* API トークンは環境変数やシークレットストアから読み、**ソースコード・ログ・URL に書かない**
* 資格情報（`credentials`）は書き込み専用で、どの API からも読み出せない。外部アプリ側に控えが要るなら、
  外部アプリ側の秘密の保管場所に置く
* `media[].url`・`link` に署名付き URL などの秘密を含めない。投稿の応答として `social.read` を持つ誰にでも見える

### 8.4 手動投稿

* 手動投稿は**人が画面で操作するまで終わらない。** 外部アプリの処理を手動投稿の完了で待たせない
* 使えるかは provider と、X の場合はどちらの Plugin が有効かで決まる（§5.2）。
  使えないと 422 `deliveryMode`
* 本文は投稿画面の URL に埋め込まれるので、日本語で約 220 文字を超えると登録時に 422 `body` で断られる（§5.5）

### 8.5 そのほか

* 投稿先 SNS の規則は Plugin の版で変わりうる。**文字数の事前チェックを外部アプリ側に持つ場合も、
  最終判断は Torifune の 422 に任せる**（`details` のキーを見て利用者へ返す）
* 一覧には区画の中の他のアプリ（共通のトークンなら共通の区画の他のアプリ、サイトのトークンなら同じサイトの他のトークン）や人が登録した投稿も出る（§2.3）。
  一覧を処理するときは自分の `externalRef` の形で絞る

---

## 9. 変更履歴・関連文書

### 変更履歴

| 日付 | 内容 |
| --- | --- |
| 2026-09-24 | 初版。コード（Core の SNS API と `sns-bluesky` / `sns-x-api` / `sns-x-manual` / `sns-threads` / `sns-instagram` の 5 Plugin）から起こした |
| 2026-09-24 | 検証を受けて訂正。認証失敗時の 403 `CSRF_FAILED`、`media.<n>.url` のキー、`failureReason` の 422、409 の `details`、`externalRef` が SNS をまたいで衝突すること、`page` / `perPage` / `accountId` の範囲外の振る舞い、Rate Limit の送信元 IP、Webhook の回数、例の不具合を直し、§10 を整理した |
| 2026-09-24 | コードの課題（旧 §10.1 の 1・2・4・5）を直したのに合わせて更新。Bluesky の手動投稿は、投稿画面の URL が 2048 文字を超える本文と対になっていないサロゲートを登録時に 422 `body` で断る（§5.2・§5.5）。SNS の一覧の `page` / `perPage` の範囲外を丸める（§3.6。従来は `page=0`・`perPage=-1` などが 500、`perPage=0` は空の 200）。OpenAPI に `createSocialPost` の 200・`{id}` の 6 操作の 404・`publishSocialPosts` の 409 を宣言した（§3.7）。**動作の変更が 2 つある**：(1) **`perPage` を 101 以上で送ると 100 件までしか返らない**（従来は要求した件数まで返っていた。`meta.perPage` が `100` になるので検知でき、`meta.total` までページを送れば全件取れる）。(2) **`GET /social/posts` の `accountId` が UUID の形でない値（空文字を含む）は 422 `accountId`**（従来は絞り込みが黙って外れて全件が返っていた。§4.5）。どちらも初版から送らないよう書いていた値で、API のバージョンは v1 のまま。あわせて OpenAPI の `accountId` に `format: uuid` が付いた（生成クライアントでは引数の型が変わることがある。§3.7） |
| 2026-09-24 | §10.1 の「初版の 1 の記述の訂正」を、SNS 以外の一覧の `page` / `perPage`・`GET /campaigns?siteId=`・SNS 以外の OpenAPI の宣言を直したことに合わせて更新した。**記述の更新だけで、SNS 投稿 API の振る舞い・OpenAPI は変わらない** |
| 2026-09-25 | 入力の文字と範囲の規則を足した（§1.3・§1.4・§3.2・§4.4・§4.7・§5.2・§5.5）。**動作の変更がある**：(1) **対になっていないサロゲートを含む文字列は 422**（従来は `body`・`link`・`externalRef`・`externalId`・`externalUrl`・`failureReason`・アカウントの `displayName` / `handle` などで 2xx になり、U+FFFD に置き換わって保存されていた。`media`・`providerOptions` は 500）。絵文字を UTF-16 の長さで半分に切るクライアントは、コードポイント単位で切るよう直す必要がある。(2) 本文・`link` の対になっていないサロゲートの 422 は、X・Threads・Bluesky の手動投稿でも **Core の文言**になり、`link` の片割れは**キーが `link`** になる（従来は配信 Plugin の `本文に扱えない文字が含まれています。` を `body` で返していた）。(3) **NUL（U+0000）を含む文字列は 422**（従来は多くの項目で 500、`scheduledAt`・`credentials` などは 2xx）。(4) **`scheduledAt` の `0001-01-01T00:00:00Z` より前・`9999-12-31T23:59:59.999Z` より後は 422 `scheduledAt`**（従来は 201 か 500）。どれも正当な利用で送る値ではなく、API のバージョンは v1 のまま。OpenAPI の `scheduledAt` に範囲の説明が付いた |
| 2026-09-25 | 検証を受けて §1.3 を訂正・追記した。使えない文字の検査はクエリの**名前**も見る（名前そのものに含むときの `details` のキーは `_`）。`details` のキーは先頭の 50 個まで。あわせて、項目名が `constructor`・`__proto__` などのときに 500 になっていたのと、深い入れ子（1 万段など）の本文で 500 になっていたのを直した（どちらも 422） |
| 2026-10-01 | **承認待ちを足した**（`048-social-post-approval`）。`POST /social/posts` に任意の **`publishTiming`**（`now` / `scheduled` / `after_approval`。§4.4）、状態 **`awaiting_approval`**（§4.3・§6）、承認の操作 **`POST /social/posts/{id}/approve`**（Permission **`social.approve`**。§4.10）、応答の **`approvedAt`**、イベント **`social.post.approved`**（§6.6）。API のバージョンは v1 のまま。**既存の外部アプリへの影響**：(1) `publishTiming` を送らない要求は従来どおり。(2) `POST` の `status` の既定が OpenAPI から消えた（省略時は従来どおり `draft`。生成クライアントの既定値が消えることがある）。`publishTiming` と `status` を同時に送ると 422 `status`。(3) **状態の値 `awaiting_approval` が増えた。** 自分が承認待ちを使わなければ自分の投稿には現れないが、**`GET /social/posts` の一覧には他のアプリや人が作った承認待ちが含まれうる**。状態を網羅的に分岐しているクライアントは知らない値を受け取るので、無視するか「その他」として扱う。(4) `PATCH` で承認待ちから `scheduled` / `published` / `failed` へは変えられない（422 `status`）。`PATCH` に `publishTiming` を送ると 422（従来は黙って無視されていた）。(5) **承認を経た予約（`approvedAt` あり）の内容・日時・配信方法を書き換えると承認待ちに戻る。** 既存の予約はすべて `approvedAt: null` で、振る舞いは変わらない。(6) 既存のトークンの Scope に `social.approve` は無いので、既存のトークンは承認できない。(7) X の無料版（`sns-x-manual`）では `publishTiming` を送った登録が常に承認待ちになる（§5.1）。(8) **`PATCH /social/posts/{id}` の処理中に承認・配信の開始などで投稿の状態が変わると 409 `CONFLICT`**（`details.status`。何も変えない。§4.7）。OpenAPI の `updateSocialPost` に 409 を宣言した |
| 2026-10-01 | **配信の不具合を直した**（`049-publish-claim-conditions`）。配信ジョブが、その周期の配信の順番に並べた後に `PATCH` で予約日時を未来へ直された・`deliveryMode` を `manual` に変えられた・取りやめてから予約し直された予約を、直す前の内容のまま送っていた（`PATCH` は 200 を返していた）。直した後は、こうした予約は直した内容で扱われる（§4.7）。`POST /social/publish` の件数では `due` にだけ数え、他のどれにも数えない。こうした予約について誤って出ていた `social.post.published` / `social.post.failed` も出なくなる。**API の形・バージョン（v1）・OpenAPI・イベントの形は変わらない** |
| 2026-10-02 | 管理画面のアカウント一覧に ID の表示とコピーを足した（`051-social-account-id-display`）。画面で登録したアカウントの `id` は一覧の「アカウントID」列で写せる（§4.2）。**API の形・バージョン（v1）・OpenAPI は変わらない** |
| 2026-10-08 | **SNS アカウントと API トークンを Web サイトに紐づけられるようにした**（`053-site-scoped-social`）。トークンの**区画**（§2.3）、アカウントの応答・作成・更新の **`siteId`**（§4.2）、区画の外の 404 / 422 / 403、サイトの削除・アーカイブでサイトのトークンが 401（§3.3）、再送で既存の投稿が区画の外なら 422 `externalRef`（§3.5）。API のバージョンは v1 のまま。**既存の外部アプリへの影響**：(1) アカウントの応答に `siteId` が増えた（既存のアカウントはすべて `null`）。(2) アカウントの作成・更新の `siteId` は送らなければ今までどおり（共通のトークンが値を送ると 422）。(3) **運用者がアカウントをサイトに紐づけたときだけ**、共通のトークンからそのアカウントは使えなくなる（登録は 422 `socialAccountId`、そのアカウントの投稿の取得・更新は 404）。(4) サイトのトークンが発行されたときだけ、そのトークンが共通のアカウントへ登録した投稿は共通のトークンから見えない。既存の投稿はすべて共通の区画のまま。(5) **運用者がトークンのサイトを変えると、そのトークンから見える範囲が次の要求から変わる**（§2.2）。(6) 共通のトークンどうしは今までどおり分離境界ではない。Plugin API・イベント・Webhook は変わらない |
| 2026-10-08 | 053 の検証を受けて足した。**トークンから見えない投稿が載ったアカウントは、トークンから削除・資格情報の変更ができない**（403 `FORBIDDEN`。§2.3・§3.3・§4.2）。表示名・`handle`・`status` の変更は通る。見えない投稿が載るのは共通のアカウントへサイトのトークンが投稿を登録したときだけなので、**サイトを使っていない間は既存の外部アプリに影響しない**。あわせて、同じ `externalRef` の要求が同時に届いた場合も、既存の投稿が区画の外なら 422 `externalRef`（§3.5 の再送と同じ）にそろえた |

### 関連文書

* 運用手順（トークン発行・アカウント登録・結果の読み方）：[`SNS投稿の外部連携.md`](SNS投稿の外部連携.md)
* イベントと Webhook：[`Eventリファレンス.md`](../Eventリファレンス.md)
* 配信 Plugin の作り方：[`Plugin開発ガイド.md`](../Plugin開発ガイド.md) §9
* API の全体方針：`docs/仕様書/05_API設計.md`（§10・§11 形式、§18 SNS API、§33 ページング、§36 Rate Limit、§37・§38 API Token）
* 設計：`docs/設計/035-social-publishing/設計.md`、各 SNS は `036-sns-bluesky` / `037-sns-x` /
  `038-sns-instagram` / `040-sns-threads`、承認待ちは `048-social-post-approval`、
  アカウントの ID の表示とコピーは `051-social-account-id-display`、トークンの区画は `053-site-scoped-social`

---

## 10. コードの課題・文書間の食い違い・未確定の点

この文書はコードの振る舞いに合わせて書いた。以下は、その過程で見つけた点。

### 10.1 コードの課題（未修正）

いまの振る舞いとして本文に書いたが、直すべき候補。外部アプリは本文の回避策に従う。

1. **Rate Limit の送信元 IP が取れないと全クライアントが 1 枠を共有する**：`X-Forwarded-For` も `X-Real-IP` も無い要求は
   `unknown` という同じキーで数えられる（`apps/web/src/api/route.ts` の `rateLimitKey`）。リバースプロキシの設定次第で、
   1 分 300 回を全員で分け合うことになる（§3.4）

初版の 1・2・4・5（SNS の一覧の `page` / `perPage` の範囲、`accountId` の絞り込みが黙って外れること、
Bluesky の手動投稿の URL の長さ、OpenAPI の 200・404・409 の宣言）は直した（§9 の変更履歴）。

**初版の 1 の記述の訂正**：初版は「他の一覧 API は `paginationSchema` で 1〜100 に丸めている」と書いたが、誤りだった。
丸めているのは `/analytics`・`/analytics/breakdown` だけで、`/sites`・`/users`・`/campaigns` の一覧も、直す前の
SNS の一覧と同じく `page` / `perPage` の範囲を検査していなかった。これらと、`GET /campaigns?siteId=` の絞り込みが
UUID の形でない値で外れること、SNS 以外のエンドポイントの 404・409 の OpenAPI の宣言は、`043` で直した
（SNS 投稿 API の振る舞いには影響しない）。

### 10.2 文書間の食い違い

1. **`providerOptions` の例**：手順書 §3 は「返信先の ID など」と書くが、**いまの 5 Plugin で受け付けるキーは
   Bluesky の `langs` だけ**で、他はすべて 422。返信・引用などはできない
2. **`05_API設計.md` §18 のエンドポイント例**には `GET` / `PATCH /social/accounts/{id}` と `POST /social/publish` が無い。
   実装にはある（§4.1）
3. **手順書 §7 の `due` の説明**は「1 回あたり最大 20 件」だったが、`due` は 1 回の実行で**読んだ**期限切れの行の数で、
   上限は 200（`PUBLISH_SCAN_LIMIT`）。20（`PUBLISH_BATCH_SIZE`）は**配信に着手する**上限
   （`apps/web/src/domain/social/publishing.ts`）。手順書は 2026-09-24 に直した

### 10.3 未確定の点

1. **Threads の画像の形式・大きさ（JPEG・PNG、8 MB）と Instagram の JPEG のみ**は、Plugin の失敗時の文言から読んだ
   各 SNS 側の条件で、Torifune のコードでは検査していない。SNS 側の仕様変更で変わりうる
