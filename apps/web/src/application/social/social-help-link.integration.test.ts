import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { helpLinkOfPlugin } from '@/application/plugin/plugin-help-use-cases';
import { listPublishers, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import type { DependencyCandidate } from '@/plugin/dependencies';
import { disablePlugin, enablePlugin, installPlugin } from '@/plugin/lifecycle';
import { discoverPlugins } from '@/plugin/loader';
import { resetPluginRuntime } from '@/plugin/runtime';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { buildProviderOptions } from '@/ui/social/provider-options';
import type { ProviderOption } from '@/ui/social/social-accounts';

/**
 * `/social` のヘルプボタンの行き先を、**実物の登録簿と実物の `sns-bluesky`** で引く
 * （041-plugin-help-docs 設計 §7.4.1、受け入れ条件 #46）。
 *
 * `app/social/page.tsx` は `buildProviderOptions(listPublishers(), helpLinkOfPlugin)` と呼ぶ。
 * ここでも同じ 2 つを渡し、`bluesky` の選択肢の `help` が Plugin の Manifest の先頭の手順書を指すこと、
 * 無効化すると `help` が消えることを見る。
 *
 * 登録簿は差し替えない（`plugin-help.integration.test.ts` は差し替えるので同居できない。実装プラン §8 の 14）。
 * `sns-bluesky` の `activate` は外へ要求を出さないが、念のため `globalThis.fetch` を「呼ばれたら投げる」偽物にして戻す。
 */

const PLUGIN_ID = 'sns-bluesky';
const PROVIDER = 'bluesky';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let realFetch: typeof globalThis.fetch;

function entry(): { readonly manifest: PluginManifest; readonly plugin: Plugin } {
  const found = discoverPlugins().plugins.find((p) => p.manifest.id === PLUGIN_ID);
  if (found === undefined) throw new Error('Bluesky 配信 Plugin が読み込めていない');
  return found;
}

function candidatesOf(
  manifest: PluginManifest,
  enabled: boolean,
): Map<string, DependencyCandidate> {
  return new Map([[manifest.id, { manifest, enabled }]]);
}

async function activate(): Promise<void> {
  const { manifest, plugin } = entry();
  const result = await withConnection(async (connection) => {
    await installPlugin(connection, manifest);
    return enablePlugin({
      connection,
      manifest,
      plugin,
      authorization: admin,
      candidates: candidatesOf(manifest, false),
    });
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);
}

async function deactivate(): Promise<void> {
  const { manifest, plugin } = entry();
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
        display_name: 'social help link test',
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
    displayName: 'social help link test',
    email: `h${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

function blueskyOption(): ProviderOption {
  const found = buildProviderOptions(listPublishers(), helpLinkOfPlugin).find(
    (option) => option.value === PROVIDER,
  );
  if (found === undefined) throw new Error('bluesky の選択肢が無い');
  return found;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialhelplink');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('この結合テストは外へ要求を出さない');
  }) as typeof globalThis.fetch;
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  resetPluginRuntime();
  resetPublisherRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#46 sns-bluesky を有効にした登録簿で、bluesky の選択肢が手順書を指す', () => {
  it('#46 sns-bluesky の Manifest が手順書を宣言している（この条件の前提）', () => {
    expect(entry().manifest.help?.[0]).toBeDefined();
  });

  it('#46 有効化すると bluesky の選択肢の help.href が /plugins/sns-bluesky/help/credentials', async () => {
    await activate();

    expect(blueskyOption().help?.href).toBe('/plugins/sns-bluesky/help/credentials');
  });

  it('#46 help.title が Manifest の先頭の手順書の title', async () => {
    await activate();
    const first = entry().manifest.help?.[0];

    expect(first).toBeDefined();
    expect(blueskyOption().help?.title).toBe(first?.title);
  });

  it('#46 help は href と title ちょうど', async () => {
    await activate();

    expect(Object.keys(blueskyOption().help ?? {}).sort()).toEqual(['href', 'title']);
  });

  it('#46 無効化すると bluesky の選択肢は help を持たない', async () => {
    await activate();
    await deactivate();

    expect('help' in blueskyOption()).toBe(false);
  });

  it('#46 有効化していなければ bluesky の選択肢は help を持たない', () => {
    expect('help' in blueskyOption()).toBe(false);
  });
});
