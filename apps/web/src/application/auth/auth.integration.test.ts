import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../authentication/password';
import { hashSessionToken } from '../../authentication/session-token';
import type { Connection } from '../../database/provider';
import { setAuthenticationProvider } from '../../authentication/registry';
import { useScratchDatabase, type ScratchDatabase } from '../../test-support/database';
import { setNotifier, type Notification } from '../notification';
import { withConnection } from '../transaction';
import { getCurrentUser } from './current-user';
import { login } from './login';
import { logout } from './logout';
import {
  confirmPasswordReset,
  requestPasswordReset,
  RESET_TOKEN_LIFETIME_MS,
} from './password-reset';
import { completeSetup, isSetupOpen } from './setup';

const request = { ipAddress: '203.0.113.10', userAgent: 'vitest' } as const;

let scratch: ScratchDatabase;
const createdUserIds: string[] = [];
const sentNotifications: Notification[] = [];

/** テストごとに一意な資格情報を作る。 */
function credentials(): { loginId: string; email: string; password: string } {
  const suffix = uuidv7().replaceAll('-', '').slice(-12);
  return {
    loginId: `u${suffix}`,
    email: `u${suffix}@example.com`,
    password: 'correct horse battery staple',
  };
}

async function createUser(options?: { status?: 'active' | 'disabled' }): Promise<{
  id: string;
  loginId: string;
  email: string;
  password: string;
}> {
  const c = credentials();
  const id = uuidv7();
  const passwordHash = await hashPassword(c.password);

  await withConnection(async (connection: Connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: c.loginId,
        email: c.email,
        display_name: c.loginId,
        password_hash: passwordHash,
        status: options?.status ?? 'active',
      })
      .execute();
  });

  createdUserIds.push(id);
  return { id, ...c };
}

async function countAuditEvents(userId: string, event: string): Promise<number> {
  return withConnection(async (connection) => {
    const result = await connection.db
      .selectFrom('auth_audit_logs')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('user_id', '=', userId)
      .where('event', '=', event)
      .executeTakeFirstOrThrow();
    return Number(result.count);
  });
}

beforeAll(async () => {
  // このファイル専用のデータベースを使う。初回セットアップは「管理者が0人」を
  // 前提にするため、他のテストファイルと共有できない。
  scratch = await useScratchDatabase('auth');
  setNotifier({
    async send(notification) {
      sentNotifications.push(notification);
    },
  });
});

afterAll(async () => {
  setAuthenticationProvider(null);
  await scratch.dispose();
});

afterEach(async () => {
  sentNotifications.length = 0;
  if (createdUserIds.length > 0) {
    await withConnection(async (connection) => {
      await connection.db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
      await connection.db.deleteFrom('login_attempts').execute();
    });
    createdUserIds.length = 0;
  }
});

