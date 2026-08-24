import type { Connection } from '../database/provider';
import { sanitizeAuditDetail, type AuthAuditEntry } from '../domain/auth-audit';
import type { AuthAuditRepository } from '../domain/auth-audit-repository';

export const authAuditRepository: AuthAuditRepository = {
  async record(connection: Connection, entry: AuthAuditEntry): Promise<void> {
    // 保存の直前で機密キーを落とす。呼び出し側の規律に頼らない。
    const detail = sanitizeAuditDetail(entry.detail);

    await connection.db
      .insertInto('auth_audit_logs')
      .values({
        id: entry.id,
        event: entry.event,
        user_id: entry.userId,
        login_id_attempted: entry.loginIdAttempted,
        ip_address: entry.ipAddress,
        user_agent: entry.userAgent,
        detail: JSON.stringify(detail),
      })
      .execute();
  },
};
