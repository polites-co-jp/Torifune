import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GET as getCampaignRoute,
  PATCH as updateCampaignRoute,
} from '@/app/api/v1/campaigns/[id]/route';
import { POST as createCampaignRoute } from '@/app/api/v1/campaigns/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `POST /api/v1/campaigns`・`PATCH /api/v1/campaigns/{id}` の `siteIds` / `socialPostIds`
 * （045-campaign-input-500 設計 §6.3・§8、受け入れ条件 #10〜#22）。
 *
 * - 存在しない ID（#10〜#12・#16）：500 ではなく 422。キーは `siteIds` / `socialPostIds`。何も書かない
 * - 形の誤り（#13）：UUID の形（8-4-4-4-12）でなければ 422 `UUID の形で指定してください。`
 * - 大文字（#14）：同じ ID として扱い、応答も後の `GET` も小文字
 * - 件数（#15）：1000 件まで（重複を除く前）。1001 件以上は 422 `1000件以内で指定してください。`
 * - 値を載せない（#17）：422 の本文に、送った ID・値が含まれない
 * - 従来どおり（#18）：昇順・空・重複の除去
 * - `PATCH`（#19〜#21）：失敗すれば何も変わらない。本文の形の誤りは 404 より先、存在の確かめは 404 より後
 * - 認可が先（#22）：403・401 が 422 より先に返る
 *
 * **ルートを直接叩く結合テスト**（`list-query.integration.test.ts`・`social-post-create.integration.test.ts` の形を写した）。
 * 認証は Bearer の API Token（`campaign.read`・`campaign.write`）。サイト・SNS 投稿は UseCase で作る。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const CAMPAIGNS_URL = `${ORIGIN}/api/v1/campaigns`;
const CSRF_TOKEN = 'csrf-token-for-campaign-link-input';

const NOT_FOUND_SITE = '存在しないWebサイトが含まれています。';
const NOT_FOUND_POST = '存在しないSNS投稿が含まれています。';
const SHAPE = 'UUID の形で指定してください。';
const TOO_MANY = '1000件以内で指定してください。';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** `campaign.read` と `campaign.write` を持つ Token の平文。 */
let writeToken: string;
/** 実在するサイト S1・S2 と SNS 投稿 P1。 */
let s1: string;
let s2: string;
let p1: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function dataOf(result: JsonResult): Record<string, unknown> {
  return result.body['data'] as Record<string, unknown>;
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

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  return errorOf(result).details ?? {};
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `i${suffix}`,
        email: `i${suffix}@example.com`,
        display_name: 'campaign link input test',
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
    loginId: `i${suffix}`,
    displayName: 'campaign link input test',
    email: `i${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function issueToken(scopes: readonly string[]): Promise<string> {
  const created = await createApiToken(admin, {
    name: `t-${uuidv7().slice(-8)}`,
    scopes,
    expiresAt: null,
  });
  return created.plaintext;
}

interface CallOptions {
  /** Bearer の平文。省略すると `writeToken`。`null` なら Authorization を付けない。 */
  readonly token?: string | null;
  /** セッション経路（Cookie）を模す。CSRF を通すためのヘッダを付ける（401 を確かめるため）。 */
  readonly browser?: boolean;
}

function headersFor(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = options.token === undefined ? writeToken : options.token;
  if (token !== null) {
    headers['authorization'] = `Bearer ${token}`;
  }
  if (options.browser === true) {
    // Bearer が無い経路は CSRF を通らないと 403 になり、401 を確かめられない。
    headers['x-forwarded-host'] = '127.0.0.1:3000';
    headers['origin'] = ORIGIN;
    headers['cookie'] = `torifune_csrf=${CSRF_TOKEN}`;
    headers['x-csrf-token'] = CSRF_TOKEN;
  }
  return headers;
}

async function resultOf(response: Response): Promise<JsonResult> {
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** 名前と開始日だけの、通るだけの本文に `overrides` を重ねる。 */
function campaignBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'キャンペーン', startsOn: '2026-01-01', ...overrides };
}

async function callCreate(body: unknown, options: CallOptions = {}): Promise<JsonResult> {
  return resultOf(
    await createCampaignRoute(
      new Request(CAMPAIGNS_URL, {
        method: 'POST',
        headers: headersFor(options),
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function callUpdate(
  id: string,
  body: unknown,
  options: CallOptions = {},
): Promise<JsonResult> {
  return resultOf(
    await updateCampaignRoute(
      new Request(`${CAMPAIGNS_URL}/${id}`, {
        method: 'PATCH',
        headers: headersFor(options),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function callGet(id: string): Promise<JsonResult> {
  return resultOf(
    await getCampaignRoute(
      new Request(`${CAMPAIGNS_URL}/${id}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${writeToken}` },
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

async function countCampaigns(): Promise<number> {
  return withConnection(async (connection) => {
    const rows = await connection.db.selectFrom('campaigns').select('id').execute();
    return rows.length;
  });
}

/** S1 を対象にしたキャンペーンを UseCase で作る（#19・#20）。 */
async function campaignOnS1(): Promise<string> {
  const campaign = await createCampaign(admin, {
    name: '元の名前',
    description: '',
    status: 'draft',
    startsOn: '2026-01-01',
    endsOn: null,
    siteIds: [s1],
  });
  return campaign.id;
}

/**
 * 形の誤り（設計 #13）。引数はハイフンなし・`{…}` の元にする実在の ID
 * （サイト・投稿は `beforeEach` で作るので、値はテストの中で組み立てる）。
 */
const MALFORMED: readonly (readonly [string, (id: string) => string])[] = [
  ['abc', () => 'abc'],
  ['空文字', () => ''],
  ['1000 文字', () => 'a'.repeat(1000)],
  ['実在する ID のハイフンなし', (id) => id.replaceAll('-', '')],
  ['実在する ID を {…} で囲んだ値', (id) => `{${id}}`],
];

beforeAll(async () => {
  scratch = await useScratchDatabase('campaignlinkinput');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  writeToken = await issueToken(['campaign.read', 'campaign.write']);

  for (const label of ['s1', 's2']) {
    const site = await createSite(admin, {
      name: label,
      url: `https://${label}.example.com`,
      description: '',
      status: 'active',
    });
    if (label === 's1') s1 = site.id;
    else s2 = site.id;
  }

  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'アカウント',
    handle: '@campaign-link',
    credential: null,
    status: 'connected',
  });
  p1 = (
    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: 'P1',
      scheduledAt: null,
      status: 'draft',
    })
  ).post.id;
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #10・#11 存在しない ID                                                            */
/* -------------------------------------------------------------------------- */

