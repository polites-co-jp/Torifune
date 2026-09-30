import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listCampaignsRoute } from '@/app/api/v1/campaigns/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign, listCampaigns } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { isValidDateOnly } from '@/domain/campaign/campaign';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `GET /api/v1/campaigns?activeOn=` の暦の検査（045-campaign-input-500 設計 §6.2・§8、受け入れ条件 #1〜#5）。
 *
 * - #1：暦に無い日付（形は `YYYY-MM-DD`）は 500 ではなく 422 `activeOn`（`存在しない日付です。`）
 * - #2：暦にある日付（うるう年の 2/29・`9999-12-31`）は 200 で正しく絞る（従来どおり）
 * - #3：形の誤りは従来どおり 422（`YYYY-MM-DD の形式で入力してください。`）
 * - #4：**認可は検査より先**（403・401 が 422 より先に返る）
 * - #5：UseCase `listCampaigns` を直接呼んでも `ValidationError`（`field === 'activeOn'`）で、DB の例外ではない
 *
 * **ルートを直接叩く結合テスト**（`list-query.integration.test.ts` の形を写した）。
 * 認証は Bearer の API Token。キャンペーンは UseCase で作る。
 */

const CAMPAIGNS_URL = 'http://127.0.0.1:3000/api/v1/campaigns';

/** 設計 #1 の 7 値。形は `YYYY-MM-DD` だが暦に無い（`0050-06-01` は西暦 1〜99 年の扱い。設計 §6.2）。 */
const NOT_ON_CALENDAR = [
  '2026-02-30',
  '2026-13-01',
  '2026-00-10',
  '2026-01-00',
  '2026-02-29',
  '0000-01-01',
  '0050-06-01',
] as const;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** `campaign.read` を持つ Token の平文。 */
let readToken: string;

interface JsonResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): readonly Record<string, unknown>[] {
  return result.body['data'] as readonly Record<string, unknown>[];
}

