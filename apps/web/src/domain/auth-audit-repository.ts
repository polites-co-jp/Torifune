import type { Connection } from '../database/provider';
import type { AuthAuditEntry } from './auth-audit';

export interface AuthAuditRepository {
  record(connection: Connection, entry: AuthAuditEntry): Promise<void>;
}