describe('#10 POST の siteIds に UUID の形で存在しない ID は 422 siteIds', () => {
  const missingIds: readonly (readonly [string, () => string])[] = [
    ['新しい UUID', (): string => uuidv7()],
    ['00000000-0000-0000-0000-000000000000', (): string => '00000000-0000-0000-0000-000000000000'],
  ];

  it.each(missingIds)('#10 %s → 422 VALIDATION_ERROR', async (_label, make) => {
    const result = await callCreate(campaignBody({ siteIds: [make()] }));

    expect(result.status, result.text).toBe(422);
    expect(errorOf(result).code).toBe('VALIDATION_ERROR');
  });

  it(`#10 details.siteIds がちょうど ["${NOT_FOUND_SITE}"]`, async () => {
    const result = await callCreate(campaignBody({ siteIds: [uuidv7()] }));

    expect(detailsOf(result)['siteIds']).toEqual([NOT_FOUND_SITE]);
  });

  it('#10 キャンペーンの件数が増えていない', async () => {
    await callCreate(campaignBody({ siteIds: [uuidv7()] }));

    expect(await countCampaigns()).toBe(0);
  });

  it('#10 実在する ID と存在しない ID が混ざっても全体を断る（422、件数が増えない）', async () => {
    const result = await callCreate(campaignBody({ siteIds: [s1, uuidv7()] }));

    expect(result.status, result.text).toBe(422);
    expect(await countCampaigns()).toBe(0);
  });
});

