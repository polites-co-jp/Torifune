import { request as playwrightRequest, type FullConfig } from '@playwright/test';
import { hash } from '@node-rs/argon2';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';

/**
 * E2E の開始状態を作る。
 *
 * 1. 既知の管理者を1人だけ用意する
 * 2. その管理者でログインし、セッションを `storageState` として保存する
 *
 * **テストごとにログインしない。**
 * ログインには Rate Limit が掛かっており（`05_API設計.md` §36）、
 * テストの数だけ叩くと、テストが Rate Limit に当たって落ちる。
 * それは製品の不具合ではなく、テストの設計の問題。
 *
 * また `/setup` は「管理者が0人」を前提にするため、複数のテストファイルが
 * その状態を奪い合うと結果が実行順に依存する。ここで1人作っておく。
 * 「管理者が0人のときの挙動」は結合テスト側で検証する。
 */

export const SEEDED_ADMIN = {
  loginId: 'e2e_admin',
  email: 'e2e_admin@example.com',
  password: 'e2e correct horse battery staple',
} as const;

export const ADMIN_STORAGE_STATE = 'e2e/.auth/admin.json';

async function seedAdministrator(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // 前回の実行の残骸を消す。専用のテストデータベースを使う前提。
    // campaigns を先に消す。sites より後だと、残ったキャンペーンが
    // 次の実行の一覧へ積み上がり、テストが実行回数に依存する。
    await client.query('DELETE FROM webhooks');
    await client.query('DELETE FROM access_logs');
    await client.query('DELETE FROM analytics');
    await client.query('DELETE FROM campaigns');
    await client.query('DELETE FROM sites');
    await client.query('DELETE FROM social_accounts');
    await client.query('DELETE FROM users');
    await client.query('DELETE FROM login_attempts');
    await client.query('DELETE FROM system_settings');
    await client.query('DELETE FROM api_tokens');
    // ダッシュボードの「最近の活動」が実行回数ぶん積み上がらないようにする。
    await client.query('DELETE FROM audit_logs');
    await client.query('DELETE FROM auth_audit_logs');
    // リダイレクト型認証の State。期限切れでも行としては残る。
    await client.query('DELETE FROM auth_authorization_states');
    // 導入済み Plugin。**消さないと2回目以降の導入が 409 になる。**
    // ファイルは `plugins/` に残るので、消えるのは「導入済み」という記録だけ。
    await client.query('DELETE FROM plugin_operations');
    await client.query('DELETE FROM plugin_store');
    await client.query('DELETE FROM plugins');
    // 定期実行の記録（029）。前回の実行の `ok` が残ると「起動から 60 秒以内に ok になる」が空振りで通る。
    await client.query('DELETE FROM job_runs');

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

async function saveLoggedInState(baseURL: string): Promise<void> {
  const context = await playwrightRequest.newContext({ baseURL });

  try {
    const csrfResponse = await context.get('/api/v1/auth/csrf');
    const csrfBody = (await csrfResponse.json()) as { data: { csrfToken: string } };
    const token = csrfBody.data.csrfToken;

    const login = await context.post('/api/v1/auth/login', {
      headers: { 'X-CSRF-Token': token, Origin: baseURL },
      data: {
        loginId: SEEDED_ADMIN.loginId,
        password: SEEDED_ADMIN.password,
        csrfToken: token,
      },
    });

    if (login.status() !== 200) {
      throw new Error(`E2E の初期ログインに失敗した: ${login.status()} ${await login.text()}`);
    }

    mkdirSync(dirname(ADMIN_STORAGE_STATE), { recursive: true });
    await context.storageState({ path: ADMIN_STORAGE_STATE });
  } finally {
    await context.dispose();
  }
}

/**
 * **E2E 用のデータベースであることを確かめる。**
 *
 * この setup は対象データベースの行を**全部消す**。開発用の `.env` を
 * 読んだまま `pnpm test:e2e` を叩くと、開発中のデータが消える。
 * 「気をつける」で防げる種類の事故ではないので、名前で断る。
 *
 * 名前に `test` / `e2e` を含まないデータベースは拒否する。
 * どうしてもその名前で回す必要があるときだけ
 * `TORIFUNE_E2E_ALLOW_ANY_DATABASE=1` を明示する。
 */
function assertTestDatabase(connectionString: string): void {
  if (process.env['TORIFUNE_E2E_ALLOW_ANY_DATABASE'] === '1') {
    return;
  }

  // 末尾のパス部分がデータベース名。解析できない形なら通さない。
  let name: string;
  try {
    name = new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    throw new Error('E2E: DATABASE_URL の形式が読めない。');
  }

  if (!/test|e2e/i.test(name)) {
    throw new Error(
      `E2E はデータベースの中身を全部消す。'${name}' は名前に test / e2e を含まないため中止した。\n` +
        'E2E 専用のデータベースを指すか、意図してその DB を消すなら ' +
        'TORIFUNE_E2E_ALLOW_ANY_DATABASE=1 を付ける。',
    );
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('E2E には DATABASE_URL が必要。');
  }

  assertTestDatabase(connectionString);

  await seedAdministrator(connectionString);

  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:3000';
  await saveLoggedInState(baseURL);
}
