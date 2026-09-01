/**
 * Event API（03_プラグイン設計.md §6）。
 *
 * **Event の Payload は Plugin API のバージョン管理対象**
 * （07_開発者向けガイド.md §23）。項目を減らす・型を変えるのは破壊的変更。
 *
 * **ハンドラの失敗は発火元を巻き込まない。**
 * Plugin の不具合で本体の処理が失敗すると、
 * Plugin を入れた瞬間に機能が壊れる、という壊れ方をする。
 */

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/** Core が発火するイベント。Plugin は自身のイベントも定義できる。 */
export const CORE_EVENTS = [
  'site.created',
  'site.updated',
  'site.deleted',
  'social.account.connected',
  'social.account.disconnected',
  'social.post.created',
  'social.post.published',
  'campaign.created',
  'campaign.updated',
  'campaign.deleted',
  'analytics.rolledUp',
] as const;

export type CoreEventName = (typeof CORE_EVENTS)[number];

/**
 * 日次ロールアップが終わったとき（018-analytics）。
 *
 * **1アクセスごとには発火しない。** アクセスの発生を通知すると、
 * 秒間に何度も呼ばれる口を Plugin へ渡すことになり、
 * 遅い Plugin が計測そのものを詰まらせる。集計が済んだ単位で1回だけ知らせる。
 *
 * 集計値そのものは載せない（量が読めない）。Data API で引き直す。
 */
export interface AnalyticsRollupEventPayload {
  /** 集計した期間（`YYYY-MM-DD`）。 */
  readonly from: string;
  readonly to: string;
  /** 書き込んだ集計値の件数。 */
  readonly points: number;
}

/** キャンペーン（017-campaigns）。 */
export interface CampaignEventPayload {
  readonly campaignId: string;
  readonly name: string;
  readonly status: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  /** 対象の Webサイト。 */
  readonly siteIds: readonly string[];
  /**
   * 紐づくSNS投稿（06_画面設計.md §14）。
   *
   * **任意にしてある。** Plugin も `events.emit` でこのイベントを
   * 発火できるため、必須にすると既存の呼び出しが壊れる。
   * Core が発火するときは常に入っている。
   */
  readonly socialPostIds?: readonly string[];
}

export interface SiteEventPayload {
  readonly siteId: string;
  readonly name: string;
  readonly url: string;
  readonly status: string;
}

export interface SocialAccountEventPayload {
  readonly accountId: string;
  readonly provider: string;
  readonly displayName: string;
}

export interface SocialPostEventPayload {
  readonly postId: string;
  readonly accountId: string;
  readonly status?: string;
}

/**
 * Core のイベント名と Payload の対応。
 *
 * **これがあると、Plugin 側で Payload の型を書き写さずに済む。**
 * 書き写すと、Payload が増えたときに Plugin 側が古い形のまま残る。
 */
export interface CoreEventPayloads {
  readonly 'site.created': SiteEventPayload;
  readonly 'site.updated': SiteEventPayload;
  readonly 'site.deleted': SiteEventPayload;
  readonly 'social.account.connected': SocialAccountEventPayload;
  readonly 'social.account.disconnected': SocialAccountEventPayload;
  readonly 'social.post.created': SocialPostEventPayload;
  readonly 'social.post.published': SocialPostEventPayload;
  readonly 'campaign.created': CampaignEventPayload;
  readonly 'campaign.updated': CampaignEventPayload;
  readonly 'campaign.deleted': CampaignEventPayload;
  readonly 'analytics.rolledUp': AnalyticsRollupEventPayload;
}

export interface PluginEventApi {
  /** Core のイベントを購読する。Payload の型が付く。 */
  subscribe<K extends CoreEventName>(
    eventName: K,
    handler: EventHandler<CoreEventPayloads[K]>,
  ): () => void;
  /** 任意のイベントを購読する。返る関数を呼ぶと解除できる。 */
  subscribe<T = unknown>(eventName: string, handler: EventHandler<T>): () => void;
  /**
   * 自分のイベントを発火する。
   *
   * **イベント名は Plugin ID を接頭辞にする**（`seo.report.generated` 等）。
   * Core のイベント名は発火できない。
   */
  emit(eventName: string, payload: unknown): Promise<void>;
}