function errorOf(result: JsonResult): {
  readonly code?: string;
  readonly details?: Record<string, readonly string[]>;
} {
  return (result.body['error'] ?? {}) as {
    readonly code?: string;
    readonly details?: Record<string, readonly string[]>;
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
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'campaign active on test',
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
    displayName: 'campaign active on test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function list(query: string, token: string | null = readToken): Promise<JsonResult> {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const response = await listCampaignsRoute(
    new Request(`${CAMPAIGNS_URL}${query}`, { method: 'GET', headers }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

async function makeCampaign(
  name: string,
  startsOn: string,
  endsOn: string | null,
): Promise<string> {
  const campaign = await createCampaign(admin, {
    name,
    description: '',
    status: 'draft',
    startsOn,
    endsOn,
    siteIds: [],
  });
  return campaign.id;
}

/** UseCase `listCampaigns` の入力（`activeOn` だけを変える）。 */
function listInput(activeOn: string | null): Parameters<typeof listCampaigns>[1] {
  return {
    page: 1,
    perPage: 20,
    status: null,
    keyword: null,
    activeOn,
    siteId: null,
    sort: [{ field: 'starts_on', direction: 'desc' }],
  };
}

/** 返した Promise が reject したときの例外。resolve したらテストを落とす。 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return expect.unreachable('reject されなかった');
}

beforeAll(async () => {
  scratch = await useScratchDatabase('campaignactiveon');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  const created = await createApiToken(admin, {
    name: 'campaign active on test',
    scopes: ['campaign.read'],
    expiresAt: null,
  });
  readToken = created.plaintext;
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* 前提：UseCase が使う判定（isValidDateOnly）                                     */
/* -------------------------------------------------------------------------- */

describe('前提：isValidDateOnly が #1 の値を暦に無い日付とする', () => {
  it.each(NOT_ON_CALENDAR)('isValidDateOnly(%s) === false', (value) => {
    expect(isValidDateOnly(value)).toBe(false);
  });

  it.each(['2024-02-29', '2026-04-15', '9999-12-31'])('isValidDateOnly(%s) === true', (value) => {
    expect(isValidDateOnly(value)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #1 暦に無い日付                                                                  */
/* -------------------------------------------------------------------------- */

describe('#1 暦に無い activeOn は 500 ではなく 422 activeOn', () => {
  it.each(NOT_ON_CALENDAR)('#1 activeOn=%s → 422 VALIDATION_ERROR', async (value) => {
    const result = await list(`?activeOn=${value}`);

    expect(result.status, JSON.stringify(result.body)).toBe(422);
    expect(errorOf(result).code).toBe('VALIDATION_ERROR');
  });

  it.each(NOT_ON_CALENDAR)(
    '#1 activeOn=%s → details.activeOn がちょうど ["存在しない日付です。"]',
    async (value) => {
      const result = await list(`?activeOn=${value}`);

      expect(errorOf(result).details?.['activeOn']).toEqual(['存在しない日付です。']);
    },
  );

  it('#1 422 の応答にキャンペーンが 1 件も載らない（絞り込みを外して全件を返さない）', async () => {
    await makeCampaign('載ってはいけない', '2026-01-01', null);

    const result = await list('?activeOn=2026-02-30');

    expect(result.body['data']).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* #2 暦にある日付は従来どおり絞る                                                    */
/* -------------------------------------------------------------------------- */

describe('#2 暦にある activeOn は 200 で正しく絞る', () => {
  async function seed(): Promise<{ readonly a: string; readonly b: string }> {
    const a = await makeCampaign('A', '2024-02-01', '2024-03-31');
    const b = await makeCampaign('B', '2024-03-01', null);
    return { a, b };
  }

  it('#2 activeOn=2024-02-29（うるう年）→ 200、A を含み B を含まない', async () => {
    const { a, b } = await seed();

    const result = await list('?activeOn=2024-02-29');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const ids = dataOf(result).map((campaign) => campaign['id']);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });

  it('#2 activeOn=9999-12-31 → 200、B を含み A を含まない', async () => {
    const { a, b } = await seed();

    const result = await list('?activeOn=9999-12-31');

    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const ids = dataOf(result).map((campaign) => campaign['id']);
    expect(ids).toContain(b);
    expect(ids).not.toContain(a);
  });
});

/* -------------------------------------------------------------------------- */
/* #3 形の誤りは従来どおり                                                           */
/* -------------------------------------------------------------------------- */

describe('#3 形の誤りは従来どおり 422（形式の文言）', () => {
  it.each(['abc', '2026-1-1'])(
    '#3 activeOn=%s → 422、details.activeOn が "YYYY-MM-DD の形式で入力してください。"',
    async (value) => {
      const result = await list(`?activeOn=${value}`);

      expect(result.status).toBe(422);
      expect(errorOf(result).details?.['activeOn']).toEqual([
        'YYYY-MM-DD の形式で入力してください。',
      ]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #4 認可は検査より先                                                               */
/* -------------------------------------------------------------------------- */

describe('#4 認可は activeOn の検査より先', () => {
  it('#4 campaign.read を持たない Token で activeOn=2026-02-30 → 403 FORBIDDEN', async () => {
    const other = await createApiToken(admin, {
      name: 'site read only',
      scopes: ['site.read'],
      expiresAt: null,
    });

    const result = await list('?activeOn=2026-02-30', other.plaintext);

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it('#4 認証なしで activeOn=2026-02-30 → 401 UNAUTHENTICATED', async () => {
    const result = await list('?activeOn=2026-02-30', null);

    expect(result.status).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });
});

/* -------------------------------------------------------------------------- */
/* #5 UseCase を直接呼ぶ                                                             */
/* -------------------------------------------------------------------------- */

describe('#5 UseCase listCampaigns も暦に無い activeOn を ValidationError で断る', () => {
  it('#5 activeOn: "2026-02-30" → ValidationError（DB の例外ではない）', async () => {
    const error = await rejectionOf(listCampaigns(admin, listInput('2026-02-30')));

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('#5 activeOn: "2026-02-30" → field === "activeOn"', async () => {
    const error = await rejectionOf(listCampaigns(admin, listInput('2026-02-30')));

    expect((error as { field?: unknown }).field).toBe('activeOn');
  });

  it('#5 activeOn: "2024-02-29" → 例外なし', async () => {
    await expect(listCampaigns(admin, listInput('2024-02-29'))).resolves.toMatchObject({
      total: 0,
    });
  });
});
