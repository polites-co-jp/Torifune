import type { Connection } from '../database/provider';
import { sanitizeAuditDetail, type AuditEntry } from '../domain/audit';

export interface RecentActivity {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly occurredAt: Date;
  /** 消えたユーザーの操作も残る（audit_logs は ON DELETE SET NULL）。 */
  readonly actorDisplayName: string | null;
}

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

  /** 直近の操作。ダッシュボードの「最近の活動」に使う。 */
  async listRecent(connection: Connection, limit: number): Promise<readonly RecentActivity[]> {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .leftJoin('users', 'users.id', 'audit_logs.actor_user_id')
      .select([
        'audit_logs.id',
        'audit_logs.action',
        'audit_logs.resource_type',
        'audit_logs.occurred_at',
        'users.display_name',
      ])
      .orderBy('audit_logs.occurred_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      resourceType: row.resource_type,
      occurredAt: row.occurred_at,
      actorDisplayName: row.display_name,
    }));
  },
};
