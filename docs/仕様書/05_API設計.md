# 05_API設計.md

## 1. 目的

本ドキュメントでは、Torifune OSSが提供するAPIの基本方針、構造、認証・認可、Pluginから利用するAPI、およびAPIの拡張方針を定義する。

TorifuneのAPIは、Web UIだけでなくPluginからも利用できる共通インターフェースとして設計する。

---

## 2. 基本方針

Torifune APIは以下を基本方針とする。

1. REST APIを基本とする
2. Web UIとPluginで可能な限り同じAPIを利用する
3. PluginからTorifune内部のデータへアクセスするための正式なAPIを提供する
4. Pluginがデータベースへ直接アクセスすることを原則として禁止する
5. APIによる認証と認可を明確に分離する
6. API Versionを管理する
7. APIの公開範囲を明確にする
8. 外部公開APIと内部APIを明確に区別する
9. Plugin APIをTorifune内部実装から独立した契約として扱う

---

## 3. APIの分類

TorifuneではAPIを以下の3種類に分類する。

```text
API
├── Public API
├── Plugin API
└── Internal API
```

### 3.1 Public API

外部クライアントから利用可能なAPI。

主に以下を想定する。

* Web UI
* 外部アプリケーション
* 外部サービス
* APIクライアント

### 3.2 Plugin API

Torifune Pluginから利用することを目的としたAPI。

Plugin APIはTorifuneの拡張機構の一部として正式に公開する。

### 3.3 Internal API

Torifune内部の各モジュール間で利用するAPI。

Internal APIは外部Pluginに対する互換性を保証しない。

---

## 4. APIアーキテクチャ

APIはPresentation LayerとしてApplication Layerを呼び出す。

```text
┌──────────────────────┐
│ Web Browser          │
│ External Client      │
│ Plugin               │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│       API Layer      │
│                      │
│ Routing              │
│ Authentication       │
│ Authorization        │
│ Validation           │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Application Layer    │
│                      │
│ Use Case             │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Domain Layer         │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Repository / Provider│
└──────────────────────┘
```

API Layerから直接SQLを実行することは原則として禁止する。

---

## 5. REST API

標準APIはREST APIを基本とする。

URLはリソースを表現し、HTTP Methodによって操作を表現する。

例：

```text
GET    /api/v1/sites
POST   /api/v1/sites
GET    /api/v1/sites/{id}
PATCH  /api/v1/sites/{id}
DELETE /api/v1/sites/{id}
```

---

## 6. API Version

APIにはVersionを設定する。

初期Versionは`v1`とする。

```text
/api/v1/...
```

将来的に互換性を維持できない変更を行う場合は、新しいAPI Versionを提供する。

```text
/api/v1/...
/api/v2/...
```

既存APIを突然変更して既存Pluginを破壊することは避ける。

---

## 7. Content-Type

JSONを標準フォーマットとする。

Request：

```http
Content-Type: application/json
```

Response：

```http
Content-Type: application/json
```

ファイルアップロード等、JSONが適さない処理については`multipart/form-data`等を利用する。

---

## 8. HTTP Method

基本的なHTTP Methodの用途を以下とする。

| Method | 用途        |
| ------ | --------- |
| GET    | データ取得     |
| POST   | 新規作成・処理実行 |
| PUT    | リソース全体の置換 |
| PATCH  | リソースの部分更新 |
| DELETE | 削除        |

HTTP Methodの意味を逸脱した利用は避ける。

---

## 9. HTTP Status Code

代表的なStatus Codeは以下とする。

| Status | 意味               |
| -----: | ---------------- |
|    200 | 成功               |
|    201 | 作成成功             |
|    204 | 成功・レスポンスBodyなし   |
|    400 | 不正なRequest       |
|    401 | 未認証              |
|    403 | 権限不足             |
|    404 | リソースが存在しない       |
|    409 | リソース競合           |
|    422 | Validation Error |
|    429 | Rate Limit超過     |
|    500 | サーバー内部エラー        |

---

## 10. Response形式

成功時は、可能な限り一定の形式でResponseを返す。

例：

```json
{
  "data": {
    "id": "site_123",
    "name": "Example Site"
  }
}
```

一覧取得では、ページング情報を含める。

```json
{
  "data": [
    {
      "id": "site_123",
      "name": "Example Site"
    }
  ],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 1
  }
}
```

---

## 11. Error Response

エラーResponseも統一された形式を使用する。

