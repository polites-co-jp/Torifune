import { sql } from 'kysely';
import type { Connection } from '@/database/provider';
import { isRetryable, retryDelayMs, signPayload } from '@/domain/webhook/webhook';
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { log } from '@/infrastructure/logging';

/**
 * 予約された配信を送る（05_API設計.md §39、023-webhook 設計 §3.4）。
 *
 * **発火の場では送らない。** ここは cron から叩かれる想定で、
 * `018-analytics` のロールアップと同じ形にそろえている。
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

interface PendingRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  secret: string;
}

export async function deliverPendingWebhooks(connection: Connection): Promise<DeliverResult> {
  const rows = (await connection.db
    .selectFrom('webhook_deliveries')
    .innerJoin('webhooks', 'webhooks.id', 'webhook_deliveries.webhook_id')
    .select([
      'webhook_deliveries.id',
      'webhook_deliveries.webhook_id',
      'webhook_deliveries.event',
      'webhook_deliveries.payload',
      'webhook_deliveries.attempts',
      'webhooks.url',
      'webhooks.secret',
    ])
    .where('webhook_deliveries.status', '=', 'pending')
    // **DB の時計で比べる。** 既定値も再試行の予約も DB の now() で入るため、
    // アプリ側の時計と突き合わせると、わずかなずれで「まだ送らない」になる。
    .where(sql<boolean>`webhook_deliveries.next_attempt_at <= now()`)
    // 送り先が止められていれば送らない。
    .where('webhooks.status', '=', 'active')
    .orderBy('webhook_deliveries.next_attempt_at', 'asc')
    .limit(BATCH_SIZE)
    .execute()) as unknown as PendingRow[];

  let delivered = 0;
  let failed = 0;

  for (const row of rows) {
    const attempts = row.attempts + 1;
    const body = JSON.stringify({ event: row.event, data: row.payload });
    const timestamp = Math.floor(Date.now() / 1000);

    const decrypted = decryptSecret(row.secret);
    if (!decrypted.ok) {
      // 鍵が変わったなどで復号できない。**再試行しても直らないので諦める。**
      await markFailed(connection, row.id, attempts, '署名鍵を復号できない');
      failed += 1;
      log.error('webhook secret cannot be decrypted', {
        webhookId: row.webhook_id,
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

      await connection.db
        .updateTable('webhook_deliveries')
        .set({ status: 'delivered', attempts, delivered_at: new Date(), last_error: null })
        .where('id', '=', row.id)
        .execute();
      delivered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (isRetryable(attempts)) {
        await connection.db
          .updateTable('webhook_deliveries')
          .set({
            attempts,
            last_error: message,
            // 落ちている受け手を叩き続けない。DB の時計で先へずらす。
            next_attempt_at: sql`now() + make_interval(secs => ${
              retryDelayMs(attempts) / 1000
            })` as unknown as Date,
          })
          .where('id', '=', row.id)
          .execute();
      } else {
        await markFailed(connection, row.id, attempts, message);
        failed += 1;
      }
    }
  }

  log.info('webhook delivery finished', { attempted: rows.length, delivered, failed });

  return { attempted: rows.length, delivered, failed };
}

async function markFailed(
  connection: Connection,
  deliveryId: string,
  attempts: number,
  message: string,
): Promise<void> {
  await connection.db
    .updateTable('webhook_deliveries')
    .set({ status: 'failed', attempts, last_error: message })
    .where('id', '=', deliveryId)
    .execute();
}
