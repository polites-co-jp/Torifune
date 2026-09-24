import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  resolveManualHandoff,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信 Plugin の戻り値の NUL・対になっていないサロゲート（L4。046-input-500-nul-and-ranges 設計 §9.4、受け入れ条件 #32〜#35）。
 *
 * Core が書く Plugin 由来の文字列は**断らずに U+FFFD に置き換えて記録する**（断ると起きたことの記録が消える）。
 *
 * - #32：`{ ok: true, externalId: 'e\u0000' }` → `published: 1`・`unrecorded: 0`、行は `published`・`external_id` が `e` と U+FFFD の 2 文字・
 *   着手印が `NULL`。`externalId: 'e\ud800'` も同じ。**SNS に出た投稿が `published` として残るので、次の回で送り直さない（二重投稿にならない）**
 * - #33：`{ ok: true, externalUrl: 'https://x.example.com/p\u0000' }` → `published`、`external_url` が `NULL`
 * - #34：`{ ok: false, reason: 'r\u0000', retryable: false }` → `failed`、`failure_reason` が U+FFFD を含み NUL を含まない。
 *   `Error('m\u0000')` を投げる → `failed`（`unrecorded: 0`）、`failure_reason` が NUL を含まない
 * - #35：`manual()` が `'https://x.example.com/intent\u0000'` を返す → `resolveManualHandoff` が `{ ok: false, reason: 'invalid_url' }`
 *
 * 置き換えは秘匿（資格情報の伏せ字）の**後**に掛ける（設計 §9.4・§13 の 4）ことも、NUL を含む資格情報の値で確かめる。
 *
 * `publish.integration.test.ts` の偽の publisher・`makePost`・`postRow` を写した。
 * **ソースに壊れた文字を置かない。** NUL と片割れはエスケープで書き、U+FFFD は `String.fromCodePoint` で作る。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';
const REPLACEMENT = String.fromCodePoint(0xfffd);
/** 伏せ字の対象になる資格情報の値（NUL を含む。UseCase から直接登録するので L1 を通らない）。 */
const SECRET_WITH_NUL = 'pw-secret-046\u0000tail';

