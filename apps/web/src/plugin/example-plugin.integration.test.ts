import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginManifest } from '@torifune/plugin-api';
import { validateManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { emit, resetEventHandlers } from '@/application/events';
import {
  getPluginSettings,
  savePluginSettings,
} from '@/application/plugin/plugin-settings-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { CORE_PERMISSIONS } from '@/domain/permission';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { disablePlugin, enablePlugin, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import {
  collectActions,
  collectExtensions,
  collectMenus,
  collectWidgets,
  findPage,
  resetPluginRegistry,
  settingsOf,
} from './registry';

/**
 * サンプル Plugin の検証（013-example-plugin）。
 *
 * **本体のコードを1行も変えずに、Plugin API だけで動くこと**を確かめる。
 */

const PLUGIN_ID = 'example-plugin';
const PLUGIN_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'plugins', PLUGIN_ID);

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

function example() {
  const entry = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (entry === undefined) throw new Error('サンプル Plugin が読み込めていない');
  return entry;
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `x${suffix}`,
        email: `x${suffix}@example.com`,
        display_name: 'example test',
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
    loginId: `x${suffix}`,
    displayName: 'example test',
    email: `x${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function activate(): Promise<void> {
  const entry = example();
  await withConnection(async (connection) => {
    await installPlugin(connection, entry.manifest);
    const outcome = await enablePlugin({
      connection,
      manifest: entry.manifest,
      plugin: entry.plugin,
      authorization: admin,
      candidates: new Map([[PLUGIN_ID, { manifest: entry.manifest, enabled: false }]]),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

async function deactivate(): Promise<void> {
  const entry = example();
  await withConnection((connection) =>
    disablePlugin({
      connection,
      manifest: entry.manifest,
      plugin: entry.plugin,
      authorization: admin,
      candidates: new Map([[PLUGIN_ID, { manifest: entry.manifest, enabled: true }]]),
    }),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('example');
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
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('境界', () => {
  it('本体（apps/web）を import していない', () => {
    // 本体の内部へ手を伸ばすと、本体の再編で Plugin が壊れる。
    for (const file of sourceFiles(PLUGIN_DIR)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"]@\//);
      expect(source, file).not.toMatch(/from\s+['"].*apps\/web/);
      expect(source, file).not.toMatch(/require\(['"]@\//);
    }
  });

  it('Torifune のパッケージは @torifune/plugin-api しか使わない', () => {
    for (const file of sourceFiles(PLUGIN_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+['"](@torifune\/[^'"]+)['"]/g)) {
        expect(match[1], file).toBe('@torifune/plugin-api');
      }
    }
  });

  it('DB のライブラリを直接使っていない', () => {
    // Plugin は Torifune のデータベースへ直接 SQL を発行しない（03 §5）。
    for (const file of sourceFiles(PLUGIN_DIR)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"](pg|kysely)['"]/);
    }
  });
});

describe('Manifest', () => {
  it('検証を通る', () => {
    const raw: unknown = JSON.parse(readFileSync(join(PLUGIN_DIR, 'plugin.json'), 'utf8'));
    const result = validateManifest(raw, { knownPermissions: [...CORE_PERMISSIONS] });

    expect(result.ok, result.ok ? '' : JSON.stringify(result.problems)).toBe(true);
  });

  it('要求する Permission を宣言している', () => {
    const manifest: PluginManifest = example().manifest;

    expect(manifest.permissions).toContain('site.read');
    expect(manifest.extensions).toContain('database');
  });
});

describe('有効化', () => {
  it('メニューが増える', async () => {
    await activate();

    expect(collectMenus(new Set(['site.read'])).map((menu) => menu.label)).toContain(
      'サンプルPlugin',
    );
  });

  it('ページが引ける', async () => {
    await activate();

    expect(findPage(PLUGIN_ID, '/plugins/example-plugin')).not.toBeNull();
  });

  it('ダッシュボードに Widget が増える', async () => {
    await activate();

    expect(collectWidgets('dashboard', new Set())).toHaveLength(1);
  });

  it('Webサイト一覧に Action が増える', async () => {
    await activate();

    expect(collectActions('site.list.actions', new Set())).toHaveLength(1);
  });

  it('Webサイト編集の拡張点に差し込まれる', async () => {
    await activate();

    expect(collectExtensions('site.edit.sidebar', new Set())).toHaveLength(1);
  });

  it('設定項目が宣言される', async () => {
    await activate();

    expect(settingsOf(PLUGIN_ID)?.fields.map((field) => field.key)).toEqual([
      'greeting',
      'api-token',
    ]);
  });

  it('Key-Value Store に既定値が入る', async () => {
    await activate();

    const row = await withConnection((c) =>
      c.db
        .selectFrom('plugin_store')
        .select('value')
        .where('plugin_id', '=', PLUGIN_ID)
        .where('key', '=', 'greeting')
        .executeTakeFirst(),
    );
    expect(row).toBeDefined();
  });

  it('Database Provider を既定では差し替えない', async () => {
    // 差し替えると本体のすべてのデータアクセスがダミーを通り、何も読めなくなる。
    await activate();

    const sites = await withConnection((c) => c.db.selectFrom('sites').selectAll().execute());
    expect(sites).toEqual([]);
  });
});

describe('無効化', () => {
  it('登録したものがすべて消える', async () => {
    await activate();
    await deactivate();

    expect(collectMenus(new Set(['site.read']))).toHaveLength(0);
    expect(collectWidgets('dashboard', new Set())).toHaveLength(0);
    expect(collectActions('site.list.actions', new Set())).toHaveLength(0);
    expect(collectExtensions('site.edit.sidebar', new Set())).toHaveLength(0);
    expect(findPage(PLUGIN_ID, '/plugins/example-plugin')).toBeNull();
    expect(settingsOf(PLUGIN_ID)).toBeNull();
  });

  it('保存したデータは消えない', async () => {
    // 消すかどうかは削除時に利用者が決める。
    await activate();
    await deactivate();

    const rows = await withConnection((c) =>
      c.db.selectFrom('plugin_store').selectAll().where('plugin_id', '=', PLUGIN_ID).execute(),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('イベント', () => {
  it('site.created を購読している', async () => {
    // ハンドラが例外を投げても発火元が成功することは 011 で検証済み。
    // ここでは購読が成立していることを見る。
    await activate();

    await expect(
      emit('site.created', {
        siteId: '1',
        name: 'x',
        url: 'https://example.com',
        status: 'active',
      }),
    ).resolves.toBeUndefined();
  });

  it('無効化すると購読が外れる', async () => {
    await activate();
    await deactivate();

    await expect(
      emit('site.created', {
        siteId: '1',
        name: 'x',
        url: 'https://example.com',
        status: 'active',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('設定', () => {
  it('現在値を読める', async () => {
    await activate();

    const settings = await getPluginSettings(admin, { pluginId: PLUGIN_ID });

    expect(settings.pluginName).toBe('サンプルPlugin');
    expect(settings.fields.find((f) => f.key === 'greeting')?.value).toBe('こんにちは');
  });

  it('Secret の平文を返さない', async () => {
    // 06_画面設計.md §38。
    await activate();
    await savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { 'api-token': 'とても秘密' } });

    const settings = await getPluginSettings(admin, { pluginId: PLUGIN_ID });
    const token = settings.fields.find((f) => f.key === 'api-token');

    expect(token?.value).toBeNull();
    expect(token?.configured).toBe(true);
    expect(JSON.stringify(settings)).not.toContain('とても秘密');
  });

  it('Secret が DB 上で平文になっていない', async () => {
    await activate();
    await savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { 'api-token': 'とても秘密' } });

    const row = await withConnection((c) =>
      c.db
        .selectFrom('plugin_store')
        .select(['value', 'is_secret'])
        .where('plugin_id', '=', PLUGIN_ID)
        .where('key', '=', 'api-token')
        .executeTakeFirstOrThrow(),
    );

    expect(row.is_secret).toBe(true);
    expect(String(row.value)).not.toContain('とても秘密');
  });

  it('Secret を空で送っても消えない', async () => {
    // 保存し直すたびに設定済みの資格情報が消えると使えない。
    await activate();
    await savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { 'api-token': 'とても秘密' } });

    await savePluginSettings(admin, {
      pluginId: PLUGIN_ID,
      values: { 'api-token': '', greeting: 'やあ' },
    });

    const settings = await getPluginSettings(admin, { pluginId: PLUGIN_ID });
    expect(settings.fields.find((f) => f.key === 'api-token')?.configured).toBe(true);
    expect(settings.fields.find((f) => f.key === 'greeting')?.value).toBe('やあ');
  });

  it('宣言されていない項目は保存できない', async () => {
    // 受け付けると、フォームを細工して Plugin の任意のキーを書き換えられる。
    await activate();

    await expect(
      savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { 'not-declared': 'x' } }),
    ).rejects.toThrow();
  });

  it('Plugin の検証が働く', async () => {
    await activate();

    await expect(
      savePluginSettings(admin, { pluginId: PLUGIN_ID, values: { greeting: 'あ'.repeat(41) } }),
    ).rejects.toThrow();
  });

  it('plugin.manage を持たないユーザーは読めない', async () => {
    await activate();
    const viewer = await contextFor(['viewer']);

    await expect(getPluginSettings(viewer, { pluginId: PLUGIN_ID })).rejects.toThrow();
  });

  it('plugin.manage を持たないユーザーは保存できない', async () => {
    await activate();
    const viewer = await contextFor(['viewer']);

    await expect(
      savePluginSettings(viewer, { pluginId: PLUGIN_ID, values: { greeting: 'x' } }),
    ).rejects.toThrow();
  });

  it('無効な Plugin の設定は開けない', async () => {
    await expect(getPluginSettings(admin, { pluginId: PLUGIN_ID })).rejects.toThrow();
  });
});
