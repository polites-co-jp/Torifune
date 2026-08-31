import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { ForbiddenError, UnauthenticatedError } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { sessionRepository } from '@/infrastructure/session-repository';
import { userRepository } from '@/infrastructure/user-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createUser, deleteUser, getUser, listUsers, updateUser } from './user-use-cases';

/**
 * ユーザー管理（015-settings）の結合テスト。
 *
 * **権限昇格と締め出しを起こさないこと**を重点的に確かめる（設計 §8）。
 */

let scratch: ScratchDatabase;

async function insertUser(roleNames: readonly string[]): Promise<UserIdentity> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  const loginId = `u${suffix}`;

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: loginId,
        email: `${loginId}@example.com`,
        display_name: 'user test',
      })
      .execute();

    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) throw new Error(`ロールが無い: ${roleName}`);
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: id, role_id: role.id })
        .execute();
    }
  });

  return {
    userId: id,
    loginId,
    displayName: 'user test',
    email: `${loginId}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const identity = await insertUser(roleNames);
  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function anonymousContext(): Promise<AuthorizationContext> {
  return withConnection(async (connection) => ({
    identity: null,
    permissions: new Set<string>(),
    connection,
  }));
}

const DEFAULT_SORT = [{ field: 'created_at', direction: 'desc' as const }];

function listInput(overrides: Partial<Parameters<typeof listUsers>[1]> = {}) {
  return { page: 1, perPage: 20, status: null, keyword: null, sort: DEFAULT_SORT, ...overrides };
}

function newUserInput(overrides: Partial<Parameters<typeof createUser>[1]> = {}) {
  const suffix = uuidv7().replaceAll('-', '').slice(-10);
  return {
    loginId: `n${suffix}`,
    displayName: '新しい人',
    email: `n${suffix}@example.com`,
    password: 'correct horse battery staple',
    roles: [] as readonly string[],
    request: null,
    ...overrides,
  };
}

async function auditEvents(userId: string): Promise<string[]> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('auth_audit_logs')
      .select(['event'])
      .where('user_id', '=', userId)
      .execute();
    return rows.map((row) => row.event as string);
  });
}

/** そのユーザーの有効なセッションの数。 */
async function liveSessions(userId: string): Promise<number> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('sessions')
      .select(['id'])
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
    return rows.length;
  });
}

async function giveSession(userId: string): Promise<void> {
  await withConnection(async (connection) => {
    await sessionRepository.insert(connection, {
      id: uuidv7(),
      userId,
      tokenHash: uuidv7(),
      expiresAt: new Date(Date.now() + 3_600_000),
      ipAddress: null,
      userAgent: null,
    });
  });
}

let admin: AuthorizationContext;
/** 最後の管理者にならないよう、常にもう1人管理者を置いておく。 */
let spareAdmin: UserIdentity;

beforeAll(async () => {
  scratch = await useScratchDatabase('users');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  spareAdmin = await insertUser(['administrator']);
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('sessions').execute();
  });
});

describe('作成', () => {
  it('ユーザーを作成できる', async () => {
    const created = await createUser(admin, newUserInput());
    expect(created.user.id).toBeTruthy();
    expect(created.roles).toEqual([]);
  });

  it('ログインIDが重複したら 409 相当', async () => {
    const input = newUserInput();
    await createUser(admin, input);
    await expect(createUser(admin, newUserInput({ loginId: input.loginId }))).rejects.toThrow(
      ConflictError,
    );
  });

  it('メールが重複したら 409 相当', async () => {
    const input = newUserInput();
    await createUser(admin, input);
    await expect(createUser(admin, newUserInput({ email: input.email }))).rejects.toThrow(
      ConflictError,
    );
  });

  it('ログインIDの形式が不正なら 422 相当', async () => {
    await expect(createUser(admin, newUserInput({ loginId: 'a b' }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('メールの形式が不正なら 422 相当', async () => {
    await expect(createUser(admin, newUserInput({ email: 'not-an-email' }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('ロールを指定して作成できる', async () => {
    const created = await createUser(admin, newUserInput({ roles: ['editor'] }));
    expect(created.roles).toEqual(['editor']);
  });

  it('**存在しないロール名を指定したら 422 相当**', async () => {
    // クライアントから来たロール名をそのまま割り当てない（04_認証設計.md §28）。
    await expect(createUser(admin, newUserInput({ roles: ['superuser'] }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('user.created が監査ログに残る', async () => {
    const created = await createUser(admin, newUserInput());
    expect(await auditEvents(created.user.id)).toContain('user.created');
  });

  it('**監査ログにパスワードが残らない**', async () => {
    const created = await createUser(admin, newUserInput({ password: 'super-secret-password' }));
    const detail = await withConnection(async (connection) => {
      const rows = await connection.db
        .selectFrom('auth_audit_logs')
        .select(['detail'])
        .where('user_id', '=', created.user.id)
        .execute();
      return JSON.stringify(rows);
    });
    expect(detail).not.toContain('super-secret-password');
  });
});

describe('取得・一覧', () => {
  it('一覧を取得できる', async () => {
    await createUser(admin, newUserInput());
    const page = await listUsers(admin, listInput());
    expect(page.total).toBeGreaterThan(0);
  });

  it('状態で絞り込める', async () => {
    const created = await createUser(admin, newUserInput());
    await updateUser(admin, { id: created.user.id, status: 'disabled', request: null });

    const disabled = await listUsers(admin, listInput({ status: 'disabled' }));
    expect(disabled.items.map((entry) => entry.user.id)).toContain(created.user.id);

    const active = await listUsers(admin, listInput({ status: 'active' }));
    expect(active.items.map((entry) => entry.user.id)).not.toContain(created.user.id);
  });

  it('キーワードで検索できる', async () => {
    const created = await createUser(admin, newUserInput({ displayName: '検索対象の人' }));
    const page = await listUsers(admin, listInput({ keyword: '検索対象' }));
    expect(page.items.map((entry) => entry.user.id)).toContain(created.user.id);
  });

  it('存在しないIDで 404 相当', async () => {
    await expect(getUser(admin, { id: '01900000-0000-7000-8000-0000000000ff' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('**不正な形式のIDでも 404 相当**（500 にしない）', async () => {
    await expect(getUser(admin, { id: 'not-a-uuid' })).rejects.toThrow(NotFoundError);
  });

  it('**返す形にパスワードハッシュが含まれない**', async () => {
    const created = await createUser(admin, newUserInput());
    const fetched = await getUser(admin, { id: created.user.id });
    // Entity にはあるが、API の応答は `toUserResponse` が選ぶ。
    // ここでは「UseCase が Entity を返す」ことを固定し、応答の形は
    // `api-foundation` 側のテストと E2E で確かめる。
    expect(Object.keys(fetched)).toEqual(['user', 'roles']);
  });
});

describe('更新', () => {
  it('表示名とメールを更新できる', async () => {
    const created = await createUser(admin, newUserInput());
    const updated = await updateUser(admin, {
      id: created.user.id,
      displayName: '変えた名前',
      email: `changed-${created.user.loginId}@example.com`,
      request: null,
    });
    expect(updated.user.displayName).toBe('変えた名前');
  });

  it('ロールを付け替えられ、role.changed が残る', async () => {
    const created = await createUser(admin, newUserInput({ roles: ['viewer'] }));
    const updated = await updateUser(admin, {
      id: created.user.id,
      roles: ['editor'],
      request: null,
    });

    expect(updated.roles).toEqual(['editor']);
    expect(await auditEvents(created.user.id)).toContain('role.changed');
  });

  it('パスワードを再設定でき、password.changed が残る', async () => {
    const created = await createUser(admin, newUserInput());
    await updateUser(admin, { id: created.user.id, password: 'a-new-password', request: null });
    expect(await auditEvents(created.user.id)).toContain('password.changed');
  });

  it('**パスワード再設定でセッションが失効する**', async () => {
    const created = await createUser(admin, newUserInput());
    await giveSession(created.user.id);
    expect(await liveSessions(created.user.id)).toBe(1);

    await updateUser(admin, { id: created.user.id, password: 'a-new-password', request: null });
    expect(await liveSessions(created.user.id)).toBe(0);
  });

  it('無効化でき、user.disabled が残る', async () => {
    const created = await createUser(admin, newUserInput());
    const updated = await updateUser(admin, {
      id: created.user.id,
      status: 'disabled',
      request: null,
    });

    expect(updated.user.status).toBe('disabled');
    expect(await auditEvents(created.user.id)).toContain('user.disabled');
  });

  it('**無効化でセッションが失効する**', async () => {
    const created = await createUser(admin, newUserInput());
    await giveSession(created.user.id);

    await updateUser(admin, { id: created.user.id, status: 'disabled', request: null });
    expect(await liveSessions(created.user.id)).toBe(0);
  });

  it('**無効化したユーザーはログインできない状態になる**', async () => {
    const created = await createUser(admin, newUserInput());
    await updateUser(admin, { id: created.user.id, status: 'disabled', request: null });

    const stored = await withConnection((connection) =>
      userRepository.findById(connection, created.user.id),
    );
    expect(stored?.status).toBe('disabled');
  });

  it('**自分自身を無効化できない**', async () => {
    const selfId = admin.identity?.userId ?? '';
    await expect(
      updateUser(admin, { id: selfId, status: 'disabled', request: null }),
    ).rejects.toThrow(ValidationError);
  });

  it('**最後の有効な管理者を無効化できない**', async () => {
    // 自分以外の管理者をすべて無効にして、admin ただ1人が有効な管理者の状態を作る。
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '!=', admin.identity?.userId ?? '')
        .execute();
    });

    // 操作するのは別の管理者。**自分自身かどうかではなく、
    // 「最後の1人か」で止まることを確かめる。**
    const operator = await contextFor(['administrator']);
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', operator.identity?.userId ?? '')
        .execute();
    });

    await expect(
      updateUser(operator, {
        id: admin.identity?.userId ?? '',
        status: 'disabled',
        request: null,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('**最後の有効な管理者から administrator ロールを外せない**', async () => {
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '!=', admin.identity?.userId ?? '')
        .execute();
    });

    const operator = await contextFor(['administrator']);
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', operator.identity?.userId ?? '')
        .execute();
    });

    await expect(
      updateUser(operator, {
        id: admin.identity?.userId ?? '',
        roles: ['viewer'],
        request: null,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('削除', () => {
  it('ユーザーを削除できる', async () => {
    const created = await createUser(admin, newUserInput());
    await deleteUser(admin, { id: created.user.id });

    const stored = await withConnection((connection) =>
      userRepository.findById(connection, created.user.id),
    );
    expect(stored).toBeNull();
  });

  it('**削除でセッションが失効する**', async () => {
    const created = await createUser(admin, newUserInput());
    await giveSession(created.user.id);

    await deleteUser(admin, { id: created.user.id });
    expect(await liveSessions(created.user.id)).toBe(0);
  });

  it('**自分自身を削除できない**', async () => {
    await expect(deleteUser(admin, { id: admin.identity?.userId ?? '' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('存在しないIDの削除で 404 相当', async () => {
    await expect(deleteUser(admin, { id: '01900000-0000-7000-8000-0000000000ff' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('**削除しても監査ログの記録が消えない**', async () => {
    const created = await createUser(admin, newUserInput());
    await deleteUser(admin, { id: created.user.id });

    const remaining = await withConnection(async (connection) => {
      const rows = await connection.db
        .selectFrom('auth_audit_logs')
        .select(['event'])
        .where('event', '=', 'user.created')
        .execute();
      return rows.length;
    });
    expect(remaining).toBeGreaterThan(0);
  });
});

describe('権限', () => {
  it('未認証では UnauthenticatedError', async () => {
    const anonymous = await anonymousContext();
    await expect(listUsers(anonymous, listInput())).rejects.toThrow(UnauthenticatedError);
    await expect(createUser(anonymous, newUserInput())).rejects.toThrow(UnauthenticatedError);
  });

  it('**user.manage を持たないユーザーでは ForbiddenError**', async () => {
    const editor = await contextFor(['editor']);
    await expect(listUsers(editor, listInput())).rejects.toThrow(ForbiddenError);
    await expect(createUser(editor, newUserInput())).rejects.toThrow(ForbiddenError);
    await expect(deleteUser(editor, { id: spareAdmin.userId })).rejects.toThrow(ForbiddenError);
  });
});