describe('#11 POST の socialPostIds に UUID の形で存在しない ID は 422 socialPostIds', () => {
  it('#11 → 422 VALIDATION_ERROR', async () => {
    const result = await callCreate(campaignBody({ socialPostIds: [uuidv7()] }));

    expect(result.status, result.text).toBe(422);
    expect(errorOf(result).code).toBe('VALIDATION_ERROR');
  });

  it(`#11 details.socialPostIds がちょうど ["${NOT_FOUND_POST}"]`, async () => {
    const result = await callCreate(campaignBody({ socialPostIds: [uuidv7()] }));

    expect(detailsOf(result)['socialPostIds']).toEqual([NOT_FOUND_POST]);
  });

  it('#11 キャンペーンの件数が増えていない', async () => {
    await callCreate(campaignBody({ socialPostIds: [uuidv7()] }));

    expect(await countCampaigns()).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #12 種類の取り違え                                                                */
/* -------------------------------------------------------------------------- */

describe('#12 別の種類の実在する ID は存在しない ID として扱う', () => {
  it(`#12 siteIds: [P1]（SNS 投稿の ID）→ 422、details.siteIds が ["${NOT_FOUND_SITE}"]`, async () => {
    const result = await callCreate(campaignBody({ siteIds: [p1] }));

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['siteIds']).toEqual([NOT_FOUND_SITE]);
  });

  it(`#12 socialPostIds: [S1]（サイトの ID）→ 422、details.socialPostIds が ["${NOT_FOUND_POST}"]`, async () => {
    const result = await callCreate(campaignBody({ socialPostIds: [s1] }));

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['socialPostIds']).toEqual([NOT_FOUND_POST]);
  });
});

/* -------------------------------------------------------------------------- */
/* #13 形の誤り                                                                      */
/* -------------------------------------------------------------------------- */

describe('#13 siteIds の要素が UUID の形でなければ 422 siteIds（形の文言）', () => {
  it.each(MALFORMED)(
    `#13 siteIds に %s → 422、details.siteIds がちょうど ["${SHAPE}"]`,
    async (_label, make) => {
      const result = await callCreate(campaignBody({ siteIds: [make(s1)] }));

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)['siteIds']).toEqual([SHAPE]);
    },
  );

  it('#13 形の誤りでは details に socialPostIds が出ない（キーを取り違えない）', async () => {
    const result = await callCreate(campaignBody({ siteIds: ['abc'] }));

    expect(Object.keys(detailsOf(result))).toEqual(['siteIds']);
  });
});

describe('#13 socialPostIds の要素が UUID の形でなければ 422 socialPostIds（形の文言）', () => {
  it.each(MALFORMED)(
    `#13 socialPostIds に %s → 422、details.socialPostIds がちょうど ["${SHAPE}"]`,
    async (_label, make) => {
      const result = await callCreate(campaignBody({ socialPostIds: [make(p1)] }));

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)['socialPostIds']).toEqual([SHAPE]);
    },
  );

  it('#13 形の誤りでは details に siteIds が出ない（キーを取り違えない）', async () => {
    const result = await callCreate(campaignBody({ socialPostIds: ['abc'] }));

    expect(Object.keys(detailsOf(result))).toEqual(['socialPostIds']);
  });
});

/* -------------------------------------------------------------------------- */
/* #14 大文字                                                                        */
/* -------------------------------------------------------------------------- */

describe('#14 大文字と小文字は同じ ID として扱い、小文字で返す', () => {
  it('#14 siteIds: [S1, S1 の大文字] → 201、応答の siteIds が [S1]', async () => {
    const result = await callCreate(campaignBody({ siteIds: [s1, s1.toUpperCase()] }));

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['siteIds']).toEqual([s1]);
  });

  it('#14 siteIds: [S1 の大文字] → 201、応答の siteIds が [S1]（小文字）', async () => {
    const result = await callCreate(campaignBody({ siteIds: [s1.toUpperCase()] }));

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['siteIds']).toEqual([s1]);
  });

  it('#14 大文字で作った後の GET /campaigns/{id} の siteIds が作成の応答と等しい', async () => {
    const created = await callCreate(campaignBody({ siteIds: [s1.toUpperCase()] }));
    const id = String(dataOf(created)['id']);

    const got = await callGet(id);

    expect(got.status, got.text).toBe(200);
    expect(dataOf(got)['siteIds']).toEqual(dataOf(created)['siteIds']);
  });

  it('#14 socialPostIds: [P1, P1 の大文字] → 201、応答の socialPostIds が [P1]', async () => {
    const result = await callCreate(campaignBody({ socialPostIds: [p1, p1.toUpperCase()] }));

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['socialPostIds']).toEqual([p1]);
  });
});

/* -------------------------------------------------------------------------- */
/* #15 件数                                                                          */
/* -------------------------------------------------------------------------- */

