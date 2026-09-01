import { CORE_EVENTS } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { defineUseCase } from '@/application/authorization/use-case';
import { withConnection } from '@/application/transaction';
import { ValidationError, NotFoundError } from '@/domain/repository';
import {
  generateWebhookSecret,
  isValidWebhookName,
  isValidWebhookUrl,
  WEBHOOK_NAME_MAX_LENGTH,
  type Webhook,
} from '@/domain/webhook/webhook';
import { encryptSecret } from '@/infrastructure/crypto/cipher';
import { log } from '@/infrastructure/logging';
import { webhookRepository } from '@/infrastructure/webhook-repository';

/**
 * Webhook の管理（05_API設計.md §39）。
 *
 * **`system.manage` を要求する。** 外部へデータを送る設定であり、
 * 誰にでも配ってよい操作ではない。
 *
 * SQL は `infrastructure/webhook-repository.ts` に置く
 * （02_データベース設計.md §7）。
 */

const CORE_EVENT_NAMES = new Set<string>(CORE_EVENTS);

export const listWebhooks = defineUseCase<Record<string, never>, readonly Webhook[]>({
  name: 'webhook.list',
  permission: 'system.manage',
  handler: async (context) => webhookRepository.list(context.connection),
});

export interface CreateWebhookInput {
  readonly name: string;
  readonly url: string;
  readonly events: readonly string[];
}

export interface CreatedWebhook {
  readonly webhook: Webhook;
  /** **発行時に一度だけ返す平文。** 保存していないので二度と取り出せない。 */
  readonly secret: string;
}

export const createWebhook = defineUseCase<CreateWebhookInput, CreatedWebhook>({
  name: 'webhook.create',
  permission: 'system.manage',
  audit: {
    action: 'created',
    resourceType: 'webhook',
    resourceId: (_input, created) => created.webhook.id,
    // URL は残す。どこへ送る設定を足したのかが監査の要点。
    detail: (input) => ({ url: input.url, events: [...input.events] }),
  },
  handler: async (context, input) => {
    if (!isValidWebhookName(input.name)) {
      throw new ValidationError(
        'Webhook',
        'name',
        `名前を入力してください（${WEBHOOK_NAME_MAX_LENGTH}文字以内）。`,
      );
    }
    if (!isValidWebhookUrl(input.url)) {
      throw new ValidationError(
        'Webhook',
        'url',
        'https:// の URL を入力してください（資格情報は含められません）。',
      );
    }
    for (const event of input.events) {
      // **Plugin のイベントは中継しない**（設計 §3.1）。
      // 名前も中身も Plugin 次第で、Core が「外へ送ってよい」と判断できない。
      if (!CORE_EVENT_NAMES.has(event)) {
        throw new ValidationError('Webhook', 'events', `送れないイベントです: ${event}`);
      }
    }

    const secret = generateWebhookSecret();

    const webhook = await context.connection.transaction((tx) =>
      webhookRepository.create(tx, {
        id: uuidv7(),
        name: input.name.trim(),
        url: input.url,
        // 平文で保存しない（02_データベース設計.md §13）。
        encryptedSecret: encryptSecret(secret),
        events: input.events,
      }),
    );

    return { webhook, secret };
  },
});

export const deleteWebhook = defineUseCase<{ id: string }, void>({
  name: 'webhook.delete',
  permission: 'system.manage',
  audit: { action: 'deleted', resourceType: 'webhook', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const deleted = await context.connection.transaction((tx) =>
      webhookRepository.delete(tx, input.id),
    );

    if (deleted === 0) {
      throw new NotFoundError('Webhook', input.id);
    }
  },
});

/**
 * イベントが起きたら配信を**予約する**（設計 §3.4）。
 *
 * **ここで送らない。** 受け手が落ちていると、Torifune の操作そのものが
 * 遅くなる／失敗する。
 *
 * 予約に失敗しても操作は止めない。Webhook は付随的な機能であり、
 * それで本体の操作を落とす理由が無い。
 */
export async function enqueueWebhookDeliveries(eventName: string, payload: unknown): Promise<void> {
  if (!CORE_EVENT_NAMES.has(eventName)) {
    return;
  }

  try {
    await withConnection(async (connection) => {
      const ids = await webhookRepository.idsSubscribedTo(connection, eventName);

      await webhookRepository.enqueueDeliveries(
        connection,
        ids.map((webhookId) => ({ id: uuidv7(), webhookId, event: eventName, payload })),
      );
    });
  } catch (error) {
    log.error('failed to enqueue webhook deliveries', {
      event: eventName,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