例：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request.",
    "details": {
      "name": [
        "The name field is required."
      ]
    }
  }
}
```

`code`はプログラムから判定可能な固定値とし、`message`は表示用の説明とする。

内部ExceptionのStack TraceやSQL等の機密情報をAPI Responseへ返してはならない。

---

## 12. 認証

APIへのアクセスには、APIの用途に応じて認証を要求する。

Web UIから利用するAPIでは、Torifuneのログインセッションを利用する。

```text
Browser
   │
   │ Session Cookie
   ▼
Torifune API
```

外部クライアントから利用するAPIでは、API Token等の専用認証方式を利用できる構造とする。

外部認証方式についてはAuthentication Providerの仕組みを利用する。

---

## 13. API認証とBrowser Session

Browser向けAPIでは、Torifuneのセッションを利用する。

API Requestに含まれるUser Identityは、クライアントから自由に指定できるものとして扱わない。

```text
Session
   │
   ▼
Authenticated User
   │
   ▼
Authorization
   │
   ▼
API Request
```

例えば以下のようなRequestを送信しても、

```json
{
  "userId": "other-user"
}
```

この値を認証ユーザーとして利用してはならない。

認証ユーザーはサーバー側のSessionから確定する。

---

## 14. API認可

認証後、ユーザーが対象操作を実行する権限を持っているか確認する。

```text
Request
   │
   ▼
Authentication
   │
   ▼
User Identity
   │
   ▼
Authorization
   │
   ▼
Permission Check
   │
   ▼
Use Case
```

例えば、

```text
GET /api/v1/sites
```

には`site.read`、

```text
POST /api/v1/sites
```

には`site.write`

等のPermissionを要求する。

具体的なPermission体系は機能実装時に定義する。

---

## 15. User API

ユーザー情報を扱うAPIを提供する。

例：

```text
GET    /api/v1/users
POST   /api/v1/users
GET    /api/v1/users/{id}
PATCH  /api/v1/users/{id}
DELETE /api/v1/users/{id}
```

ただし、ユーザー管理APIへのアクセスは高い権限を要求する。

ユーザーのパスワードHashやAuthentication Secret等の機密情報をAPI Responseに含めてはならない。

---

## 16. Site API

Webサイトを管理するAPI。

```text
GET    /api/v1/sites
POST   /api/v1/sites
GET    /api/v1/sites/{id}
PATCH  /api/v1/sites/{id}
DELETE /api/v1/sites/{id}
```

---

## 17. Content API

コンテンツを管理するAPI。

```text
GET    /api/v1/contents
POST   /api/v1/contents
GET    /api/v1/contents/{id}
PATCH  /api/v1/contents/{id}
DELETE /api/v1/contents/{id}
```

必要に応じて公開・下書き等の状態を管理する。

---

## 18. SNS API

SNS関連情報を扱うAPI。

例：

```text
GET    /api/v1/social/accounts
POST   /api/v1/social/accounts
DELETE /api/v1/social/accounts/{id}

GET    /api/v1/social/posts
POST   /api/v1/social/posts
GET    /api/v1/social/posts/{id}
PATCH  /api/v1/social/posts/{id}
DELETE /api/v1/social/posts/{id}
```

外部SNSのAccess Token等の機密情報はResponseへ返さない。

---

## 19. Campaign API

マーケティングキャンペーンを管理するAPI。

```text
GET    /api/v1/campaigns
POST   /api/v1/campaigns
GET    /api/v1/campaigns/{id}
PATCH  /api/v1/campaigns/{id}
DELETE /api/v1/campaigns/{id}
```

---

## 20. Analytics API

アクセス情報やマーケティング分析情報を扱うAPI。

```text
GET /api/v1/analytics
GET /api/v1/analytics/{id}
```

大量データを扱う可能性があるため、Pagination、Filtering、期間指定等を提供する。

例：

```text
GET /api/v1/analytics?siteId=site_123&from=2026-08-01&to=2026-08-31
```

---

## 21. Plugin API

PluginがTorifuneの機能へアクセスするためのAPIを提供する。

Plugin APIは以下のカテゴリに分類する。

```text
Plugin API
├── Data API
├── UI API
├── Event API
├── Configuration API
├── Authentication API
└── Database API
```

---

## 22. Data API

PluginがTorifuneのデータを利用するためのAPI。

例えば、

```text
Sites
Contents
Campaigns
Social Accounts
Social Posts
Analytics
Users
```

等へのアクセスを提供する。

Pluginは原則としてDatabaseへ直接接続せず、Data APIを利用する。

---

## 23. UI API

PluginからTorifuneのWeb UIを拡張するためのAPI。

例：

```text
registerMenu()
registerPage()
registerWidget()
registerAction()
registerSettingPage()
```

実際のInterfaceおよびメソッド名は実装時に確定する。

---

## 24. Event API

PluginがTorifune内部イベントを購読するためのAPI。

例：

```text
subscribe(
    "content.created",
    handler
)
```

イベント発生時には、Pluginへ定義されたEvent Payloadを渡す。

PluginはTorifune内部のEvent Dispatcherを直接操作しない。

---

## 25. Configuration API

Pluginが独自設定を保存・取得するためのAPI。

例：

```text
GET /api/v1/plugin-config/{pluginId}
PUT /api/v1/plugin-config/{pluginId}
```

Plugin Configuration APIでは、一般設定とSecret設定を区別する。

Secret情報はAPI Responseへ平文で返さない。

---

## 26. Authentication API

Authentication Provider Pluginが認証処理へ接続するためのAPI。

```text
Authentication Interface
├── authenticate
├── getIdentity
├── logout
└── refresh
```

具体的なAPIは、`04_認証設計.md`で定義したAuthentication Provider仕様に従う。

---

## 27. Database API

Database Provider Pluginがデータベース接続を提供するためのAPI。

```text
Database Interface
├── connect
├── disconnect
├── transaction
├── query
└── healthCheck
```

ただし、Database APIの公開範囲は慎重に設計する。

一般Pluginに自由なSQL実行権限を与えると、Torifuneのデータ分離やセキュリティ境界を破壊する可能性があるためである。

一般PluginにはData APIを優先して利用させる。

---

## 28. Plugin APIとPublic APIの関係

Public APIとPlugin APIは同じ内部処理を利用することを基本とする。

```text
                 ┌── Web UI
                 │
