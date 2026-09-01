import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Connection } from '../../database/provider';
import { roleRepository } from '../../infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '../../test-support/database';
import { withConnection } from '../transaction';
import { effectivePermissions } from './context';

let scratch: ScratchDatabase;
const createdUserIds: string[] = [];

async function createUserWithRoles(roleNames: readonly string[]): Promise<string> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection: Connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `p${suffix}`,
        email: `p${suffix}@example.com`,
        display_name: 'perm test',
      })
      .execute();

    for (const roleName of roleNames) {
      const role = await roleRepository.findByName(connection, roleName);
      if (role === null) {
        throw new Error(`ロールが無い: ${roleName}`);
      }
      await connection.db
        .insertInto('user_roles')
        .values({ user_id: id, role_id: role.id })
        .execute();
    }
  });

  createdUserIds.push(id);
  return id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('authz');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await withConnection((connection) =>
      connection.db.deleteFrom('users').where('id', 'in', createdUserIds).execute(),
    );
    createdUserIds.length = 0;
  }
});

describe('実効 Permission', () => {
  it('administrator は 14 種すべてを持つ', async () => {
    const userId = await createUserWithRoles(['administrator']);

    const permissions = await withConnection((c) => effectivePermissions(c, userId));

    expect(permissions.size).toBe(14);
  });

  it('viewer は read 系だけを持つ', async () => {
    const userId = await createUserWithRoles(['viewer']);

    const permissions = await withConnection((c) => effectivePermissions(c, userId));

    expect([...permissions].sort()).toEqual([
      'analytics.read',
      'campaign.read',
      'site.read',
      'social.read',
    ]);
  });

  it('ロールを持たないユーザーは Permission を1つも持たない', async () => {
    // 既定で何か持たせると、ロールの割り当てを忘れたユーザーが操作できてしまう。
    const userId = await createUserWithRoles([]);

    const permissions = await withConnection((c) => effectivePermissions(c, userId));

    expect(permissions.size).toBe(0);
  });

  it('複数ロールでは和集合になる', async () => {
    const userId = await createUserWithRoles(['viewer', 'editor']);

    const permissions = await withConnection((c) => effectivePermissions(c, userId));

    expect([...permissions].sort()).toEqual([
      'analytics.read',
      'campaign.read',
      'campaign.write',
      'site.read',
      'site.write',
      'social.read',
      'social.write',
    ]);
  });

  it('複数ロールから同じ Permission を得ても重複しない', async () => {
    const userId = await createUserWithRoles(['viewer', 'editor', 'administrator']);

    const permissions = await withConnection((c) =>
      roleRepository.effectivePermissionsOf(c, userId),
    );

    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it('存在しないユーザーの Permission は空', async () => {
    const permissions = await withConnection((c) =>
      effectivePermissions(c, '01900000-0000-7000-8000-0000000000ff'),
    );

    expect(permissions.size).toBe(0);
  });

  it('ロールを外すと Permission も消える', async () => {
    const userId = await createUserWithRoles(['administrator']);

    await withConnection((c) =>
      c.db.deleteFrom('user_roles').where('user_id', '=', userId).execute(),
    );
    const permissions = await withConnection((c) => effectivePermissions(c, userId));

    expect(permissions.size).toBe(0);
  });
});

describe('roleRepository', () => {
  it('ロール一覧を名前順で返す', async () => {
    const roles = await withConnection((c) => roleRepository.list(c));

    expect(roles.map((r) => r.name)).toEqual(['administrator', 'editor', 'viewer']);
  });

  it('標準ロールに isSystem が立っている', async () => {
    const roles = await withConnection((c) => roleRepository.list(c));

    expect(roles.every((r) => r.isSystem)).toBe(true);
  });

  it('名前でロールを引ける', async () => {
    const role = await withConnection((c) => roleRepository.findByName(c, 'editor'));

    expect(role?.displayName).toBe('編集者');
  });

  it('存在しない名前では null', async () => {
    await expect(
      withConnection((c) => roleRepository.findByName(c, 'nonexistent')),
    ).resolves.toBeNull();
  });

  it('ユーザーのロールを引ける', async () => {
    const userId = await createUserWithRoles(['editor', 'viewer']);

    const roles = await withConnection((c) => roleRepository.rolesOf(c, userId));

    expect(roles.map((r) => r.name)).toEqual(['editor', 'viewer']);
  });
});
