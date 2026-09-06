# Event リファレンス

Torifune が発火するイベントの一覧（`07_開発者向けガイド.md` §23, §57）。

Plugin は `context.events.on(...)` で購読する。使い方は
[`Plugin開発ガイド.md`](Plugin開発ガイド.md) を参照。

正典は `packages/plugin-api/src/events.ts`。**この文書と食い違ったらコードが正しい。**

## 前提

* **Payload は Plugin API のバージョン管理対象。** 項目を減らす・型を変えるのは
  破壊的変更であり、Migration Guide（`docs/移行手引き/`）が要る。
  **項目を増やすのは破壊的変更ではない。**
* **ハンドラの失敗は発火元を巻き込まない。** Plugin の不具合で本体の処理が
  失敗すると、Plugin を入れた瞬間に機能が壊れる、という壊れ方をする。
* **発火は操作が成功したあと。** 失敗した操作のイベントは飛ばない。
* Plugin は自身のイベントも定義できる。その場合は
  **自分の Plugin ID を先頭に付けた名前**にする（Core のイベント名は騙れない）。

## Core が発火するイベント

| イベント名 | いつ | Payload |
| --- | --- | --- |
| `site.created` | Webサイトを作った | `SiteEventPayload` |
| `site.updated` | Webサイトを更新した | `SiteEventPayload` |
| `site.deleted` | Webサイトを削除した | `SiteEventPayload` |
| `social.account.connected` | SNSアカウントを接続した | `SocialAccountEventPayload` |
| `social.account.disconnected` | SNSアカウントの接続を切った | `SocialAccountEventPayload` |
| `social.post.created` | SNS投稿を作った | `SocialPostEventPayload` |
| `social.post.published` | SNS投稿の配信が完了した | `SocialPostEventPayload` |
| `campaign.created` | キャンペーンを作った | `CampaignEventPayload` |
| `campaign.updated` | キャンペーンを更新した | `CampaignEventPayload` |
| `campaign.deleted` | キャンペーンを削除した | `CampaignEventPayload` |
| `analytics.rolledUp` | アクセスの日次集計が終わった（本体の定期実行、`POST /api/v1/analytics/rollup`、または基準タイムゾーンの変更に伴う洗い替え。洗い替えでは 30 日ごとのチャンクを処理するたびに発火する） | `AnalyticsRollupEventPayload` |
| `analytics.purged` | 基準タイムゾーンの変更に伴う洗い替えで、集計値を消した（**洗い替え 1 回につき 1 度だけ。1 行も消えなければ発火しない**） | `AnalyticsPurgedEventPayload` |

## Payload

```ts
interface SiteEventPayload {
  readonly siteId: string;
  readonly name: string;
  readonly url: string;
  readonly status: string;
}

interface SocialAccountEventPayload {
  readonly accountId: string;
  readonly provider: string;
  readonly displayName: string;
}

interface SocialPostEventPayload {
  readonly postId: string;
  readonly accountId: string;
  readonly status?: string;
}

interface AnalyticsRollupEventPayload {
  /** 集計した期間（`YYYY-MM-DD`）。 */
  readonly from: string;
  readonly to: string;
  /** 書き込んだ集計値の件数。 */
  readonly points: number;
}

/**
 * 基準タイムゾーンの変更に伴う洗い替えで、集計値を消したとき（032-timezone-setting）。
 *
 * **消えたのは「その日に生ログが 1 行も無い (サイト, 日)」の行**で、出所を問わない。
 * 自分の Plugin が `data.analytics.record` で入れた値も含まれる。
 * **本体には取り込み直す手段が無い。** 必要なら Plugin 側で再取得すること。
 *
 * 計測タグを一度も貼っていないサイト（生ログが 1 行も無いサイト）は対象外なので、
 * そのサイトの値は消えず、`sites[]` にも現れない。
 */
interface AnalyticsPurgedEventPayload {
  /** 消す根拠になった、新しい基準タイムゾーン（IANA 名）。 */
  readonly timeZone: string;
  /** 消した集計値の総行数（出所を問わない）。 */
  readonly rows: number;
  /** サイトごとの、消えた範囲。**消えなかったサイトは現れない。** */
  readonly sites: readonly {
    readonly siteId: string;
    /** 消えた `metric_date` の最古・最新。**この範囲の日がすべて消えたとは限らない。** */
    readonly from: string;
    readonly to: string;
    readonly rows: number;
    /** 消えた行の `source`（Core の分は `core`）。**自分の値が消えたかをここで判定できる。** */
    readonly sources: readonly string[];
  }[];
}

interface CampaignEventPayload {
  readonly campaignId: string;
  readonly name: string;
  readonly status: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  /** 対象の Webサイト。 */
  readonly siteIds: readonly string[];
}
```

**Payload に Secret を入れない。** SNSアカウントの Payload に
アクセストークンが無いのはそのため。必要なら Data API から取り直す
（取れないものは、Plugin へ渡さないと決めたもの）。

**Payload に本体の内部構造を入れない。** ID と、それを見て判断するのに要る
最小限だけを載せる。詳細が要るときは Data API で引く。

## Webhook との関係

Core のイベントは Webhook としても外部へ送れる（`05_API設計.md` §39）。
**Plugin が定義したイベントは Webhook にできない。** Core が
「外へ送ってよいものか」を判断できないため。
