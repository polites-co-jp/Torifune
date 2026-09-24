import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, PluginContext, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError } from '@/domain/repository';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import type { DependencyCandidate } from '@/plugin/dependencies';
import type { PluginModuleEntry } from '@/plugin/generated-registry';
import { disablePlugin, enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRegistry } from '@/plugin/registry';
import { resetPluginRuntime } from '@/plugin/runtime';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { getPluginHelpDoc, getPluginHelpIndex, helpLinkOfPlugin } from './plugin-help-use-cases';
import { getPluginSettingsPage } from './plugin-settings-use-cases';
import { listPlugins, type PluginSummary } from './plugin-use-cases';

/**
 * 手順書の UseCase・`helpLinkOfPlugin`・`PluginSummary` の 2 項目・設定画面の組み立て
 * （041-plugin-help-docs 設計 §6.3・§7.5・§7.6・§8・§9.2、受け入れ条件 #31〜#39・#49・#51）。
 *
 * **登録簿（`generated-registry`）だけを差し替え、本物の `discoverPlugins` を走らせる**
 * （#38 が `discoverPlugins` の警告のログを見るため。実装プラン §2「テストの方法」）。
 * 手順書のファイルは `TORIFUNE_PLUGINS_DIR` の一時フォルダに置く。
 *
 * 認可の要点（設計 §8）：
 *
 * * 読み込まれた Plugin の手順書は**認証済みなら誰でも**読める（Permission なしでも）
 * * 読み込まれていない Plugin（検出済み・導入済みで無効）は `plugin.manage` だけ。
 *   持たなければ **`NotFoundError`**（`ForbiddenError` にしない。存在を明かさない）
 * * 未認証は `UnauthenticatedError`
 * * 手順書は利用者ごとのデータを持たない。**ID を差し替えて届いてはならないのは
 *   宣言した `.md` 以外のファイル**（`plugin.json` など）である（#36）
 */

vi.mock('@/plugin/generated-registry', () => ({
  get PLUGIN_MODULES() {
    return modules;
  },
}));

let modules: PluginModuleEntry[] = [];

/** `help-demo/plugin.json` の実ファイルにだけ入れる目印。どの戻り値・例外にも出てはならない。 */
const PLUGIN_JSON_MARKER = 'PLUGIN-JSON-MARKER-7Q';
const FIRST_BODY = '# 最初の手順書\n\n## 手順 1\n\n設定を開く。\n';
const ONLY_BODY = '# 唯一の手順書\n\n本文。\n';

const HELP_DEMO_HELP = [
  { id: 'first', title: '最初の手順書', path: 'help/first.md' },
  // `help/second.md` は置かない（#37：宣言したファイルが無い）。
  { id: 'second', title: '二本目の手順書', path: 'help/second.md' },
];

const SETTINGS = { fields: [{ key: 'endpoint', label: '接続先', kind: 'text' as const }] };

function withSettings(): Plugin {
  return {
    activate(context: PluginContext): void {
      context.ui.registerSettings(SETTINGS);
    },
  };
}

function withoutSettings(): Plugin {
  return { activate: () => undefined };
}

const MANIFESTS: Readonly<Record<string, Record<string, unknown>>> = {
  'help-demo': {
    id: 'help-demo',
    name: '手順書デモ',
    version: '1.2.3',
    apiVersion: 1,
    help: HELP_DEMO_HELP,
  },
  'help-only': {
    id: 'help-only',
    name: '手順書だけ',
    version: '1.0.0',
    apiVersion: 1,
    help: [{ id: 'only', title: '唯一の手順書', path: 'help/only.md' }],
  },
  'settings-only': { id: 'settings-only', name: '設定だけ', version: '1.0.0', apiVersion: 1 },
  plain: { id: 'plain', name: 'どちらも無い', version: '1.0.0', apiVersion: 1 },
  'help-broken': {
    id: 'help-broken',
    name: '形の誤った help',
    version: '1.0.0',
    apiVersion: 1,
    // 041 より前に独自の意味で使われていたかもしれない形（設計 §9.2）。
    help: 'https://example.com',
  },
};

