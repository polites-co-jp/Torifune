import { generateKeyPairSync, sign as signMessage } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { ForbiddenError, UnauthenticatedError } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { packageChecksum } from '@/domain/plugin/package-signature';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { installPlugin } from '@/plugin/lifecycle';
import type { DiscoveryResult } from '@/plugin/loader';
import { resetPluginRegistry } from '@/plugin/registry';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { validPackageZip } from '@/test-support/zip';
import { installFromRegistry, listRegistryPlugins } from './plugin-use-cases';

/**
 * Registry からの導入の**配線**を確かめる（020-plugin-registry 設計 §2.1 §2.2、受け入れ条件 1-3）。
 *
 * 検証そのもの（checksum・署名）は `domain/plugin/package-signature.test.ts` にある。
 * ここで見るのは「取得 → 検証 → 導入」が繋がっていること、そして
 * **検証が通らなければ何も入らないこと**。検証関数を呼び忘れても単体テストは緑のままなので、
 * ここを押さえないと署名検証は有名無実になる。
 *
 * Registry は「HTTPS で取れる JSON」（設計 §2.1）なので、`fetch` を差し替えれば足りる。
 * 実在の配布元は要らない。
 */

// `plugins/` の走査結果は使わない（Registry からの導入は zip を展開する）。
vi.mock('@/plugin/loader', () => ({
  discoverPlugins: (): DiscoveryResult => ({ plugins: [], problems: [] }),
}));

const REGISTRY_URL = 'https://registry.example.test/index.json';
const DOWNLOAD_URL = 'https://registry.example.test/sample-plugin-1.0.0.zip';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let workDir: string;

/** 配布元の鍵。テストのたびに作る。 */
const keyPair = generateKeyPairSync('ed25519');
const trustedKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
/** 別人の鍵。信頼していない配布元を作るために使う。 */
const otherKeyPair = generateKeyPairSync('ed25519');

function signChecksum(checksum: string, privateKey = keyPair.privateKey): string {
  return signMessage(null, Buffer.from(checksum, 'utf8'), privateKey).toString('base64');
}

interface IndexOverrides {
  readonly sha256?: string;
  readonly signature?: string;
  readonly id?: string;
  readonly version?: string;
  readonly apiVersion?: number | null;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly torifuneVersion?: string | null;
  readonly updatedAt?: string | null;
  readonly permissions?: readonly string[] | null;
}

