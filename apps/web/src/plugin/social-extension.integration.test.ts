import type { Plugin, PluginManifest, PublisherRegistration } from '@torifune/plugin-api';
import { PluginExtensionNotDeclaredError } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetPermissionRegistry } from '@/application/authorization/permission-registry';
import { resetEventHandlers } from '@/application/events';
import { findPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import type { DependencyCandidate } from './dependencies';
import { disablePlugin, enablePlugin, findPluginRecord, installPlugin } from './lifecycle';
import { registrationsOf } from './registry';
import { resetPluginRuntime } from './runtime';

/**
 * 拡張点 `social`（035-social-publishing 設計 §9.3 / §9.4 / §9.7）。
 *
 * 受け入れ条件 #15（宣言なしは拒否）、#16（宣言ありで登録でき、無効化で消える）、
 * #17（同じ provider は先に有効化したほうが勝つ）。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function manifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1, ...overrides };
}

/** `extensions: ['social']` を宣言した Manifest。 */
function socialManifest(id: string): PluginManifest {
  return manifest(id, { extensions: ['social'] });
}

function publisherFor(provider: string, label: string): PublisherRegistration {
  return { provider, label, credentialFields: [] };
}

/**
 * `activate()` で publisher を登録する Plugin。
 *
 * `capture` を渡すと、登録で投げられた例外を握って `activate` を成功させる
 * （「例外の中身」と「Plugin が disabled になること」を別のテストで見るため）。
 */
function publisherPlugin(options: {
  readonly registration: PublisherRegistration;
  readonly capture?: (error: unknown) => void;
}): Plugin {
  return {
    activate(context) {
      if (options.capture === undefined) {
        context.social.registerPublisher(options.registration);
        return;
      }
      try {
        context.social.registerPublisher(options.registration);
      } catch (error) {
        options.capture(error);
      }
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
        login_id: `s${suffix}`,
        email: `s${suffix}@example.com`,
        display_name: 'social extension test',
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
    loginId: `s${suffix}`,
    displayName: 'social extension test',
    email: `s${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function enable(
  m: PluginManifest,
  plugin: Plugin,
  candidates = candidatesOf([m, false]),
): Promise<{ ok: boolean; reason?: string }> {
  await withConnection((connection) => installPlugin(connection, m));
  return withConnection((connection) =>
    enablePlugin({ connection, manifest: m, plugin, authorization: admin, candidates }),
  );
}

async function disable(m: PluginManifest, plugin: Plugin): Promise<void> {
  await withConnection((connection) =>
    disablePlugin({
      connection,
      manifest: m,
      plugin,
      authorization: admin,
      candidates: candidatesOf([m, true]),
    }),
  );
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialext');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  resetPluginRuntime();
  resetPublisherRegistry();
  resetPermissionRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('plugin_store').execute();
    await connection.db.deleteFrom('plugins').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#15 宣言していない Plugin は登録できない', () => {
  it('#15 social を宣言していなければ PluginExtensionNotDeclaredError を投げる', async () => {
    // 宣言なしに登録できると、Plugin を入れた側が
    // 「どの Plugin が資格情報を受け取るか」を知らないまま運用することになる。
    let captured: unknown = null;

    await enable(
      manifest('undeclared-plugin'),
      publisherPlugin({
        registration: publisherFor('example', 'サンプルSNS'),
        capture: (error) => {
          captured = error;
        },
      }),
    );

    expect(captured).toBeInstanceOf(PluginExtensionNotDeclaredError);
  });

  it('#15 投げられた例外の kind が social', async () => {
    let captured: unknown = null;

    await enable(
      manifest('undeclared-plugin'),
      publisherPlugin({
        registration: publisherFor('example', 'サンプルSNS'),
        capture: (error) => {
          captured = error;
        },
      }),
    );

    expect((captured as PluginExtensionNotDeclaredError).kind).toBe('social');
  });

  it('#15 宣言していない Plugin の登録は登録簿に入らない', async () => {
    await enable(
      manifest('undeclared-plugin'),
      publisherPlugin({
        registration: publisherFor('example', 'サンプルSNS'),
        capture: () => undefined,
      }),
    );

    expect(findPublisher('example')).toBeNull();
  });

  it('#15 activate で投げれば有効化に失敗する', async () => {
    const outcome = await enable(
      manifest('undeclared-plugin'),
      publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') }),
    );

    expect(outcome.ok).toBe(false);
  });

  it('#15 activate で投げた Plugin は disabled になる', async () => {
    await enable(
      manifest('undeclared-plugin'),
      publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') }),
    );

    const record = await withConnection((c) => findPluginRecord(c, 'undeclared-plugin'));
    expect(record?.status).toBe('disabled');
  });

  it('#15 reason に PluginExtensionNotDeclaredError の内容が入る', async () => {
    // 理由が分からないと、管理画面で「なぜ無効になったか」を追えない。
    const outcome = await enable(
      manifest('undeclared-plugin'),
      publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') }),
    );

    expect(outcome.reason).toContain('宣言していない拡張点');
  });
});

describe('#16 宣言した Plugin は登録でき、無効化で消える', () => {
  it('#16 activate で登録した publisher を findPublisher で引ける', async () => {
    const m = socialManifest('social-plugin');

    await enable(m, publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') }));

    expect(findPublisher('example')).toMatchObject({ pluginId: 'social-plugin' });
  });

  it('#16 宣言した Plugin の有効化は成功する', async () => {
    const m = socialManifest('social-plugin');

    const outcome = await enable(
      m,
      publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') }),
    );

    expect(outcome.ok).toBe(true);
  });

  it('#16 Registrations.publishers に provider が記録される', async () => {
    // 管理画面で「何を握っているか」を出せるように（設計 §9.4）。
    const m = socialManifest('social-plugin');

    await enable(m, publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') }));

    expect(registrationsOf('social-plugin').publishers).toEqual(['example']);
  });

  it('#16 disablePlugin のあとは findPublisher で引けない', async () => {
    // 外さないと、無効化したはずの Plugin へ資格情報が渡り続ける。
    const m = socialManifest('social-plugin');
    const plugin = publisherPlugin({ registration: publisherFor('example', 'サンプルSNS') });
    await enable(m, plugin);

    await disable(m, plugin);

    expect(findPublisher('example')).toBeNull();
  });
});

describe('#17 同じ provider は先に有効化したほうが勝つ', () => {
  /** 同じ provider を登録する 2 つの Plugin を、この順で有効化する。 */
  async function enableBoth(): Promise<{ ok: boolean; reason?: string }> {
    const first = socialManifest('first-plugin');
    const second = socialManifest('second-plugin');

    await enable(first, publisherPlugin({ registration: publisherFor('example', '先の Plugin') }));
    return enable(
      second,
      publisherPlugin({ registration: publisherFor('example', '後の Plugin') }),
    );
  }

  it('#17 後から有効化した Plugin は有効化に失敗する', async () => {
    const outcome = await enableBoth();

    expect(outcome.ok).toBe(false);
  });

  it('#17 後から有効化した Plugin は disabled になる', async () => {
    await enableBoth();

    const record = await withConnection((c) => findPluginRecord(c, 'second-plugin'));
    expect(record?.status).toBe('disabled');
  });

  it('#17 reason に provider 名が入る', async () => {
    const outcome = await enableBoth();

    expect(outcome.reason).toContain('example');
  });

  it('#17 reason に先に登録した Plugin ID が入る', async () => {
    const outcome = await enableBoth();

    expect(outcome.reason).toContain('first-plugin');
  });

  it('#17 先に有効化した Plugin の登録が残る', async () => {
    await enableBoth();

    expect(findPublisher('example')).toMatchObject({ pluginId: 'first-plugin' });
  });
});
