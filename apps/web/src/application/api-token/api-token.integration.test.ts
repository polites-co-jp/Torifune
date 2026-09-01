import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * API Token（05_API設計.md §37-38、docs/設計/021-api-token/設計.md）。
 */

const request = { ipAddress: '203.0.113.20', userAgent: 'vitest' } as const;

let scratch: ScratchDatabase;

interface Actor {
  readonly userId: string;
  readonly context: AuthorizationContext;
}

async function actorWithRoles(roleNames: readonly string[]): Promise<Actor> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `t${suffix}`,
        email: `t${suffix}@example.com`,
        display_name: 'token test',
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

  const identity: UserIdentity = {
    userId: id,
    loginId: `t${suffix}`,
    displayName: 'token test',
    email: `t${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  const context = await withConnection(async (connection) =>
    authorizationContextFor(connection, identity),
  );

  return { userId: id, context: { ...context, request } };
}

/** ロールを外す。Token の実効権限が追随することを見るため。 */
async function removeRole(userId: string, roleName: string): Promise<void> {
  await withConnection(async (connection) => {
    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .deleteFrom('user_roles')
      .where('user_id', '=', userId)
      .where('role_id', '=', role.id)
      .execute();
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('apitoken');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

describe('発行', () => {
  it('平文は発行時に一度だけ返る', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });

    expect(created.plaintext).not.toBe('');
    // 一覧には平文が無い。
    const list = await listApiTokens(admin.context, {});
    expect(JSON.stringify(list)).not.toContain(created.plaintext);
  });

  it('DB に平文を保存しない', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('api_tokens').selectAll().execute(),
    );
    expect(JSON.stringify(rows)).not.toContain(created.plaintext);
  });

  /**
   * 黙って削らない。使用時に交差させるので実害は無いが、
   * 「指定したのに効かない」より「指定できない」ほうがよい（設計 §2.3）。
   */
  it('自分が持たない権限を Scope に指定できない', async () => {
    const viewer = await actorWithRoles(['administrator']);
    await expect(
      createApiToken(viewer.context, {
        name: 'CI',
        scopes: ['plugin.manage', 'not.a.real.permission'],
        expiresAt: null,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('過去の有効期限を拒否する', async () => {
    const admin = await actorWithRoles(['administrator']);
    await expect(
      createApiToken(admin.context, {
        name: 'CI',
        scopes: [],
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('token.manage が無ければ発行できない', async () => {
    const editor = await actorWithRoles(['editor']);
    await expect(
      createApiToken(editor.context, { name: 'CI', scopes: [], expiresAt: null }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('他人の Token は一覧に出ない', async () => {
    const a = await actorWithRoles(['administrator']);
    const b = await actorWithRoles(['administrator']);

    await createApiToken(a.context, { name: 'A の Token', scopes: [], expiresAt: null });

    expect(await listApiTokens(b.context, {})).toHaveLength(0);
  });
});

describe('Token による認証', () => {
  it('Scope の範囲で権限を持つ', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });

    const context = await buildApiTokenContext(created.plaintext, request);

    expect(context.identity?.userId).toBe(admin.userId);
    expect(context.permissions.has('site.read')).toBe(true);
    // 所有者は持っているが Scope 外。
    expect(context.permissions.has('site.write')).toBe(false);
  });

  /**
   * Token は権限を増やせない。絞るだけ（設計 §2.2）。
   * ロールを外したら、Token の実効権限も狭まらなければならない。
   */
  it('所有者のロールを外すと実効権限も狭まる', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });

    const before = await buildApiTokenContext(created.plaintext, request);
    expect(before.permissions.has('site.read')).toBe(true);

    await removeRole(admin.userId, 'administrator');

    const after = await buildApiTokenContext(created.plaintext, request);
    expect(after.permissions.has('site.read')).toBe(false);
  });

  it('失効した Token は未認証になる', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });

    await revokeApiToken(admin.context, { id: created.token.id });

    const context = await buildApiTokenContext(created.plaintext, request);
    expect(context.identity).toBeNull();
    expect(context.permissions.size).toBe(0);
  });

  it('期限切れの Token は未認証になる', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: new Date(Date.now() + 60_000),
    });

    await withConnection(async (connection) => {
      await connection.db
        .updateTable('api_tokens')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', created.token.id)
        .execute();
    });

    expect((await buildApiTokenContext(created.plaintext, request)).identity).toBeNull();
  });

  it('所有者が無効化されていれば未認証になる', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });

    await withConnection(async (connection) => {
      await connection.db
        .updateTable('users')
        .set({ status: 'disabled' })
        .where('id', '=', admin.userId)
        .execute();
    });

    expect((await buildApiTokenContext(created.plaintext, request)).identity).toBeNull();
  });

  it('存在しない Token は未認証になる', async () => {
    expect((await buildApiTokenContext('tfp_nope', request)).identity).toBeNull();
  });

  it('使用すると最終利用時刻が記録される', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: ['site.read'],
      expiresAt: null,
    });
    expect(created.token.lastUsedAt).toBeNull();

    await buildApiTokenContext(created.plaintext, request);

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('api_tokens').select('last_used_at').execute(),
    );
    expect(rows[0]?.last_used_at).not.toBeNull();
  });
});

describe('失効', () => {
  it('他人の Token は失効させられない', async () => {
    const a = await actorWithRoles(['administrator']);
    const b = await actorWithRoles(['administrator']);

    const created = await createApiToken(a.context, {
      name: 'A の Token',
      scopes: [],
      expiresAt: null,
    });

    // 存在を教えない。見つからない場合と同じ扱い。
    await expect(revokeApiToken(b.context, { id: created.token.id })).rejects.toThrow(
      NotFoundError,
    );
  });

  /** 失効しても行は消さない。消すと監査が追えない。 */
  it('失効しても記録は残る', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: [],
      expiresAt: null,
    });

    await revokeApiToken(admin.context, { id: created.token.id });

    const list = await listApiTokens(admin.context, {});
    expect(list).toHaveLength(1);
    expect(list[0]?.revokedAt).not.toBeNull();
  });

  it('失効を監査ログに残す', async () => {
    const admin = await actorWithRoles(['administrator']);
    const created = await createApiToken(admin.context, {
      name: 'CI',
      scopes: [],
      expiresAt: null,
    });

    await revokeApiToken(admin.context, { id: created.token.id });

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('audit_logs').select(['action', 'resource_type']).execute(),
    );
    expect(rows).toEqual([{ action: 'deleted', resource_type: 'api_token' }]);
  });
});