API Layer ───────┼── Public API
                 │
                 └── Plugin API
                         │
                         ▼
                  Application Layer
```

ただし、Pluginにのみ必要な機能についてはPlugin API専用のInterfaceを提供することができる。

---

## 29. PluginからのAPI利用

Pluginは、Torifuneが提供するAPI ClientまたはService Interfaceを利用する。

```text
Plugin
   │
   ▼
Torifune SDK / API
   │
   ▼
Application Layer
```

PluginがHTTP経由で自分自身のAPIを呼び出すことを必須としない。

同一プロセス内で利用できるService Interfaceが存在する場合は、それを利用する。

これにより不要なHTTP通信や認証処理を避けられる。

---

## 30. APIによるデータアクセス制御

APIから取得できるデータは、認証ユーザーの権限およびアクセス可能なリソースに限定する。

特に以下の値をクライアントから受け取って、そのままアクセス制御に利用してはならない。

* User ID
* Role
* Permission
* Tenant ID
* Database ID

アクセス対象はサーバー側で認証情報および権限情報から確定する。

---

## 31. SaaS版との連携

Torifune SaaSでは、Torifune OSSのAPIを利用してSaaS固有のUIや機能を実装する。

例えばSaaS固有Pluginから、

```text
User Identity
Tenant Information
Subscription Information
```

等を利用することを想定する。

ただし、SaaS側のユーザー管理やTenant管理そのものはTorifune OSSのPublic APIとして必須にはしない。

---

## 32. Tenant Context

SaaS環境では、API RequestにTenant Contextが存在する場合がある。

ただし、Tenant IDをクライアントから送信された値だけで決定してはならない。

```text
Request
   │
   ▼
Authentication
   │
   ▼
User Identity
   │
   ▼
Tenant Resolution
   │
   ▼
Tenant Context
   │
   ▼
