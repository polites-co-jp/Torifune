import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import {
  listPermissions,
  resetPermissionRegistry,
} from '@/application/authorization/permission-registry';
import { emit, resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import type { DependencyCandidate } from './dependencies';
import {
  disablePlugin,
  enablePlugin,
  findPluginRecord,
  installPlugin,
  uninstallPlugin,
} from './lifecycle';
import {
  collectExtensions,
  collectMenus,
  collectWidgets,
  findPage,
  isLoaded,
  loadedPlugin,
  resetPluginRegistry,
} from './registry';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function manifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1, ...overrides };
}

/** テスト用の Plugin。activate で何を登録したかを記録する。 */
function testPlugin(options: {
  onActivate?: (context: Parameters<Plugin['activate']>[0]) => void | Promise<void>;
  onDeactivate?: () => void;
  throwOnActivate?: boolean;
}): Plugin {
  return {
    async activate(context) {
      if (options.throwOnActivate === true) {
        throw new Error('意図的な失敗');
      }
      await options.onActivate?.(context);
    },
    deactivate() {
      options.onDeactivate?.();
    },
  };
}

function candidatesOf(
  ...entries: readonly [PluginManifest, boolean][]
): Map<string, DependencyCandidate> {
  return new Map(entries.map(([m, enabled]) => [m.id, { manifest: m, enabled }]));
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `l${suffix}`,
        email: `l${suffix}@example.com`,
        display_name: 'lifecycle test',
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
    loginId: `l${suffix}`,
    displayName: 'lifecycle test',
    email: `l${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** 有効化のヘルパ。 */
async function enable(
  m: PluginManifest,
  plugin: Plugin,
  candidates = candidatesOf([m, false]),
): Promise<{ ok: boolean; reason?: string }> {
  return withConnection((connection) =>
    enablePlugin({ connection, manifest: m, plugin, authorization: admin, candidates }),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('lifecycle');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  resetPluginRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('導入', () => {
  it('導入すると installed になる', async () => {
    const m = manifest('sample-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    const record = await withConnection((c) => findPluginRecord(c, 'sample-plugin'));
    expect(record).toMatchObject({ id: 'sample-plugin', version: '1.0.0', status: 'installed' });
  });

  it('二重に導入しても行が増えない', async () => {
    const m = manifest('sample-plugin');
    await withConnection((connection) => installPlugin(connection, m));
    await withConnection((connection) => installPlugin(connection, m));

    const rows = await withConnection((c) => c.db.selectFrom('plugins').selectAll().execute());
    expect(rows).toHaveLength(1);
  });

  it('導入し直しても状態を変えない', async () => {
    // 有効なものを導入し直して勝手に無効化されると困る。
    const m = manifest('sample-plugin');
    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, testPlugin({}));

    await withConnection((connection) =>
      installPlugin(connection, manifest('sample-plugin', { version: '1.1.0' })),
    );

    const record = await withConnection((c) => findPluginRecord(c, 'sample-plugin'));
    expect(record?.status).toBe('enabled');
    expect(record?.version).toBe('1.1.0');
  });
});

describe('有効化', () => {
  it('有効化すると enabled になり activate が呼ばれる', async () => {
    let activated = false;
    const m = manifest('sample-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(
      m,
      testPlugin({
        onActivate: () => {
          activated = true;
        },
      }),
    );

    expect(outcome.ok).toBe(true);
    expect(activated).toBe(true);
    expect(isLoaded('sample-plugin')).toBe(true);

    const record = await withConnection((c) => findPluginRecord(c, 'sample-plugin'));
    expect(record?.status).toBe('enabled');
  });

  it('activate が例外を投げても本体は動き続ける', async () => {
    const m = manifest('broken-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, testPlugin({ throwOnActivate: true }));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('有効化に失敗した');
  });

  it('例外を投げた Plugin は disabled になる', async () => {
    const m = manifest('broken-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, testPlugin({ throwOnActivate: true }));

    const record = await withConnection((c) => findPluginRecord(c, 'broken-plugin'));
    expect(record?.status).toBe('disabled');
    expect(isLoaded('broken-plugin')).toBe(false);
  });
});

describe('無効化', () => {
  it('deactivate が呼ばれ、disabled になる', async () => {
    let deactivated = false;
    const m = manifest('sample-plugin');
    const plugin = testPlugin({
      onDeactivate: () => {
        deactivated = true;
      },
    });

    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);

    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin,
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );

    expect(deactivated).toBe(true);
    expect(isLoaded('sample-plugin')).toBe(false);

    const record = await withConnection((c) => findPluginRecord(c, 'sample-plugin'));
    expect(record?.status).toBe('disabled');
  });

  it('登録した UI 拡張がすべて消える', async () => {
    const m = manifest('ui-plugin');
    const plugin = testPlugin({
      onActivate: (context) => {
        context.ui.registerMenu({ label: 'SEO', route: '/plugins/ui-plugin' });
        context.ui.registerWidget({ location: 'dashboard', component: () => null });
      },
    });

    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);
    expect(collectMenus(new Set())).toHaveLength(1);

    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin,
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );

    expect(collectMenus(new Set())).toHaveLength(0);
    expect(collectWidgets('dashboard', new Set())).toHaveLength(0);
  });

  it('deactivate が例外を投げても無効化できる', async () => {
    // 止めると、壊れた Plugin を外せなくなる。
    const m = manifest('bad-deactivate');
    const plugin: Plugin = {
      activate: () => undefined,
      deactivate: () => {
        throw new Error('後始末に失敗');
      },
    };

    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);

    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin,
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );

    const record = await withConnection((c) => findPluginRecord(c, 'bad-deactivate'));
    expect(record?.status).toBe('disabled');
  });

  it('依存されている Plugin を無効化すると、依存元も無効化される', async () => {
    // 依存先が消えたまま動くと、Plugin が実行時に壊れる。
    const base = manifest('base-plugin');
    const dependent = manifest('dependent-plugin', { dependencies: { 'base-plugin': '*' } });

    await withConnection(async (connection) => {
      await installPlugin(connection, base);
      await installPlugin(connection, dependent);
    });

    const candidates = candidatesOf([base, false], [dependent, false]);
    await enable(base, testPlugin({}), candidates);
    candidates.set('base-plugin', { manifest: base, enabled: true });
    await enable(dependent, testPlugin({}), candidates);
    candidates.set('dependent-plugin', { manifest: dependent, enabled: true });

    const disabled = await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: base,
        plugin: testPlugin({}),
        authorization: admin,
        candidates,
      }),
    );

    expect(disabled).toContain('dependent-plugin');
    expect(disabled).toContain('base-plugin');

    const record = await withConnection((c) => findPluginRecord(c, 'dependent-plugin'));
    expect(record?.status).toBe('disabled');
  });
});

describe('依存関係', () => {
  it('依存 Plugin が導入されていなければ有効化しない', async () => {
    const m = manifest('needs-base', { dependencies: { 'base-plugin': '*' } });
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, testPlugin({}), candidatesOf([m, false]));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('導入されていない');
  });

  it('依存 Plugin が無効なら有効化しない', async () => {
    const base = manifest('base-plugin');
    const m = manifest('needs-base', { dependencies: { 'base-plugin': '*' } });

    const outcome = await enable(m, testPlugin({}), candidatesOf([base, false], [m, false]));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('無効');
  });

  it('バージョンが範囲外なら有効化しない', async () => {
    const base = manifest('base-plugin', { version: '1.0.0' });
    const m = manifest('needs-base', { dependencies: { 'base-plugin': '^2.0.0' } });

    const outcome = await enable(m, testPlugin({}), candidatesOf([base, true], [m, false]));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('範囲外');
  });

  it('循環依存を検出して有効化しない', async () => {
    const a = manifest('cycle-a', { dependencies: { 'cycle-b': '*' } });
    const b = manifest('cycle-b', { dependencies: { 'cycle-a': '*' } });

    const outcome = await enable(a, testPlugin({}), candidatesOf([a, false], [b, true]));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('循環');
  });

  it('依存を満たせば有効化できる', async () => {
    const base = manifest('base-plugin', { version: '1.2.0' });
    const m = manifest('needs-base', { dependencies: { 'base-plugin': '^1.0.0' } });
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, testPlugin({}), candidatesOf([base, true], [m, false]));

    expect(outcome.ok).toBe(true);
  });
});

describe('UI 拡張', () => {
  it('メニュー・Widget・拡張点を登録できる', async () => {
    const m = manifest('ui-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(
      m,
      testPlugin({
        onActivate: (context) => {
          context.ui.registerMenu({ label: 'SEO', route: '/plugins/ui-plugin', order: 10 });
          context.ui.registerWidget({ location: 'dashboard', component: () => null });
          context.ui.registerExtension({ point: 'site.edit.sidebar', component: () => null });
          context.ui.defineExtensionPoint('ui-plugin.report.footer');
        },
      }),
    );

    expect(collectMenus(new Set()).map((menu) => menu.label)).toEqual(['SEO']);
    expect(collectWidgets('dashboard', new Set())).toHaveLength(1);
    expect(collectExtensions('site.edit.sidebar', new Set())).toHaveLength(1);
  });

  it('Permission を持たないユーザーにメニューが出ない', async () => {
    const m = manifest('ui-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(
      m,
      testPlugin({
        onActivate: (context) => {
          context.ui.registerMenu({
            label: 'SEO',
            route: '/plugins/ui-plugin',
            permission: 'site.read',
          });
        },
      }),
    );

    expect(collectMenus(new Set())).toHaveLength(0);
    expect(collectMenus(new Set(['site.read']))).toHaveLength(1);
  });

  it('並び順を指定できる', async () => {
    const m = manifest('ui-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(
      m,
      testPlugin({
        onActivate: (context) => {
          context.ui.registerMenu({ label: 'Second', route: '/plugins/ui-plugin/b', order: 20 });
          context.ui.registerMenu({ label: 'First', route: '/plugins/ui-plugin/a', order: 10 });
        },
      }),
    );

    expect(collectMenus(new Set()).map((menu) => menu.label)).toEqual(['First', 'Second']);
  });

  it('ページをルートで引ける', async () => {
    const m = manifest('ui-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(
      m,
      testPlugin({
        onActivate: (context) => {
          context.ui.registerPage({ route: '/plugins/ui-plugin', component: () => null });
          context.ui.registerPage({
            route: '/plugins/ui-plugin/reports',
            component: () => null,
          });
        },
      }),
    );

    expect(findPage('ui-plugin', '/plugins/ui-plugin')).not.toBeNull();
    expect(findPage('ui-plugin', '/plugins/ui-plugin/reports')).not.toBeNull();
    // 前方一致で、より長いルートが選ばれる。
    expect(findPage('ui-plugin', '/plugins/ui-plugin/reports/1')?.route).toBe(
      '/plugins/ui-plugin/reports',
    );
    expect(findPage('ui-plugin', '/plugins/ui-plugin/unknown-x')).not.toBeNull();
    expect(findPage('other-plugin', '/plugins/ui-plugin')).toBeNull();
  });
});

describe('イベント', () => {
  it('購読でき、無効化すると解除される', async () => {
    const received: unknown[] = [];
    const m = manifest('event-plugin');
    const plugin = testPlugin({
      onActivate: (context) => {
        context.events.subscribe('site.created', (payload) => {
          received.push(payload);
        });
      },
    });

    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);

    await emit('site.created', { siteId: '1' });
    expect(received).toHaveLength(1);

    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin,
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );

    await emit('site.created', { siteId: '2' });
    // 解除しないと、無効化したはずの Plugin がイベントに反応し続ける。
    expect(received).toHaveLength(1);
  });

  it('Core のイベント名を Plugin から発火できない', async () => {
    // 騙れると、他の Plugin を誤作動させられる。
    let error: Error | null = null;
    const m = manifest('event-plugin');

    await withConnection((connection) => installPlugin(connection, m));
    await enable(
      m,
      testPlugin({
        onActivate: async (context) => {
          error = await context.events
            .emit('site.created', {})
            .then(() => null)
            .catch((e: unknown) => e as Error);
        },
      }),
    );

    expect(error).not.toBeNull();
    expect((error as unknown as Error).message).toContain('Core のイベント');
  });

  it('自分の名前空間のイベントは発火できる', async () => {
    const received: unknown[] = [];
    const m = manifest('event-plugin');

    await withConnection((connection) => installPlugin(connection, m));
    await enable(
      m,
      testPlugin({
        onActivate: async (context) => {
          context.events.subscribe('event-plugin.done', (payload) => {
            received.push(payload);
          });
          await context.events.emit('event-plugin.done', { ok: true });
        },
      }),
    );

    expect(received).toEqual([{ ok: true }]);
  });

  it('Plugin のハンドラが例外を投げても発火元が成功する', async () => {
    // Plugin ひとつの不具合で本体の処理が失敗すると、
    // 「サイトを作れない」といった形で利用者に跳ね返る。
    const m = manifest('event-plugin');
    const other: unknown[] = [];

    await withConnection((connection) => installPlugin(connection, m));
    await enable(
      m,
      testPlugin({
        onActivate: (context) => {
          context.events.subscribe('site.created', () => {
            throw new Error('ハンドラが壊れている');
          });
          context.events.subscribe('site.created', (payload) => {
            other.push(payload);
          });
        },
      }),
    );

    await expect(emit('site.created', { siteId: '1' })).resolves.toBeUndefined();
    // 後続のハンドラも止まらない。
    expect(other).toHaveLength(1);
  });

  it('他の Plugin の名前空間では発火できない', async () => {
    let error: Error | null = null;
    const m = manifest('event-plugin');

    await withConnection((connection) => installPlugin(connection, m));
    await enable(
      m,
      testPlugin({
        onActivate: async (context) => {
          error = await context.events
            .emit('other-plugin.done', {})
            .then(() => null)
            .catch((e: unknown) => e as Error);
        },
      }),
    );

    expect(error).not.toBeNull();
  });
});

describe('Permission', () => {
  it('Plugin が Permission を登録できる', async () => {
    const m = manifest('perm-plugin', { permissions: ['perm-plugin.report.read'] });
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, testPlugin({}));

    expect(listPermissions().map((p) => p.name)).toContain('perm-plugin.report.read');
  });

  it('無効化すると Permission が取り下げられる', async () => {
    const m = manifest('perm-plugin', { permissions: ['perm-plugin.report.read'] });
    const plugin = testPlugin({});
    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);

    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin,
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );

    expect(listPermissions().map((p) => p.name)).not.toContain('perm-plugin.report.read');
  });

  it('system.* は登録できない', async () => {
    // 取らせると、システム管理相当の権限を Plugin が勝手に定義できてしまう。
    const m = manifest('greedy-plugin', { permissions: ['system.takeover'] });
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, testPlugin({}));

    expect(outcome.ok).toBe(false);
    expect(listPermissions().map((p) => p.name)).not.toContain('system.takeover');
  });

  it('Permission を登録できなかった Plugin は disabled になる', async () => {
    // 権限を持たないまま有効化されると、あとで分かりにくい失敗をする。
    const m = manifest('greedy-plugin', { permissions: ['system.takeover'] });
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, testPlugin({}));

    const record = await withConnection((c) => findPluginRecord(c, 'greedy-plugin'));
    expect(record?.status).toBe('disabled');
  });

  it('本体の Permission を宣言しても壊れない', async () => {
    const m = manifest('perm-plugin', { permissions: ['site.read'] });
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, testPlugin({}));

    expect(outcome.ok).toBe(true);
    expect(listPermissions().filter((p) => p.name === 'site.read')).toHaveLength(1);
  });
});

describe('削除', () => {
  it('削除すると行が消える', async () => {
    const m = manifest('sample-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await withConnection((connection) =>
      uninstallPlugin(connection, 'sample-plugin', { deleteData: false }),
    );

    await expect(withConnection((c) => findPluginRecord(c, 'sample-plugin'))).resolves.toBeNull();
  });

  it('データを残す指定なら Store が消えない', async () => {
    const m = manifest('data-plugin');
    await withConnection((connection) => installPlugin(connection, m));
    await enable(
      m,
      testPlugin({
        onActivate: async (context) => {
          await context.store.set('kept', 'value');
        },
      }),
    );

    await withConnection((connection) =>
      uninstallPlugin(connection, 'data-plugin', { deleteData: false }),
    );

    const rows = await withConnection((c) =>
      c.db
        .selectFrom('plugin_store')
        .select('key')
        .where('plugin_id', '=', 'data-plugin')
        .execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it('データを消す指定なら Store も消える', async () => {
    const m = manifest('data-plugin');
    await withConnection((connection) => installPlugin(connection, m));
    await enable(
      m,
      testPlugin({
        onActivate: async (context) => {
          await context.store.set('gone', 'value');
        },
      }),
    );

    await withConnection((connection) =>
      uninstallPlugin(connection, 'data-plugin', { deleteData: true }),
    );

    const rows = await withConnection((c) =>
      c.db
        .selectFrom('plugin_store')
        .select('key')
        .where('plugin_id', '=', 'data-plugin')
        .execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('削除すると読み込み済みからも外れる', async () => {
    const m = manifest('sample-plugin');
    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, testPlugin({}));

    await withConnection((connection) =>
      uninstallPlugin(connection, 'sample-plugin', { deleteData: true }),
    );

    expect(loadedPlugin('sample-plugin')).toBeNull();
  });
});

/**
 * Permission変更・外部認証連携設定変更の監査（04_認証設計.md §26）。
 *
 * ロールの編集は入れていないため（自分へ権限を足す経路を作らない）、
 * 本体の Permission 集合が変わるのは **Plugin が権限を登録・取り下げるときだけ**
 * （015b-settings 設計 §3.4、§3.5）。
 */
describe('セキュリティ監査', () => {
  async function eventsFor(pluginId: string): Promise<{ event: string; change: unknown }[]> {
    return withConnection(async (connection) => {
      const rows = await connection.db
        .selectFrom('auth_audit_logs')
        .select(['event', 'detail'])
        .orderBy('occurred_at')
        .execute();

      return rows
        .filter((row) => (row.detail as { pluginId?: string }).pluginId === pluginId)
        .map((row) => ({
          event: row.event,
          change: (row.detail as { change?: unknown }).change,
        }));
    });
  }

  it('Permission を宣言した Plugin の有効化・無効化を記録する', async () => {
    const m = manifest('perm-audit-plugin', { permissions: ['perm-audit-plugin.read'] });
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, testPlugin({}));
    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin: testPlugin({}),
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );

    expect(await eventsFor('perm-audit-plugin')).toEqual([
      { event: 'permission.changed', change: 'enabled' },
      { event: 'permission.changed', change: 'disabled' },
    ]);
  });

  /** 認証方式が変わったことは、Plugin の有効化ログとは別に残す。 */
  it('認証を差し替える Plugin の有効化を記録する', async () => {
    const m = manifest('auth-audit-plugin', { extensions: ['authentication'] });
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, testPlugin({}));

    expect(await eventsFor('auth-audit-plugin')).toEqual([
      { event: 'auth.provider.changed', change: 'enabled' },
    ]);
  });

  it('権限も認証も宣言しない Plugin では記録しない', async () => {
    const m = manifest('plain-audit-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, testPlugin({}));

    expect(await eventsFor('plain-audit-plugin')).toEqual([]);
  });
});

/**
 * install() / uninstall() フック（03_プラグイン設計.md §12、S-8 #3）。
 *
 * 契約にありながら呼ばれていなかった。
 * `install()` は**導入後の最初の有効化の直前に1度だけ**呼ぶ
 * （020-plugin-registry 設計 §2.5）。導入の瞬間には再ビルド前で、
 * Plugin のコードをまだ読み込めないため。
 */
describe('install / uninstall フック', () => {
  function hookPlugin(calls: string[], options: { failInstall?: boolean } = {}): Plugin {
    return {
      async install() {
        calls.push('install');
        if (options.failInstall === true) {
          throw new Error('初期化に失敗');
        }
      },
      async activate() {
        calls.push('activate');
      },
      async deactivate() {
        calls.push('deactivate');
      },
      async uninstall() {
        calls.push('uninstall');
      },
    };
  }

  it('最初の有効化で install() を1度だけ呼ぶ', async () => {
    const calls: string[] = [];
    const m = manifest('hook-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    await enable(m, hookPlugin(calls));

    // 無効化してから有効化し直しても、install() は増えない。
    await withConnection((connection) =>
      disablePlugin({
        connection,
        manifest: m,
        plugin: hookPlugin(calls),
        authorization: admin,
        candidates: candidatesOf([m, true]),
      }),
    );
    await enable(m, hookPlugin(calls));

    expect(calls.filter((call) => call === 'install')).toHaveLength(1);
    expect(calls[0]).toBe('install');
    expect(calls[1]).toBe('activate');
  });

  /** 初期化に失敗した Plugin を動かすと、あとで分かりにくい失敗をする。 */
  it('install() が失敗したら有効化しない', async () => {
    const calls: string[] = [];
    const m = manifest('failing-install-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, hookPlugin(calls, { failInstall: true }));

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('初期化に失敗');
    // activate まで進まない。
    expect(calls).toEqual(['install']);

    const record = await withConnection((connection) =>
      findPluginRecord(connection, 'failing-install-plugin'),
    );
    expect(record?.status).toBe('disabled');
    // 失敗したので「呼んだ」ことにしない。直して入れ直せば、また呼ばれる。
    expect(record?.installedHookAt).toBeNull();
  });

  it('削除で uninstall() を呼ぶ', async () => {
    const calls: string[] = [];
    const m = manifest('uninstall-hook-plugin');
    const plugin = hookPlugin(calls);
    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);

    await withConnection((connection) =>
      uninstallPlugin(connection, m.id, {
        deleteData: true,
        hook: { manifest: m, plugin, authorization: admin },
      }),
    );

    expect(calls).toContain('uninstall');
  });

  /** 止めると、壊れた Plugin を外せなくなる。 */
  it('uninstall() が失敗しても削除は進む', async () => {
    const m = manifest('broken-uninstall-plugin');
    const plugin: Plugin = {
      async activate() {},
      async uninstall() {
        throw new Error('後始末に失敗');
      },
    };
    await withConnection((connection) => installPlugin(connection, m));
    await enable(m, plugin);

    await withConnection((connection) =>
      uninstallPlugin(connection, m.id, {
        deleteData: true,
        hook: { manifest: m, plugin, authorization: admin },
      }),
    );

    expect(await withConnection((connection) => findPluginRecord(connection, m.id))).toBeNull();
  });

  /** フックを持たない Plugin でも壊れない（どちらも任意）。 */
  it('フックを持たない Plugin でも動く', async () => {
    const m = manifest('no-hook-plugin');
    await withConnection((connection) => installPlugin(connection, m));

    const outcome = await enable(m, testPlugin({}));

    expect(outcome.ok).toBe(true);
  });
});
