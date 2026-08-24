import type { Connection } from '../database/provider';
import type { Session } from '../domain/session';
import type { NewSession, SessionRepository } from '../domain/session-repository';

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  last_accessed_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

const COLUMNS = [
  'id',
  'user_id',
  'created_at',
  'last_accessed_at',
  'expires_at',
  'revoked_at',
] as const;

export const sessionRepository: SessionRepository = {
  async insert(connection: Connection, session: NewSession): Promise<Session> {
    const row = await connection.db
      .insertInto('sessions')
      .values({
        id: session.id,
        user_id: session.userId,
        token_hash: session.tokenHash,
        expires_at: session.expiresAt,
        ip_address: session.ipAddress,
        user_agent: session.userAgent,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return toSession(row as SessionRow);
  },

  async findByTokenHash(connection: Connection, tokenHash: string): Promise<Session | null> {
    const row = await connection.db
      .selectFrom('sessions')
      .select(COLUMNS)
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();
    return row === undefined ? null : toSession(row as SessionRow);
  },

  async touch(connection: Connection, sessionId: string, at: Date): Promise<void> {
    await connection.db
      .updateTable('sessions')
      .set({ last_accessed_at: at })
      .where('id', '=', sessionId)
      .execute();
  },

  async revoke(connection: Connection, sessionId: string, at: Date): Promise<void> {
    await connection.db
      .updateTable('sessions')
      .set({ revoked_at: at })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  },

  async revokeAllForUser(connection: Connection, userId: string, at: Date): Promise<void> {
    await connection.db
      .updateTable('sessions')
      .set({ revoked_at: at })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  },
};
