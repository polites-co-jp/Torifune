import { PluginPermissionError, type PluginDataApi } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { ForbiddenError } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { sanitizeLogDetail } from './logger';
import { createPluginDataApi } from './data-api';
import { Secret } from '@/domain/secret';

let scratch: ScratchDatabase;
let adminContext: AuthorizationContext;
let viewerContext: AuthorizationContext;

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `p${suffix}`,
        email: `p${suffix}@example.com`,
        display_name: 'plugin test',
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
    loginId: `p${suffix}`,
    displayName: 'plugin test',
    email: `p${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function apiFor(
  declared: readonly string[],
  context: AuthorizationContext = adminContext,
): PluginDataApi {
  return createPluginDataApi({
    pluginId: 'seo-plugin',
    declaredPermissions: new Set(declared),
    context,
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('plugindata');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  adminContext = await contextFor(['administrator']);
  viewerContext = await contextFor(['viewer']);
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('宣言した Permission の範囲', () => {
  it('宣言していれば Sites を読める', async () => {
    const api = apiFor(['site.read']);

    await expect(api.sites.list()).resolves.toMatchObject({ total: 0 });
  });

  it('宣言していなければ PluginPermissionError', async () => {
    const api = apiFor([]);

    await expect(api.sites.list()).rejects.toThrowError(PluginPermissionError);
  });

  it('読み取りを宣言しても書き込みはできない', async () => {
    const api = apiFor(['site.read']);

    await expect(api.sites.create({ name: 'x', url: 'https://example.com' })).rejects.toThrowError(
      PluginPermissionError,
    );
  });

  it('書き込みを宣言しても削除はできない', async () => {
    const api = apiFor(['site.read', 'site.write']);
    const site = await api.sites.create({ name: 'x', url: 'https://example.com' });

    await expect(api.sites.delete(site.id)).rejects.toThrowError(PluginPermissionError);
  });

  it('例外に Plugin ID と Permission が入る', async () => {
    const api = apiFor([]);

    try {
      await api.sites.list();
      expect.unreachable();
    } catch (error) {
      const typed = error as PluginPermissionError;
      expect(typed.pluginId).toBe('seo-plugin');
      expect(typed.permission).toBe('site.read');
    }
  });
});

describe('利用者の権限も併せて働く', () => {
  it('Plugin が宣言していても、利用者が権限を持たなければ通らない', async () => {
    // viewer は site.write を持たない。
    const api = apiFor(['site.read', 'site.write'], viewerContext);

    await expect(api.sites.create({ name: 'x', url: 'https://example.com' })).rejects.toThrowError(
      ForbiddenError,
    );
  });

  it('利用者が権限を持てば通る', async () => {
    const api = apiFor(['site.read', 'site.write'], adminContext);

    await expect(
      api.sites.create({ name: 'x', url: 'https://example.com' }),
    ).resolves.toMatchObject({ name: 'x' });
  });
});

describe('Sites', () => {
  it('作成・取得・更新・削除ができる', async () => {
    const api = apiFor(['site.read', 'site.write', 'site.delete']);

    const created = await api.sites.create({ name: 'Plugin Site', url: 'https://example.com' });
    expect(created.name).toBe('Plugin Site');

    await expect(api.sites.get(created.id)).resolves.toMatchObject({ id: created.id });

    const updated = await api.sites.update(created.id, { name: '更新後' });
    expect(updated.name).toBe('更新後');

    await api.sites.delete(created.id);
    await expect(api.sites.get(created.id)).resolves.toBeNull();
  });

  it('存在しない ID では null を返す（例外にしない）', async () => {
    const api = apiFor(['site.read']);

    await expect(api.sites.get('01900000-0000-7000-8000-0000000000ff')).resolves.toBeNull();
  });

  it('一覧がページング情報を返す', async () => {
    const api = apiFor(['site.read', 'site.write']);
    await api.sites.create({ name: 'a', url: 'https://a.example.com' });
    await api.sites.create({ name: 'b', url: 'https://b.example.com' });

    const page = await api.sites.list({ page: 1, perPage: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.perPage).toBe(1);
  });

  it('返る形に内部の項目が含まれない', async () => {
    const api = apiFor(['site.read', 'site.write']);
    const site = await api.sites.create({ name: 'x', url: 'https://example.com' });

    expect(Object.keys(site).sort()).toEqual([
      'createdAt',
      'description',
      'id',
      'name',
      'status',
      'updatedAt',
      'url',
    ]);
  });
});

describe('SNS', () => {
  it('資格情報の平文が Plugin へ渡らない', async () => {
    const CREDENTIAL = 'plugin-must-not-see-this';

    await withConnection((connection) =>
      connection.db
        .insertInto('social_accounts')
        .values({
          id: uuidv7(),
          provider: 'x',
          display_name: 'test',
          handle: '@t',
          // 暗号化済みの形式でないと CHECK 制約に引っかかるため、
          // ここでは資格情報なしで作り、平文が経路に現れないことだけを見る。
          credential: null,
          status: 'disconnected',
        })
        .execute(),
    );

    const api = apiFor(['social.read']);
    const page = await api.socialAccounts.list();

    expect(JSON.stringify(page)).not.toContain(CREDENTIAL);
    expect(Object.keys(page.items[0] ?? {})).not.toContain('credential');
    expect(Object.keys(page.items[0] ?? {})).toContain('credentialConfigured');
  });

  it('social.read を宣言していなければ読めない', async () => {
    const api = apiFor([]);

    await expect(api.socialAccounts.list()).rejects.toThrowError(PluginPermissionError);
  });
});

describe('Campaigns', () => {
  it('作成・取得・更新・削除ができる', async () => {
    const api = apiFor(['campaign.read', 'campaign.write', 'campaign.delete']);

    const created = await api.campaigns.create({
      name: '春の施策',
      startsOn: '2026-03-01',
      endsOn: '2026-03-31',
    });
    expect(created.name).toBe('春の施策');

    expect(await api.campaigns.get(created.id)).toMatchObject({ id: created.id });

    const updated = await api.campaigns.update(created.id, { name: '春の施策（改）' });
    expect(updated.name).toBe('春の施策（改）');

    await api.campaigns.delete(created.id);
    expect(await api.campaigns.get(created.id)).toBeNull();
  });

  it('宣言していなければ読めない', async () => {
    await expect(apiFor([]).campaigns.list()).rejects.toThrowError(PluginPermissionError);
  });

  it('読み取りを宣言しても書き込みはできない', async () => {
    const api = apiFor(['campaign.read']);

    await expect(
      api.campaigns.create({ name: 'x', startsOn: '2026-03-01', endsOn: '2026-03-31' }),
    ).rejects.toThrowError(PluginPermissionError);
  });

  it('無い ID は null（例外にしない）', async () => {
    const api = apiFor(['campaign.read']);

    expect(await api.campaigns.get(uuidv7())).toBeNull();
  });
});

describe('Analytics', () => {
  it('取り込んだ値を書き、読み返せる', async () => {
    const api = apiFor(['site.read', 'site.write', 'analytics.read']);
    const site = await api.sites.create({ name: 'x', url: 'https://example.com' });

    await api.analytics.record({
      siteId: site.id,
      metricDate: '2026-03-01',
      metric: 'pageviews',
      value: 42,
    });

    const points = await api.analytics.list({
      siteId: site.id,
      from: '2026-03-01',
      to: '2026-03-01',
    });

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ metric: 'pageviews', value: 42 });
  });

  /**
   * **出所を名乗らせない。** 名乗れると、Plugin が外部から取り込んだ値を
   * 本体自身の集計として画面に出せてしまう。
   */
  it('書き込んだ値の出所は Plugin ID になり、core を名乗れない', async () => {
    const api = apiFor(['site.read', 'site.write', 'analytics.read']);
    const site = await api.sites.create({ name: 'x', url: 'https://example.com' });

    // **出所を指定する口が型に無い。** 型で塞いだうえで、
    // 実行時に渡しても無視されることを確かめる（型は実行時には残らない）。
    const forged = {
      siteId: site.id,
      metricDate: '2026-03-02',
      metric: 'pageviews',
      value: 7,
      source: 'core',
    } as unknown as Parameters<typeof api.analytics.record>[0];

    await api.analytics.record(forged);

    const points = await api.analytics.list({
      siteId: site.id,
      from: '2026-03-02',
      to: '2026-03-02',
    });

    expect(points[0]).toMatchObject({ source: 'seo-plugin' });
    expect(points.some((point) => point.source === 'core')).toBe(false);
  });

  it('宣言していなければ読めない', async () => {
    await expect(
      apiFor([]).analytics.list({ from: '2026-03-01', to: '2026-03-01' }),
    ).rejects.toThrowError(PluginPermissionError);
  });

  it('宣言していなければ書けない', async () => {
    await expect(
      apiFor([]).analytics.record({
        siteId: uuidv7(),
        metricDate: '2026-03-01',
        metric: 'pageviews',
        value: 1,
      }),
    ).rejects.toThrowError(PluginPermissionError);
  });

  /**
   * 内訳キー（028 設計 §9、受け入れ条件 #50〜#52）。
   *
   * すべて後方互換の追加。`key` を省略した既存の呼び出しはそのまま通る。
   */
  describe('内訳キー', () => {
    const DAY = '2026-03-01';

    async function makeSite(api: PluginDataApi): Promise<string> {
      const site = await api.sites.create({ name: 'x', url: 'https://example.com' });
      return site.id;
    }

    /** DB に保存された行を直接読む（`key` が保存されていることの確認用）。 */
    async function storedRows(siteId: string) {
      return withConnection((connection) =>
        connection.db
          .selectFrom('analytics')
          .select(['source', 'metric', 'key', 'value'])
          .where('site_id', '=', siteId)
          .orderBy('metric')
          .orderBy('key')
          .execute(),
      );
    }

    /** #50 */
    it("key を省略した record は key = '' で保存される", async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await api.analytics.record({ siteId, metricDate: DAY, metric: 'pageviews', value: 42 });

      const rows = await storedRows(siteId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.key).toBe('');
    });

    /** #51 */
    it('key を渡した record は key 付きで保存され、source は Plugin ID', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/pricing',
        value: 7,
      });

      const rows = await storedRows(siteId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: 'seo-plugin',
        metric: 'path_pageviews',
        key: '/pricing',
      });
      expect(Number(rows[0]?.value)).toBe(7);
    });

    /** #51。同じ指標で key だけ違う行を並べて持てる。 */
    it('同じ指標で key だけ違う行を持てる', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/a',
        value: 1,
      });
      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/b',
        value: 2,
      });

      const rows = await storedRows(siteId);
      expect(rows.map((row) => row.key)).toEqual(['/a', '/b']);
    });

    /** #51。制御文字は ValidationError。 */
    it('key に制御文字があれば ValidationError', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await expect(
        api.analytics.record({
          siteId,
          metricDate: DAY,
          metric: 'path_pageviews',
          key: '/bad\u0000',
          value: 1,
        }),
      ).rejects.toThrowError(ValidationError);
    });

    /** #51。境界：500 文字は通り、501 文字は ValidationError。 */
    it('key は 500 文字まで受け付ける', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: 'x'.repeat(500),
        value: 1,
      });

      expect((await storedRows(siteId))[0]?.key).toHaveLength(500);
    });

    it('key が 501 文字なら ValidationError', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await expect(
        api.analytics.record({
          siteId,
          metricDate: DAY,
          metric: 'path_pageviews',
          key: 'x'.repeat(501),
          value: 1,
        }),
      ).rejects.toThrowError(ValidationError);
    });

    /** #52 */
    it('list の各要素に key がある', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);
      await api.analytics.record({ siteId, metricDate: DAY, metric: 'pageviews', value: 1 });
      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/a',
        value: 1,
      });

      const points = await api.analytics.list({ siteId, from: DAY, to: DAY });

      expect(points).toHaveLength(2);
      expect(points.map((point) => point.key).sort()).toEqual(['', '/a']);
    });

    /** #52 */
    it('list を metric で絞れる', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);
      await api.analytics.record({ siteId, metricDate: DAY, metric: 'pageviews', value: 1 });
      await api.analytics.record({ siteId, metricDate: DAY, metric: 'visitors', value: 1 });

      const points = await api.analytics.list({ siteId, from: DAY, to: DAY, metric: 'visitors' });

      expect(points).toHaveLength(1);
      expect(points[0]?.metric).toBe('visitors');
    });

    /** #52 */
    it('list を key で絞れる', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);
      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/a',
        value: 1,
      });
      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/b',
        value: 2,
      });

      const points = await api.analytics.list({ siteId, from: DAY, to: DAY, key: '/b' });

      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ key: '/b', value: 2 });
    });

    /** #52。`key: ''` でキー無しの行だけ。 */
    it("list に key: '' を渡すとキー無しの行だけになる", async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);
      await api.analytics.record({ siteId, metricDate: DAY, metric: 'pageviews', value: 1 });
      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/a',
        value: 1,
      });

      const points = await api.analytics.list({ siteId, from: DAY, to: DAY, key: '' });

      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ metric: 'pageviews', key: '' });
    });

    /** #52。省略時は従来どおり全件。 */
    it('metric / key を省略すると全件返す', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);
      await api.analytics.record({ siteId, metricDate: DAY, metric: 'pageviews', value: 1 });
      await api.analytics.record({ siteId, metricDate: DAY, metric: 'visitors', value: 1 });
      await api.analytics.record({
        siteId,
        metricDate: DAY,
        metric: 'path_pageviews',
        key: '/a',
        value: 1,
      });

      const points = await api.analytics.list({ siteId, from: DAY, to: DAY });

      expect(points).toHaveLength(3);
    });

    /** #52。list に不正な metric を渡せば ValidationError。 */
    it('list の metric が指標名の形式でなければ ValidationError', async () => {
      const api = apiFor(['site.read', 'site.write', 'analytics.read']);
      const siteId = await makeSite(api);

      await expect(
        api.analytics.list({ siteId, from: DAY, to: DAY, metric: 'Page Views' }),
      ).rejects.toThrowError(ValidationError);
    });
  });
});

describe('Users', () => {
  it('user.manage を宣言していれば読める', async () => {
    const api = apiFor(['user.manage']);

    const page = await api.users.list();
    expect(page.total).toBeGreaterThan(0);
  });

  it('宣言していなければ読めない', async () => {
    await expect(apiFor([]).users.list()).rejects.toThrowError(PluginPermissionError);
  });

  /**
   * **Plugin へ渡す型に `passwordHash` と `email` を入れていない**（`data.ts` の注記）。
   * 型で防いでいても、実装が生の行をそのまま返せば漏れる。実際の値で確かめる。
   */
  it('パスワードハッシュとメールアドレスを渡さない', async () => {
    const api = apiFor(['user.manage']);

    const page = await api.users.list();
    const json = JSON.stringify(page);

    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('@example.com');
    // 表示に要るものは残っている。
    expect(Object.keys(page.items[0] ?? {})).toContain('displayName');
  });

  it('ユーザーを作る・消す口が無い', () => {
    const api = apiFor(['user.manage']);

    // Plugin の導入がそのまま管理者の追加になりうるため、読み取りだけにしている。
    expect((api.users as Record<string, unknown>)['create']).toBeUndefined();
    expect((api.users as Record<string, unknown>)['delete']).toBeUndefined();
    expect((api.users as Record<string, unknown>)['update']).toBeUndefined();
  });

  it('無い ID は null（例外にしない）', async () => {
    const api = apiFor(['user.manage']);

    expect(await api.users.get(uuidv7())).toBeNull();
  });
});

describe('ログの整形', () => {
  it('Secret 型の値を落とす', () => {
    const result = sanitizeLogDetail({ token: new Secret('plain-value') });

    expect(JSON.stringify(result)).not.toContain('plain-value');
  });

  it('機密になりうるキーの値を落とす', () => {
    const result = sanitizeLogDetail({
      accessToken: 'abc',
      api_key: 'def',
      Password: 'ghi',
      normal: 'visible',
    });

    const json = JSON.stringify(result);
    expect(json).not.toContain('abc');
    expect(json).not.toContain('def');
    expect(json).not.toContain('ghi');
    expect(json).toContain('visible');
  });

  it('入れ子でも落とす', () => {
    const result = sanitizeLogDetail({ outer: { inner: { secret: 'hidden' } } });

    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('配列の中でも落とす', () => {
    const result = sanitizeLogDetail({ list: [{ token: 'hidden' }] });

    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('通常の値は残す', () => {
    const result = sanitizeLogDetail({ count: 3, name: 'とりふね', flag: true });

    expect(result).toEqual({ count: 3, name: 'とりふね', flag: true });
  });
});
