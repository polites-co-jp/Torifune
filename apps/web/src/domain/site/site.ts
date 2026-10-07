/**
 * Torifune が管理する Webサイト。
 *
 * **Domain 層。** DB 製品も HTTP も知らない。
 */

export const SITE_STATUSES = ['active', 'paused', 'archived'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export interface Site {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly status: SiteStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdBy: string | null;
}

export const SITE_NAME_MAX_LENGTH = 200;

export function isValidSiteName(value: string): boolean {
  return value.trim() !== '' && value.length <= SITE_NAME_MAX_LENGTH;
}

/**
 * URL として受け付けるか。
 *
 * `http` / `https` に限る。`javascript:` や `data:` を通すと、
 * 一覧のリンクから任意のスクリプトを実行させられる。
 */
export function isValidSiteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  // URL に認証情報を書かせない。保存すると、一覧やログに資格情報が載る。
  if (url.username !== '' || url.password !== '') {
    return false;
  }
  return url.hostname !== '';
}

export function isSiteStatus(value: string): value is SiteStatus {
  return (SITE_STATUSES as readonly string[]).includes(value);
}

/** 一覧の既定で `archived` を隠す。「もう使わないが記録は残す」状態のため。 */
export const DEFAULT_LISTED_STATUSES: readonly SiteStatus[] = ['active', 'paused'];

/**
 * 投稿の登録の直前に、登録元のトークンが使えなくなっていた（053-site-scoped-social 設計 §8.3.1）。
 *
 * 挿入のトランザクションの中で読んだトークンの行が失効している、またはサイトのトークンでサイトが消えている
 * （`site_scoped` で `site_id` が NULL）。要求の始めには使えたトークンがサイトの削除と同時に進んだ窓を閉じる。
 * API はトークンが使えなくなったのと同じく 401 `UNAUTHENTICATED` に写す（理由は返さない）。
 */
export class SiteGoneError extends Error {
  constructor(readonly tokenId: string) {
    super('登録元のトークンが使えなくなっています');
    this.name = 'SiteGoneError';
  }
}
