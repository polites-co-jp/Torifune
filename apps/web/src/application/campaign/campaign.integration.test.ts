import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from '@/application/campaign/campaign-use-cases';
import { emit, resetEventHandlers, subscribe } from '@/application/events';
import { createSite, deleteSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * キャンペーン（017-campaigns）。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `c${suffix}`,
        email: `c${suffix}@example.com`,
        display_name: 'campaign test',
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
    loginId: `c${suffix}`,
    displayName: 'campaign test',
    email: `c${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function input(overrides: Partial<Parameters<typeof createCampaign>[1]> = {}) {
  return {
    name: '春の施策',
    description: '',
    status: 'draft' as const,
    startsOn: '2026-04-01',
    endsOn: '2026-04-30' as string | null,
    siteIds: [] as readonly string[],
    ...overrides,
  };
}

async function makeSite(name: string): Promise<string> {
  const site = await createSite(admin, {
    name,
    url: `https://${name}.example.com`,
    description: '',
    status: 'active',
  });
  return site.id;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('campaign');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

describe('作成', () => {
  it('作成して読み直せる', async () => {
    const created = await createCampaign(admin, input());
    const found = await getCampaign(admin, { id: created.id });

    expect(found.name).toBe('春の施策');
    expect(found.startsOn).toBe('2026-04-01');
    expect(found.endsOn).toBe('2026-04-30');
  });

  it('終わりを決めずに作れる', async () => {
    const created = await createCampaign(admin, input({ endsOn: null }));
    expect(created.endsOn).toBeNull();
  });

  /** 逆転を許すと、一覧の並びも期間の計算も壊れる。 */
  it('終了日が開始日より前なら失敗する', async () => {
    await expect(
      createCampaign(admin, input({ startsOn: '2026-04-30', endsOn: '2026-04-01' })),
    ).rejects.toThrow(ValidationError);
  });

  it('存在しない日付を拒否する', async () => {
    await expect(createCampaign(admin, input({ startsOn: '2026-02-31' }))).rejects.toThrow(
      ValidationError,
    );
  });

  it('名前が空なら失敗する', async () => {
    await expect(createCampaign(admin, input({ name: '   ' }))).rejects.toThrow(ValidationError);
  });

  it('campaign.write が無ければ作れない', async () => {
    const viewer = await contextFor('viewer');
    await expect(createCampaign(viewer, input())).rejects.toThrow(ForbiddenError);
  });
});

describe('対象サイト', () => {
  it('複数のサイトを対象にできる', async () => {
    const a = await makeSite('alpha');
    const b = await makeSite('beta');

    const created = await createCampaign(admin, input({ siteIds: [a, b] }));

    expect([...created.siteIds].sort()).toEqual([a, b].sort());
  });

  /** 差分では「消す」を表現できないので、指定したら丸ごと置き換える。 */
  it('更新で対象サイトを置き換えられる', async () => {
    const a = await makeSite('alpha');
    const b = await makeSite('beta');
    const created = await createCampaign(admin, input({ siteIds: [a, b] }));

    const updated = await updateCampaign(admin, { id: created.id, siteIds: [b] });

    expect(updated.siteIds).toEqual([b]);
  });

  it('対象サイトを空にできる', async () => {
    const a = await makeSite('alpha');
    const created = await createCampaign(admin, input({ siteIds: [a] }));

    const updated = await updateCampaign(admin, { id: created.id, siteIds: [] });

    expect(updated.siteIds).toEqual([]);
  });

  /**
   * サイトを消しても、そのサイトを対象にしていたキャンペーンは残す。
   * 対象が減っただけで、取り組みの記録は消さない。
   */
  it('サイトを削除してもキャンペーンは残る', async () => {
    const a = await makeSite('alpha');
    const created = await createCampaign(admin, input({ siteIds: [a] }));

    await deleteSite(admin, { id: a });

    const found = await getCampaign(admin, { id: created.id });
    expect(found.siteIds).toEqual([]);
  });

  it('対象サイトで絞り込める', async () => {
    const a = await makeSite('alpha');
    const b = await makeSite('beta');
    await createCampaign(admin, input({ name: 'A の施策', siteIds: [a] }));
    await createCampaign(admin, input({ name: 'B の施策', siteIds: [b] }));

    const page = await listCampaigns(admin, {
      page: 1,
      perPage: 20,
      status: null,
      keyword: null,
      activeOn: null,
      siteId: a,
      sort: [],
    });

    expect(page.items.map((c) => c.name)).toEqual(['A の施策']);
  });
});

