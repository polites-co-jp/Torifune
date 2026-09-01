import type { Connection } from '@/database/provider';
import { isRetryable, retryDelayMs, signPayload } from '@/domain/webhook/webhook';
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { log } from '@/infrastructure/logging';
import { webhookRepository } from '@/infrastructure/webhook-repository';

/**
 * 予約された配信を送る（05_API設計.md §39、023-webhook 設計 §3.4）。
 *
 * **発火の場では送らない。** ここは cron から叩かれる想定で、
 * `018-analytics` のロールアップと同じ形にそろえている。
 *
 * SQL は `infrastructure/webhook-repository.ts` に置く
 * （02_データベース設計.md §7）。
 */

/** 受け手が遅いと送信の処理が詰まる。短くして、非同期処理を促す（設計 §3.6）。 */
const TIMEOUT_MS = 10_000;

/** 1回の実行で送る上限。長く回りすぎないようにする。 */
const BATCH_SIZE = 50;

export interface DeliverResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
}

export async function deliverPendingWebhooks(connection: Connection): Promise<DeliverResult> {
  const pending = await webhookRepository.listDue(connection, BATCH_SIZE);

  let delivered = 0;
  let failed = 0;

  for (const row of pending) {
    const attempts = row.attempts + 1;
    const body = JSON.stringify({ event: row.event, data: row.payload });
    const timestamp = Math.floor(Date.now() / 1000);

    const decrypted = decryptSecret(row.encryptedSecret);
    if (!decrypted.ok) {
      // 鍵が変わったなどで復号できない。**再試行しても直らないので諦める。**
      await webhookRepository.markFailed(connection, row.id, attempts, '署名鍵を復号できない');
      failed += 1;
      log.error('webhook secret cannot be decrypted', {
        webhookId: row.webhookId,
        reason: decrypted.reason,
      });
      continue;
    }
    const secret = decrypted.secret.expose();

    try {
      const response = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Torifune-Event': row.event,
          // **再試行でも変わらない。** 受け手はこの ID で二重処理を避ける（設計 §3.5）。
          'X-Torifune-Delivery': row.id,
          'X-Torifune-Timestamp': String(timestamp),
          'X-Torifune-Signature': `sha256=${signPayload(secret, timestamp, body)}`,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });

      if (!response.ok) {
        throw new Error(`受け手が ${response.status} を返した`);
      }

      await webhookRepository.markDelivered(connection, row.id, attempts);
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isRetryable(attempts)) {
        // 落ちている受け手を叩き続けない。
        await webhookRepository.rescheduleAfter(
          connection,
          row.id,
          attempts,
          message,
          retryDelayMs(attempts) / 1000,
        );
      } else {
        await webhookRepository.markFailed(connection, row.id, attempts, message);
        failed += 1;
      }
    }
  }

  log.info('webhook delivery finished', { attempted: pending.length, delivered, failed });

  return { attempted: pending.length, delivered, failed };
}