describe('#15 件数は 1000 件まで（重複を除く前）', () => {
  it('#15 siteIds に S1 を 1000 個 → 201、[S1]', async () => {
    const result = await callCreate(
      campaignBody({ siteIds: Array.from({ length: 1000 }, () => s1) }),
    );

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['siteIds']).toEqual([s1]);
  });

  it(`#15 siteIds に S1 を 1001 個 → 422、details.siteIds に「${TOO_MANY}」`, async () => {
    const result = await callCreate(
      campaignBody({ siteIds: Array.from({ length: 1001 }, () => s1) }),
    );

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['siteIds']).toContain(TOO_MANY);
  });

  it('#15 socialPostIds に P1 を 1000 個 → 201、[P1]', async () => {
    const result = await callCreate(
      campaignBody({ socialPostIds: Array.from({ length: 1000 }, () => p1) }),
    );

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['socialPostIds']).toEqual([p1]);
  });

  it(`#15 socialPostIds に P1 を 1001 個 → 422、details.socialPostIds に「${TOO_MANY}」`, async () => {
    const result = await callCreate(
      campaignBody({ socialPostIds: Array.from({ length: 1001 }, () => p1) }),
    );

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['socialPostIds']).toContain(TOO_MANY);
  });
});

/* -------------------------------------------------------------------------- */
/* #16 両方の誤りをまとめて返す                                                        */
/* -------------------------------------------------------------------------- */

describe('#16 両方に存在しない ID があれば details に両方のキーが入る', () => {
  it('#16 → 422、details に siteIds と socialPostIds の両方', async () => {
    const result = await callCreate(
      campaignBody({ siteIds: [uuidv7()], socialPostIds: [uuidv7()] }),
    );

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({
      siteIds: [NOT_FOUND_SITE],
      socialPostIds: [NOT_FOUND_POST],
    });
  });

  it('#16 両方に形の誤りがあれば、details に両方のキーが形の文言で入る', async () => {
    const result = await callCreate(campaignBody({ siteIds: ['abc'], socialPostIds: ['abc'] }));

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)).toEqual({ siteIds: [SHAPE], socialPostIds: [SHAPE] });
  });
});

/* -------------------------------------------------------------------------- */
/* #17 値を載せない                                                                  */
/* -------------------------------------------------------------------------- */

describe('#17 422 の応答の本文に、送った値が含まれない', () => {
  it('#17 存在しない ID を送った 422 の本文に、その ID が含まれない', async () => {
    const missing = uuidv7();

    const result = await callCreate(campaignBody({ siteIds: [missing] }));

    expect(result.status, result.text).toBe(422);
    expect(result.text).not.toContain(missing);
  });

  it('#17 存在しない SNS 投稿の ID を送った 422 の本文に、その ID が含まれない', async () => {
    const missing = uuidv7();

    const result = await callCreate(campaignBody({ socialPostIds: [missing] }));

    expect(result.status, result.text).toBe(422);
    expect(result.text).not.toContain(missing);
  });

  it('#17 形の誤りの値（abc）を送った 422 の本文に、その値が含まれない', async () => {
    const result = await callCreate(campaignBody({ siteIds: ['abc'] }));

    expect(result.status, result.text).toBe(422);
    expect(result.text).not.toContain('abc');
  });
});

/* -------------------------------------------------------------------------- */
/* #18 従来どおり                                                                    */
/* -------------------------------------------------------------------------- */

describe('#18 実在する ID は従来どおり（昇順・空・重複の除去）', () => {
  it('#18 siteIds: [S2, S1] → 201、昇順に並ぶ', async () => {
    const result = await callCreate(campaignBody({ siteIds: [s2, s1] }));

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['siteIds']).toEqual([s1, s2].sort());
  });

  it('#18 siteIds: [] → 201、[]', async () => {
    const result = await callCreate(campaignBody({ siteIds: [] }));

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['siteIds']).toEqual([]);
  });

  it('#18 siteIds: [S1, S1]（同じ ID の重複）→ 201、1 件', async () => {
    const result = await callCreate(campaignBody({ siteIds: [s1, s1] }));

    expect(result.status, result.text).toBe(201);
    expect(dataOf(result)['siteIds']).toEqual([s1]);
  });
});

/* -------------------------------------------------------------------------- */
/* #19・#20 PATCH                                                                  */
/* -------------------------------------------------------------------------- */

describe('#19 PATCH の失敗で名前も紐づけも変わらない', () => {
  it(`#19 { name: '変えた名前', siteIds: [存在しない ID] } → 422、details.siteIds が ["${NOT_FOUND_SITE}"]`, async () => {
    const id = await campaignOnS1();

    const result = await callUpdate(id, { name: '変えた名前', siteIds: [uuidv7()] });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['siteIds']).toEqual([NOT_FOUND_SITE]);
  });

  it('#19 失敗の後の GET で、名前が変わっていない', async () => {
    const id = await campaignOnS1();
    await callUpdate(id, { name: '変えた名前', siteIds: [uuidv7()] });

    const got = await callGet(id);

    expect(dataOf(got)['name']).toBe('元の名前');
  });

  it('#19 失敗の後の GET で、siteIds が [S1] のまま', async () => {
    const id = await campaignOnS1();
    await callUpdate(id, { name: '変えた名前', siteIds: [uuidv7()] });

    const got = await callGet(id);

    expect(dataOf(got)['siteIds']).toEqual([s1]);
  });
});

