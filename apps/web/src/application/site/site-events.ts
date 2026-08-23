import type { Site } from '@/domain/site/site';

/**
 * Webサイトに関するイベント（03_プラグイン設計.md §6）。
 *
 * **ペイロードは Plugin API のバージョン管理対象になる**
 * （07_開発者向けガイド.md §23）。項目を減らす・型を変えるのは破壊的変更。
 * 後から足せる形にしておく。
 */

export const SITE_EVENTS = ['site.created', 'site.updated', 'site.deleted'] as const;
export type SiteEventName = (typeof SITE_EVENTS)[number];

export interface SiteEventPayload {
  readonly siteId: string;
  readonly name: string;
  readonly url: string;
  readonly status: string;
}

export function siteEventPayload(site: Site): SiteEventPayload {
  return { siteId: site.id, name: site.name, url: site.url, status: site.status };
}
