import { createHash, randomBytes } from 'node:crypto';

/**
 * アクセスの生ログ（02_データベース設計.md §5.8、018-analytics）。
 *
 * **Domain 層。** DB 製品も HTTP も知らない。
 *
 * 設計の要点は「個人を特定しうる値を保存しない」こと（設計 §3.2）。
 */

export const DEVICE_KINDS = ['desktop', 'mobile', 'tablet', 'bot'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface AccessLog {
  readonly id: string;
  readonly siteId: string;
  readonly occurredAt: Date;
  readonly path: string;
  readonly referrerHost: string | null;
  readonly visitorHash: string;
  readonly device: DeviceKind;
}

/** サイトを識別する公開キー。推測できない長さにする。 */
export function generateSitePublicKey(): string {
  return randomBytes(16).toString('hex');
}

/** 訪問者ハッシュの長さ。総当たりで元を割り出せない程度に短くする。 */
const VISITOR_HASH_LENGTH = 32;

/**
 * 訪問者ハッシュを作る。
 *
 * **ソルトを日ごとに変える。** 変えないとハッシュが恒久的な識別子になり、
 * 日をまたいで同じ人を追跡できてしまう。
 * 日をまたぐと同じ訪問者を数えられなくなるが、
 * **追跡できないことのほうが重要**（設計 §3.2）。
 */
export function visitorHash(input: {
  readonly dailySalt: string;
  readonly siteId: string;
  readonly ipAddress: string;
  readonly userAgent: string;
}): string {
  return createHash('sha256')
    .update(`${input.dailySalt}:${input.siteId}:${input.ipAddress}:${input.userAgent}`, 'utf8')
    .digest('hex')
    .slice(0, VISITOR_HASH_LENGTH);
}

/**
 * 保存するパスを正規化する。
 *
 * **クエリ文字列とフラグメントを落とす。** トークンや個人情報が URL に
 * 入ることがある。長すぎるパスも切る。
 */
export const PATH_MAX_LENGTH = 500;

export function normalizePath(raw: string): string | null {
  const withoutQuery = raw.split(/[?#]/)[0] ?? '';
  const trimmed = withoutQuery.trim();

  if (trimmed === '') {
    return null;
  }
  // 絶対URLを渡されても、パスだけを取り出す。
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).pathname.slice(0, PATH_MAX_LENGTH);
    } catch {
      return null;
    }
  }
  if (!trimmed.startsWith('/')) {
    return null;
  }
  return trimmed.slice(0, PATH_MAX_LENGTH);
}

/**
 * リファラから**ホストだけ**を取り出す。
 *
 * パスまで持つと、他サイト上で何を見ていたかが残る。
 */
export function referrerHostOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.hostname === '' ? null : url.hostname.slice(0, 255);
  } catch {
    return null;
  }
}

/**
 * User-Agent からデバイス種別を推定する。
 *
 * **完璧を目指さない。** 分類の精度より、Bot を集計から外せることが要る。
 */
const BOT_PATTERN =
  /bot|crawler|spider|crawling|slurp|facebookexternalhit|preview|monitor|curl|wget|python-requests|headless/i;
const TABLET_PATTERN = /ipad|tablet|playbook|silk|android(?!.*mobile)/i;
const MOBILE_PATTERN = /mobile|iphone|ipod|android|blackberry|windows phone/i;

export function deviceKindOf(userAgent: string | null | undefined): DeviceKind {
  const ua = userAgent ?? '';
  if (ua.trim() === '' || BOT_PATTERN.test(ua)) {
    // User-Agent が無いものは Bot として扱う。通常のブラウザは必ず送る。
    return 'bot';
  }
  if (TABLET_PATTERN.test(ua)) {
    return 'tablet';
  }
  if (MOBILE_PATTERN.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
}

/** 集計に含めるか。Bot は記録するが数えない。 */
export function countsTowardMetrics(device: DeviceKind): boolean {
  return device !== 'bot';
}
