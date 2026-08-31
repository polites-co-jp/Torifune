import { uuidv7 } from 'uuidv7';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import { withTransaction } from '@/application/transaction';
import { hashPassword } from '@/authentication/password';
import type { Connection } from '@/database/provider';
import { authAuditRepository } from '@/infrastructure/auth-audit-repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { sessionRepository } from '@/infrastructure/session-repository';
import { userRepository } from '@/infrastructure/user-repository';
import { ConflictError, NotFoundError, ValidationError } from '@/domain/repository';
import { isValidEmail, isValidLoginId, type User, type UserStatus } from '@/domain/user';
import type { UserPage } from '@/domain/user-repository';
import type { RequestInfo } from '@/application/auth/context';

/**
 * ユーザー管理の UseCase（015-settings）。
 *
 * **この機能は権限昇格の入口になりうる**（`04_認証設計.md` §28）。
 * 設計 §8 の不変条件をすべてここに置く。API Layer にも画面にも置かない。
 * 画面と API の両方から同じ判定を通す必要があるため（決定事項 D-06）。
 */

const ADMINISTRATOR_ROLE = 'administrator';

/** ユーザーとそのロール。画面と API が必要とする形。 */
export interface UserWithRoles {
  readonly user: User;
  readonly roles: readonly string[];
}

export interface UserWithRolesPage {
  readonly items: readonly UserWithRoles[];
  readonly total: number;
}

async function withRoles(connection: Connection, user: User): Promise<UserWithRoles> {
  const roles = await roleRepository.rolesOf(connection, user.id);
  return { user, roles: roles.map((role) => role.name) };
}

/**
 * 「最後の有効な管理者」を失う操作を止める。
 *
 * **判定と更新を同じトランザクションで行う。** 分けると、2つの要求が
 * 同時に来たときに管理者が0人になり、誰も復旧できなくなる。
 * 行ロックは `countActiveByRoleForUpdate` が取る。
 */
async function assertNotLastAdministrator(
  tx: Connection,
  targetUserId: string,
  what: string,
): Promise<void> {
  const roles = await roleRepository.rolesOf(tx, targetUserId);
  if (!roles.some((role) => role.name === ADMINISTRATOR_ROLE)) {
    return;
  }

  const admins = await userRepository.countActiveByRoleForUpdate(tx, ADMINISTRATOR_ROLE);
  if (admins <= 1) {
    throw new ValidationError('User', 'id', `最後の管理者は${what}できません。`);
  }
}

/** 自分自身への操作を止める。締め出しと、権限を失って復旧できなくなる事故を防ぐ。 */
function assertNotSelf(actorUserId: string, targetUserId: string, what: string): void {
  if (actorUserId === targetUserId) {
    throw new ValidationError('User', 'id', `自分自身を${what}することはできません。`);
  }
}

/** 指定されたロール名がすべて実在することを確かめる。 */
async function assertRolesExist(tx: Connection, names: readonly string[]): Promise<void> {
  if (names.length === 0) {
    return;
  }
  const known = new Set((await roleRepository.list(tx)).map((role) => role.name));
  for (const name of names) {
    if (!known.has(name)) {
      throw new ValidationError('User', 'roles', `不明なロールです: ${name}`);
    }
  }
}

async function record(
  tx: Connection,
  event: 'user.created' | 'user.disabled' | 'password.changed' | 'role.changed',
  input: { actorUserId: string; targetUserId: string; request: RequestInfo | null },
  detail: Record<string, unknown> = {},
): Promise<void> {
  await authAuditRepository.record(tx, {
    id: uuidv7(),
    event,
    // 「誰がやったか」ではなく「誰に起きたか」を主体にする。
    // 実行者は detail に残す。ユーザーが消えても記録は残る（ON DELETE SET NULL）。
    userId: input.targetUserId,
    loginIdAttempted: null,
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
    // **パスワードを入れない。** sanitizeAuditDetail が機械的に落とすが、渡さない。
    detail: { ...detail, actorUserId: input.actorUserId },
  });
}

// ---------------------------------------------------------------------------
// 一覧・取得
// ---------------------------------------------------------------------------

export interface ListUsersInput {
  readonly page: number;
  readonly perPage: number;
  readonly status: UserStatus | null;
  readonly keyword: string | null;
  readonly sort: readonly { field: string; direction: 'asc' | 'desc' }[];
}

export const listUsers = defineUseCase<ListUsersInput, UserWithRolesPage>({
  name: 'user.list',
  permission: 'user.manage',
  handler: async (context, input) => {
    const page: UserPage = await userRepository.list(context.connection, {
      page: input.page,
      perPage: input.perPage,
      status: input.status,
      keyword: input.keyword,
      sort: input.sort,
    });

    const items = await Promise.all(page.items.map((user) => withRoles(context.connection, user)));
    return { items, total: page.total };
  },
});

export const getUser = defineUseCase<{ id: string }, UserWithRoles>({
  name: 'user.get',
  permission: 'user.manage',
  handler: async (context, input) => {
    const user = await userRepository.findById(context.connection, input.id);
    if (user === null) {
      throw new NotFoundError('User', input.id);
    }
    return withRoles(context.connection, user);
  },
});

// ---------------------------------------------------------------------------
// 作成
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  readonly loginId: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly roles: readonly string[];
  readonly request: RequestInfo | null;
}