describe('一覧', () => {
  it('既定では中止を隠す', async () => {
    await createCampaign(admin, input({ name: '実施', status: 'running' }));
    await createCampaign(admin, input({ name: '中止', status: 'cancelled' }));

    const page = await listCampaigns(admin, {
      page: 1,
      perPage: 20,
      status: null,
      keyword: null,
      activeOn: null,
      siteId: null,
      sort: [],
    });

    expect(page.items.map((c) => c.name)).toEqual(['実施']);
  });

  it('状態を指定すれば中止も出る', async () => {
    await createCampaign(admin, input({ name: '中止', status: 'cancelled' }));

    const page = await listCampaigns(admin, {
      page: 1,
      perPage: 20,
      status: 'cancelled',
      keyword: null,
      activeOn: null,
      siteId: null,
      sort: [],
    });

    expect(page.items.map((c) => c.name)).toEqual(['中止']);
  });

  it('その日に実施中のものだけを取れる', async () => {
    await createCampaign(
      admin,
      input({ name: '4月', startsOn: '2026-04-01', endsOn: '2026-04-30' }),
    );
    await createCampaign(
      admin,
      input({ name: '5月', startsOn: '2026-05-01', endsOn: '2026-05-31' }),
    );
    // 終わりが無いものは「まだ続いている」として含める。
    await createCampaign(admin, input({ name: '継続', startsOn: '2026-01-01', endsOn: null }));

    const page = await listCampaigns(admin, {
      page: 1,
      perPage: 20,
      status: null,
      keyword: null,
      activeOn: '2026-04-15',
      siteId: null,
      sort: [{ field: 'name', direction: 'asc' }],
    });

    expect(page.items.map((c) => c.name).sort()).toEqual(['4月', '継続']);
  });
});

describe('更新', () => {
  /** 期間は片方だけ変えられる。いまの値と突き合わせないと逆転を見逃す。 */
  it('終了日だけを開始日より前へ変えられない', async () => {
    const created = await createCampaign(admin, input({ startsOn: '2026-04-10', endsOn: null }));

    await expect(updateCampaign(admin, { id: created.id, endsOn: '2026-04-01' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('開始日だけを終了日より後へ変えられない', async () => {
    const created = await createCampaign(
      admin,
      input({ startsOn: '2026-04-01', endsOn: '2026-04-10' }),
    );

    await expect(updateCampaign(admin, { id: created.id, startsOn: '2026-04-20' })).rejects.toThrow(
      ValidationError,
    );
  });

  it('終了日を未定へ戻せる', async () => {
    const created = await createCampaign(admin, input({ endsOn: '2026-04-30' }));

    const updated = await updateCampaign(admin, { id: created.id, endsOn: null });

    expect(updated.endsOn).toBeNull();
  });

  it('存在しないキャンペーンの更新は失敗する', async () => {
    await expect(updateCampaign(admin, { id: uuidv7(), name: 'x' })).rejects.toThrow(NotFoundError);
  });
});

describe('削除', () => {
  it('削除できる', async () => {
    const created = await createCampaign(admin, input());
    await deleteCampaign(admin, { id: created.id });

    await expect(getCampaign(admin, { id: created.id })).rejects.toThrow(NotFoundError);
  });

  it('campaign.delete が無ければ削除できない', async () => {
    const created = await createCampaign(admin, input());
    const editor = await contextFor('editor');

    await expect(deleteCampaign(editor, { id: created.id })).rejects.toThrow(ForbiddenError);
  });
});

describe('イベント', () => {
  it('作成・更新・削除で発火する', async () => {
    const seen: string[] = [];
    subscribe('campaign.created', () => void seen.push('created'));
    subscribe('campaign.updated', () => void seen.push('updated'));
    subscribe('campaign.deleted', () => void seen.push('deleted'));

    const created = await createCampaign(admin, input());
    await updateCampaign(admin, { id: created.id, name: '改名' });
    await deleteCampaign(admin, { id: created.id });

    expect(seen).toEqual(['created', 'updated', 'deleted']);
  });

  it('削除イベントに消えたキャンペーンの内容が載る', async () => {
    let payload: unknown;
    subscribe('campaign.deleted', (value) => {
      payload = value;
    });

    const created = await createCampaign(admin, input({ name: '消える施策' }));
    await deleteCampaign(admin, { id: created.id });

    expect((payload as { name: string }).name).toBe('消える施策');
  });

  /** Core のイベント名を Plugin から騙れない。 */
  it('Core のイベント名は Plugin から発火できない', async () => {
    await expect(emit('campaign.created', {})).resolves.toBeUndefined();
  });
});

describe('監査ログ', () => {
  it('作成・更新・削除を記録する', async () => {
    const created = await createCampaign(admin, input());
    await updateCampaign(admin, { id: created.id, name: '改名' });
    await deleteCampaign(admin, { id: created.id });

    const rows = await withConnection(async (connection) =>
      connection.db
        .selectFrom('audit_logs')
        .select(['action', 'resource_type'])
        .orderBy('occurred_at')
        .execute(),
    );

    expect(rows).toEqual([
      { action: 'created', resource_type: 'campaign' },
      { action: 'updated', resource_type: 'campaign' },
      { action: 'deleted', resource_type: 'campaign' },
    ]);
  });
});
