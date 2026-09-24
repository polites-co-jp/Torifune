import { uuidv7 } from 'uuidv7';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET as listSocialAccountsRoute,
  POST as createSocialAccountRoute,
} from '@/app/api/v1/social/accounts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { publisherLabels, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { providerLabel } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';
import { buildProviderOptions } from '@/ui/social/provider-options';
import { SocialAccounts, type AccountRow } from '@/ui/social/social-accounts';

/**
 * provider が `constructor` の SNS アカウント（047-prototype-key-sweep 設計 §1.2・§6・§11 の 1、
 * 受け入れ条件 #11）。
 *
 * **`provider: 'constructor'` はこれまでどおり 201 で受け付ける**（名前の拒否リストは採らない）。
 * 直すのは読む側で、変更前は `providerLabel('constructor', publisherLabels())` が `Object` 関数を返し、
 * 画面のアカウント名が `とりふね（function Object() { [native code] }）` になっていた（K3）。
 *
 * publisher は登録しない（実装プラン T3）。準備は `social-account-credentials.integration.test.ts` を写した。
 */

// `SocialAccounts` は `useRouter` を使う。App Router の外では例外を投げるので差し替える。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const BASE = 'http://127.0.0.1:3000/api/v1/social/accounts';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let token: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
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
        display_name: 'social account prototype provider test',
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
    displayName: 'social account prototype provider test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function toJson(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function callCreate(body: unknown): Promise<JsonResult> {
  return toJson(
    await createSocialAccountRoute(
      new Request(BASE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function callList(query: string): Promise<JsonResult> {
  return toJson(
    await listSocialAccountsRoute(
      new Request(`${BASE}?${query}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      }),
    ),
  );
}

function accountInput(provider: string): Record<string, unknown> {
  return {
    provider,
    displayName: 'とりふね',
    handle: '@torifune',
    status: 'connected',
  };
}

function itemsOf(result: JsonResult): Record<string, unknown>[] {
  return result.body['data'] as Record<string, unknown>[];
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialprotoprovider');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  resetPublisherRegistry();
  admin = await contextFor(['administrator']);
  const created = await createApiToken(admin, {
    name: 'prototype provider test',
    scopes: ['social.read', 'social.write'],
    expiresAt: null,
  });
  token = created.plaintext;
});

afterEach(async () => {
  resetPublisherRegistry();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#11 provider: constructor の SNS アカウント', () => {
  it('#11 social.write の Token で provider: constructor を POST すると 201（従来どおり）', async () => {
    const result = await callCreate(accountInput('constructor'));

    expect(result.status).toBe(201);
  });

  it('#11 GET ?provider=constructor が 200 で 1 件', async () => {
    await callCreate(accountInput('constructor'));

    const result = await callList('provider=constructor');

    expect(result.status).toBe(200);
    expect(itemsOf(result)).toHaveLength(1);
    expect(itemsOf(result)[0]?.['provider']).toBe('constructor');
  });

  it('#11 一覧の provider を providerLabel(provider, publisherLabels()) に渡すと constructor', async () => {
    await callCreate(accountInput('constructor'));
    const provider = String(itemsOf(await callList('provider=constructor'))[0]?.['provider']);

    const label = providerLabel(provider, publisherLabels());

    expect(typeof label).toBe('string');
    expect(label).toBe('constructor');
  });

  it('#11 一覧の行を SocialAccounts で描くと「サービス」列が constructor で function Object が無い', async () => {
    // 画面（`/social`）が一覧の行と `buildProviderOptions` の結果で描くのと同じ組み合わせ（設計 §1.2）。
    await callCreate(accountInput('constructor'));
    const item = itemsOf(await callList('provider=constructor'))[0] ?? {};
    const row: AccountRow = {
      id: String(item['id']),
      provider: String(item['provider']),
      displayName: String(item['displayName']),
      handle: String(item['handle']),
      status: String(item['status']),
      credentialConfigured: item['credentialConfigured'] === true,
    };

    const html = renderToStaticMarkup(
      createElement(SocialAccounts, {
        initialAccounts: [row],
        permissions: ['social.read', 'social.write'],
        providers: buildProviderOptions([]),
      }),
    );
    const bodyRow = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((match) => match[1] ?? '')
      .find((candidate) => candidate.includes('@torifune'));
    const serviceCell = /<td\b[^>]*>([\s\S]*?)<\/td>/.exec(bodyRow ?? '')?.[1];

    expect(serviceCell?.replace(/<[^>]+>/g, '')).toBe('constructor');
    expect(html).not.toContain('function Object');
  });

  it.each(['__proto__', 'toString'])(
    '#11 provider: %s は 422 で details のキーが provider（従来どおり）',
    async (provider) => {
      const result = await callCreate(accountInput(provider));

      expect(result.status).toBe(422);
      expect(Object.keys(detailsOf(result))).toEqual(['provider']);
    },
  );
});
