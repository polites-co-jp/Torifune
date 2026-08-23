import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';

/**
 * E2E の開始状態を作る。
 *
 * `/setup` は「管理者が0人」を前提にするため、複数のテストファイルがその状態を
 * 奪い合うと結果が実行順に依存する。ここで**既知の管理者を1人だけ**用意し、
 * E2E は常に「管理者がいる状態」から始める。
 *
 * 「管理者が0人のときの挙動」は結合テスト側で検証する
 * （そちらは DB を自分で制御できる）。
 */

export const SEEDED_ADMIN = {
  loginId: 'e2e_admin',
  email: 'e2e_admin@example.com',
  password: 'e2e correct horse battery staple',
} as const;

export default async function globalSetup(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('E2E には DATABASE_URL が必要。');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // 前回の実行の残骸を消す。専用のテストデータベースを使う前提。
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM login_attempts');

    const id = uuidv7();
    const passwordHash = await hash(SEEDED_ADMIN.password);

    await client.query(
      'INSERT INTO users (id, login_id, email, display_name, password_hash) VALUES ($1, $2, $3, $4, $5)',
      [id, SEEDED_ADMIN.loginId, SEEDED_ADMIN.email, 'E2E Admin', passwordHash],
    );
    await client.query(
      "INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = 'administrator'",
      [id],
    );
  } finally {
    await client.end();
  }
}
