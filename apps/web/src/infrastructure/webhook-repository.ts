import { sql } from 'kysely';
import type { Connection } from '../database/provider';
import type { Webhook, WebhookStatus } from '../domain/webhook/webhook';

/**
 * Webhook の保存（05_API設計.md §39、023-webhook）。
 *
 * **Application 層から SQL を追い出すために切り出した。**
 * `02_データベース設計.md` §7 は、Application / Domain から直接 SQL を実行せず
 * Repository を通すことを求めている。Webhook はこの層が丸ごと欠けており、
 * UseCase がテーブル名とカラム名へ直結していた。
 */

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  status: string;
  created_at: Date;
}

function toWebhook(row: WebhookRow): Webhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    status: row.status as WebhookStatus,
    createdAt: row.created_at,
  };
}

/** 一覧・取得で返す列。**`secret` を入れない。** 型に載らなければ、うっかり返せない。 */
const PUBLIC_COLUMNS = ['id', 'name', 'url', 'events', 'status', 'created_at'] as const;

export interface NewWebhook {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** 暗号化済み。平文を渡さない（02_データベース設計.md §13）。 */
  readonly encryptedSecret: string;
  readonly events: readonly string[];
}

/** 配信待ちの1件。送信に要るものだけを持つ。 */
export interface PendingDelivery {
  readonly id: string;
  readonly webhookId: string;
  readonly event: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly url: string;
  /** 暗号化されたまま。復号は呼び出し側で行う。 */
  readonly encryptedSecret: string;
}

export const webhookRepository = {
  async list(connection: Connection): Promise<readonly Webhook[]> {
    const rows = await connection.db
      .selectFrom('webhooks')
      .select(PUBLIC_COLUMNS)
      .orderBy('created_at', 'desc')
      .execute();

    return rows.map((row) => toWebhook(row as WebhookRow));
  },

  async create(connection: Connection, input: NewWebhook): Promise<Webhook> {
    const row = await connection.db
      .insertInto('webhooks')
      .values({
        id: input.id,
        name: input.name,
        url: input.url,
        secret: input.encryptedSecret,
        events: [...input.events],
      })
      .returning(PUBLIC_COLUMNS)
      .executeTakeFirstOrThrow();

    return toWebhook(row as WebhookRow);
  },

  /** 消せた件数を返す。0 なら存在しなかった。 */
  async delete(connection: Connection, id: string): Promise<number> {
    const result = await connection.db
      .deleteFrom('webhooks')
      .where('id', '=', id)
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  },

  /** そのイベントを購読している、動いている Webhook の ID。 */
  async idsSubscribedTo(connection: Connection, eventName: string): Promise<readonly string[]> {
    const rows = await connection.db
      .selectFrom('webhooks')
      .select(['id', 'events'])
      .where('status', '=', 'active')
      .execute();

    return rows.filter((row) => (row.events as string[]).includes(eventName)).map((row) => row.id);
  },

  async enqueueDeliveries(
    connection: Connection,
    entries: readonly {
      readonly id: string;
      readonly webhookId: string;
      readonly event: string;
      readonly payload: unknown;
    }[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    await connection.db
      .insertInto('webhook_deliveries')
      .values(
        entries.map((entry) => ({
          id: entry.id,
          webhook_id: entry.webhookId,
          event: entry.event,
          payload: JSON.stringify(entry.payload ?? {}),
        })),
      )
      .execute();
  },

  /**
   * 送る時刻になっている配信を取る。
   *
   * **DB の時計で比べる。** 既定値も再試行の予約も DB の `now()` で入るため、
   * アプリ側の時計と突き合わせると、わずかなずれで「まだ送らない」になる。
   */
  async listDue(connection: Connection, limit: number): Promise<readonly PendingDelivery[]> {
    const rows = await connection.db
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
      .where(sql<boolean>`webhook_deliveries.next_attempt_at <= now()`)
      // 送り先が止められていれば送らない。
      .where('webhooks.status', '=', 'active')
      .orderBy('webhook_deliveries.next_attempt_at', 'asc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      webhookId: row.webhook_id,
      event: row.event,
      payload: row.payload as Record<string, unknown>,
      attempts: row.attempts,
      url: row.url,
      encryptedSecret: row.secret,
    }));
  },

  async markDelivered(connection: Connection, deliveryId: string, attempts: number): Promise<void> {
    await connection.db
      .updateTable('webhook_deliveries')
      .set({ status: 'delivered', attempts, delivered_at: new Date(), last_error: null })
      .where('id', '=', deliveryId)
      .execute();
  },

  async markFailed(
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
  },

  /** 次に試す時刻を先へずらす。**DB の時計で計算する**（`listDue` と揃える）。 */
  async rescheduleAfter(
    connection: Connection,
    deliveryId: string,
    attempts: number,
    message: string,
    delaySeconds: number,
  ): Promise<void> {
    await connection.db
      .updateTable('webhook_deliveries')
      .set({
        attempts,
        last_error: message,
        next_attempt_at: sql`now() + make_interval(secs => ${delaySeconds})` as unknown as Date,
      })
      .where('id', '=', deliveryId)
      .execute();
  },
};