function registryEntries(): PluginModuleEntry[] {
  return [
    { directory: 'help-demo', manifest: MANIFESTS['help-demo'], module: withSettings() },
    { directory: 'help-only', manifest: MANIFESTS['help-only'], module: withoutSettings() },
    { directory: 'settings-only', manifest: MANIFESTS['settings-only'], module: withSettings() },
    { directory: 'plain', manifest: MANIFESTS['plain'], module: withoutSettings() },
    { directory: 'help-broken', manifest: MANIFESTS['help-broken'], module: withoutSettings() },
  ];
}

let scratch: ScratchDatabase;
let workDir: string;
/** `plugin.manage` を持つ利用者。 */
let admin: AuthorizationContext;
/** Permission を 1 つも持たない認証済みの利用者。 */
let nobody: AuthorizationContext;
/** `social.read` などを持つが `plugin.manage` を持たない利用者。 */
let viewer: AuthorizationContext;
let records: LogRecord[];

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `h${suffix}`,
        email: `h${suffix}@example.com`,
        display_name: 'plugin help test',
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
    loginId: `h${suffix}`,
    displayName: 'plugin help test',
    email: `h${suffix}@example.com`,
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

function discovered(pluginId: string): { manifest: PluginManifest; plugin: Plugin } {
  const found = discoverPlugins().plugins.find((entry) => entry.manifest.id === pluginId);
  if (found === undefined) throw new Error(`登録簿に無い: ${pluginId}`);
  return found;
}

function candidatesOf(manifest: PluginManifest, enabled: boolean) {
  return new Map<string, DependencyCandidate>([[manifest.id, { manifest, enabled }]]);
}

/** 導入だけ（導入済み・無効）。 */
async function install(pluginId: string): Promise<void> {
  const { manifest } = discovered(pluginId);
  await withConnection((connection) => installPlugin(connection, manifest));
}

/** 導入して有効化する（読み込まれた状態）。 */
async function enable(pluginId: string): Promise<void> {
  const { manifest, plugin } = discovered(pluginId);
  await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    const outcome = await enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, false),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

/** 有効化の後に無効化する（導入済み・無効）。 */
async function disable(pluginId: string): Promise<void> {
  const { manifest, plugin } = discovered(pluginId);
  await withConnection((connection) =>
    disablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, true),
    }),
  );
}

async function writePluginFiles(): Promise<void> {
  const demo = join(workDir, 'help-demo');
  await mkdir(join(demo, 'help'), { recursive: true });
  await writeFile(
    join(demo, 'plugin.json'),
    JSON.stringify({ ...MANIFESTS['help-demo'], description: PLUGIN_JSON_MARKER }),
    'utf8',
  );
  await writeFile(join(demo, 'index.ts'), `// ${PLUGIN_JSON_MARKER}\n`, 'utf8');
  await writeFile(join(demo, 'README.md'), `# README ${PLUGIN_JSON_MARKER}\n`, 'utf8');
  await writeFile(join(demo, 'help', 'first.md'), FIRST_BODY, 'utf8');
  await writeFile(join(demo, 'help', 'doc.md'), `宣言していない ${PLUGIN_JSON_MARKER}\n`, 'utf8');

  const only = join(workDir, 'help-only');
  await mkdir(join(only, 'help'), { recursive: true });
  await writeFile(join(only, 'help', 'only.md'), ONLY_BODY, 'utf8');

  for (const id of ['settings-only', 'plain', 'help-broken']) {
    await mkdir(join(workDir, id), { recursive: true });
  }
}

function warnings(message: string): LogRecord[] {
  return records.filter((record) => record.level === 'warn' && record.message === message);
}

const DEMO_DOCS = [
  { id: 'first', title: '最初の手順書', href: '/plugins/help-demo/help/first' },
  { id: 'second', title: '二本目の手順書', href: '/plugins/help-demo/help/second' },
];

