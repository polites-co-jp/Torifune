import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Webhook（05_API設計.md §39）。
 *
 * **Domain 層。** HTTP も DB も知らない。
 * 設計は docs/設計/023-webhook/設計.md。
 */

export const WEBHOOK_STATUSES = ['active', 'paused'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface Webhook {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly status: WebhookStatus;
  readonly createdAt: Date;
}

export const WEBHOOK_NAME_MAX_LENGTH = 100;

export function isValidWebhookName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= WEBHOOK_NAME_MAX_LENGTH;
}

/**
 * 送信先として受け付けるか。
 *
 * **HTTPS に限る**（localhost を除く）。平文で送ると、署名があっても中身は読まれる。
 *
 * 内部ネットワークへの送信は止めない。自己ホストで社内の受け手へ送るのは
 * 正当な用途で、それを塞ぐと使えない（設計 §3.7）。
 */
export function isValidWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') {
    // URL に資格情報を書かせない。保存すると一覧やログに載る。
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** Secret。受け手が署名を検証するために使う。 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * 署名を作る。
 *
 * **対象は `<timestamp>.<body>`。** 本文だけに署名すると、
 * 古い正当な配信をそのまま送りつけられる（リプレイ）。
 *
 * 受け手は timestamp が現在から離れすぎていないことを確かめる。
 * **その確認は受け手の責任**であり、送る側は材料を渡すだけ（設計 §3.2）。
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/**
 * 署名を検証する（受け手の実装例であり、本体では使わない）。
 *
 * **時間差のない比較を使う。** 文字列比較だと、一致した先頭の長さから
 * 正しい署名を1文字ずつ探れる。
 */
export function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, body), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/** 再試行の上限。超えたら諦める。 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * 次に試すまでの待ち時間（ミリ秒）。
 *
 * 指数的に空ける。**落ちている受け手を叩き続けない。**
 * 1分 → 2分 → 4分 → 8分。
 */
export function retryDelayMs(attempts: number): number {
  return 60_000 * 2 ** Math.max(0, attempts - 1);
}

export function isRetryable(attempts: number): boolean {
  return attempts < MAX_DELIVERY_ATTEMPTS;
}
