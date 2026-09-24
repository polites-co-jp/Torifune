import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PATCH as updateSocialPostRoute } from '@/app/api/v1/social/posts/[id]/route';
import { POST as createSocialPostRoute } from '@/app/api/v1/social/posts/route';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `POST` / `PATCH /social/posts` の `scheduledAt` の範囲（046-input-500-nul-and-ranges 設計 §6.5・§8、受け入れ条件 #41・#43）。
 *
 * - #41（B3）：範囲外（`-8.64e15`（数値）・`'-271821-04-20T00:00:00Z'`・`'-010000-01-01T00:00:00Z'`・`'0000-12-31T23:59:59.999Z'`・
 *   `'+010000-01-01T00:00:00Z'`・`8.64e15`（数値））→ 422 `details.scheduledAt`（範囲の文言）、投稿が増えない。
 *   範囲内（`'0001-01-01T00:00:00Z'`・`'9999-12-31T23:59:59.999Z'`・`'2030-01-01T09:00:00+09:00'`・`null`）→ 201。
 *   `PATCH` も同じ（範囲外は 422 で行が変わらない、範囲内は 200）
 * - #43：認可が先（`social.write` を持たない Token → 403、認証なし → 401）
 *
 * ルートを直接叩く（`social-post-create.integration.test.ts` の形）。数値の `scheduledAt` は JSON の数として送る。
 */

const ORIGIN = 'http://127.0.0.1:3000';
const ENDPOINT = `${ORIGIN}/api/v1/social/posts`;
const CSRF_TOKEN = 'csrf-token-for-scheduled-at-range';
const RANGE_TEXT =
  '0001-01-01T00:00:00Z から 9999-12-31T23:59:59.999Z までの日時を指定してください。';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
/** `social.read` と `social.write` を持つ Token。 */
let writeToken: string;