beforeAll(async () => {
  scratch = await useScratchDatabase('pluginhelp');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  modules = registryEntries();
  workDir = await mkdtemp(join(tmpdir(), 'torifune-help-uc-'));
  process.env['TORIFUNE_PLUGINS_DIR'] = workDir;
  await writePluginFiles();

  records = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });

  admin = await contextFor(['administrator']);
  nobody = await contextFor([]);
  viewer = await contextFor(['viewer']);
});

afterEach(async () => {
  delete process.env['TORIFUNE_PLUGINS_DIR'];
  await rm(workDir, { recursive: true, force: true });
  resetPluginRuntime();
  resetPluginRegistry();
  resetPublisherRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  resetLogger();
  modules = [];
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#31 読み込まれた Plugin の手順書は、Permission を持たない認証済みの利用者でも読める', () => {
  it('#31 本文・pluginName・pluginVersion・docs（宣言の順・href つき）・loaded: true が返る', async () => {
    await enable('help-demo');

    const result = await getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId: 'first' });

    expect(result).toEqual({
      pluginId: 'help-demo',
      pluginName: '手順書デモ',
      pluginVersion: '1.2.3',
      docs: DEMO_DOCS,
      loaded: true,
      doc: {
        id: 'first',
        title: '最初の手順書',
        href: '/plugins/help-demo/help/first',
        path: 'help/first.md',
      },
      content: { ok: true, markdown: FIRST_BODY },
    });
  });

  it('#31 一覧も Permission なしで読め、宣言の順の docs と loaded: true を返す', async () => {
    await enable('help-demo');

    const index = await getPluginHelpIndex(nobody, { pluginId: 'help-demo' });

    expect(index).toEqual({
      pluginId: 'help-demo',
      pluginName: '手順書デモ',
      pluginVersion: '1.2.3',
      docs: DEMO_DOCS,
      loaded: true,
    });
  });

  it('#31 plugin.manage を持たない viewer も読める', async () => {
    await enable('help-demo');

    const result = await getPluginHelpDoc(viewer, { pluginId: 'help-demo', docId: 'first' });

    expect(result.content).toEqual({ ok: true, markdown: FIRST_BODY });
  });

  it('#31 両 UseCase は permission: null で、理由を持つ（中で判定する）', () => {
    expect(getPluginHelpIndex.name).toBe('plugin.help.index');
    expect(getPluginHelpDoc.name).toBe('plugin.help.get');
    expect(getPluginHelpIndex.permission).toBeNull();
    expect(getPluginHelpDoc.permission).toBeNull();
    expect(getPluginHelpIndex.reason).toBeTruthy();
    expect(getPluginHelpDoc.reason).toBeTruthy();
  });
});

