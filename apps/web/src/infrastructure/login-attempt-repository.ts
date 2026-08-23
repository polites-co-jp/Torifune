import type { Connection } from '../database/provider';
import type { LoginAttemptRepository } from '../domain/login-attempt-repository';

export const loginAttemptRepository: LoginAttemptRepository = {
  async record(connection: Connection, id: string, key: string, at: Date): Promise<void> {
    await connection.db.insertInto('login_attempts').values({ id, key, occurred_at: at }).execute();
  },

  async countSince(connection: Connection, key: string, since: Date): Promise<number> {
    const result = await connection.db
      .selectFrom('login_attempts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('key', '=', key)
      .where('occurred_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  },

  async clear(connection: Connection, key: string): Promise<void> {
    await connection.db.deleteFrom('login_attempts').where('key', '=', key).execute();
  },
};
