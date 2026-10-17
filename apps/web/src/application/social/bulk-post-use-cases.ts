import { uuidv7 } from 'uuidv7';
import { defineUseCase } from '@/application/authorization/use-case';
import {
  approveSocialPost,
  deleteSocialPost,
  logBulkItemFailure,
  publishSocialPostNow,
} from '@/application/social/social-use-cases';
import { NotFoundError, ValidationError } from '@/domain/repository';
import {
  BULK_BUDGET_MS,
  BULK_INTERNAL_ERROR_MESSAGE,
  BULK_NOT_FOUND_MESSAGE,
  BULK_TIMEOUT_MESSAGE,
  PUBLISH_NOW_STALE_MESSAGE,
  type BulkEffect,
  type BulkFailureReason,
  type BulkItemResult,
} from '@/domain/social/bulk';
import {
  ApprovalScheduleError,
  POST_STATE_CHANGED_MESSAGE,
  SocialPostIneligibleError,
  SocialPostStateChangedError,
  STALE_POST_MESSAGE,
  StaleSocialPostError,
  type SocialPost,
} from '@/domain/social/social';

/**
 * SNS 投稿の一括操作（054-bulk-post-actions 設計 §5.2・§8.1・§8.1.1・§8.2・§8.3・§8.4）。
 *
 * **項目ごとに既存の 1 件の UseCase を呼ぶだけ。** 区画・権限・条件付き更新・監査・イベントは項目の UseCase が持ち、
 * ここでは二重に書かない。Repository も `infrastructure/` も触らない（受け入れ条件 #56）。
 *
 * 項目は要求の並びの順に 1 件ずつ処理し（並列にしない）、項目の例外は設計 §8.1.1 の表で結果に写す。
 * 1 件の失敗で残りを止めない（全部か無しか、にしない）。
 *
 * 時間の予算（設計 §8.6）：土台が始めた時刻を覚え、**各項目を始める前に**予算を過ぎていないかを見る。過ぎていれば
 * 残りの項目は処理せず `timeout` にする。始めた項目は最後まで処理する。
 */

/** 一括の操作の入力に共通の項目。 */
interface BulkBudgetInput {
  /** 時間の予算（ミリ秒）。テスト用の差し替え口で、ルートは渡さない。省略すると `BULK_BUDGET_MS`。 */
  readonly budgetMs?: number;
}

/** 一括の操作の出力。`results` は要求の並びと同じ順・同じ数。 */
export interface BulkOutput {
  /** 要求ごとの ID。各項目の監査の `detail.bulkId` と同じ値。 */
  readonly bulkId: string;
  readonly results: readonly BulkItemResult[];
}

/** 一括の項目（承認・今すぐ送る）。`expectedUpdatedAt` は画面が読んだ投稿の `updatedAt`。 */
export interface BulkPostItem {
  readonly id: string;
  readonly expectedUpdatedAt: Date;
}

/** 項目を 1 件処理した成功の結果。 */
interface ItemSuccess {
  readonly effect: BulkEffect;
  readonly post: SocialPost | null;
}

function failure(
  id: string,
  reason: BulkFailureReason,
  message: string,
  field: string | null = null,
): BulkItemResult {
  return { id, ok: false, reason, message, field };
}

/**
 * 操作ごとに差し替える文言。省略すると 1 件の操作の 409 の文言（実装プラン §8 の 7）。
 *
 * 今すぐ送るには 1 件の操作が無いので、承認の文言（「承認し直して」）を使わず `stale` を自分の文言にする。
 */
interface FailureMessages {
  readonly stale?: string;
}

/**
 * 項目の UseCase が投げた例外を結果に写す（設計 §8.1.1 の表。並びは判定の順）。
 *
 * `SocialPostIneligibleError` / `ApprovalScheduleError` は `ValidationError` の派生なので、一般の
 * `ValidationError` より先に見る。想定外の例外は原因をログに残し、応答には既定の文言だけを返す。
 */
function toFailure(
  operation: string,
  id: string,
  error: unknown,
  messages: FailureMessages,
): BulkItemResult {
  if (error instanceof NotFoundError) {
    return failure(id, 'not_found', BULK_NOT_FOUND_MESSAGE);
  }
  if (error instanceof SocialPostIneligibleError) {
    return failure(id, error.reason, error.detail);
  }
  if (error instanceof ApprovalScheduleError) {
    switch (error.reason) {
      case 'missing':
        return failure(id, 'no_desired_time', error.detail, error.field);
      case 'past':
        return failure(id, 'desired_time_passed', error.detail, error.field);
      case 'out_of_range':
        return failure(id, 'validation', error.detail, error.field);
    }
  }
  if (error instanceof StaleSocialPostError) {
    return failure(id, 'stale', messages.stale ?? STALE_POST_MESSAGE);
  }
  if (error instanceof SocialPostStateChangedError) {
    return failure(id, 'stale', messages.stale ?? POST_STATE_CHANGED_MESSAGE);
  }
  if (error instanceof ValidationError) {
    // 承認待ちでない・予約でない など、状態の誤りは「対象外」。
    if (error.field === 'status') {
      return failure(id, 'not_applicable', error.detail);
    }
    return failure(id, 'validation', error.detail, error.field);
  }
  logBulkItemFailure(operation, id, error);
  return failure(id, 'internal_error', BULK_INTERNAL_ERROR_MESSAGE);
}