interface JsonResult {
  readonly status: number;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function detailsOf(result: JsonResult): Record<string, readonly string[]> {
  const error = result.body['error'] as
    { readonly details?: Record<string, readonly string[]> } | undefined;
  return error?.details ?? {};
}

function errorCodeOf(result: JsonResult): string {
  return (result.body['error'] as { readonly code?: string } | undefined)?.code ?? '';
}

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `sr${suffix}`,
        email: `sr${suffix}@example.com`,
        display_name: 'scheduled at range api test',
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
    loginId: `sr${suffix}`,
    displayName: 'scheduled at range api test',
    email: `sr${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
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
  /** Bearer の平文。省略すると `writeToken`。`null` なら Authorization を付けない（CSRF は通す）。 */
  readonly token?: string | null;
}

function headersFor(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = options.token === undefined ? writeToken : options.token;
  if (bearer !== null) {
    headers['authorization'] = `Bearer ${bearer}`;
  } else {
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

async function callCreate(body: unknown, options: CallOptions = {}): Promise<JsonResult> {
  return resultOf(
    await createSocialPostRoute(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: headersFor(options),
        body: JSON.stringify(body),
      }),
    ),
  );
}

async function callUpdate(id: string, body: unknown): Promise<JsonResult> {
  return resultOf(
    await updateSocialPostRoute(
      new Request(`${ENDPOINT}/${id}`, {
        method: 'PATCH',
        headers: headersFor({}),
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  );
}

function postBody(scheduledAt: unknown): Record<string, unknown> {
  return { socialAccountId: accountId, body: '予約の本文', scheduledAt };
}

async function postRows(): Promise<readonly string[]> {
  return withConnection(async (connection) => {
    const result = await sql<Record<string, unknown>>`SELECT * FROM social_posts`.execute(
      connection.db,
    );
    return result.rows.map((row) => JSON.stringify(row)).sort();
  });
}

async function makeDraft(): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '本文',
    scheduledAt: null,
    status: 'draft',
  });
  return post.id;
}

/** 設計 #41 の範囲外の値。 */
const OUT_OF_RANGE: readonly (readonly [string, unknown])[] = [
  ['-8.64e15（数値）', -8.64e15],
  ["'-271821-04-20T00:00:00Z'", '-271821-04-20T00:00:00Z'],
  ["'-010000-01-01T00:00:00Z'", '-010000-01-01T00:00:00Z'],
  ["'0000-12-31T23:59:59.999Z'", '0000-12-31T23:59:59.999Z'],
  ["'+010000-01-01T00:00:00Z'", '+010000-01-01T00:00:00Z'],
  ['8.64e15（数値）', 8.64e15],
];

/** 設計 #41 の範囲内の値。 */
const IN_RANGE: readonly (readonly [string, unknown])[] = [
  ["'0001-01-01T00:00:00Z'", '0001-01-01T00:00:00Z'],
  ["'9999-12-31T23:59:59.999Z'", '9999-12-31T23:59:59.999Z'],
  ["'2030-01-01T09:00:00+09:00'", '2030-01-01T09:00:00+09:00'],
  ['null', null],
];

beforeAll(async () => {
  scratch = await useScratchDatabase('scheduledatrangeapi');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  accountId = (
    await createSocialAccount(admin, {
      provider: 'x',
      displayName: 'とりふね公式',
      handle: '@torifune',
      credential: null,
      status: 'connected',
    })
  ).id;
  writeToken = await issueToken(['social.read', 'social.write']);
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #41 POST                                                                     */
/* -------------------------------------------------------------------------- */

describe('#41 POST /social/posts の scheduledAt の範囲外は 422', () => {
  it.each(OUT_OF_RANGE)(
    '#41 scheduledAt: %s → 422、details.scheduledAt が範囲の文言',
    async (_label, scheduledAt) => {
      const result = await callCreate(postBody(scheduledAt));

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ scheduledAt: [RANGE_TEXT] });
    },
  );

  it.each(OUT_OF_RANGE)('#41 scheduledAt: %s → 投稿が増えない', async (_label, scheduledAt) => {
    const before = await postRows();

    await callCreate(postBody(scheduledAt));

    expect(await postRows()).toEqual(before);
  });

  it.each(IN_RANGE)('#41 scheduledAt: %s → 201', async (_label, scheduledAt) => {
    const result = await callCreate(postBody(scheduledAt));

    expect(result.status, result.text).toBe(201);
  });
});

/* -------------------------------------------------------------------------- */
/* #41 PATCH                                                                    */
/* -------------------------------------------------------------------------- */

describe('#41 PATCH /social/posts/{id} の scheduledAt の範囲外は 422', () => {
  it.each(OUT_OF_RANGE)(
    '#41 scheduledAt: %s → 422、details.scheduledAt が範囲の文言',
    async (_label, scheduledAt) => {
      const id = await makeDraft();

      const result = await callUpdate(id, { scheduledAt });

      expect(result.status, result.text).toBe(422);
      expect(detailsOf(result)).toEqual({ scheduledAt: [RANGE_TEXT] });
    },
  );

  it.each(OUT_OF_RANGE)('#41 scheduledAt: %s → 行が変わらない', async (_label, scheduledAt) => {
    const id = await makeDraft();
    const before = await postRows();

    await callUpdate(id, { scheduledAt });

    expect(await postRows()).toEqual(before);
  });

  it.each(IN_RANGE)('#41 scheduledAt: %s → 200', async (_label, scheduledAt) => {
    const id = await makeDraft();

    const result = await callUpdate(id, { scheduledAt });

    expect(result.status, result.text).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* #43 認可が先                                                                 */
/* -------------------------------------------------------------------------- */

describe('#43 scheduledAt の範囲外でも認可が先', () => {
  it('#43 social.write を持たない Token で scheduledAt: -8.64e15 → 403', async () => {
    const readOnly = await issueToken(['social.read']);

    const result = await callCreate(postBody(-8.64e15), { token: readOnly });

    expect(result.status, result.text).toBe(403);
    expect(errorCodeOf(result)).toBe('FORBIDDEN');
  });

  it('#43 認証なしで scheduledAt: -8.64e15 → 401', async () => {
    const result = await callCreate(postBody(-8.64e15), { token: null });

    expect(result.status, result.text).toBe(401);
    expect(errorCodeOf(result)).toBe('UNAUTHENTICATED');
  });
});
