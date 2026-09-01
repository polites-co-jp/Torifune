import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createSite, deleteSite, listSites, updateSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 一般API操作の監査ログ（05_API設計.md §42）。
 *
 * 認証イベントは `auth_audit_logs`、操作の追跡は `audit_logs` と分けている
 * （docs/設計/022-hardening/設計.md §3.1）。
 */

let scratch: ScratchDatabase;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'audit test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `a${suffix}`,
    displayName: 'audit test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => {
    const base = await authorizationContextFor(connection, identity);
    return { ...base, request: { ipAddress: '203.0.113.7', userAgent: 'vitest' } };
  });
}

/** createSite の必須項目を埋める。監査の検証に関係しない値は既定でよい。 */
function siteInput() {
  return {
    name: 'とりふね',
    url: 'https://example.com',
    description: '',
    status: 'active' as const,
  };
}

interface AuditRow {
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_user_id: string | null;
  detail: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
}

async function auditRows(): Promise<AuditRow[]> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('audit_logs')
      .select([
        'action',
        'resource_type',
        'resource_id',
        'actor_user_id',
        'detail',
        'ip_address',
        'user_agent',
      ])
      .orderBy('occurred_at')
      .execute(),
  ) as Promise<AuditRow[]>;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('audit');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('sites').execute();
  });
});

describe('一般API操作の監査ログ', () => {
  it('作成を記録する', async () => {
    const context = await contextFor('administrator');
    const site = await createSite(context, siteInput());

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('created');
    expect(rows[0]?.resource_type).toBe('site');
    expect(rows[0]?.resource_id).toBe(site.id);
  });

  it('更新を記録する', async () => {
    const context = await contextFor('administrator');
    const site = await createSite(context, siteInput());
    await updateSite(context, { id: site.id, name: '改名' });

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(['created', 'updated']);
  });

  it('削除を記録する', async () => {
    const context = await contextFor('administrator');
    const site = await createSite(context, siteInput());
    await deleteSite(context, { id: site.id });

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(['created', 'deleted']);
    // 消えたあとでも、何が消えたかを追えなければ監査にならない。
    expect(rows[1]?.resource_id).toBe(site.id);
  });

  it('操作した人と経路を記録する', async () => {
    const context = await contextFor('administrator');
    await createSite(context, siteInput());

    const rows = await auditRows();
    expect(rows[0]?.actor_user_id).toBe(context.identity?.userId);
    expect(rows[0]?.ip_address).toBe('203.0.113.7');
    expect(rows[0]?.user_agent).toBe('vitest');
  });

  /** 参照は記録しない。記録すると量が跳ね上がり、肝心の変更が埋もれる。 */
  it('参照は記録しない', async () => {
    const context = await contextFor('administrator');
    await listSites(context, { page: 1, perPage: 20, status: null, keyword: null, sort: [] });

    expect(await auditRows()).toHaveLength(0);
  });

  /** 起きなかったことを記録しない。 */
  it('権限不足で失敗した操作は記録しない', async () => {
    const context = await contextFor('viewer');
    await expect(createSite(context, siteInput())).rejects.toThrow();

    expect(await auditRows()).toHaveLength(0);
  });

  it('入力の検証で失敗した操作は記録しない', async () => {
    const context = await contextFor('administrator');
    await expect(createSite(context, { ...siteInput(), name: '' })).rejects.toThrow();

    expect(await auditRows()).toHaveLength(0);
  });

  it('detail に機密を残さない', async () => {
    const context = await contextFor('administrator');
    await createSite(context, siteInput());

    const rows = await auditRows();
    const serialized = JSON.stringify(rows[0]?.detail);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
  });
});
