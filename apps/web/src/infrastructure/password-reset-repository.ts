import type { Connection } from '../database/provider';
import type {
  NewPasswordResetToken,
  PasswordResetRepository,
  PasswordResetToken,
} from '../domain/password-reset-repository';

export const passwordResetRepository: PasswordResetRepository = {
  async insert(connection: Connection, token: NewPasswordResetToken): Promise<void> {
    await connection.db
      .insertInto('password_reset_tokens')
      .values({
        id: token.id,
        user_id: token.userId,
        token_hash: token.tokenHash,
        expires_at: token.expiresAt,
      })
      .execute();
  },

  async findByTokenHash(
    connection: Connection,
    tokenHash: string,
  ): Promise<PasswordResetToken | null> {
    const row = await connection.db
      .selectFrom('password_reset_tokens')
      .select(['id', 'user_id', 'expires_at', 'used_at'])
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }
    return { id: row.id, userId: row.user_id, expiresAt: row.expires_at, usedAt: row.used_at };
  },

  async markUsed(connection: Connection, id: string, at: Date): Promise<void> {
    await connection.db
      .updateTable('password_reset_tokens')
      .set({ used_at: at })
      .where('id', '=', id)
      .where('used_at', 'is', null)
      .execute();
  },
};
