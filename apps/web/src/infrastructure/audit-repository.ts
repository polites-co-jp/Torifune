import type { Connection } from '../database/provider';
import { sanitizeAuditDetail, type AuditEntry } from '../domain/audit';

/**
 * 一般API操作の監査ログの保存（05_API設計.md §42）。
 *
 * 保存の直前で機密キーを落とす。呼び出し側の規律に頼らない
 * （`auth-audit-repository.ts` と同じ方針）。
 */
export const auditRepository = {
  async record(connection: Connection, entry: AuditEntry): Promise<void> {
    const detail = sanitizeAuditDetail(entry.detail);

    await connection.db
      .insertInto('audit_logs')
      .values({
        id: entry.id,
        actor_user_id: entry.actorUserId,
        action: entry.action,
        resource_type: entry.resourceType,
        resource_id: entry.resourceId,
        ip_address: entry.ipAddress,
        user_agent: entry.userAgent,
        detail: JSON.stringify(detail),
      })
      .execute();
  },
};