describe('#20 PATCH の形の誤り・存在しない投稿は 422、大文字との重複は 200', () => {
  it(`#20 siteIds: ['abc'] → 422、details.siteIds が ["${SHAPE}"]`, async () => {
    const id = await campaignOnS1();

    const result = await callUpdate(id, { siteIds: ['abc'] });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['siteIds']).toEqual([SHAPE]);
  });

  it(`#20 socialPostIds: [存在しない ID] → 422、details.socialPostIds が ["${NOT_FOUND_POST}"]`, async () => {
    const id = await campaignOnS1();

    const result = await callUpdate(id, { socialPostIds: [uuidv7()] });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['socialPostIds']).toEqual([NOT_FOUND_POST]);
  });

  it('#20 siteIds: [S2, S2 の大文字] → 200、[S2]', async () => {
    const id = await campaignOnS1();

    const result = await callUpdate(id, { siteIds: [s2, s2.toUpperCase()] });

    expect(result.status, result.text).toBe(200);
    expect(dataOf(result)['siteIds']).toEqual([s2]);
  });

  it('#20 siteIds: [S2 の大文字] で更新した後の GET の siteIds が [S2]（小文字）', async () => {
    const id = await campaignOnS1();
    await callUpdate(id, { siteIds: [s2.toUpperCase()] });

    const got = await callGet(id);

    expect(dataOf(got)['siteIds']).toEqual([s2]);
  });
});

/* -------------------------------------------------------------------------- */
/* #21 404 と 422 の順序                                                            */
/* -------------------------------------------------------------------------- */

describe('#21 存在しないキャンペーンへの PATCH：本文の形の誤りは 404 より先、存在の確かめは 404 より後', () => {
  it('#21 PATCH /campaigns/{UUID の形で存在しない ID} に siteIds: [存在しない ID] → 404', async () => {
    const result = await callUpdate(uuidv7(), { siteIds: [uuidv7()] });

    expect(result.status, result.text).toBe(404);
  });

  it("#21 同じパスに siteIds: ['abc'] → 422", async () => {
    const result = await callUpdate(uuidv7(), { siteIds: ['abc'] });

    expect(result.status, result.text).toBe(422);
    expect(detailsOf(result)['siteIds']).toEqual([SHAPE]);
  });
});

/* -------------------------------------------------------------------------- */
/* #22 認可が先                                                                      */
/* -------------------------------------------------------------------------- */

describe('#22 認可は siteIds の検査より先', () => {
  it("#22 POST に siteIds: ['abc'] を campaign.write を持たない Token で → 403 FORBIDDEN", async () => {
    const readOnly = await issueToken(['campaign.read']);

    const result = await callCreate(campaignBody({ siteIds: ['abc'] }), { token: readOnly });

    expect(result.status, result.text).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it("#22 POST に siteIds: ['abc'] を認証なしで → 401 UNAUTHENTICATED", async () => {
    const result = await callCreate(campaignBody({ siteIds: ['abc'], csrfToken: CSRF_TOKEN }), {
      token: null,
      browser: true,
    });

    expect(result.status, result.text).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it("#22 PATCH に siteIds: ['abc'] を campaign.write を持たない Token で → 403 FORBIDDEN", async () => {
    const id = await campaignOnS1();
    const readOnly = await issueToken(['campaign.read']);

    const result = await callUpdate(id, { siteIds: ['abc'] }, { token: readOnly });

    expect(result.status, result.text).toBe(403);
    expect(errorOf(result).code).toBe('FORBIDDEN');
  });

  it("#22 PATCH に siteIds: ['abc'] を認証なしで → 401 UNAUTHENTICATED", async () => {
    const id = await campaignOnS1();

    const result = await callUpdate(
      id,
      { siteIds: ['abc'], csrfToken: CSRF_TOKEN },
      { token: null, browser: true },
    );

    expect(result.status, result.text).toBe(401);
    expect(errorOf(result).code).toBe('UNAUTHENTICATED');
  });

  it('#22 campaign.write を持つ Token なら POST の同じ要求は 201 ではなく 422（403・401 が値のせいでないことの対照）', async () => {
    const result = await callCreate(campaignBody({ siteIds: ['abc'] }));

    expect(result.status, result.text).toBe(422);
  });
});
