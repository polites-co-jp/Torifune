import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { ForbiddenError, UnauthenticatedError } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import type { DiscoveryResult } from '@/plugin/loader';
import { installPlugin } from '@/plugin/lifecycle';
import { findOperation } from '@/plugin/operations';
import { resetPluginRegistry } from '@/plugin/registry';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { validPackageZip } from '@/test-support/zip';
import {
  disablePluginUseCase,
  enablePluginUseCase,
  getPluginOperation,
  inspectPluginPackage,
  installPluginPackage,
  installPluginUseCase,
  listPlugins,
  uninstallPluginUseCase,
} from './plugin-use-cases';

// `plugins/` の走査結果を差し替える。
vi.mock('@/plugin/loader', () => ({
  discoverPlugins: (): DiscoveryResult => discovery,
}));

let discovery: DiscoveryResult = { plugins: [], problems: [] };
let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let workDir: string;

function manifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1, ...overrides };
}

function discovered(...manifests: readonly PluginManifest[]): DiscoveryResult {
  return {
    plugins: manifests.map((m) => ({ manifest: m, plugin: { activate: () => undefined } })),
    problems: [],
  };
}

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

async function anonymousContext(): Promise<AuthorizationContext> {
  return withConnection(async (connection) => ({
    identity: null,
    permissions: new Set<string>(),
    connection,
  }));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('pluginmgr');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'torifune-mgr-'));
  process.env['TORIFUNE_PLUGINS_DIR'] = workDir;
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  delete process.env['TORIFUNE_PLUGINS_DIR'];
  delete process.env['TORIFUNE_SELF_RESTART'];
  await rm(workDir, { recursive: true, force: true });
  discovery = { plugins: [], problems: [] };
  resetPluginRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('plugin_operations').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('認可', () => {
  it('plugin.manage を持たないユーザーは一覧を取れない', async () => {
    const viewer = await contextFor(['viewer']);

    await expect(listPlugins(viewer, undefined)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('未認証は一覧を取れない', async () => {
    const anonymous = await anonymousContext();

    await expect(listPlugins(anonymous, undefined)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('plugin.manage を持たないユーザーは有効化できない', async () => {
    const viewer = await contextFor(['viewer']);
    discovery = discovered(manifest('sample-plugin'));

    await expect(enablePluginUseCase(viewer, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('plugin.manage を持たないユーザーは導入できない', async () => {
    const viewer = await contextFor(['viewer']);
    discovery = discovered(manifest('sample-plugin'));

    await expect(
      installPluginUseCase(viewer, { pluginId: 'sample-plugin' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('plugin.manage を持たないユーザーは Package を検証できない', async () => {
    // 検証だけでも、どんな Plugin があるかを試せてしまう。
    const viewer = await contextFor(['viewer']);

    await expect(
      inspectPluginPackage(viewer, { archive: validPackageZip() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('plugin.manage を持たないユーザーは削除できない', async () => {
    const viewer = await contextFor(['viewer']);

    await expect(
      uninstallPluginUseCase(viewer, {
        pluginId: 'sample-plugin',
        deleteData: false,
        deleteFiles: true,
        confirm: 'sample-plugin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('plugin.manage を持たないユーザーは操作の状況を見られない', async () => {
    // ID を差し替えても他の操作が見えないようにする。
    const viewer = await contextFor(['viewer']);

    await expect(getPluginOperation(viewer, { id: uuidv7() })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('一覧', () => {
  it('導入済みと検出済みを分けて返す', async () => {
    discovery = discovered(manifest('installed-plugin'), manifest('detected-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('installed-plugin')));

    const result = await listPlugins(admin, undefined);

    expect(result.installed.map((p) => p.id)).toEqual(['installed-plugin']);
    expect(result.detected.map((p) => p.id)).toEqual(['detected-plugin']);
  });

  it('要求 Permission を返す', async () => {
    discovery = discovered(
      manifest('seo-plugin', { permissions: ['site.read', 'seo-plugin.report.read'] }),
    );

    const result = await listPlugins(admin, undefined);

    expect(result.detected[0]?.permissions).toEqual(['site.read', 'seo-plugin.report.read']);
  });

  /**
   * 作者（03_プラグイン設計.md §11 §13）。
   *
   * **誰が作ったものかが分からないまま導入させない。**
   * Manifest の任意項目なので、無ければ null を返す（後方互換）。
   */
  it('作者を返す。宣言が無ければ null', async () => {
    discovery = discovered(
      manifest('authored-plugin', { author: 'example.com' }),
      manifest('anonymous-plugin'),
    );

    const result = await listPlugins(admin, undefined);

    const byId = new Map(result.detected.map((plugin) => [plugin.id, plugin]));
    expect(byId.get('authored-plugin')?.author).toBe('example.com');
    expect(byId.get('anonymous-plugin')?.author).toBeNull();
  });

  it('読み込めなかったものを黙って消さない', async () => {
    discovery = { plugins: [], problems: [{ pluginId: 'broken', message: 'id: 形式が不正' }] };

    const result = await listPlugins(admin, undefined);

    expect(result.problems).toEqual([{ pluginId: 'broken', message: 'id: 形式が不正' }]);
  });

  it('ファイルが消えた Plugin も見せる', async () => {
    // 行だけ残ると、一覧に出ないのに削除もできない状態になる。
    await withConnection((connection) => installPlugin(connection, manifest('ghost-plugin')));

    const result = await listPlugins(admin, undefined);

    expect(result.installed.map((p) => p.id)).toEqual(['ghost-plugin']);
    expect(result.installed[0]?.description).toContain('ファイルが見つからない');
  });
});

describe('有効化・無効化', () => {
  it('有効化すると enabled になる', async () => {
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));

    const result = await enablePluginUseCase(admin, { pluginId: 'sample-plugin' });

    expect(result.ok).toBe(true);
    const list = await listPlugins(admin, undefined);
    expect(list.installed[0]?.status).toBe('enabled');
  });

  it('有効化では再ビルドの操作を作らない', async () => {
    // レジストリはすでにビルドに含まれている。落とす必要が無い。
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));

    await enablePluginUseCase(admin, { pluginId: 'sample-plugin' });

    const operations = await withConnection((c) =>
      c.db.selectFrom('plugin_operations').selectAll().execute(),
    );
    expect(operations).toEqual([]);
  });

  it('依存を満たさなければ有効化できず、理由が返る', async () => {
    discovery = discovered(manifest('needs-base', { dependencies: { 'base-plugin': '*' } }));
    await withConnection((connection) => installPlugin(connection, manifest('needs-base')));

    const result = await enablePluginUseCase(admin, { pluginId: 'needs-base' });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('導入されていない');
  });

  it('無効化すると disabled になる', async () => {
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));
    await enablePluginUseCase(admin, { pluginId: 'sample-plugin' });

    await disablePluginUseCase(admin, { pluginId: 'sample-plugin' });

    const list = await listPlugins(admin, undefined);
    expect(list.installed[0]?.status).toBe('disabled');
  });

  it('依存元も一緒に無効化されたことを返す', async () => {
    const base = manifest('base-plugin');
    const dependent = manifest('dependent-plugin', { dependencies: { 'base-plugin': '*' } });
    discovery = discovered(base, dependent);

    await withConnection(async (connection) => {
      await installPlugin(connection, base);
      await installPlugin(connection, dependent);
    });
    await enablePluginUseCase(admin, { pluginId: 'base-plugin' });
    await enablePluginUseCase(admin, { pluginId: 'dependent-plugin' });

    const result = await disablePluginUseCase(admin, { pluginId: 'base-plugin' });

    expect(result.disabled).toContain('dependent-plugin');
  });

  it('導入されていない Plugin は有効化できない', async () => {
    discovery = discovered(manifest('sample-plugin'));

    await expect(enablePluginUseCase(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('導入（配置済み）', () => {
  it('導入すると installed の行ができる', async () => {
    discovery = discovered(manifest('sample-plugin'));

    const result = await installPluginUseCase(admin, { pluginId: 'sample-plugin' });

    const list = await listPlugins(admin, undefined);
    expect(list.installed[0]?.status).toBe('installed');
    expect(result.operationId).toBeTruthy();
  });

  it('二重に導入できない', async () => {
    discovery = discovered(manifest('sample-plugin'));
    await installPluginUseCase(admin, { pluginId: 'sample-plugin' });

    await expect(installPluginUseCase(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('監視ループが無い環境では落とさない', async () => {
    // 落としても誰も起こしてくれない。
    discovery = discovered(manifest('sample-plugin'));

    const result = await installPluginUseCase(admin, { pluginId: 'sample-plugin' });

    expect(result.willRestart).toBe(false);
    expect(result.message).toContain('pnpm dev');
  });

  it('監視ループがある環境では再起動を予約する', async () => {
    process.env['TORIFUNE_SELF_RESTART'] = '1';
    process.env['TORIFUNE_REBUILD_SENTINEL'] = join(workDir, '.rebuild');
    try {
      discovery = discovered(manifest('sample-plugin'));

      const result = await installPluginUseCase(admin, { pluginId: 'sample-plugin' });

      expect(result.willRestart).toBe(true);
      await expect(stat(join(workDir, '.rebuild'))).resolves.toBeDefined();

      const operation = await withConnection((c) => findOperation(c, result.operationId));
      expect(operation?.status).toBe('restarting');
    } finally {
      delete process.env['TORIFUNE_REBUILD_SENTINEL'];
    }
  });
});

describe('導入（Plugin Package）', () => {
  it('検証だけでは配置しない', async () => {
    // 要求 Permission を見せてから同意させるため、段階を分ける。
    const result = await inspectPluginPackage(admin, { archive: validPackageZip() });

    expect(result.pluginId).toBe('sample-plugin');
    expect(await readdir(workDir)).toEqual([]);
  });

  it('要求 Permission を返す', async () => {
    const archive = validPackageZip('sample-plugin', { permissions: ['site.read'] });

    const result = await inspectPluginPackage(admin, { archive });

    expect(result.permissions).toEqual(['site.read']);
  });

  it('不正な Manifest をビルドに入る前に拒否する', async () => {
    const archive = validPackageZip('sample-plugin', { version: 'いち' });

    await expect(inspectPluginPackage(admin, { archive })).rejects.toBeInstanceOf(ValidationError);
    expect(await readdir(workDir)).toEqual([]);
  });

  it('すでにある Plugin ID を拒否する', async () => {
    // 黙って上書きすると、動いている Plugin が入れ替わる。
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));

    await expect(
      inspectPluginPackage(admin, { archive: validPackageZip() }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('同意したあとに展開して導入する', async () => {
    const archive = validPackageZip();

    const result = await installPluginPackage(admin, {
      archive,
      expectedPluginId: 'sample-plugin',
    });

    expect(result.operationId).toBeTruthy();
    expect((await readdir(join(workDir, 'sample-plugin'))).sort()).toEqual([
      'index.ts',
      'plugin.json',
    ]);

    const list = await listPlugins(admin, undefined);
    // discovery を差し替えているため一覧には出ないが、行はできている。
    expect(list.installed.map((p) => p.id)).toEqual(['sample-plugin']);
  });

  it('同意した Plugin と中身が違えば拒否する', async () => {
    // 同意の直後に別の Plugin へ差し替えられないようにする。
    await expect(
      installPluginPackage(admin, {
        archive: validPackageZip('other-plugin'),
        expectedPluginId: 'sample-plugin',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await readdir(workDir)).toEqual([]);
  });
});

describe('削除', () => {
  it('確認が一致しなければ削除しない', async () => {
    // 押し間違いで消えるものを作らない。
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));

    await expect(
      uninstallPluginUseCase(admin, {
        pluginId: 'sample-plugin',
        deleteData: false,
        deleteFiles: true,
        confirm: 'ちがう',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const list = await listPlugins(admin, undefined);
    expect(list.installed).toHaveLength(1);
  });

  it('削除すると行が消える', async () => {
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));

    await uninstallPluginUseCase(admin, {
      pluginId: 'sample-plugin',
      deleteData: false,
      deleteFiles: false,
      confirm: 'sample-plugin',
    });

    const rows = await withConnection((c) => c.db.selectFrom('plugins').selectAll().execute());
    expect(rows).toEqual([]);
  });

  it('データを残す指定なら Store が消えない', async () => {
    discovery = discovered(manifest('data-plugin'));
    await withConnection(async (connection) => {
      await installPlugin(connection, manifest('data-plugin'));
      await connection.db
        .insertInto('plugin_store')
        .values({ plugin_id: 'data-plugin', key: 'kept', value: '"x"' })
        .execute();
    });

    await uninstallPluginUseCase(admin, {
      pluginId: 'data-plugin',
      deleteData: false,
      deleteFiles: false,
      confirm: 'data-plugin',
    });

    const rows = await withConnection((c) =>
      c.db.selectFrom('plugin_store').selectAll().where('plugin_id', '=', 'data-plugin').execute(),
    );
    expect(rows).toHaveLength(1);
  });

  it('データを消す指定なら Store も消える', async () => {
    discovery = discovered(manifest('data-plugin'));
    await withConnection(async (connection) => {
      await installPlugin(connection, manifest('data-plugin'));
      await connection.db
        .insertInto('plugin_store')
        .values({ plugin_id: 'data-plugin', key: 'gone', value: '"x"' })
        .execute();
    });

    await uninstallPluginUseCase(admin, {
      pluginId: 'data-plugin',
      deleteData: true,
      deleteFiles: false,
      confirm: 'data-plugin',
    });

    const rows = await withConnection((c) =>
      c.db.selectFrom('plugin_store').selectAll().where('plugin_id', '=', 'data-plugin').execute(),
    );
    expect(rows).toEqual([]);
  });

  it('ファイルを残すなら再ビルドしない', async () => {
    // ビルド成果物は変わらない。
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));

    const result = await uninstallPluginUseCase(admin, {
      pluginId: 'sample-plugin',
      deleteData: false,
      deleteFiles: false,
      confirm: 'sample-plugin',
    });

    expect(result.willRestart).toBe(false);
    const operation = await withConnection((c) => findOperation(c, result.operationId));
    expect(operation?.status).toBe('succeeded');
  });

  it('有効な Plugin を削除すると、先に無効化される', async () => {
    discovery = discovered(manifest('sample-plugin'));
    await withConnection((connection) => installPlugin(connection, manifest('sample-plugin')));
    await enablePluginUseCase(admin, { pluginId: 'sample-plugin' });

    await uninstallPluginUseCase(admin, {
      pluginId: 'sample-plugin',
      deleteData: false,
      deleteFiles: false,
      confirm: 'sample-plugin',
    });

    const { isLoaded } = await import('@/plugin/registry');
    expect(isLoaded('sample-plugin')).toBe(false);
  });

  it('導入されていない Plugin は削除できない', async () => {
    await expect(
      uninstallPluginUseCase(admin, {
        pluginId: 'sample-plugin',
        deleteData: false,
        deleteFiles: false,
        confirm: 'sample-plugin',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('操作の状況', () => {
  it('自分が要求した操作を見られる', async () => {
    discovery = discovered(manifest('sample-plugin'));
    const result = await installPluginUseCase(admin, { pluginId: 'sample-plugin' });

    const operation = await getPluginOperation(admin, { id: result.operationId });

    expect(operation.pluginId).toBe('sample-plugin');
    expect(operation.kind).toBe('install');
  });

  it('存在しない操作は 404 相当', async () => {
    await expect(getPluginOperation(admin, { id: uuidv7() })).rejects.toBeInstanceOf(NotFoundError);
  });
});