describe('#32 未認証', () => {
  it('#32 読み込まれた Plugin でも、一覧は UnauthenticatedError', async () => {
    await enable('help-demo');
    const anonymous = await anonymousContext();

    await expect(getPluginHelpIndex(anonymous, { pluginId: 'help-demo' })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('#32 読み込まれた Plugin でも、本文は UnauthenticatedError', async () => {
    await enable('help-demo');
    const anonymous = await anonymousContext();

    await expect(
      getPluginHelpDoc(anonymous, { pluginId: 'help-demo', docId: 'first' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('#32 存在しない ID でも 404 より先に UnauthenticatedError（存在の有無を明かさない）', async () => {
    const anonymous = await anonymousContext();

    await expect(getPluginHelpIndex(anonymous, { pluginId: 'nonexistent' })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(
      getPluginHelpDoc(anonymous, { pluginId: 'nonexistent', docId: 'first' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('#33 導入済み・無効の Plugin', () => {
  it('#33 有効化の後に無効化 → plugin.manage を持つ利用者は読め、loaded: false', async () => {
    await enable('help-demo');
    await disable('help-demo');

    const result = await getPluginHelpDoc(admin, { pluginId: 'help-demo', docId: 'first' });

    expect(result.loaded).toBe(false);
    expect(result.pluginName).toBe('手順書デモ');
    expect(result.docs).toEqual(DEMO_DOCS);
    expect(result.content).toEqual({ ok: true, markdown: FIRST_BODY });
  });

  it('#33 導入だけ（有効化していない）→ plugin.manage を持つ利用者は一覧を読め、loaded: false', async () => {
    await install('help-demo');

    const index = await getPluginHelpIndex(admin, { pluginId: 'help-demo' });

    expect(index).toEqual({
      pluginId: 'help-demo',
      pluginName: '手順書デモ',
      pluginVersion: '1.2.3',
      docs: DEMO_DOCS,
      loaded: false,
    });
  });

  it('#33 Permission を持たない利用者は NotFoundError（ForbiddenError ではない）', async () => {
    await enable('help-demo');
    await disable('help-demo');

    const index = getPluginHelpIndex(nobody, { pluginId: 'help-demo' });
    const doc = getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId: 'first' });

    await expect(index).rejects.toBeInstanceOf(NotFoundError);
    await expect(doc).rejects.toBeInstanceOf(NotFoundError);
  });

  it('#33 plugin.manage を持たない viewer も NotFoundError で、ForbiddenError ではない', async () => {
    await install('help-demo');

    const error = await getPluginHelpDoc(viewer, { pluginId: 'help-demo', docId: 'first' }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).not.toBeInstanceOf(ForbiddenError);
  });
});

describe('#34 検出済み（導入していない）の Plugin', () => {
  it('#34 plugin.manage を持つ利用者は本文を読め、loaded: false', async () => {
    const result = await getPluginHelpDoc(admin, { pluginId: 'help-demo', docId: 'first' });

    expect(result.loaded).toBe(false);
    expect(result.content).toEqual({ ok: true, markdown: FIRST_BODY });
  });

  it('#34 Permission を持たない利用者・viewer は NotFoundError', async () => {
    for (const context of [nobody, viewer]) {
      await expect(getPluginHelpIndex(context, { pluginId: 'help-demo' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        getPluginHelpDoc(context, { pluginId: 'help-demo', docId: 'first' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});

describe('#35 ビルドの登録簿に無い ID', () => {
  it('#35 存在しない ID（nonexistent）は plugin.manage を持っていても NotFoundError', async () => {
    await expect(getPluginHelpIndex(admin, { pluginId: 'nonexistent' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      getPluginHelpDoc(admin, { pluginId: 'nonexistent', docId: 'first' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('#35 plugins テーブルに行だけある ID は plugin.manage を持っていても NotFoundError', async () => {
    await withConnection((connection) =>
      installPlugin(connection, {
        id: 'orphan-row',
        name: 'orphan',
        version: '1.0.0',
        apiVersion: 1,
      }),
    );
    // 行だけの Plugin のフォルダに手順書らしいファイルがあっても読まない。
    await mkdir(join(workDir, 'orphan-row', 'help'), { recursive: true });
    await writeFile(join(workDir, 'orphan-row', 'help', 'first.md'), '# x\n', 'utf8');

    await expect(getPluginHelpIndex(admin, { pluginId: 'orphan-row' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      getPluginHelpDoc(admin, { pluginId: 'orphan-row', docId: 'first' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('#35 読み込めなかった Plugin（Manifest の誤りで登録簿から外れた）も NotFoundError', async () => {
    modules = [
      ...registryEntries(),
      {
        directory: 'broken-manifest',
        manifest: {
          id: 'broken-manifest',
          name: '',
          version: 'x',
          apiVersion: 1,
          help: [{ id: 'first', title: 't', path: 'help/first.md' }],
        },
        module: withoutSettings(),
      },
    ];

    await expect(getPluginHelpIndex(admin, { pluginId: 'broken-manifest' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('#36 宣言に無い docId（ID の差し替えで Plugin の他のファイルに届かない）', () => {
  const docIds = [
    'nope',
    '..',
    '../plugin.json',
    'plugin.json',
    'help/doc.md',
    'doc',
    'help/first.md',
    'first.md',
    'FIRST',
    '../help-only/only',
  ];

  it.each(docIds)(
    '#36 docId %j → NotFoundError（読み込まれた Plugin・認証済み）',
    async (docId) => {
      await enable('help-demo');

      await expect(
        getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId }),
      ).rejects.toBeInstanceOf(NotFoundError);
    },
  );

  it.each(docIds)('#36 docId %j → plugin.manage を持っていても NotFoundError', async (docId) => {
    await enable('help-demo');

    await expect(getPluginHelpDoc(admin, { pluginId: 'help-demo', docId })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('#36 どの例外の文言にも plugin.json・index.ts・README.md・宣言していない .md の中身が現れない', async () => {
    await enable('help-demo');

    for (const docId of docIds) {
      const error = await getPluginHelpDoc(admin, { pluginId: 'help-demo', docId }).catch(
        (caught: unknown) => caught,
      );
      expect(error, docId).toBeInstanceOf(NotFoundError);
      expect(String((error as Error).message), docId).not.toContain(PLUGIN_JSON_MARKER);
      expect(JSON.stringify(error), docId).not.toContain(PLUGIN_JSON_MARKER);
    }
  });

  it('#36 正しい docId の戻り値にも plugin.json の中身が現れない', async () => {
    await enable('help-demo');

    const result = await getPluginHelpDoc(admin, { pluginId: 'help-demo', docId: 'first' });

    expect(JSON.stringify(result)).not.toContain(PLUGIN_JSON_MARKER);
  });
});

describe('#37 宣言したファイルが無い', () => {
  it('#37 例外にならず content: { ok: false, reason: "not_found" } を返す', async () => {
    await enable('help-demo');

    const result = await getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId: 'second' });

    expect(result.content).toStrictEqual({ ok: false, reason: 'not_found' });
    expect(result.doc).toEqual({
      id: 'second',
      title: '二本目の手順書',
      href: '/plugins/help-demo/help/second',
      path: 'help/second.md',
    });
  });

  it('#37 log.warn("plugin help could not be read") が 1 回で、fields のキーが pluginId / docId / reason ちょうど', async () => {
    await enable('help-demo');
    records.length = 0;

    await getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId: 'second' });

    const warned = warnings('plugin help could not be read');
    expect(warned).toHaveLength(1);
    expect(Object.keys(warned[0]?.fields ?? {}).sort()).toEqual(['docId', 'pluginId', 'reason']);
    expect(warned[0]?.fields).toEqual({
      pluginId: 'help-demo',
      docId: 'second',
      reason: 'not_found',
    });
  });

  it('#37 ログにパスも OS のエラー文言も載らない', async () => {
    await enable('help-demo');
    records.length = 0;

    await getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId: 'second' });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(workDir);
    expect(serialized).not.toContain(workDir.replaceAll('\\', '/'));
    expect(serialized).not.toContain('second.md');
    expect(serialized).not.toMatch(/ENOENT/);
  });

  it('#37 読めた手順書では could not be read のログを出さない', async () => {
    await enable('help-demo');
    records.length = 0;

    await getPluginHelpDoc(nobody, { pluginId: 'help-demo', docId: 'first' });

    expect(warnings('plugin help could not be read')).toHaveLength(0);
  });
});

describe('#38 help を持たない Plugin・形の誤った help', () => {
  it('#38 help を持たない Plugin（有効）→ 一覧・本文とも NotFoundError', async () => {
    await enable('plain');

    await expect(getPluginHelpIndex(nobody, { pluginId: 'plain' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      getPluginHelpDoc(nobody, { pluginId: 'plain', docId: 'first' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('#38 help の形が誤った Plugin（有効）→ 一覧・本文とも NotFoundError（plugin.manage でも）', async () => {
    await enable('help-broken');

    for (const context of [nobody, admin]) {
      await expect(getPluginHelpIndex(context, { pluginId: 'help-broken' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        getPluginHelpDoc(context, { pluginId: 'help-broken', docId: 'first' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('#38 discoverPlugins を 1 回呼ぶと、log.warn("plugin manifest has warnings") が 1 回だけ出る', () => {
    records.length = 0;

    discoverPlugins();

    const warned = warnings('plugin manifest has warnings');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.fields?.['pluginId']).toBe('help-broken');
    expect(warned[0]?.fields?.['fields']).toEqual(['help']);
    const messages = warned[0]?.fields?.['messages'];
    expect(Array.isArray(messages)).toBe(true);
    expect((messages as unknown[]).length).toBeGreaterThan(0);
  });

  it('#38 形の誤った help を持つ Plugin も登録簿に入り（拒否されず）、help を持たない Manifest になる', () => {
    const result = discoverPlugins();

    const broken = result.plugins.find((entry) => entry.manifest.id === 'help-broken');
    expect(broken).toBeDefined();
    expect(Object.keys(broken?.manifest ?? {})).not.toContain('help');
    expect(result.problems.map((problem) => problem.pluginId)).not.toContain('help-broken');
  });

  it('#38 形の誤った help を持つ Plugin も有効化できる', async () => {
    await expect(enable('help-broken')).resolves.toBeUndefined();

    expect(helpLinkOfPlugin('help-broken')).toBeNull();
  });
});

describe('#39 helpLinkOfPlugin', () => {
  it('#39 有効な help-demo → 先頭の手順書の { id, title, href }', async () => {
    await enable('help-demo');

    expect(helpLinkOfPlugin('help-demo')).toEqual({
      id: 'first',
      title: '最初の手順書',
      href: '/plugins/help-demo/help/first',
    });
  });

  it('#39 無効化した後は null', async () => {
    await enable('help-demo');
    await disable('help-demo');

    expect(helpLinkOfPlugin('help-demo')).toBeNull();
  });

  it('#39 help を持たない Plugin（有効）は null', async () => {
    await enable('plain');

    expect(helpLinkOfPlugin('plain')).toBeNull();
  });

  it('#39 導入していない・存在しない Plugin は null', () => {
    expect(helpLinkOfPlugin('help-demo')).toBeNull();
    expect(helpLinkOfPlugin('nonexistent')).toBeNull();
  });

  it('#39 ファイルの有無を見ない（手順書のファイルが消えていても宣言から組む）', async () => {
    await enable('help-demo');
    await rm(join(workDir, 'help-demo', 'help'), { recursive: true, force: true });

    expect(helpLinkOfPlugin('help-demo')).toEqual({
      id: 'first',
      title: '最初の手順書',
      href: '/plugins/help-demo/help/first',
    });
  });
});

describe('#49 listPlugins の PluginSummary.hasSettings / help', () => {
  function find(list: readonly PluginSummary[], id: string): PluginSummary {
    const found = list.find((summary) => summary.id === id);
    if (found === undefined) throw new Error(`一覧に無い: ${id}`);
    return found;
  }

  it('#49 registerSettings した有効な Plugin は hasSettings: true、しない有効な Plugin は false', async () => {
    await enable('help-demo');
    await enable('help-only');
    await enable('plain');

    const { installed } = await listPlugins(admin, undefined);

    expect(find(installed, 'help-demo').hasSettings).toBe(true);
    expect(find(installed, 'help-only').hasSettings).toBe(false);
    expect(find(installed, 'plain').hasSettings).toBe(false);
  });

  it('#49 無効化した Plugin・導入だけの Plugin・検出済みの Plugin は hasSettings: false', async () => {
    await enable('settings-only');
    await disable('settings-only');
    await install('help-demo');

    const { installed, detected } = await listPlugins(admin, undefined);

    expect(find(installed, 'settings-only').hasSettings).toBe(false);
    expect(find(installed, 'help-demo').hasSettings).toBe(false);
    expect(find(detected, 'plain').hasSettings).toBe(false);
  });

  it('#49 help は Manifest の { id, title } の配列（宣言の順・path を持たない）', async () => {
    await enable('help-demo');

    const { installed, detected } = await listPlugins(admin, undefined);

    expect(find(installed, 'help-demo').help).toStrictEqual([
      { id: 'first', title: '最初の手順書' },
      { id: 'second', title: '二本目の手順書' },
    ]);
    // 検出済みの Plugin も Manifest から help を持つ。
    expect(find(detected, 'help-only').help).toStrictEqual([{ id: 'only', title: '唯一の手順書' }]);
  });

  it('#49 help を持たない Plugin・形の誤った help の Plugin は help: []', async () => {
    await enable('plain');

    const { installed, detected } = await listPlugins(admin, undefined);

    expect(find(installed, 'plain').help).toEqual([]);
    expect(find(detected, 'help-broken').help).toEqual([]);
  });

  it('#49 ファイルが消えた Plugin の行も hasSettings: false・help: [] を持つ', async () => {
    await withConnection((connection) =>
      installPlugin(connection, {
        id: 'orphan-row',
        name: 'orphan',
        version: '1.0.0',
        apiVersion: 1,
      }),
    );

    const { installed } = await listPlugins(admin, undefined);

    const orphan = find(installed, 'orphan-row');
    expect(orphan.hasSettings).toBe(false);
    expect(orphan.help).toEqual([]);
  });
});

describe('#51 getPluginSettingsPage', () => {
  it('#51 設定と手順書の両方を持つ → settings と helpDocs の両方', async () => {
    await enable('help-demo');

    const page = await getPluginSettingsPage(admin, { pluginId: 'help-demo' });

    expect(page.pluginId).toBe('help-demo');
    expect(page.pluginName).toBe('手順書デモ');
    expect(page.settings).not.toBeNull();
    expect(page.settings?.fields.map((field) => field.key)).toEqual(['endpoint']);
    expect(page.helpDocs).toEqual(DEMO_DOCS);
  });

  it('#51 手順書だけ → settings: null、helpDocs が 1 件以上', async () => {
    await enable('help-only');

    const page = await getPluginSettingsPage(admin, { pluginId: 'help-only' });

    expect(page.settings).toBeNull();
    expect(page.helpDocs).toEqual([
      { id: 'only', title: '唯一の手順書', href: '/plugins/help-only/help/only' },
    ]);
  });

  it('#51 設定だけ → helpDocs: []', async () => {
    await enable('settings-only');

    const page = await getPluginSettingsPage(admin, { pluginId: 'settings-only' });

    expect(page.settings?.fields.map((field) => field.key)).toEqual(['endpoint']);
    expect(page.helpDocs).toEqual([]);
  });

  it('#51 設定も手順書も無い Plugin（有効）→ NotFoundError', async () => {
    await enable('plain');

    await expect(getPluginSettingsPage(admin, { pluginId: 'plain' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('#51 読み込まれていない Plugin（無効化・導入だけ・検出済み・存在しない）→ NotFoundError', async () => {
    await enable('help-demo');
    await disable('help-demo');
    await install('help-only');

    for (const pluginId of ['help-demo', 'help-only', 'settings-only', 'nonexistent']) {
      await expect(getPluginSettingsPage(admin, { pluginId })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
  });

  it('#51 plugin.manage を持たない利用者は ForbiddenError（Permission なし・viewer とも）', async () => {
    await enable('help-demo');

    await expect(getPluginSettingsPage(nobody, { pluginId: 'help-demo' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(getPluginSettingsPage(viewer, { pluginId: 'help-demo' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('#51 未認証は UnauthenticatedError', async () => {
    await enable('help-demo');
    const anonymous = await anonymousContext();

    await expect(
      getPluginSettingsPage(anonymous, { pluginId: 'help-demo' }),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('#51 UseCase の名前と Permission', () => {
    expect(getPluginSettingsPage.name).toBe('plugin.settings.page');
    expect(getPluginSettingsPage.permission).toBe('plugin.manage');
  });
});