type PublishFn = NonNullable<PublisherRegistration['publish']>;
type ManualFn = NonNullable<PublisherRegistration['manual']>;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `pt${suffix}`,
        email: `pt${suffix}@example.com`,
        display_name: 'publish text test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `pt${suffix}`,
    displayName: 'publish text test',
    email: `pt${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 偽の publisher。`publish` は `vi.fn()` にして回数を見る。 */
function usePublisher(publish: PublishFn): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(publish);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [
      { key: 'identifier', label: '識別子', kind: 'text' },
      { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
    ],
    publish: mock,
  });
  return mock;
}

/** 手動投稿に対応した偽の publisher。 */
function useManualPublisher(manual: ManualFn): void {
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    // accountFor() が送る資格情報のキーと揃える（宣言外のキーは 035 からの規則で作成時に断られる）
    credentialFields: [
      { key: 'identifier', label: '識別子', kind: 'text' },
      { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
    ],
    manual,
  });
}

async function accountFor(appPassword = 'pw-c3d4'): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    credentials: { identifier: 'id-a1b2', appPassword },
    status: 'connected',
  });
  return account.id;
}

/** 期限の来た予約（既定は自動配信・1 分前）。 */
async function makePost(
  accountId: string,
  deliveryMode: 'auto' | 'manual' = 'auto',
): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '配信される本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode,
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly failure_reason: string | null;
  readonly external_id: string | null;
  readonly external_url: string | null;
  readonly publish_started_at: Date | null;
}

async function postRow(id: string): Promise<PostRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status', 'failure_reason', 'external_id', 'external_url', 'publish_started_at'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('publishtext');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor('administrator');
  // 記録の失敗（`social post publish aborted`）をテストの出力に流さない。
  capture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #32 externalId                                                               */
/* -------------------------------------------------------------------------- */

const EXTERNAL_IDS = [
  ['NUL', 'e\u0000'],
  ['片割れ', 'e\ud800'],
] as const;

describe('#32 ok: true の externalId に NUL・片割れがあっても published として記録する', () => {
  it.each(EXTERNAL_IDS)(
    '#32 externalId に %s → summary が published: 1・unrecorded: 0',
    async (_label, externalId) => {
      usePublisher(async () => ({ ok: true, externalId }));
      await makePost(await accountFor());

      const summary = await run();

      expect(summary.published).toBe(1);
      expect(summary.unrecorded).toBe(0);
    },
  );

  it.each(EXTERNAL_IDS)(
    '#32 externalId に %s → 行の status が published',
    async (_label, externalId) => {
      usePublisher(async () => ({ ok: true, externalId }));
      const postId = await makePost(await accountFor());

      await run();

      expect((await postRow(postId)).status).toBe('published');
    },
  );

  it.each(EXTERNAL_IDS)(
    '#32 externalId に %s → external_id が e と U+FFFD の 2 文字',
    async (_label, externalId) => {
      usePublisher(async () => ({ ok: true, externalId }));
      const postId = await makePost(await accountFor());

      await run();

      const stored = (await postRow(postId)).external_id;
      expect(stored).toBe(`e${REPLACEMENT}`);
      expect(stored).toHaveLength(2);
    },
  );

  it.each(EXTERNAL_IDS)(
    '#32 externalId に %s → 着手印が NULL に戻る',
    async (_label, externalId) => {
      usePublisher(async () => ({ ok: true, externalId }));
      const postId = await makePost(await accountFor());

      await run();

      expect((await postRow(postId)).publish_started_at).toBeNull();
    },
  );

  it.each(EXTERNAL_IDS)(
    '#32 externalId に %s → 次の回で publish() を呼び直さない（二重投稿にならない）',
    async (_label, externalId) => {
      const publish = usePublisher(async () => ({ ok: true, externalId }));
      const postId = await makePost(await accountFor());

      await run();
      const second = await run();

      expect(publish).toHaveBeenCalledTimes(1);
      expect(second.interrupted).toBe(0);
      expect((await postRow(postId)).status).toBe('published');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #33 externalUrl                                                              */
/* -------------------------------------------------------------------------- */

describe('#33 ok: true の externalUrl に NUL があれば published で external_url は NULL', () => {
  it('#33 externalUrl に NUL → 行の status が published', async () => {
    usePublisher(async () => ({
      ok: true,
      externalId: 'e33',
      externalUrl: 'https://x.example.com/p\u0000',
    }));
    const postId = await makePost(await accountFor());

    const summary = await run();

    expect(summary.published).toBe(1);
    expect(summary.unrecorded).toBe(0);
    expect((await postRow(postId)).status).toBe('published');
  });

  it('#33 externalUrl に NUL → external_url が NULL、external_id はそのまま', async () => {
    usePublisher(async () => ({
      ok: true,
      externalId: 'e33',
      externalUrl: 'https://x.example.com/p\u0000',
    }));
    const postId = await makePost(await accountFor());

    await run();

    const row = await postRow(postId);
    expect(row.external_url).toBeNull();
    expect(row.external_id).toBe('e33');
  });
});

/* -------------------------------------------------------------------------- */
/* #34 reason・例外の文言                                                        */
/* -------------------------------------------------------------------------- */

describe('#34 ok: false の reason・例外の文言に NUL があっても failed として記録する', () => {
  it("#34 { ok: false, reason: 'r\\u0000', retryable: false } → failed（unrecorded: 0）", async () => {
    usePublisher(async () => ({ ok: false, reason: 'r\u0000', retryable: false }));
    const postId = await makePost(await accountFor());

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(summary.unrecorded).toBe(0);
    expect((await postRow(postId)).status).toBe('failed');
  });

  it("#34 reason: 'r\\u0000' → failure_reason が U+FFFD を含み NUL を含まない", async () => {
    usePublisher(async () => ({ ok: false, reason: 'r\u0000', retryable: false }));
    const postId = await makePost(await accountFor());

    await run();

    const reason = (await postRow(postId)).failure_reason ?? '';
    expect(reason).toContain(REPLACEMENT);
    expect(reason).not.toContain('\u0000');
    expect(reason.startsWith('r')).toBe(true);
  });

  it("#34 reason: 'r\\ud800' → failed で、failure_reason が U+FFFD を含む", async () => {
    usePublisher(async () => ({ ok: false, reason: 'r\ud800', retryable: false }));
    const postId = await makePost(await accountFor());

    await run();

    const row = await postRow(postId);
    expect(row.status).toBe('failed');
    expect(row.failure_reason ?? '').toContain(REPLACEMENT);
  });

  it("#34 Error('m\\u0000') を投げる → failed（unrecorded: 0）", async () => {
    usePublisher(async () => {
      throw new Error('m\u0000');
    });
    const postId = await makePost(await accountFor());

    const summary = await run();

    expect(summary.failed).toBe(1);
    expect(summary.unrecorded).toBe(0);
    expect((await postRow(postId)).status).toBe('failed');
  });

  it("#34 Error('m\\u0000') を投げる → failure_reason が NUL を含まない", async () => {
    usePublisher(async () => {
      throw new Error('m\u0000');
    });
    const postId = await makePost(await accountFor());

    await run();

    const reason = (await postRow(postId)).failure_reason;
    expect(reason).not.toBeNull();
    expect(reason ?? '').not.toContain('\u0000');
    expect(reason ?? '').toContain(REPLACEMENT);
  });

  it('#34 置き換えは伏せ字の後：NUL を含む資格情報の値を reason に混ぜても平文で残らない', async () => {
    usePublisher(async () => ({
      ok: false,
      reason: `認証に失敗しました（${SECRET_WITH_NUL}）`,
      retryable: false,
    }));
    const postId = await makePost(await accountFor(SECRET_WITH_NUL));

    await run();

    const row = await postRow(postId);
    expect(row.status).toBe('failed');
    const reason = row.failure_reason ?? '';
    expect(reason).toContain('***');
    expect(reason).not.toContain('pw-secret-046');
    expect(reason).not.toContain('tail');
  });
});

/* -------------------------------------------------------------------------- */
/* #35 manual() の URL                                                           */
/* -------------------------------------------------------------------------- */

describe('#35 manual() の URL に NUL があれば invalid_url', () => {
  it("#35 manual() が 'https://x.example.com/intent\\u0000' → { ok: false, reason: 'invalid_url' }", async () => {
    useManualPublisher(() => ({ url: 'https://x.example.com/intent\u0000' }));
    const postId = await makePost(await accountFor(), 'manual');

    await expect(resolveManualHandoff(admin, { id: postId })).resolves.toEqual({
      ok: false,
      reason: 'invalid_url',
    });
  });

  it('#35 対照：NUL の無い同じ URL は ok: true', async () => {
    useManualPublisher(() => ({ url: 'https://x.example.com/intent' }));
    const postId = await makePost(await accountFor(), 'manual');

    await expect(resolveManualHandoff(admin, { id: postId })).resolves.toMatchObject({
      ok: true,
      url: 'https://x.example.com/intent',
    });
  });
});
