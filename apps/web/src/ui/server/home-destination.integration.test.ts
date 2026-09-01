import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setAuthenticationProvider } from '../../authentication/registry';
import { hashSessionToken } from '../../authentication/session-token';
import { login } from '../../application/auth/login';
import { completeSetup } from '../../application/auth/setup';
import { withConnection } from '../../application/transaction';
import { useScratchDatabase, type ScratchDatabase } from '../../test-support/database';
import { resolveHomeDestination } from './home-destination';

/**
 * トップページの振り分け（016-home-routing）。
 *
 * **専用のデータベースを使う。** 「管理者が0人」の状態を前提にするテストがあり、
 * 他のテストファイルと共有すると実行順に結果が左右される
 * （`auth.integration.test.ts` と同じ理由）。
 */

const request = { ipAddress: '203.0.113.10', userAgent: 'vitest' } as const;

const ADMIN = {
  loginId: 'home_admin',
  displayName: 'Home Admin',
  email: 'home_admin@example.com',
  password: 'correct horse battery staple',
} as const;

let scratch: ScratchDatabase;

/** 管理者を1人作る。ロールを付けるため `completeSetup` を通す。 */
async function seedAdministrator(): Promise<void> {
  const outcome = await completeSetup({ ...ADMIN, request });
  if (!outcome.ok) {
    throw new Error(`管理者の作成に失敗した: ${outcome.reason}`);
  }
}

/** 実際にログインして、有効なセッショントークンを得る。 */
async function issueSessionToken(): Promise<string> {
  const outcome = await login({ loginId: ADMIN.loginId, password: ADMIN.password, request });
  if (!outcome.ok) {
    throw new Error(`ログインに失敗した: ${outcome.reason}`);
  }
  return outcome.sessionToken;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('homedestination');
});

afterAll(async () => {
  setAuthenticationProvider(null);
  await scratch.dispose();
});

afterEach(async () => {
  // 各テストが「管理者が0人」から始められるようにする。
  // sessions は users への外部キーで CASCADE 削除される。
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('users').execute();
    await connection.db.deleteFrom('login_attempts').execute();
  });
});

describe('resolveHomeDestination', () => {
  it('管理者が0人のとき /setup へ送る', async () => {
    await expect(resolveHomeDestination(undefined, request)).resolves.toBe('/setup');
  });

  it('管理者が0人であれば、有効なセッションがあっても /setup へ送る', async () => {
    // **セッションより先にセットアップを判定する**ことの確認（設計 §4）。
    // 管理者を作ってログインし、セッションを持ったまま管理者を消す。
    await seedAdministrator();
    const sessionToken = await issueSessionToken();

    await withConnection(async (connection) => {
      await connection.db.deleteFrom('user_roles').execute();
    });

    await expect(resolveHomeDestination(sessionToken, request)).resolves.toBe('/setup');
  });

  it('管理者がいてセッションが無いとき /login へ送る', async () => {
    await seedAdministrator();

    await expect(resolveHomeDestination(undefined, request)).resolves.toBe('/login');
  });

  it('セッショントークンが不正なとき /login へ送る', async () => {
    await seedAdministrator();

    await expect(resolveHomeDestination('not-a-real-token', request)).resolves.toBe('/login');
  });

  it('セッションが期限切れのとき /login へ送る', async () => {
    await seedAdministrator();
    const sessionToken = await issueSessionToken();

    await withConnection(async (connection) => {
      await connection.db
        .updateTable('sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('token_hash', '=', hashSessionToken(sessionToken))
        .execute();
    });

    await expect(resolveHomeDestination(sessionToken, request)).resolves.toBe('/login');
  });

  it('ログイン済みのとき /dashboard へ送る', async () => {
    await seedAdministrator();
    const sessionToken = await issueSessionToken();

    await expect(resolveHomeDestination(sessionToken, request)).resolves.toBe('/dashboard');
  });
});
