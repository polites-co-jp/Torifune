import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { listRoleGrants, listRoles } from '@/application/authorization/role-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * ロールの grants（047-prototype-key-sweep 設計 §1.2・§4.2・§6、受け入れ条件 #7〜#10）。
 *
 * ロールを作る API・画面は無い（`015-settings`）。`constructor` のロールは、運用者が DB に
 * 直接作ったときだけ現れる（設計 §1.2）。ここでは `roles` へ直接 `insertInto` して再現する。
 *
 * 変更前は、`constructor` に Permission を 1 つでも付けると `listRoleGrants` が
 * TypeError `grants[row.role_name].push is not a function` を投げていた（K1）。
 *
 * **後始末**：`constructor` のロールを残すと #7 のキーの順が崩れるので、各件の後に
 * 自分で入れた行を消す（実装プラン §7 の 4）。
 */

const STANDARD_ROLES = ['administrator', 'editor', 'viewer'];

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
const insertedRoleIds: string[] = [];
const createdUserIds: string[] = [];

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `r${suffix}`,
        email: `r${suffix}@example.com`,
        display_name: 'role grants test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });
  createdUserIds.push(id);

  const identity: UserIdentity = {
    userId: id,
    loginId: `r${suffix}`,
    displayName: 'role grants test',
    email: `r${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** `roles` へ直接ロールを入れる（運用者が DB に直接作ったときの再現）。 */
async function insertRole(name: string, permissions: readonly string[] = []): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('roles')
      .values({ id, name, display_name: `直接作ったロール（${name}）` })
      .execute();
    insertedRoleIds.push(id);
    for (const permission of permissions) {
      await connection.db
        .insertInto('role_permissions')
        .values({ role_id: id, permission_name: permission })
        .execute();
    }
  });
  return id;
}

/** `role_permissions` をそのロールで絞り、`permission_name` の順に並べたもの。 */
async function permissionsOf(roleName: string): Promise<string[]> {
  const rows = await withConnection(async (connection) =>
    connection.db
      .selectFrom('role_permissions')
      .innerJoin('roles', 'roles.id', 'role_permissions.role_id')
      .select('role_permissions.permission_name')
      .where('roles.name', '=', roleName)
      .orderBy('role_permissions.permission_name')
      .execute(),
  );
  return rows.map((row) => row.permission_name);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('rolegrants');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await withConnection(async (connection) => {
    if (createdUserIds.length > 0) {
      await connection.db.deleteFrom('users').where('id', 'in', createdUserIds).execute();
    }
  });
  await scratch.dispose();
});

afterEach(async () => {
  if (insertedRoleIds.length === 0) return;
  await withConnection(async (connection) => {
    await connection.db
      .deleteFrom('role_permissions')
      .where('role_id', 'in', insertedRoleIds)
      .execute();
    await connection.db.deleteFrom('roles').where('id', 'in', insertedRoleIds).execute();
  });
  insertedRoleIds.length = 0;
});

describe('#7 標準の 3 ロールだけのとき listRoleGrants は従来どおり', () => {
  it('#7 キーが administrator・editor・viewer の順', async () => {
    const grants = await listRoleGrants(admin, {});

    expect(Object.keys(grants)).toEqual(STANDARD_ROLES);
  });

  it.each(STANDARD_ROLES)(
    '#7 %s の値が role_permissions をそのロールで絞って permission_name の順に並べたもの',
    async (roleName) => {
      const grants = await listRoleGrants(admin, {});
      const expected = await permissionsOf(roleName);

      expect(expected.length).toBeGreaterThan(0);
      expect(grants[roleName]).toEqual(expected);
    },
  );
});

describe('#8 Permission を持つ constructor のロールがあっても listRoleGrants が通る', () => {
  it('#8 constructor に site.read を付けても例外を投げない', async () => {
    await insertRole('constructor', ['site.read']);

    await expect(listRoleGrants(admin, {})).resolves.toBeDefined();
  });

  it('#8 自分のキー constructor の値が [site.read]', async () => {
    await insertRole('constructor', ['site.read']);

    const grants = await listRoleGrants(admin, {});

    expect(Object.hasOwn(grants, 'constructor')).toBe(true);
    expect(grants['constructor']).toEqual(['site.read']);
  });

  it('#8 キーの順が administrator・constructor・editor・viewer', async () => {
    await insertRole('constructor', ['site.read']);

    const grants = await listRoleGrants(admin, {});

    expect(Object.keys(grants)).toEqual(['administrator', 'constructor', 'editor', 'viewer']);
  });

  it.each(STANDARD_ROLES)('#8 %s の値は #7 と同じ', async (roleName) => {
    await insertRole('constructor', ['site.read']);

    const grants = await listRoleGrants(admin, {});

    expect(grants[roleName]).toEqual(await permissionsOf(roleName));
  });
});

describe('#9 Permission を持たない constructor のロール', () => {
  it('#9 listRoleGrants の結果に自分のキー constructor が無い', async () => {
    await insertRole('constructor');

    const grants = await listRoleGrants(admin, {});

    expect(Object.hasOwn(grants, 'constructor')).toBe(false);
    expect(Object.keys(grants)).toEqual(STANDARD_ROLES);
  });

  it('#9 listRoles には constructor が現れる', async () => {
    await insertRole('constructor');

    const roles = await listRoles(admin, {});

    expect(roles.map((role) => role.name)).toContain('constructor');
  });
});

describe('#10 roles.name の CHECK が原型の名前で通すのは constructor だけ（前提の記録）', () => {
  it.each(['__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'])(
    '#10 %s は CHECK 違反（roles_name_format）で入らない',
    async (name) => {
      await expect(insertRole(name)).rejects.toMatchObject({
        code: '23514',
        constraint: 'roles_name_format',
      });
    },
  );

  it('#10 constructor は入る', async () => {
    await expect(insertRole('constructor')).resolves.toEqual(expect.any(String));
  });
});
