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
] as const;

export type CoreEventName = (typeof CORE_EVENTS)[number];

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

export interface PluginEventApi {
  /** 購読する。返る関数を呼ぶと解除できる。 */
  subscribe<T = unknown>(eventName: string, handler: EventHandler<T>): () => void;
  /**
   * 自分のイベントを発火する。
   *
   * **イベント名は Plugin ID を接頭辞にする**（`seo.report.generated` 等）。
   * Core のイベント名は発火できない。
   */
  emit(eventName: string, payload: unknown): Promise<void>;
}
