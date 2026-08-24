import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import type { DiscoveryResult } from './loader';
import { installPlugin } from './lifecycle';
import { collectMenus, isLoaded } from './registry';
import { ensurePluginsStarted, resetPluginRuntime } from './runtime';

// `plugins/` の走査結果を差し替える。
// テストのために本番コードへ差し込み口を作ると、そこが本番でも使えてしまう。
vi.mock('./loader', () => ({
  discoverPlugins: (): DiscoveryResult => discovery,
}));

let discovery: DiscoveryResult = { plugins: [], problems: [] };
let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function manifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1, ...overrides };
}

function countingPlugin(counter: { activated: number }): Plugin {
  return {
    activate(context) {
      counter.activated += 1;
      context.ui.registerMenu({ label: `menu-${counter.activated}`, route: '/plugins/x' });
    },
  };
}

async function adminContext(): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `r${suffix}`,
        email: `r${suffix}@example.com`,
        display_name: 'runtime test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, 'administrator');
    if (role === null) throw new Error('administrator ロールが無い');
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `r${suffix}`,
    displayName: 'runtime test',
    email: `r${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('runtime');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await adminContext();
});

afterEach(async () => {
  discovery = { plugins: [], problems: [] };
  resetPluginRuntime();
  resetPermissionRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('起動', () => {
  it('DB に行が無い Plugin は動かさない', async () => {
    // ファイルを置いただけで勝手に動くと、意図しないコードが実行される。
    const counter = { activated: 0 };
    discovery = {
      plugins: [{ manifest: manifest('ghost-plugin'), plugin: countingPlugin(counter) }],
      problems: [],
    };

    const result = await ensurePluginsStarted(admin);

    expect(counter.activated).toBe(0);
    expect(result.enabled).toEqual([]);
    expect(isLoaded('ghost-plugin')).toBe(false);
  });

  it('installed のままの Plugin は動かさない', async () => {
    const counter = { activated: 0 };
    const m = manifest('installed-plugin');
    discovery = { plugins: [{ manifest: m, plugin: countingPlugin(counter) }], problems: [] };
    await withConnection((connection) => installPlugin(connection, m));

    const result = await ensurePluginsStarted(admin);

    expect(counter.activated).toBe(0);
    expect(result.enabled).toEqual([]);
  });

  it('enabled の Plugin を動かす', async () => {
    const counter = { activated: 0 };
    const m = manifest('live-plugin');
    discovery = { plugins: [{ manifest: m, plugin: countingPlugin(counter) }], problems: [] };
    await withConnection(async (connection) => {
      await installPlugin(connection, m);
      await connection.db
        .updateTable('plugins')
        .set({ status: 'enabled' })
        .where('id', '=', m.id)
        .execute();
    });

    const result = await ensurePluginsStarted(admin);

    expect(counter.activated).toBe(1);
    expect(result.enabled).toEqual(['live-plugin']);
    expect(isLoaded('live-plugin')).toBe(true);
  });

  it('何度呼んでも activate は1度だけ', async () => {
    // リクエストごとに activate を呼ぶと、登録が積み重なってメニューが増殖する。
    const counter = { activated: 0 };
    const m = manifest('live-plugin');
    discovery = { plugins: [{ manifest: m, plugin: countingPlugin(counter) }], problems: [] };
    await withConnection(async (connection) => {
      await installPlugin(connection, m);
      await connection.db
        .updateTable('plugins')
        .set({ status: 'enabled' })
        .where('id', '=', m.id)
        .execute();
    });

    await ensurePluginsStarted(admin);
    await ensurePluginsStarted(admin);
    await ensurePluginsStarted(admin);

    expect(counter.activated).toBe(1);
    expect(collectMenus(new Set())).toHaveLength(1);
  });

  it('同時に呼んでも activate は1度だけ', async () => {
    const counter = { activated: 0 };
    const m = manifest('live-plugin');
    discovery = { plugins: [{ manifest: m, plugin: countingPlugin(counter) }], problems: [] };
    await withConnection(async (connection) => {
      await installPlugin(connection, m);
      await connection.db
        .updateTable('plugins')
        .set({ status: 'enabled' })
        .where('id', '=', m.id)
        .execute();
    });

    await Promise.all([
      ensurePluginsStarted(admin),
      ensurePluginsStarted(admin),
      ensurePluginsStarted(admin),
    ]);

    expect(counter.activated).toBe(1);
  });

  it('1つが失敗しても他は動く', async () => {
    // Plugin ひとつの不具合で Torifune 全体が使えなくなるのは重すぎる。
    const counter = { activated: 0 };
    const broken = manifest('broken-plugin');
    const good = manifest('good-plugin');

    discovery = {
      plugins: [
        {
          manifest: broken,
          plugin: {
            activate: () => {
              throw new Error('壊れている');
            },
          },
        },
        { manifest: good, plugin: countingPlugin(counter) },
      ],
      problems: [],
    };

    await withConnection(async (connection) => {
      await installPlugin(connection, broken);
      await installPlugin(connection, good);
      await connection.db.updateTable('plugins').set({ status: 'enabled' }).execute();
    });

    const result = await ensurePluginsStarted(admin);

    expect(result.enabled).toEqual(['good-plugin']);
    expect(result.failed.map((f) => f.pluginId)).toEqual(['broken-plugin']);
    expect(isLoaded('good-plugin')).toBe(true);
  });

  it('読み込めなかったものを黙って捨てない', async () => {
    // 管理画面で見せるため、起動結果に残す。
    discovery = {
      plugins: [],
      problems: [{ pluginId: 'bad-plugin', message: 'id: 形式が不正' }],
    };

    const result = await ensurePluginsStarted(admin);

    expect(result.problems).toEqual([{ pluginId: 'bad-plugin', message: 'id: 形式が不正' }]);
  });

  it('依存を満たさない Plugin は起動しない', async () => {
    const dependent = manifest('needs-base', { dependencies: { 'base-plugin': '^2.0.0' } });
    const base = manifest('base-plugin', { version: '1.0.0' });
    const counter = { activated: 0 };

    discovery = {
      plugins: [
        { manifest: base, plugin: countingPlugin({ activated: 0 }) },
        { manifest: dependent, plugin: countingPlugin(counter) },
      ],
      problems: [],
    };

    await withConnection(async (connection) => {
      await installPlugin(connection, base);
      await installPlugin(connection, dependent);
      await connection.db.updateTable('plugins').set({ status: 'enabled' }).execute();
    });

    const result = await ensurePluginsStarted(admin);

    expect(counter.activated).toBe(0);
    expect(result.failed.map((f) => f.pluginId)).toEqual(['needs-base']);
    expect(result.failed[0]?.reason).toContain('範囲外');
  });

  it('起動に失敗した Plugin は disabled になる', async () => {
    const m = manifest('broken-plugin');
    discovery = {
      plugins: [
        {
          manifest: m,
          plugin: {
            activate: () => {
              throw new Error('壊れている');
            },
          },
        },
      ],
      problems: [],
    };

    await withConnection(async (connection) => {
      await installPlugin(connection, m);
      await connection.db.updateTable('plugins').set({ status: 'enabled' }).execute();
    });

    await ensurePluginsStarted(admin);

    const row = await withConnection((c) =>
      c.db.selectFrom('plugins').select('status').where('id', '=', m.id).executeTakeFirst(),
    );
    expect(row?.status).toBe('disabled');
  });
});

describe('再起動', () => {
  it('resetPluginRuntime のあとは読み込み直す', async () => {
    // 有効・無効を切り替えた直後に反映されないと、
    // 管理画面の操作が効いていないように見える。
    const counter = { activated: 0 };
    const m = manifest('live-plugin');
    discovery = { plugins: [{ manifest: m, plugin: countingPlugin(counter) }], problems: [] };
    await withConnection(async (connection) => {
      await installPlugin(connection, m);
      await connection.db
        .updateTable('plugins')
        .set({ status: 'enabled' })
        .where('id', '=', m.id)
        .execute();
    });

    await ensurePluginsStarted(admin);
    resetPluginRuntime();
    await ensurePluginsStarted(admin);

    expect(counter.activated).toBe(2);
    // 登録は捨ててから読み直すので、増殖しない。
    expect(collectMenus(new Set())).toHaveLength(1);
  });
});