/**
 * 項目を要求の並びの順に 1 件ずつ処理する（設計 §5.2）。
 *
 * `bulkId` は要求ごとに作り、項目の UseCase に渡して監査の `detail.bulkId` に残させる。
 * 各項目を始める前に `budgetMs` を過ぎていれば、その項目から後ろは処理せず `timeout` にする（設計 §8.6）。
 */
async function processItems<TItem extends { readonly id: string }>(
  operation: string,
  items: readonly TItem[],
  budgetMs: number,
  process: (item: TItem, bulkId: string) => Promise<ItemSuccess>,
  messages: FailureMessages = {},
): Promise<BulkOutput> {
  const bulkId = uuidv7();
  const beganAt = Date.now();
  const results: BulkItemResult[] = [];
  for (const item of items) {
    if (Date.now() - beganAt > budgetMs) {
      results.push(failure(item.id, 'timeout', BULK_TIMEOUT_MESSAGE));
      continue;
    }
    try {
      const success = await process(item, bulkId);
      results.push({ id: item.id, ok: true, effect: success.effect, post: success.post });
    } catch (error) {
      results.push(toFailure(operation, item.id, error, messages));
    }
  }
  return { bulkId, results };
}

export interface BulkApproveInput extends BulkBudgetInput {
  /** `now`＝即投稿、`scheduled`＝それぞれの登録された希望日時（日時の指定し直しは取らない。ユーザー裁定 2）。 */
  readonly publishTiming: 'now' | 'scheduled';
  readonly items: readonly BulkPostItem[];
}

/**
 * 一括承認（設計 §8.2）。項目ごとに `approveSocialPost` を呼ぶ。
 *
 * 監査は項目ごとに `approveSocialPost` が残す（この UseCase 自身は残さない）。
 */
export const bulkApproveSocialPosts = defineUseCase<BulkApproveInput, BulkOutput>({
  name: 'social.post.bulkApprove',
  permission: 'social.approve',
  handler: async (context, input) =>
    processItems(
      'bulkApprove',
      input.items,
      input.budgetMs ?? BULK_BUDGET_MS,
      async (item, bulkId) => {
        const output = await approveSocialPost(context, {
          id: item.id,
          publishTiming: input.publishTiming,
          expectedUpdatedAt: item.expectedUpdatedAt,
          bulkId,
        });
        const effect: BulkEffect =
          output.effectiveTiming === 'scheduled'
            ? 'approved_scheduled'
            : output.approvalForced
              ? 'approved_forced_now'
              : 'approved_now';
        return { effect, post: output.post };
      },
    ),
});

export interface BulkPublishNowInput extends BulkBudgetInput {
  readonly items: readonly BulkPostItem[];
}

/**
 * 今すぐ送る（設計 §8.3）。項目ごとに `publishSocialPostNow` を呼ぶ。
 *
 * 手動投稿は Torifune が自動で送れないので、「いま手動投稿待ちに並べる」になる（`manual_pending`。設計 §5.4）。
 * 監査は項目ごとに `publishSocialPostNow` が残す。
 */
export const bulkPublishSocialPostsNow = defineUseCase<BulkPublishNowInput, BulkOutput>({
  name: 'social.post.bulkPublishNow',
  permission: 'social.write',
  handler: async (context, input) =>
    processItems(
      'bulkPublishNow',
      input.items,
      input.budgetMs ?? BULK_BUDGET_MS,
      async (item, bulkId) => {
        const output = await publishSocialPostNow(context, {
          id: item.id,
          expectedUpdatedAt: item.expectedUpdatedAt,
          bulkId,
        });
        const effect: BulkEffect =
          output.post.deliveryMode === 'manual' ? 'manual_pending' : 'queued';
        return { effect, post: output.post };
      },
      { stale: PUBLISH_NOW_STALE_MESSAGE },
    ),
});

export interface BulkDeleteInput extends BulkBudgetInput {
  readonly ids: readonly string[];
}

/**
 * 一括取り消し（設計 §5.5・§8.4）。項目ごとに条件付きの `deleteSocialPost` を呼ぶ。
 *
 * 消せるのは出す前の投稿（下書き・承認待ち・配信中でない予約）だけ。監査は項目ごとに `deleteSocialPost` が残す。
 */
export const bulkDeleteSocialPosts = defineUseCase<BulkDeleteInput, BulkOutput>({
  name: 'social.post.bulkDelete',
  permission: 'social.delete',
  handler: async (context, input) =>
    processItems(
      'bulkDelete',
      input.ids.map((id) => ({ id })),
      input.budgetMs ?? BULK_BUDGET_MS,
      async (item, bulkId) => {
        await deleteSocialPost(context, { id: item.id, guard: { bulkId } });
        return { effect: 'deleted', post: null };
      },
    ),
});