export const createUser = defineUseCase<CreateUserInput, UserWithRoles>({
  name: 'user.create',
  permission: 'user.manage',
  handler: async (context, input) => {
    const actor = requireAuthenticated(context);

    if (!isValidLoginId(input.loginId)) {
      throw new ValidationError('User', 'loginId', 'ログインIDの形式が正しくありません。');
    }
    if (!isValidEmail(input.email)) {
      throw new ValidationError('User', 'email', 'メールアドレスの形式が正しくありません。');
    }
    if (input.displayName.trim() === '') {
      throw new ValidationError('User', 'displayName', '表示名を入力してください。');
    }

    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch {
      throw new ValidationError('User', 'password', 'パスワードを確認してください。');
    }

    return withTransaction(async (tx) => {
      await assertRolesExist(tx, input.roles);

      if (await userRepository.findByLoginId(tx, input.loginId)) {
        throw new ConflictError('User', 'loginId');
      }
      if (await userRepository.findByEmail(tx, input.email)) {
        throw new ConflictError('User', 'email');
      }

      const user = await userRepository.insert(tx, {
        id: uuidv7(),
        loginId: input.loginId,
        email: input.email,
        displayName: input.displayName,
        passwordHash,
      });

      for (const role of input.roles) {
        await userRepository.assignRole(tx, user.id, role);
      }

      await record(
        tx,
        'user.created',
        { actorUserId: actor.userId, targetUserId: user.id, request: input.request },
        { loginId: user.loginId, roles: [...input.roles] },
      );

      return withRoles(tx, user);
    });
  },
});

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

export interface UpdateUserInput {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly status?: UserStatus | undefined;
  /** 空文字や undefined なら変えない。 */
  readonly password?: string | undefined;
  /** undefined なら変えない。配列を渡すと、その内容へ置き換える。 */
  readonly roles?: readonly string[] | undefined;
  readonly request: RequestInfo | null;
}

export const updateUser = defineUseCase<UpdateUserInput, UserWithRoles>({
  name: 'user.update',
  permission: 'user.manage',
  handler: async (context, input) => {
    const actor = requireAuthenticated(context);

    if (input.email !== undefined && !isValidEmail(input.email)) {
      throw new ValidationError('User', 'email', 'メールアドレスの形式が正しくありません。');
    }
    if (input.displayName !== undefined && input.displayName.trim() === '') {
      throw new ValidationError('User', 'displayName', '表示名を入力してください。');
    }

    const disabling = input.status === 'disabled';
    const changingPassword = input.password !== undefined && input.password !== '';

    let passwordHash: string | null = null;
    if (changingPassword) {
      try {
        passwordHash = await hashPassword(input.password as string);
      } catch {
        throw new ValidationError('User', 'password', 'パスワードを確認してください。');
      }
    }

    return withTransaction(async (tx) => {
      const current = await userRepository.findById(tx, input.id);
      if (current === null) {
        throw new NotFoundError('User', input.id);
      }

      if (input.roles !== undefined) {
        await assertRolesExist(tx, input.roles);
      }

      if (disabling && current.status !== 'disabled') {
        assertNotSelf(actor.userId, input.id, '無効化');
        await assertNotLastAdministrator(tx, input.id, '無効化');
      }

      // ロールの差し替えで administrator を失う場合も止める。
      if (input.roles !== undefined && !input.roles.includes(ADMINISTRATOR_ROLE)) {
        await assertNotLastAdministrator(tx, input.id, 'ロールの変更を');
      }

      if (input.email !== undefined && input.email !== current.email) {
        const duplicate = await userRepository.findByEmail(tx, input.email);
        if (duplicate !== null && duplicate.id !== current.id) {
          throw new ConflictError('User', 'email');
        }
      }

      const updated = await userRepository.update(tx, input.id, {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      if (updated === null) {
        throw new NotFoundError('User', input.id);
      }

      if (passwordHash !== null) {
        await userRepository.updatePasswordHash(tx, input.id, passwordHash);
      }

      let rolesChanged = false;
      if (input.roles !== undefined) {
        const before = (await roleRepository.rolesOf(tx, input.id)).map((role) => role.name);
        const after = new Set(input.roles);

        for (const name of before) {
          if (!after.has(name)) {
            await userRepository.removeRole(tx, input.id, name);
            rolesChanged = true;
          }
        }
        for (const name of after) {
          if (!before.includes(name)) {
            await userRepository.assignRole(tx, input.id, name);
            rolesChanged = true;
          }
        }
      }

      // **状態・パスワード・権限が変わったらセッションを切る。**
      // 切らないと、無効化しても開いている画面が動き続ける。
      if (disabling || passwordHash !== null || rolesChanged) {
        await sessionRepository.revokeAllForUser(tx, input.id, new Date());
      }

      const audit = { actorUserId: actor.userId, targetUserId: input.id, request: input.request };
      if (disabling && current.status !== 'disabled') {
        await record(tx, 'user.disabled', audit);
      }
      if (passwordHash !== null) {
        await record(tx, 'password.changed', audit);
      }
      if (rolesChanged) {
        await record(tx, 'role.changed', audit, { roles: [...(input.roles ?? [])] });
      }

      return withRoles(tx, updated);
    });
  },
});

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

export const deleteUser = defineUseCase<{ id: string }, void>({
  name: 'user.delete',
  permission: 'user.manage',
  handler: async (context, input) => {
    const actor = requireAuthenticated(context);
    assertNotSelf(actor.userId, input.id, '削除');

    await withTransaction(async (tx) => {
      const current = await userRepository.findById(tx, input.id);
      if (current === null) {
        throw new NotFoundError('User', input.id);
      }

      await assertNotLastAdministrator(tx, input.id, '削除');

      // 先にセッションを切る。行が消えれば CASCADE でも消えるが、
      // 「消したのに繋がったまま」を仕組みとして残さない。
      await sessionRepository.revokeAllForUser(tx, input.id, new Date());

      const deleted = await userRepository.deleteById(tx, input.id);
      if (!deleted) {
        throw new NotFoundError('User', input.id);
      }
    });
  },
});
