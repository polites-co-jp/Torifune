import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GET as getPluginSettingsRoute,
  PUT as savePluginSettingsRoute,
} from '@/app/api/v1/plugins/[id]/settings/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import {
  getPluginSettings,
  savePluginSettings,
} from '@/application/plugin/plugin-settings-use-cases';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import type { DependencyCandidate } from './dependencies';
import { enablePlugin, installPlugin } from './lifecycle';
import { discoverPlugins } from './loader';
import { resetPluginRuntime } from './runtime';

/**
 * PDS の URL の設定 API（036-sns-bluesky 設計 §7.1 / §7.2、受け入れ条件 #60・#61）。
 *
 * **ルートを直接叩く結合テスト**にする（実装プラン §8 の 5）。
 * `getPluginSettings` は**無効な Plugin では `NotFoundError`** になるので、
 * 使い捨て DB へ sns-bluesky を導入・有効化してから叩く。
 *
 * 見るのは `CLAUDE.md` が必須と定める 3 つ：
 * **権限あり → 200 / 権限なし → 403 / 未認証 → 401。** 加えて保存時の 422。
 *
 * **この Plugin は新しい Permission を作らない。** 設定を触れるのは Core の
 * `plugin.manage` を持つ者だけで、それは Plugin の導入そのものを許す権限である（設計 §8）。
 */

const PLUGIN_ID = 'sns-bluesky';
const ENDPOINT = `http://127.0.0.1:3000/api/v1/plugins/${PLUGIN_ID}/settings`;
const CSRF_TOKEN = 'csrf-token-for-sns-bluesky-settings';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** `plugin.manage` を持つ Token の平文。 */
let manageToken: string;
/**
 * `plugin.manage` を含まない Token の平文。
 *
 * **Token の実効権限は「所有者の権限 ∩ scope」**なので、これで叩く呼び出しは
 * `plugin.manage` を持たない。`viewer` 役の利用者そのものに Token を出させる形は
 * 取れない（Token の発行には `token.manage` が要り、`viewer` は持たない）ので、
 * **利用者の役そのもので断られること**は下の `getPluginSettings` 側で見る。
 */
let limitedToken: string;
/** `plugin.manage` を持たない利用者。 */
let viewer: AuthorizationContext;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface SettingsFieldBody {
  readonly key: string;
  readonly kind: string;
  readonly value: string | null;
}

function fieldsOf(result: JsonResult): readonly SettingsFieldBody[] {
  const data = result.body['data'] as
    { readonly fields?: readonly SettingsFieldBody[] } | undefined;
  return data?.fields ?? [];
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

async function toResult(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** Next.js の Route Handler が受け取る形（`params` は Promise）。 */
function routeArgs(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({ id: PLUGIN_ID }) };
}

interface CallOptions {
  /** Bearer の平文。省略すると Authorization を付けない（＝未認証）。 */
  readonly token?: string | undefined;
}

async function callGet(options: CallOptions = {}): Promise<JsonResult> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['authorization'] = `Bearer ${options.token}`;
  }
  return toResult(
    await getPluginSettingsRoute(new Request(ENDPOINT, { method: 'GET', headers }), routeArgs()),
  );
}

async function callPut(
  values: Record<string, string>,
  options: CallOptions = {},
): Promise<JsonResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token === undefined) {
    // Bearer の無い経路は CSRF を通らないと 403 になり、401 を確かめられない。
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = 'http://127.0.0.1:3000';
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
    headers['x-csrf-token'] = CSRF_TOKEN;
  } else {
    headers['authorization'] = `Bearer ${options.token}`;
  }

  return toResult(
    await savePluginSettingsRoute(
      new Request(ENDPOINT, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ values, csrfToken: CSRF_TOKEN }),
      }),
      routeArgs(),
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
        login_id: `p${suffix}`,
        email: `p${suffix}@example.com`,
        display_name: 'bluesky settings test',
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
    displayName: 'bluesky settings test',
    email: `p${suffix}@example.com`,
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

function entry(): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (found === undefined) throw new Error('Bluesky 配信 Plugin が読み込めていない');
  return found;
}

async function activate(): Promise<void> {
  const { manifest, plugin } = entry();
  const candidates = new Map<string, DependencyCandidate>([
    [manifest.id, { manifest, enabled: false }],
  ]);
  await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    const outcome = await enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates,
    });
    if (!outcome.ok) throw new Error(`有効化に失敗: ${outcome.reason}`);
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('blueskysettings');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  manageToken = await issueToken(admin, ['plugin.manage']);
  limitedToken = await issueToken(admin, ['social.read']);
  viewer = await contextFor(['viewer']);
  await activate();
});

