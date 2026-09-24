import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, PluginContext, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getOpenApiRoute } from '@/app/api/v1/openapi.json/route';
import { GET as getPluginSettingsRoute } from '@/app/api/v1/plugins/[id]/settings/route';
import { GET as listPluginsRoute } from '@/app/api/v1/plugins/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import type { DependencyCandidate } from '@/plugin/dependencies';
import type { PluginModuleEntry } from '@/plugin/generated-registry';
import { enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRegistry } from '@/plugin/registry';
import { resetPluginRuntime } from '@/plugin/runtime';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `/api/v1` が変わらないこと（041-plugin-help-docs 設計 §6、受け入れ条件 #50・#53）。
 *
 * 手順書は画面（Server Component）だけが読む。`PluginSummary` に `hasSettings` / `help` を
 * 足しても、`GET /api/v1/plugins` の応答は `toPluginResponse` が項目を明示して組むので変わらない。
 * 設定の API は、設定を持たず手順書だけを持つ Plugin に従来どおり 404 を返す。
 *
 * **ルートを直接叩く**（`039` の C 群と同じ）。権限は `CLAUDE.md` の必須の 3 つ
 * （権限あり → 200 / 権限なし → 403 / 未認証 → 401）も併せて見る（既存の挙動を変えないことの確かめ）。
 *
 * #50 の「OpenAPI の生成物に差分が無い」は、リポジトリに生成物のファイルが無い
 * （`/api/v1/openapi.json` が実行時に生成する）ので、その応答で `listPlugins` の記述に
 * `hasSettings` / `help` が現れないことを見る（実装プラン §8 の 3 の読み替え）。
 */

vi.mock('@/plugin/generated-registry', () => ({
  get PLUGIN_MODULES() {
    return modules;
  },
}));

let modules: PluginModuleEntry[] = [];

/** 041 より前の `GET /api/v1/plugins` の各行のキー（`toPluginResponse`）。 */
const PLUGIN_RESPONSE_KEYS = [
  'dependencies',
  'description',
  'id',
  'loaded',
  'name',
  'permissions',
  'status',
  'version',
];

const HELP_ONLY_MANIFEST = {
  id: 'help-only',
  name: '手順書だけ',
  version: '1.0.0',
  apiVersion: 1,
  help: [{ id: 'only', title: '唯一の手順書', path: 'help/only.md' }],
};

const HELP_DEMO_MANIFEST = {
  id: 'help-demo',
  name: '手順書デモ',
  version: '1.2.3',
  apiVersion: 1,
  help: [{ id: 'first', title: '最初の手順書', path: 'help/first.md' }],
};

function settingsPlugin(): Plugin {
  return {
    activate(context: PluginContext): void {
      context.ui.registerSettings({ fields: [{ key: 'endpoint', label: '接続先', kind: 'text' }] });
    },
  };
}