/** Registry の JSON と配布物を返す `fetch` を仕込む。 */
function serveRegistry(archive: Buffer, overrides: IndexOverrides = {}): void {
  const checksum = packageChecksum(archive);
  const index = {
    plugins: [
      {
        id: overrides.id ?? 'sample-plugin',
        name: 'サンプル',
        version: overrides.version ?? '1.0.0',
        description: 'テスト用',
        downloadUrl: DOWNLOAD_URL,
        sha256: overrides.sha256 ?? checksum,
        signature: overrides.signature ?? signChecksum(checksum),
        publisher: 'registry.example.test',
        ...(overrides.apiVersion === undefined ? {} : { apiVersion: overrides.apiVersion }),
        ...(overrides.dependencies === undefined ? {} : { dependencies: overrides.dependencies }),
        ...(overrides.torifuneVersion === undefined
          ? {}
          : { torifuneVersion: overrides.torifuneVersion }),
        ...(overrides.updatedAt === undefined ? {} : { updatedAt: overrides.updatedAt }),
        ...(overrides.permissions === undefined ? {} : { permissions: overrides.permissions }),
      },
    ],
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === REGISTRY_URL) {
        return new Response(JSON.stringify(index), { status: 200 });
      }
      if (url === DOWNLOAD_URL) {
        return new Response(new Uint8Array(archive), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `r${suffix}`,
        email: `r${suffix}@example.com`,
        display_name: 'registry test',
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
    loginId: `r${suffix}`,
    displayName: 'registry test',
    email: `r${suffix}@example.com`,
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

async function installedIds(): Promise<readonly string[]> {
  const rows = await withConnection((connection) =>
    connection.db.selectFrom('plugins').select(['id']).execute(),
  );
  return rows.map((row) => row.id);
}

/** `plugins/` に何が置かれたか。導入されていなければ空。 */
async function placedDirs(): Promise<readonly string[]> {
  return (await readdir(workDir)).sort();
}

beforeAll(async () => {
  scratch = await useScratchDatabase('pluginregistry');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'torifune-reg-'));
  process.env['TORIFUNE_PLUGINS_DIR'] = workDir;
  process.env['TORIFUNE_PLUGIN_REGISTRY_URL'] = REGISTRY_URL;
  process.env['TORIFUNE_PLUGIN_TRUSTED_KEYS'] = trustedKey;
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env['TORIFUNE_PLUGINS_DIR'];
  delete process.env['TORIFUNE_PLUGIN_REGISTRY_URL'];
  delete process.env['TORIFUNE_PLUGIN_TRUSTED_KEYS'];
  delete process.env['TORIFUNE_VERSION'];
  delete process.env['TORIFUNE_SELF_RESTART'];
  await rm(workDir, { recursive: true, force: true });
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
  it('plugin.manage を持たないユーザーは Registry を見られない', async () => {
    const viewer = await contextFor(['viewer']);
    serveRegistry(validPackageZip());

    await expect(listRegistryPlugins(viewer, { keyword: '' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('plugin.manage を持たないユーザーは Registry から導入できない', async () => {
    const viewer = await contextFor(['viewer']);
    serveRegistry(validPackageZip());

    await expect(installFromRegistry(viewer, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await installedIds()).toEqual([]);
  });

  it('未認証は Registry から導入できない', async () => {
    const anonymous = await anonymousContext();
    serveRegistry(validPackageZip());

    await expect(
      installFromRegistry(anonymous, { pluginId: 'sample-plugin' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(await installedIds()).toEqual([]);
  });
});

describe('取得 → 検証 → 導入', () => {
  it('署名が通れば導入される', async () => {
    serveRegistry(validPackageZip());

    const result = await installFromRegistry(admin, { pluginId: 'sample-plugin' });

    expect(result.operationId).not.toBe('');
    expect(await installedIds()).toEqual(['sample-plugin']);
    expect(await placedDirs()).toEqual(['sample-plugin']);
  });

  it('導入の操作が記録される', async () => {
    serveRegistry(validPackageZip());

    await installFromRegistry(admin, { pluginId: 'sample-plugin' });

    const operations = await withConnection((connection) =>
      connection.db.selectFrom('plugin_operations').selectAll().execute(),
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]?.plugin_id).toBe('sample-plugin');
    expect(operations[0]?.kind).toBe('install');
  });

  it('Registry に無い Plugin は導入できない', async () => {
    serveRegistry(validPackageZip());

    await expect(installFromRegistry(admin, { pluginId: 'unknown-plugin' })).rejects.toThrow();
    expect(await installedIds()).toEqual([]);
  });

  it('Registry が未設定なら導入できない', async () => {
    delete process.env['TORIFUNE_PLUGIN_REGISTRY_URL'];
    serveRegistry(validPackageZip());

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await installedIds()).toEqual([]);
  });
});

/**
 * **検証を通らないものが入らないことを、配線の側から確かめる。**
 * 検証関数を呼び忘れても `package-signature.test.ts` は緑のままになる。
 */
describe('検証を通らなければ入らない', () => {
  it('署名が信頼する鍵で検証できなければ入らない', async () => {
    const archive = validPackageZip();
    serveRegistry(archive, {
      signature: signChecksum(packageChecksum(archive), otherKeyPair.privateKey),
    });

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await installedIds()).toEqual([]);
    expect(await placedDirs()).toEqual([]);
  });

  it('署名が壊れていれば入らない', async () => {
    serveRegistry(validPackageZip(), { signature: 'not-a-signature' });

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await installedIds()).toEqual([]);
    expect(await placedDirs()).toEqual([]);
  });

  it('配布物が記録と一致しなければ入らない（改竄・破損）', async () => {
    // Registry には別の配布物の checksum と署名が載っている状態。
    const declared = packageChecksum(validPackageZip('other-plugin'));
    serveRegistry(validPackageZip(), {
      sha256: declared,
      signature: signChecksum(declared),
    });

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await installedIds()).toEqual([]);
    expect(await placedDirs()).toEqual([]);
  });

  it('信頼する鍵が無ければ入らない', async () => {
    delete process.env['TORIFUNE_PLUGIN_TRUSTED_KEYS'];
    serveRegistry(validPackageZip());

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await installedIds()).toEqual([]);
    expect(await placedDirs()).toEqual([]);
  });

  it('Registry の記載と中身の Plugin ID が違えば入らない', async () => {
    // 署名も checksum も通るが、中身は別の Plugin。
    const archive = validPackageZip('other-plugin');
    serveRegistry(archive, { id: 'sample-plugin' });

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await installedIds()).toEqual([]);
  });

  it('版を下げる更新はできない', async () => {
    await withConnection((connection) =>
      installPlugin(connection, {
        id: 'sample-plugin',
        name: 'サンプル',
        version: '2.0.0',
        apiVersion: 1,
      }),
    );
    serveRegistry(validPackageZip());

    await expect(installFromRegistry(admin, { pluginId: 'sample-plugin' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('一覧', () => {
  it('Registry が未設定なら configured=false を返し、画面を壊さない', async () => {
    delete process.env['TORIFUNE_PLUGIN_REGISTRY_URL'];

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.configured).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('取得できなければ理由を返し、例外にしない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 })),
    );

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.configured).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.error).not.toBeNull();
  });

  it('信頼鍵が無ければ trusted=false を返す（押す前に分かる）', async () => {
    delete process.env['TORIFUNE_PLUGIN_TRUSTED_KEYS'];
    serveRegistry(validPackageZip());

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.trusted).toBe(false);
  });

  it('§15 の保持項目をそのまま返す', async () => {
    serveRegistry(validPackageZip(), {
      apiVersion: 1,
      dependencies: { 'base-plugin': '^1.0.0' },
      torifuneVersion: '^1.0.0',
      updatedAt: '2026-02-01T00:00:00.000Z',
      permissions: ['site.read'],
    });

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.items[0]?.entry.apiVersion).toBe(1);
    expect(result.items[0]?.entry.dependencies).toEqual({ 'base-plugin': '^1.0.0' });
    expect(result.items[0]?.entry.torifuneVersion).toBe('^1.0.0');
    expect(result.items[0]?.entry.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(result.items[0]?.entry.permissions).toEqual(['site.read']);
  });

  /**
   * 更新の導線（03_プラグイン設計.md §13）。
   * zip を上げ直す経路しか無いと、新しい版が出ていることに気づけない。
   */
  it('導入済みより新しい版があれば、更新できると返す', async () => {
    await withConnection((connection) =>
      installPlugin(connection, {
        id: 'sample-plugin',
        name: 'サンプル',
        version: '1.0.0',
        apiVersion: 1,
      }),
    );
    serveRegistry(validPackageZip(), { version: '1.2.0' });

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.items[0]?.compatibility.installedVersion).toBe('1.0.0');
    expect(result.items[0]?.compatibility.updateAvailable).toBe(true);
  });

  it('同じ版が入っていれば更新できると言わない', async () => {
    await withConnection((connection) =>
      installPlugin(connection, {
        id: 'sample-plugin',
        name: 'サンプル',
        version: '1.0.0',
        apiVersion: 1,
      }),
    );
    serveRegistry(validPackageZip());

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.items[0]?.compatibility.updateAvailable).toBe(false);
  });

  it('Plugin API Version が合わないことを導入前に返す', async () => {
    serveRegistry(validPackageZip(), { apiVersion: 99 });

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.items[0]?.compatibility.apiVersion).toBe('unsupported');
    expect(result.items[0]?.compatibility.installable).toBe(false);
  });

  it('依存が足りないことを導入前に返す', async () => {
    serveRegistry(validPackageZip(), { dependencies: { 'base-plugin': '^1.0.0' } });

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.items[0]?.compatibility.dependencies).toEqual([
      { dependsOn: 'base-plugin', required: '^1.0.0', reason: 'missing', actual: null },
    ]);
  });

  it('依存が導入済みなら足りないと言わない', async () => {
    await withConnection(async (connection) => {
      await installPlugin(connection, {
        id: 'base-plugin',
        name: 'base',
        version: '1.2.0',
        apiVersion: 1,
      });
      await connection.db
        .updateTable('plugins')
        .set({ status: 'enabled' })
        .where('id', '=', 'base-plugin')
        .execute();
    });
    serveRegistry(validPackageZip(), { dependencies: { 'base-plugin': '^1.0.0' } });

    const result = await listRegistryPlugins(admin, { keyword: '' });

    expect(result.items[0]?.compatibility.dependencies).toEqual([]);
  });

  it('キーワードで絞れる', async () => {
    serveRegistry(validPackageZip());

    const hit = await listRegistryPlugins(admin, { keyword: 'サンプル' });
    const miss = await listRegistryPlugins(admin, { keyword: 'まったく別の語' });

    expect(hit.items).toHaveLength(1);
    expect(miss.items).toEqual([]);
  });
});
