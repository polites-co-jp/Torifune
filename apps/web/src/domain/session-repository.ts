import type { Connection } from '../database/provider';
import type { Session } from './session';

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface SessionRepository {
  insert(connection: Connection, session: NewSession): Promise<Session>;
  findByTokenHash(connection: Connection, tokenHash: string): Promise<Session | null>;
  touch(connection: Connection, sessionId: string, at: Date): Promise<void>;
  revoke(connection: Connection, sessionId: string, at: Date): Promise<void>;
  /** そのユーザーの有効なセッションをすべて失効させる。 */
  revokeAllForUser(connection: Connection, userId: string, at: Date): Promise<void>;
}