afterEach(async () => {
  resetPluginRuntime();
  resetPublisherRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#60 GET /api/v1/plugins/sns-bluesky/settings', () => {
  it('#60 未認証なら 401', async () => {
    const result = await callGet();

    expect(result.status).toBe(401);
  });

  it('#60 plugin.manage を持たない利用者は 403', async () => {
    // 設定で App Password の送り先を変えられる。閲覧者に見せる画面ではない（設計 §8.2）。
    const result = await callGet({ token: limitedToken });

    expect(result.status).toBe(403);
  });

  it('#60 plugin.manage を持つ利用者は 200', async () => {
    const result = await callGet({ token: manageToken });

    expect(result.status).toBe(200);
  });

  it('#60 返る項目は pds-url の1つだけ', async () => {
    const result = await callGet({ token: manageToken });

    expect(fieldsOf(result).map((field) => field.key)).toEqual(['pds-url']);
  });

  it('#60 その kind は text（secret にしない）', async () => {
    // `secret` にすると、どこへ App Password を送っているかを運用者が確かめられない（設計 §7.1）。
    const result = await callGet({ token: manageToken });

    expect(fieldsOf(result)[0]?.kind).toBe('text');
  });
});

describe('#61 PUT /api/v1/plugins/sns-bluesky/settings', () => {
  it('#61 未認証なら 401', async () => {
    const result = await callPut({ 'pds-url': 'https://pds.example.com' });

    expect(result.status).toBe(401);
  });

  it('#61 plugin.manage を持たない利用者は 403', async () => {
    const result = await callPut({ 'pds-url': 'https://pds.example.com' }, { token: limitedToken });

    expect(result.status).toBe(403);
  });

  it('#61 plugin.manage を持つ利用者は 200', async () => {
    const result = await callPut({ 'pds-url': 'https://pds.example.com' }, { token: manageToken });

    expect(result.status).toBe(200);
  });

  it('#61 保存した値が GET で読み出せる', async () => {
    await callPut({ 'pds-url': 'https://pds.example.com' }, { token: manageToken });

    const result = await callGet({ token: manageToken });
    expect(fieldsOf(result)[0]?.value).toBe('https://pds.example.com');
  });

  it('#61 空欄は保存できる（既定へ落とすため問題としない）', async () => {
    const result = await callPut({ 'pds-url': '' }, { token: manageToken });

    expect(result.status).toBe(200);
  });

  it('#61 http:// の URL は 422', async () => {
    // そこへ App Password を平文で送ることになる。開発用の例外も作らない（設計 §7.2）。
    const result = await callPut({ 'pds-url': 'http://pds.example.com' }, { token: manageToken });

    expect(result.status).toBe(422);
  });

  it('#61 その details に pds-url の理由が出る', async () => {
    const result = await callPut({ 'pds-url': 'http://pds.example.com' }, { token: manageToken });

    expect((detailsOf(result)['pds-url'] ?? []).join(' ')).toContain('https');
  });

  it('#61 422 になった値は保存されない', async () => {
    await callPut({ 'pds-url': 'http://pds.example.com' }, { token: manageToken });

    const result = await callGet({ token: manageToken });
    expect(fieldsOf(result)[0]?.value).toBeNull();
  });

  it('#61 URL でない値も 422', async () => {
    const result = await callPut({ 'pds-url': 'ほげ' }, { token: manageToken });

    expect(result.status).toBe(422);
  });

  it('#61 資格情報つきの URL も 422', async () => {
    const result = await callPut(
      { 'pds-url': 'https://user:pw@pds.example.com' },
      { token: manageToken },
    );

    expect(result.status).toBe(422);
  });

  it('#61 パス付きの URL も 422', async () => {
    const result = await callPut(
      { 'pds-url': 'https://pds.example.com/xrpc' },
      { token: manageToken },
    );

    expect(result.status).toBe(422);
  });

  it('#61 宣言されていない項目は 422', async () => {
    // 受け付けると、フォームを細工して Plugin の任意のキーを書き換えられる。
    const result = await callPut({ 'pds-token': 'x' }, { token: manageToken });

    expect(result.status).toBe(422);
  });
});

/**
 * #60 / #61 の「権限なし」を**利用者の役そのもの**で見る。
 *
 * API の側は「所有者の権限 ∩ scope」で断っている（上）。
 * こちらは `plugin.manage` を持たない利用者が、そもそも UseCase を通れないことを見る。
 * **認可判断は Application 層にある**（`CLAUDE.md`「認可を書く場所」）ので、
 * 経路を増やしても抜け道が生まれない。
 */
describe('#60 #61 plugin.manage を持たない利用者', () => {
  it('#60 設定を読めない', async () => {
    await expect(getPluginSettings(viewer, { pluginId: PLUGIN_ID })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('#61 設定を保存できない', async () => {
    await expect(
      savePluginSettings(viewer, {
        pluginId: PLUGIN_ID,
        values: { 'pds-url': 'https://pds.example.com' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