let scratch: ScratchDatabase;
let workDir: string;
let admin: AuthorizationContext;
/** `plugin.manage` を持つ Token の平文。 */
let manageToken: string;
/** `plugin.manage` を含まない Token の平文（実効権限は所有者の権限 ∩ scope）。 */
let limitedToken: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function headersOf(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

async function callList(token?: string): Promise<JsonResult> {
  return toResult(
    await listPluginsRoute(
      new Request('http://127.0.0.1:3000/api/v1/plugins', {
        method: 'GET',
        headers: headersOf(token),
      }),
      { params: Promise.resolve({}) },
    ),
  );
}

async function callSettings(pluginId: string, token?: string): Promise<JsonResult> {
  return toResult(
    await getPluginSettingsRoute(
      new Request(`http://127.0.0.1:3000/api/v1/plugins/${pluginId}/settings`, {
        method: 'GET',
        headers: headersOf(token),
      }),
      { params: Promise.resolve({ id: pluginId }) },
    ),
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
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'plugin help api test',
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
    loginId: `a${suffix}`,
    displayName: 'plugin help api test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function issueToken(owner: AuthorizationContext, scopes: readonly string[]): Promise<string> {
  const created = await createApiToken(owner, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return created.plaintext;
}

async function enable(pluginId: string): Promise<void> {
  const found = discoverPlugins().plugins.find((entry) => entry.manifest.id === pluginId);
  if (found === undefined) throw new Error(`登録簿に無い: ${pluginId}`);
  const manifest: PluginManifest = found.manifest;
  await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    const outcome = await enablePlugin({
      connection,
      manifest,
      plugin: found.plugin,
      authorization: admin,
      candidates: new Map<string, DependencyCandidate>([
        [manifest.id, { manifest, enabled: false }],
      ]),
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('pluginhelpapi');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  modules = [
    { directory: 'help-only', manifest: HELP_ONLY_MANIFEST, module: { activate: () => undefined } },
    { directory: 'help-demo', manifest: HELP_DEMO_MANIFEST, module: settingsPlugin() },
  ];
  workDir = await mkdtemp(join(tmpdir(), 'torifune-help-api-'));
  process.env['TORIFUNE_PLUGINS_DIR'] = workDir;
  await mkdir(join(workDir, 'help-only', 'help'), { recursive: true });
  await writeFile(join(workDir, 'help-only', 'help', 'only.md'), '# 唯一の手順書\n', 'utf8');
  await mkdir(join(workDir, 'help-demo', 'help'), { recursive: true });
  await writeFile(join(workDir, 'help-demo', 'help', 'first.md'), '# 最初の手順書\n', 'utf8');

  admin = await contextFor(['administrator']);
  manageToken = await issueToken(admin, ['plugin.manage']);
  limitedToken = await issueToken(admin, ['social.read']);
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
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#50 GET /api/v1/plugins の応答は変わらない', () => {
  it('#50 各行（導入済み・検出済み）のキーが 041 より前と同じで、hasSettings / help が現れない', async () => {
    await enable('help-demo');

    const result = await callList(manageToken);

    expect(result.status).toBe(200);
    const data = result.body['data'] as {
      readonly installed: readonly Record<string, unknown>[];
      readonly detected: readonly Record<string, unknown>[];
    };
    expect(data.installed.map((row) => row['id'])).toEqual(['help-demo']);
    expect(data.detected.map((row) => row['id'])).toEqual(['help-only']);
    for (const row of [...data.installed, ...data.detected]) {
      expect(Object.keys(row).sort(), String(row['id'])).toEqual(PLUGIN_RESPONSE_KEYS);
    }
  });

  it('#50 応答の本文のどこにも hasSettings と手順書の題名・path が現れない', async () => {
    await enable('help-demo');
    await enable('help-only');

    const result = await callList(manageToken);

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('hasSettings');
    expect(serialized).not.toContain('"help"');
    expect(serialized).not.toContain('最初の手順書');
    expect(serialized).not.toContain('help/only.md');
  });

  it('#50 未認証は 401', async () => {
    expect((await callList()).status).toBe(401);
  });

  it('#50 plugin.manage を持たない Token は 403', async () => {
    expect((await callList(limitedToken)).status).toBe(403);
  });

  it('#50 OpenAPI の listPlugins の記述に hasSettings / help が現れない', async () => {
    const response = getOpenApiRoute();
    const document = (await response.json()) as {
      readonly paths: Record<string, Record<string, unknown>>;
    };

    const operation = document.paths['/plugins']?.['get'];
    expect(operation).toBeDefined();
    const serialized = JSON.stringify(operation);
    expect(serialized).not.toContain('hasSettings');
    expect(serialized).not.toContain('"help"');
  });

  it('#50 OpenAPI に手順書のためのパスが足されていない', async () => {
    const document = (await getOpenApiRoute().json()) as {
      readonly paths: Record<string, unknown>;
    };

    expect(Object.keys(document.paths).filter((path) => /help/i.test(path))).toEqual([]);
  });
});

describe('#53 GET /api/v1/plugins/{id}/settings は手順書だけの Plugin に 404', () => {
  it('#53 設定を持たず手順書だけを持つ有効な Plugin → 404', async () => {
    await enable('help-only');

    const result = await callSettings('help-only', manageToken);

    expect(result.status).toBe(404);
  });

  it('#53 設定を持つ Plugin は従来どおり 200（手順書を持っていても設定の応答に手順書が混ざらない）', async () => {
    await enable('help-demo');

    const result = await callSettings('help-demo', manageToken);

    expect(result.status).toBe(200);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('helpDocs');
    expect(serialized).not.toContain('最初の手順書');
  });

  it('#53 未認証は 401', async () => {
    await enable('help-only');

    expect((await callSettings('help-only')).status).toBe(401);
  });

  it('#53 plugin.manage を持たない Token は 403', async () => {
    await enable('help-demo');

    expect((await callSettings('help-demo', limitedToken)).status).toBe(403);
  });
});