describe('login', () => {
  it('正しい資格情報でログインできる', async () => {
    const user = await createUser();

    const outcome = await login({ loginId: user.loginId, password: user.password, request });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.user.id).toBe(user.id);
      expect(outcome.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('レスポンスに passwordHash が含まれない', async () => {
    const user = await createUser();

    const outcome = await login({ loginId: user.loginId, password: user.password, request });

    expect(outcome.ok && JSON.stringify(outcome.user)).not.toContain('argon2');
    expect(outcome.ok && Object.keys(outcome.user).sort()).toEqual([
      'displayName',
      'email',
      'id',
      'loginId',
    ]);
  });

  it('DB にはトークンのハッシュだけが保存される', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    const rows = await withConnection((connection) =>
      connection.db
        .selectFrom('sessions')
        .select('token_hash')
        .where('user_id', '=', user.id)
        .execute(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashSessionToken(outcome.sessionToken));
    expect(rows[0]?.token_hash).not.toBe(outcome.sessionToken);
  });

  it('ログインのたびに異なるセッション識別子が発行される', async () => {
    const user = await createUser();

    const first = await login({ loginId: user.loginId, password: user.password, request });
    const second = await login({ loginId: user.loginId, password: user.password, request });

    expect(first.ok && second.ok && first.sessionToken).not.toBe(
      second.ok ? second.sessionToken : '',
    );
  });

  it('誤ったパスワードでは失敗する', async () => {
    const user = await createUser();

    const outcome = await login({ loginId: user.loginId, password: 'wrong', request });

    expect(outcome).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('存在しないログインIDでは失敗する', async () => {
    const outcome = await login({ loginId: 'nobody-here-at-all', password: 'x', request });

    expect(outcome).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('誤ったパスワードと存在しないIDで、結果が完全に同じである', async () => {
    const user = await createUser();

    const wrongPassword = await login({ loginId: user.loginId, password: 'wrong', request });
    const noSuchUser = await login({ loginId: 'nobody-here-at-all', password: 'wrong', request });

    expect(wrongPassword).toEqual(noSuchUser);
  });

  it('無効化されたユーザーはログインできない', async () => {
    const user = await createUser({ status: 'disabled' });

    const outcome = await login({ loginId: user.loginId, password: user.password, request });

    expect(outcome).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('ログイン成功で last_login_at が更新される', async () => {
    const user = await createUser();

    await login({ loginId: user.loginId, password: user.password, request });

    const row = await withConnection((connection) =>
      connection.db
        .selectFrom('users')
        .select('last_login_at')
        .where('id', '=', user.id)
        .executeTakeFirst(),
    );
    expect(row?.last_login_at).not.toBeNull();
  });

  it('大文字小文字を区別せずログインできる', async () => {
    const user = await createUser();

    const outcome = await login({
      loginId: user.loginId.toUpperCase(),
      password: user.password,
      request,
    });

    expect(outcome.ok).toBe(true);
  });
});

describe('ログイン試行制限', () => {
  it('同一アカウントへ規定回数失敗すると弾かれる', async () => {
    const user = await createUser();

    for (let i = 0; i < 10; i += 1) {
      await login({ loginId: user.loginId, password: 'wrong', request });
    }

    const outcome = await login({ loginId: user.loginId, password: 'wrong', request });
    expect(outcome).toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('弾かれている間は正しいパスワードでも通らない', async () => {
    const user = await createUser();

    for (let i = 0; i < 10; i += 1) {
      await login({ loginId: user.loginId, password: 'wrong', request });
    }

    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    expect(outcome).toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('ログイン成功でそのアカウントの失敗記録が消える', async () => {
    const user = await createUser();

    for (let i = 0; i < 5; i += 1) {
      await login({ loginId: user.loginId, password: 'wrong', request });
    }
    await login({ loginId: user.loginId, password: user.password, request });

    const remaining = await withConnection(async (connection) => {
      const result = await connection.db
        .selectFrom('login_attempts')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('key', '=', `login:${user.loginId.toLowerCase()}`)
        .executeTakeFirstOrThrow();
      return Number(result.count);
    });

    expect(remaining).toBe(0);
  });

  it('成功しても IP 側の失敗記録は消えない', async () => {
    const user = await createUser();

    for (let i = 0; i < 3; i += 1) {
      await login({ loginId: user.loginId, password: 'wrong', request });
    }
    await login({ loginId: user.loginId, password: user.password, request });

    const remaining = await withConnection(async (connection) => {
      const result = await connection.db
        .selectFrom('login_attempts')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('key', '=', `ip:${request.ipAddress}`)
        .executeTakeFirstOrThrow();
      return Number(result.count);
    });

    expect(remaining).toBe(3);
  });
});

describe('getCurrentUser', () => {
  it('有効なトークンでユーザーを返す', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    const identity = await getCurrentUser(outcome.sessionToken, request);

    expect(identity?.userId).toBe(user.id);
    expect(identity?.providerId).toBe('local');
  });

  it('トークンが無ければ null', async () => {
    await expect(getCurrentUser(undefined, request)).resolves.toBeNull();
  });

  it('存在しないトークンでは null', async () => {
    await expect(getCurrentUser('not-a-real-token', request)).resolves.toBeNull();
  });

  it('期限切れのセッションでは null', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    await withConnection((connection) =>
      connection.db
        .updateTable('sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('user_id', '=', user.id)
        .execute(),
    );

    await expect(getCurrentUser(outcome.sessionToken, request)).resolves.toBeNull();
  });

  it('失効させたセッションでは null', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    await withConnection((connection) =>
      connection.db
        .updateTable('sessions')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', user.id)
        .execute(),
    );

    await expect(getCurrentUser(outcome.sessionToken, request)).resolves.toBeNull();
  });

  it('ユーザーを無効化すると、既存セッションでも null になる', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    await withConnection((connection) =>
      connection.db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', user.id)
        .execute(),
    );

    await expect(getCurrentUser(outcome.sessionToken, request)).resolves.toBeNull();
  });
});

describe('logout', () => {
  it('ログアウト後、同じトークンでは認証されない', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    await logout(outcome.sessionToken, request);

    await expect(getCurrentUser(outcome.sessionToken, request)).resolves.toBeNull();
  });

  it('サーバー側のセッションが失効する', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');

    await logout(outcome.sessionToken, request);

    const row = await withConnection((connection) =>
      connection.db
        .selectFrom('sessions')
        .select('revoked_at')
        .where('user_id', '=', user.id)
        .executeTakeFirst(),
    );
    expect(row?.revoked_at).not.toBeNull();
  });

  it('存在しないトークンでも例外を投げない', async () => {
    await expect(logout('not-a-real-token', request)).resolves.toBeUndefined();
  });
});

describe('監査ログ', () => {
  it('ログイン成功が記録される', async () => {
    const user = await createUser();
    await login({ loginId: user.loginId, password: user.password, request });

    await expect(countAuditEvents(user.id, 'login.succeeded')).resolves.toBe(1);
  });

  it('ログイン失敗が記録される', async () => {
    const user = await createUser();
    await login({ loginId: user.loginId, password: 'wrong', request });

    await expect(countAuditEvents(user.id, 'login.failed')).resolves.toBe(1);
  });

  it('存在しないIDへの試行も記録される', async () => {
    await login({ loginId: 'ghost-account', password: 'wrong', request });

    const count = await withConnection(async (connection) => {
      const result = await connection.db
        .selectFrom('auth_audit_logs')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('login_id_attempted', '=', 'ghost-account')
        .executeTakeFirstOrThrow();
      return Number(result.count);
    });

    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('ログアウトが記録される', async () => {
    const user = await createUser();
    const outcome = await login({ loginId: user.loginId, password: user.password, request });
    if (!outcome.ok) throw new Error('ログインに失敗した');
    await logout(outcome.sessionToken, request);

    await expect(countAuditEvents(user.id, 'logout')).resolves.toBe(1);
  });

  it('監査ログにパスワードやトークンが記録されない', async () => {
    const user = await createUser();
    await login({ loginId: user.loginId, password: user.password, request });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('auth_audit_logs').select('detail').execute(),
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(user.password);
    expect(serialized).not.toContain('argon2');
  });
});

describe('初回セットアップ', () => {
  /**
   * 管理者を1人作る。各テストは自分で作る（テスト間の実行順に依存させない）。
   * afterEach で消えるため、テストの外へ影響しない。
   */
  async function createAdministrator(): Promise<string> {
    const c = credentials();
    const outcome = await completeSetup({ ...c, displayName: 'Admin', request });
    if (!outcome.ok) {
      throw new Error(`管理者を作れなかった: ${outcome.reason}`);
    }
    createdUserIds.push(outcome.userId);
    return outcome.userId;
  }

  it('管理者が0人のときは開いている', async () => {
    await expect(isSetupOpen()).resolves.toBe(true);
  });

  it('管理者を作ると閉じる', async () => {
    await createAdministrator();

    await expect(isSetupOpen()).resolves.toBe(false);
  });

  it('作られたユーザーが administrator ロールを持つ', async () => {
    const userId = await createAdministrator();

    const roles = await withConnection((connection) =>
      connection.db
        .selectFrom('user_roles')
        .innerJoin('roles', 'roles.id', 'user_roles.role_id')
        .select('roles.name')
        .where('user_roles.user_id', '=', userId)
        .execute(),
    );

    expect(roles.map((r) => r.name)).toEqual(['administrator']);
  });

  it('作成したあと、そのままログインできる', async () => {
    const c = credentials();
    const outcome = await completeSetup({ ...c, displayName: 'Admin', request });
    if (!outcome.ok) throw new Error('セットアップに失敗した');
    createdUserIds.push(outcome.userId);

    await expect(
      login({ loginId: c.loginId, password: c.password, request }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('管理者がいる状態でのセットアップは closed になる', async () => {
    await createAdministrator();

    const c = credentials();
    const outcome = await completeSetup({ ...c, displayName: 'Another', request });

    expect(outcome).toEqual({ ok: false, reason: 'closed' });
  });

  it('同時に叩いても管理者は1人しか作られない', async () => {
    const inputs = Array.from({ length: 5 }, () => credentials());

    const outcomes = await Promise.all(
      inputs.map((c) => completeSetup({ ...c, displayName: 'Race', request })),
    );

    for (const outcome of outcomes) {
      if (outcome.ok) createdUserIds.push(outcome.userId);
    }

    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
  });

  it('形式が不正なログインIDを拒否する', async () => {
    const outcome = await completeSetup({
      loginId: 'a',
      displayName: 'x',
      email: 'a@example.com',
      password: 'password123',
      request,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('形式が不正なメールアドレスを拒否する', async () => {
    const outcome = await completeSetup({
      loginId: 'validuser',
      displayName: 'x',
      email: 'not-an-email',
      password: 'password123',
      request,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('パスワードリセット', () => {
  it('DB にはトークンのハッシュだけが保存される', async () => {
    const user = await createUser();

    await requestPasswordReset({ email: user.email, request });

    const token = sentNotifications[0]?.secret;
    expect(token).toBeTypeOf('string');

    const rows = await withConnection((connection) =>
      connection.db
        .selectFrom('password_reset_tokens')
        .select('token_hash')
        .where('user_id', '=', user.id)
        .execute(),
    );

    expect(rows[0]?.token_hash).toBe(hashSessionToken(token as string));
    expect(rows[0]?.token_hash).not.toBe(token);
  });

  it('未登録のアドレスでも例外を投げず、通知も送らない', async () => {
    await expect(
      requestPasswordReset({ email: 'nobody@example.com', request }),
    ).resolves.toBeUndefined();
    expect(sentNotifications).toHaveLength(0);
  });

  it('有効なトークンでパスワードを再設定できる', async () => {
    const user = await createUser();
    await requestPasswordReset({ email: user.email, request });
    const token = sentNotifications[0]?.secret as string;

    const outcome = await confirmPasswordReset({
      token,
      newPassword: 'a brand new passphrase',
      request,
    });

    expect(outcome).toEqual({ ok: true });
    await expect(
      login({ loginId: user.loginId, password: 'a brand new passphrase', request }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('一度使ったトークンは再利用できない', async () => {
    const user = await createUser();
    await requestPasswordReset({ email: user.email, request });
    const token = sentNotifications[0]?.secret as string;

    await confirmPasswordReset({ token, newPassword: 'first new password', request });
    const second = await confirmPasswordReset({
      token,
      newPassword: 'second new password',
      request,
    });

    expect(second).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('期限切れのトークンは使えない', async () => {
    const user = await createUser();
    await requestPasswordReset({ email: user.email, request });
    const token = sentNotifications[0]?.secret as string;

    await withConnection((connection) =>
      connection.db
        .updateTable('password_reset_tokens')
        .set({ expires_at: new Date(Date.now() - RESET_TOKEN_LIFETIME_MS) })
        .where('user_id', '=', user.id)
        .execute(),
    );

    const outcome = await confirmPasswordReset({ token, newPassword: 'whatever', request });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('存在しないトークンでは失敗する', async () => {
    const outcome = await confirmPasswordReset({
      token: 'not-a-real-token',
      newPassword: 'whatever',
      request,
    });
    expect(outcome).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('再設定後、既存のセッションがすべて失効する', async () => {
    const user = await createUser();
    const first = await login({ loginId: user.loginId, password: user.password, request });
    if (!first.ok) throw new Error('ログインに失敗した');

    await requestPasswordReset({ email: user.email, request });
    const token = sentNotifications[0]?.secret as string;
    await confirmPasswordReset({ token, newPassword: 'a brand new passphrase', request });

    await expect(getCurrentUser(first.sessionToken, request)).resolves.toBeNull();
  });

  it('通知にトークンが data として渡らない（ログに出さないため）', async () => {
    const user = await createUser();

    await requestPasswordReset({ email: user.email, request });

    expect(JSON.stringify(sentNotifications[0]?.data)).not.toContain(
      sentNotifications[0]?.secret ?? 'x',
    );
  });
});
