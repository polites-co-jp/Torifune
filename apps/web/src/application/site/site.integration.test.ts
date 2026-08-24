import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { authorizationContextFor } from '@/application/authorization/context';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { ForbiddenError, UnauthenticatedError } from '@/application/authorization/authorize';
import { emit, resetEventHandlers, subscribe } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { createSite, deleteSite, getSite, listSites, updateSite } from './site-use-cases';

let scratch: ScratchDatabase;

/** ロールを持つユーザーを作り、その認可文脈を返す。 */
async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `s${suffix}`,
        email: `s${suffix}@example.com`,
        display_name: 'site test',
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
    loginId: `s${suffix}`,
    displayName: 'site test',
    email: `s${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** 未認証の文脈。 */
async function anonymousContext(): Promise<AuthorizationContext> {
  return withConnection(async (connection) => ({
    identity: null,
    permissions: new Set<string>(),
    connection,
  }));
}

const DEFAULT_SORT = [{ field: 'created_at', direction: 'desc' as const }];

function listInput(overrides: Partial<Parameters<typeof listSites>[1]> = {}) {
  return {
    page: 1,
    perPage: 20,
    status: null,
    keyword: null,
    sort: DEFAULT_SORT,
    ...overrides,
  };
}

let admin: AuthorizationContext;

beforeAll(async () => {
  scratch = await useScratchDatabase('sites');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('作成', () => {
  it('サイトを作成できる', async () => {
    const site = await createSite(admin, {
      name: 'コーポレートサイト',
      url: 'https://example.com',
      description: '説明',
      status: 'active',
    });

    expect(site.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(site.name).toBe('コーポレートサイト');
    expect(site.createdBy).toBe(admin.identity?.userId);
    expect(site.createdAt).toBeInstanceOf(Date);
  });

  it('名前が空なら ValidationError', async () => {
    await expect(
      createSite(admin, {
        name: '  ',
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).rejects.toThrowError(ValidationError);
  });

  it('名前が長すぎれば ValidationError', async () => {
    await expect(
      createSite(admin, {
        name: 'a'.repeat(201),
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).rejects.toThrowError(ValidationError);
  });

  it('URL が http/https でなければ ValidationError', async () => {
    await expect(
      createSite(admin, {
        name: 'x',
        url: 'javascript:alert(1)',
        description: '',
        status: 'active',
      }),
    ).rejects.toThrowError(ValidationError);
  });

  it('同じ URL のサイトを2つ作れる', async () => {
    // 本番と検証、言語別など、同じサイトを別の目的で登録したい場合がある。
    await createSite(admin, {
      name: 'A',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });
    await expect(
      createSite(admin, {
        name: 'B',
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).resolves.toBeDefined();
  });

  it('site.write が無ければ ForbiddenError', async () => {
    const viewer = await contextFor(['viewer']);
    await expect(
      createSite(viewer, {
        name: 'x',
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).rejects.toThrowError(ForbiddenError);
  });

  it('未認証なら UnauthenticatedError', async () => {
    const anonymous = await anonymousContext();
    await expect(
      createSite(anonymous, {
        name: 'x',
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).rejects.toThrowError(UnauthenticatedError);
  });
});

describe('取得', () => {
  it('作成したサイトを取得できる', async () => {
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });

    await expect(getSite(admin, { id: created.id })).resolves.toMatchObject({ id: created.id });
  });

  it('存在しない ID で NotFoundError', async () => {
    await expect(
      getSite(admin, { id: '01900000-0000-7000-8000-0000000000ff' }),
    ).rejects.toThrowError(NotFoundError);
  });

  it('UUID でない ID でも NotFoundError（例外で落ちない）', async () => {
    await expect(getSite(admin, { id: 'not-a-uuid' })).rejects.toThrowError(NotFoundError);
  });

  it('site.read が無ければ ForbiddenError', async () => {
    const noRole = await contextFor([]);
    await expect(getSite(noRole, { id: 'x' })).rejects.toThrowError(ForbiddenError);
  });
});

describe('一覧', () => {
  beforeEach(async () => {
    for (const [name, url, status] of [
      ['Alpha', 'https://alpha.example.com', 'active'],
      ['Beta', 'https://beta.example.com', 'paused'],
      ['Gamma', 'https://gamma.example.com', 'archived'],
    ] as const) {
      await createSite(admin, { name, url, description: '', status });
    }
  });

  it('既定では archived を含めない', async () => {
    const page = await listSites(admin, listInput());

    expect(page.items.map((s) => s.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(page.total).toBe(2);
  });

  it('status=archived を指定したときだけ archived が出る', async () => {
    const page = await listSites(admin, listInput({ status: 'archived' }));

    expect(page.items.map((s) => s.name)).toEqual(['Gamma']);
  });

  it('total が全件数を返す（ページの件数ではない）', async () => {
    const page = await listSites(admin, listInput({ perPage: 1 }));

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
  });

  it('名前で並び替えられる', async () => {
    const page = await listSites(admin, listInput({ sort: [{ field: 'name', direction: 'asc' }] }));

    expect(page.items.map((s) => s.name)).toEqual(['Alpha', 'Beta']);
  });

  it('キーワードで名前を部分一致検索できる', async () => {
    const page = await listSites(admin, listInput({ keyword: 'lph' }));

    expect(page.items.map((s) => s.name)).toEqual(['Alpha']);
  });

  it('キーワードで URL を部分一致検索できる', async () => {
    const page = await listSites(admin, listInput({ keyword: 'beta.example' }));

    expect(page.items.map((s) => s.name)).toEqual(['Beta']);
  });

  it('キーワードが大文字小文字を区別しない', async () => {
    const page = await listSites(admin, listInput({ keyword: 'ALPHA' }));

    expect(page.items.map((s) => s.name)).toEqual(['Alpha']);
  });

  it('キーワードの % がワイルドカードとして解釈されない', async () => {
    // 解釈されると全件一致してしまう。
    const page = await listSites(admin, listInput({ keyword: '%' }));

    expect(page.items).toHaveLength(0);
  });

  it('キーワードの _ がワイルドカードとして解釈されない', async () => {
    const page = await listSites(admin, listInput({ keyword: '_' }));

    expect(page.items).toHaveLength(0);
  });

  it('ページ送りで同じ行が重複しない', async () => {
    // 並び順が同値のとき順序が揺れると、ページ送りで重複や抜けが起きる。
    const first = await listSites(admin, listInput({ perPage: 1, page: 1 }));
    const second = await listSites(admin, listInput({ perPage: 1, page: 2 }));

    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  });

  it('site.read が無ければ ForbiddenError', async () => {
    const noRole = await contextFor([]);
    await expect(listSites(noRole, listInput())).rejects.toThrowError(ForbiddenError);
  });
});

describe('更新', () => {
  it('名前だけを更新でき、他の項目が変わらない', async () => {
    const created = await createSite(admin, {
      name: 'Before',
      url: 'https://example.com',
      description: '説明',
      status: 'active',
    });

    const updated = await updateSite(admin, { id: created.id, name: 'After' });

    expect(updated.name).toBe('After');
    expect(updated.url).toBe('https://example.com');
    expect(updated.description).toBe('説明');
    expect(updated.status).toBe('active');
  });

  it('updatedAt が進む', async () => {
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });

    const updated = await updateSite(admin, { id: created.id, name: 'y' });

    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('存在しない ID で NotFoundError', async () => {
    await expect(
      updateSite(admin, { id: '01900000-0000-7000-8000-0000000000ff', name: 'x' }),
    ).rejects.toThrowError(NotFoundError);
  });

  it('不正な URL で ValidationError', async () => {
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });

    await expect(
      updateSite(admin, { id: created.id, url: 'javascript:alert(1)' }),
    ).rejects.toThrowError(ValidationError);
  });

  it('site.write が無ければ ForbiddenError', async () => {
    const viewer = await contextFor(['viewer']);
    await expect(updateSite(viewer, { id: 'x', name: 'y' })).rejects.toThrowError(ForbiddenError);
  });
});

describe('削除', () => {
  it('削除できる', async () => {
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });

    await deleteSite(admin, { id: created.id });

    await expect(getSite(admin, { id: created.id })).rejects.toThrowError(NotFoundError);
  });

  it('存在しない ID で NotFoundError', async () => {
    await expect(
      deleteSite(admin, { id: '01900000-0000-7000-8000-0000000000ff' }),
    ).rejects.toThrowError(NotFoundError);
  });

  it('site.write だけでは削除できない', async () => {
    // editor は site.write を持つが site.delete を持たない。
    const editor = await contextFor(['editor']);
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });

    await expect(deleteSite(editor, { id: created.id })).rejects.toThrowError(ForbiddenError);
  });
});

describe('イベント', () => {
  it('作成で site.created が発火する', async () => {
    const received: unknown[] = [];
    subscribe('site.created', (payload) => {
      received.push(payload);
    });

    const site = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });

    expect(received).toEqual([
      { siteId: site.id, name: 'x', url: 'https://example.com', status: 'active' },
    ]);
  });

  it('更新で site.updated が発火する', async () => {
    const received: unknown[] = [];
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });
    subscribe('site.updated', (payload) => {
      received.push(payload);
    });

    await updateSite(admin, { id: created.id, name: 'y' });

    expect(received).toHaveLength(1);
  });

  it('削除で site.deleted が発火する', async () => {
    const received: unknown[] = [];
    const created = await createSite(admin, {
      name: 'x',
      url: 'https://example.com',
      description: '',
      status: 'active',
    });
    subscribe('site.deleted', (payload) => {
      received.push(payload);
    });

    await deleteSite(admin, { id: created.id });

    expect(received).toHaveLength(1);
  });

  it('UseCase が失敗したときイベントが発火しない', async () => {
    const received: unknown[] = [];
    subscribe('site.created', (payload) => {
      received.push(payload);
    });

    await expect(
      createSite(admin, {
        name: '',
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).rejects.toThrowError();

    expect(received).toHaveLength(0);
  });

  it('購読側が失敗しても発火元は成功する', async () => {
    // Plugin の不具合で本体の処理が失敗すると、
    // Plugin を入れた瞬間にサイトが作れなくなる、という壊れ方をする。
    subscribe('site.created', () => {
      throw new Error('plugin is broken');
    });

    await expect(
      createSite(admin, {
        name: 'x',
        url: 'https://example.com',
        description: '',
        status: 'active',
      }),
    ).resolves.toBeDefined();
  });

  it('購読を解除できる', async () => {
    const received: unknown[] = [];
    const unsubscribe = subscribe('site.created', (payload) => {
      received.push(payload);
    });
    unsubscribe();

    await emit('site.created', {});

    expect(received).toHaveLength(0);
  });
});