Application
```

Tenant Contextは信頼された認証情報およびSaaS側のTenant管理情報から確定する。

Torifune OSS Coreでは、Tenant Contextを必須概念としない。

---

## 33. Pagination

一覧取得APIではPaginationを提供する。

基本形式：

```text
GET /api/v1/contents?page=1&perPage=20
```

Response：

```json
{
  "data": [],
  "meta": {
    "page": 1,
    "perPage": 20,
    "total": 100
  }
}
```

大量データが想定されるAPIでは、Offset PaginationだけでなくCursor Paginationも検討する。

---

## 34. Filtering

一覧APIでは必要に応じてFilteringを提供する。

例：

```text
GET /api/v1/contents?status=published
```

複雑な検索条件を提供する場合でも、SQLをそのままAPIへ渡すような仕様は採用しない。

---

## 35. Sorting

一覧APIではSortingを提供する。

例：

```text
GET /api/v1/contents?sort=-createdAt
```

利用可能なSort FieldをAPIごとに明示し、任意のDatabase Columnを指定できる仕様にはしない。

---

## 36. Rate Limit

Public APIおよび認証関連APIにはRate Limitを設ける。

特に以下は重点的に制限する。

* Login
* Password Reset
* Token発行
* API Token認証
* 大量データ取得
* 外部サービス連携

Rate Limit超過時は`429 Too Many Requests`を返す。

---

## 37. API Token

外部クライアントからのAPIアクセスを可能にする場合、API Token方式を提供する。

API Tokenはユーザーのパスワードとは別の認証情報として扱う。

Tokenには、

* 所有ユーザー
* 有効期限
* Scope
* 作成日時
* 最終利用日時
* 無効化状態

等を紐付ける。

Token本体は可能な限り平文保存せず、安全なHash等によって管理する。

---

## 38. API Token Scope

API TokenにはScopeを設定できる構造とする。

例：

```text
site.read
content.read
content.write
analytics.read
social.read
social.write
```

Tokenに必要以上の権限を与えないことを基本とする。

---

## 39. Webhook

外部サービスやPluginとのイベント連携が必要になった場合、Webhook機能を提供できる構造とする。

例：

```text
Torifune
     │
     │ POST
     ▼
External Service
```

Webhookでは以下を考慮する。

* 署名
* リトライ
* タイムアウト
* 重複配信
* 配信履歴
* Secret管理

Webhookを導入する場合の詳細仕様は別途定義する。

---

## 40. API Documentation

Public APIおよびPlugin APIは、機械的に参照可能なAPI仕様を提供する。

OpenAPI Specificationの利用を基本方針とする。

```text
OpenAPI
   │
   ├── API Documentation
   ├── Client Generation
   └── API Testing
```

APIの仕様と実装が乖離しないよう、可能な限りコードまたは自動生成によって管理する。

---

## 41. API Compatibility

Public APIおよびPlugin APIでは後方互換性を重視する。

特にPlugin APIについては、Torifune本体の更新によって既存Pluginが動作しなくなることを可能な限り避ける。

互換性を破壊する変更が必要な場合は、

1. 新しいAPI Versionを提供する
2. 旧Versionを一定期間維持する
3. 非推奨（Deprecated）として告知する
4. 移行方法をドキュメント化する

という手順を基本とする。

---

## 42. API Security

APIでは以下のセキュリティ対策を基本とする。

* HTTPS
* Authentication
* Authorization
* CSRF対策
* Rate Limit
* Input Validation
* Output Encoding
* SQL Injection対策
* CORS制御
* Secret情報の非公開
* Audit Log

特にAPIから受け取った入力値をSQLへ直接連結してはならない。

---

## 43. CORS

外部WebアプリケーションからAPIを利用する必要がある場合、CORSを適切に設定する。

`*`による無制限のOrigin許可は、本番環境では原則として使用しない。

許可するOrigin、Method、Header、Credentialの扱いを明示的に設定する。

---

## 44. APIの責務境界

| 機能                    | Torifune Core | Plugin | SaaS |
| --------------------- | ----------------: | -----: | ---: |
| REST API基盤            |                 ○ |        |      |
| Public API            |                 ○ |        |      |
| Plugin API            |                 ○ |        |      |
| Data API              |                 ○ |      ○ |      |
| UI API                |                 ○ |      ○ |      |
| Event API             |                 ○ |      ○ |      |
| Authentication API    |                 ○ |      ○ |      |
| Database API          |                 ○ |      ○ |      |
| 外部サービスAPI             |                   |      ○ |      |
| User Management API   |                 ○ |        |    ○ |
| Tenant Management API |                   |        |    ○ |
| SaaS固有API             |                   |        |    ○ |

---

## 45. 設計上の原則

Torifune OSSのAPI設計では、以下を原則とする。

1. REST APIを基本とする
2. API Versionを管理する
3. Public API、Plugin API、Internal APIを区別する
4. Web UIとPluginが可能な限り共通のApplication Layerを利用する
5. PluginからDatabaseへ直接アクセスさせない
6. Data APIをPluginの主要なデータアクセス手段とする
7. AuthenticationとAuthorizationを分離する
8. クライアントから送信されたUser ID、Role、Tenant ID等をそのまま信頼しない
9. API TokenにはScopeを設定できる構造とする
10. API仕様をOpenAPI等で明文化する
11. Plugin APIの後方互換性を重視する
12. SaaS固有のAPIやTenant管理をTorifune OSS Coreへ持ち込まない
13. APIから内部実装や機密情報を露出させない
14. 高権限APIであるAuthentication APIおよびDatabase APIは特に慎重に設計する
