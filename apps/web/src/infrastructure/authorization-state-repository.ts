import type { Connection } from '../database/provider';
import type { AuthorizationState } from '../domain/authorization-state';
import type {
  AuthorizationStateRepository,
  NewAuthorizationState,
} from '../domain/authorization-state-repository';

/**
 * リダイレクト型認証の State の保管（025-redirect-authentication 設計 §6）。
 *
 * `passwordResetRepository` と同じ形にそろえている。
 */
export const authorizationStateRepository: AuthorizationStateRepository = {
  async insert(connection: Connection, state: NewAuthorizationState): Promise<void> {
    await connection.db
      .insertInto('auth_authorization_states')
      .values({
        id: state.id,
        state_hash: state.stateHash,
        nonce: state.nonce,
        provider_id: state.providerId,
        redirect_uri: state.redirectUri,
        return_to: state.returnTo,
        expires_at: state.expiresAt,
      })
      .execute();
  },

  async findByStateHash(
    connection: Connection,
    stateHash: string,
  ): Promise<AuthorizationState | null> {
    const row = await connection.db
      .selectFrom('auth_authorization_states')
      .select(['id', 'nonce', 'provider_id', 'redirect_uri', 'return_to', 'expires_at', 'used_at'])
      .where('state_hash', '=', stateHash)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return {
      id: row.id,
      providerId: row.provider_id,
      nonce: row.nonce,
      redirectUri: row.redirect_uri,
      returnTo: row.return_to,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
    };
  },

  async markUsed(connection: Connection, id: string, at: Date): Promise<boolean> {
    // **未使用のときだけ更新する。** 更新できた行数で「自分が最初か」を判定する。
    // 先に読んでから書くと、同時に来た2本が両方とも「未使用」を読んでしまう。
    const result = await connection.db
      .updateTable('auth_authorization_states')
      .set({ used_at: at })
      .where('id', '=', id)
      .where('used_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0n) > 0;
  },

  async deleteExpired(connection: Connection, before: Date): Promise<void> {
    await connection.db
      .deleteFrom('auth_authorization_states')
      .where('expires_at', '<', before)
      .execute();
  },
};
