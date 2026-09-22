import { uuidv7 } from 'uuidv7';
import type { Connection } from '../database/provider';
import type { AuditAction, AuditResourceType } from '../domain/audit';
import { log } from '../infrastructure/logging';
import { auditRepository } from '../infrastructure/audit-repository';
import type { AuthorizationContext } from './authorization/authorize';

/**
 * 一般API操作の監査ログを残す（05_API設計.md §42）。
 *
 * **`defineUseCase` の `audit` から自動で呼ばれる。** 各 UseCase が自分で呼ぶ形にすると、
 * 新しい UseCase を足したときに書き忘れる。認可と同じ理由で、構造的に忘れられなくする。
 */

export interface AuditInput {
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  readonly resourceId: string | null;
  readonly detail?: Record<string, unknown>;
}

/**
 * 記録する。
 *
 * **失敗しても呼び出し元へ例外を投げない。**
 * 記録は操作のあと（同じトランザクションの外）で行うため、ここで失敗を投げると
 * 「操作は成功したのに 500 が返る」ことになり、クライアントに嘘をつく。
 * 落ちたことは error ログに残す。
 *
 * 記録と操作を原子的にするには、各 UseCase のトランザクション内で呼ぶ必要がある。
 * それは「書き忘れられる」形であり、こちらの危険のほうが大きいと判断した
 * （docs/設計/022-hardening/設計.md §3.1）。
 */
export async function recordAudit(context: AuthorizationContext, input: AuditInput): Promise<void> {
  try {
    await auditRepository.record(context.connection, {
      id: uuidv7(),
      actorUserId: context.identity?.userId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ipAddress: context.request?.ipAddress ?? null,
      userAgent: context.request?.userAgent ?? null,
      detail: input.detail ?? {},
    });
  } catch (error) {
    log.error('failed to record audit log', {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 本体の処理として記録する（035-social-publishing 設計 §6.5.8）。
 *
 * 配信ジョブのように `AuthorizationContext` を持たない経路で使う。
 * **操作者も要求元も無い**ので `actor_user_id` / `ip_address` / `user_agent` は NULL。
 *
 * `recordAudit` と同じく**失敗しても呼び出し元へ例外を投げない**。
 * 記録できないことと、処理を続けられないことは別。
 */
export async function recordSystemAudit(connection: Connection, input: AuditInput): Promise<void> {
  try {
    await auditRepository.record(connection, {
      id: uuidv7(),
      actorUserId: null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ipAddress: null,
      userAgent: null,
      detail: input.detail ?? {},
    });
  } catch (error) {
    log.error('failed to record audit log', {
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
