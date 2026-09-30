import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as analyticsRoute } from '@/app/api/v1/analytics/route';
import { GET as getCampaignRoute } from '@/app/api/v1/campaigns/[id]/route';
import { POST as createCampaignRoute } from '@/app/api/v1/campaigns/route';
import { recordAnalytics } from '@/application/analytics/analytics-use-cases';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 年が 1000 未満の日付の応答（046-input-500-nul-and-ranges 設計 §6.4 の N4、受け入れ条件 #51。ユーザー裁定 4）。
 *
 * - `GET /analytics?from=0001-01-01&to=0001-01-01`（その日の値がある）→ `metricDate` が `'0001-01-01'`（いまは `'1-01-01'`）
 * - `POST /campaigns` の `startsOn: '0100-01-01'`・`endsOn: '0100-12-31'` → 応答と後の `GET` の `startsOn` / `endsOn` が
 *   `'0100-01-01'` / `'0100-12-31'`（いまは `'100-01-01'`）
 *
 * `0001-01-01` の値は `recordAnalytics`（Data API と同じ UseCase）で入れる。ルートを直接叩く。認証は Bearer の API Token。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const BASE = `${ORIGIN}/api/v1`;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let token: string;
let siteId: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `dy${suffix}`,
        email: `dy${suffix}@example.com`,
        display_name: 'date only year test',
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
    loginId: `dy${suffix}`,
    displayName: 'date only year test',
    email: `dy${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function resultOf(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('dateonlyyear');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  token = (
    await createApiToken(admin, {
      name: 'date only year token',
      scopes: ['analytics.read', 'campaign.read', 'campaign.write'],
      expiresAt: null,
    })
  ).plaintext;
  siteId = (
    await createSite(admin, {
      name: 'サイト',
      url: 'https://site.example.com',
      description: '',
      status: 'active',
    })
  ).id;
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#51 GET /analytics の metricDate の年が 4 桁', () => {
  it("#51 0001-01-01 の値 → metricDate が '0001-01-01'", async () => {
    await recordAnalytics(admin, {
      siteId,
      metricDate: '0001-01-01',
      source: 'date-only-year-plugin',
      metric: 'visits',
      value: 5,
    });

    const result = await resultOf(
      await analyticsRoute(
        new Request(`${BASE}/analytics?from=0001-01-01&to=0001-01-01&siteId=${siteId}`, {
          method: 'GET',
          headers: authHeaders(),
        }),
      ),
    );

    expect(result.status, result.text).toBe(200);
    const items = result.body['data'] as readonly { readonly metricDate: string }[];
    expect(items.map((item) => item.metricDate)).toEqual(['0001-01-01']);
  });
});

describe('#51 キャンペーンの startsOn / endsOn の年が 4 桁', () => {
  async function create(): Promise<JsonResult> {
    return resultOf(
      await createCampaignRoute(
        new Request(`${BASE}/campaigns`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            name: '西暦 100 年のキャンペーン',
            startsOn: '0100-01-01',
            endsOn: '0100-12-31',
          }),
        }),
      ),
    );
  }

  it("#51 POST /campaigns の応答の startsOn / endsOn が '0100-01-01' / '0100-12-31'", async () => {
    const result = await create();

    expect(result.status, result.text).toBe(201);
    expect(result.body['data']).toMatchObject({ startsOn: '0100-01-01', endsOn: '0100-12-31' });
  });

  it("#51 後の GET /campaigns/{id} の startsOn / endsOn が '0100-01-01' / '0100-12-31'", async () => {
    const created = await create();
    const id = (created.body['data'] as { readonly id: string }).id;

    const result = await resultOf(
      await getCampaignRoute(
        new Request(`${BASE}/campaigns/${id}`, { method: 'GET', headers: authHeaders() }),
        { params: Promise.resolve({ id }) },
      ),
    );

    expect(result.status, result.text).toBe(200);
    expect(result.body['data']).toMatchObject({ startsOn: '0100-01-01', endsOn: '0100-12-31' });
  });
});
