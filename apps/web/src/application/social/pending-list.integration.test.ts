import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiToken } from '@/application/api-token/api-token-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor, buildApiTokenContext } from '@/application/authorization/context';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import { createSocialAccount, createSocialPost } from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { SocialPost } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 送信待ちの一覧 `listSocialPendingPosts`（055-social-pending-tab 設計 §5.2・§5.3・§8.1・§8.6、
 * 受け入れ条件 #6〜#14・#75）。
 *
 * **UseCase を直接呼ぶ結合テスト（B）。** 準備は設計 §13.2（実装プラン §2「テストの方法」・§8 の 13・14）：
 *
 * * `acc`（`manual` と `publish` を持つ偽物の provider）に手動の予約 P1（`now−2h`）・P2（`now−1h`）・S1（`now+1h`）・
 *   S0（予約日時なし）
 * * `accAuto`（`publish` だけの provider）に自動の予約 S2（`now+2h`）・S3（`now−1m` で着手印あり）
 * * 承認待ち A1（`accAuto`・自動・希望日時 `now+30m`）・A2（`acc`・手動・希望日時なし）
 * * 下書き D・配信済み X・失敗 F（どれも `acc`）
 *
 * 作成の順は P1・P2・S1・S0・S2・S3・A1・A2・D・X・F（`created_at` の古い順）。UseCase で作れない形
 * （S0 の予約日時なし・S3 の着手印・X・F の状態）は、作った後に SQL で書く（`created_at` は崩さない）。
 *
 * 「いま」は入力の `now`（設計 §8.1）。準備の時刻はすべてテストの `NOW` を基準にし、一覧にも同じ `NOW` を渡す。
 * 本文は `送信待ち P1` のように名前を入れ、並びは本文から名前を取り出して**ちょうど**比べる。
 *
 * `listSocialPendingPosts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。型は設計 §8.1 から写す。
 */

type PendingKind = 'manual_pending' | 'awaiting_approval' | 'scheduled';
type PendingSort = 'action' | 'time';
type SourceFilter =
  | { readonly kind: 'screen' }
  | { readonly kind: 'token'; readonly tokenId: string }
  | { readonly kind: 'deleted_token' };

interface ListPendingPostsInput {
  readonly page: number;
  readonly perPage: number;
  readonly kind: PendingKind | null;
  readonly socialAccountId: string | null;
  readonly source?: SourceFilter | null;
  readonly sort?: PendingSort;
  readonly now: Date;
}

interface SocialPendingPage {
  readonly items: readonly SocialPost[];
  readonly total: number;
  readonly counts: Readonly<Record<PendingKind, number>>;
}

type ListPending = (
  context: AuthorizationContext,
  input: ListPendingPostsInput,
) => Promise<SocialPendingPage>;

const USE_CASES_MODULE: string = '@/application/social/social-use-cases';

async function listSocialPendingPosts(
  context: AuthorizationContext,
  input: ListPendingPostsInput,
): Promise<SocialPendingPage> {
  const module = (await import(/* @vite-ignore */ USE_CASES_MODULE)) as {
    readonly listSocialPendingPosts?: ListPending;
  };
  if (module.listSocialPendingPosts === undefined) {
    throw new Error('application/social/social-use-cases.ts に listSocialPendingPosts が無い');
  }
  return module.listSocialPendingPosts(context, input);
}

const BOTH_PROVIDER = 'pend_both';
const AUTO_PROVIDER = 'pend_auto';
const REQUEST_INFO = { ipAddress: '203.0.113.55', userAgent: 'vitest' } as const;
const SNS_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'] as const;
const BODY_PREFIX = '送信待ち ';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 準備の基準の「いま」。一覧にも同じ値を渡す。 */
const NOW = new Date();

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let viewer: AuthorizationContext;
let acc: string;
let accAuto: string;
/** 名前（P1 など）→ 投稿の ID。 */
const ids: Record<string, string> = {};

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `pl${suffix}`,
        email: `pl${suffix}@example.com`,
        display_name: 'pending list test',
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
    loginId: `pl${suffix}`,
    displayName: 'pending list test',
    email: `pl${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  const context = await withConnection((connection) =>
    authorizationContextFor(connection, identity),
  );
  return { ...context, request: REQUEST_INFO };
}

function bothPublisher(): PublisherRegistration {
  return {
    provider: BOTH_PROVIDER,
    label: '両方（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: () => ({ url: 'https://example.com/intent/post' }),
  };
}

function autoPublisher(): PublisherRegistration {
  return {
    provider: AUTO_PROVIDER,
    label: '自動だけ（テスト）',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e2' }),
  };
}

async function makeAccount(
  provider: string,
  displayName: string,
  siteId: string | null = null,
): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider,
    displayName,
    handle: '@pending',
    credential: null,
    status: 'connected',
    siteId,
  });
  return account.id;
}

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

interface MakeOptions {
  readonly context?: AuthorizationContext;
  readonly accountId: string;
  readonly deliveryMode: 'auto' | 'manual';
  readonly scheduledAt: Date | null;
  readonly kind: 'scheduled' | 'awaiting' | 'draft';
}

/** 名前を本文に入れて投稿を作り、ID を `ids` に控える。 */
async function make(name: string, options: MakeOptions): Promise<string> {
  const base = {
    socialAccountId: options.accountId,
    body: `${BODY_PREFIX}${name}`,
    scheduledAt: options.scheduledAt,
    deliveryMode: options.deliveryMode,
  };
  const input =
    options.kind === 'awaiting'
      ? { ...base, publishTiming: 'after_approval' as const }
      : { ...base, status: options.kind };
  const { post } = await createSocialPost(options.context ?? admin, input);
  if (options.kind === 'awaiting' && post.status !== 'awaiting_approval') {
    throw new Error(`承認待ちにならない: ${name} ${post.status}`);
  }
  ids[name] = post.id;
  return post.id;
}

async function rewrite(id: string, set: RawBuilder<unknown>): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
}

async function deletePosts(postIds: readonly string[]): Promise<void> {
  if (postIds.length === 0) return;
  await withConnection(async (connection) => {
    await connection.db
      .deleteFrom('social_posts')
      .where('id', 'in', [...postIds])
      .execute();
  });
}

/** 本文から名前を取り出す（`送信待ち P1` → `P1`）。 */
function namesOf(page: SocialPendingPage): string[] {
  return page.items.map((post) => post.body.replace(BODY_PREFIX, ''));
}

function input(overrides: Partial<ListPendingPostsInput> = {}): ListPendingPostsInput {
  return {
    page: 1,
    perPage: 100,
    kind: null,
    socialAccountId: null,
    now: NOW,
    ...overrides,
  };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('pendinglist');
  registerPublisher('test-plugin', bothPublisher());
  registerPublisher('test-plugin', autoPublisher());

  admin = await contextFor('administrator');
  viewer = await contextFor('viewer');
  acc = await makeAccount(BOTH_PROVIDER, '両方のアカウント');
  accAuto = await makeAccount(AUTO_PROVIDER, '自動だけのアカウント');

  // 作成の順（created_at の古い順）：P1・P2・S1・S0・S2・S3・A1・A2・D・X・F。
  await make('P1', {
    accountId: acc,
    deliveryMode: 'manual',
    scheduledAt: at(-2 * HOUR),
    kind: 'scheduled',
  });
  await make('P2', {
    accountId: acc,
    deliveryMode: 'manual',
    scheduledAt: at(-HOUR),
    kind: 'scheduled',
  });
  await make('S1', {
    accountId: acc,
    deliveryMode: 'manual',
    scheduledAt: at(HOUR),
    kind: 'scheduled',
  });
  const s0 = await make('S0', {
    accountId: acc,
    deliveryMode: 'manual',
    scheduledAt: at(3 * HOUR),
    kind: 'scheduled',
  });
  await make('S2', {
    accountId: accAuto,
    deliveryMode: 'auto',
    scheduledAt: at(2 * HOUR),
    kind: 'scheduled',
  });
  const s3 = await make('S3', {
    accountId: accAuto,
    deliveryMode: 'auto',
    scheduledAt: at(-MINUTE),
    kind: 'scheduled',
  });
  await make('A1', {
    accountId: accAuto,
    deliveryMode: 'auto',
    scheduledAt: at(30 * MINUTE),
    kind: 'awaiting',
  });
  await make('A2', { accountId: acc, deliveryMode: 'manual', scheduledAt: null, kind: 'awaiting' });
  await make('D', { accountId: acc, deliveryMode: 'manual', scheduledAt: null, kind: 'draft' });
  const x = await make('X', {
    accountId: acc,
    deliveryMode: 'manual',
    scheduledAt: null,
    kind: 'draft',
  });
  const f = await make('F', {
    accountId: acc,
    deliveryMode: 'manual',
    scheduledAt: null,
    kind: 'draft',
  });

  // 作成の検査が断る形・UseCase で作れない状態は SQL で書く（created_at は触らない）。
  await rewrite(s0, sql`scheduled_at = NULL`);
  await rewrite(s3, sql`publish_started_at = now()`);
  await rewrite(x, sql`status = 'published', published_at = now()`);
  await rewrite(
    f,
    sql`status = 'failed', failed_at = now(), failure_reason = '配信に失敗しました'`,
  );
});

afterAll(async () => {
  resetPublisherRegistry();
  await scratch.dispose();
});

// ---------------------------------------------------------------------------
// #6 既定（手が要るもの順）の並び
// ---------------------------------------------------------------------------

describe('#6 kind: null の並び（手が要るもの順）', () => {
  it('#6 sort 省略 → ちょうど P1, P2, A1, A2, S3, S1, S2, S0', async () => {
    const page = await listSocialPendingPosts(admin, input());

    expect(namesOf(page)).toEqual(['P1', 'P2', 'A1', 'A2', 'S3', 'S1', 'S2', 'S0']);
  });

  it("#6 sort: 'action' でも同じ並び", async () => {
    const page = await listSocialPendingPosts(admin, input({ sort: 'action' }));

    expect(namesOf(page)).toEqual(['P1', 'P2', 'A1', 'A2', 'S3', 'S1', 'S2', 'S0']);
  });

  it('#6 下書き D・配信済み X・失敗 F を含まない', async () => {
    const page = await listSocialPendingPosts(admin, input());

    expect(namesOf(page)).not.toContain('D');
    expect(namesOf(page)).not.toContain('X');
    expect(namesOf(page)).not.toContain('F');
  });

  it('#6 total が 8', async () => {
    const page = await listSocialPendingPosts(admin, input());

    expect(page.total).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// #7 区分ごとの件数
// ---------------------------------------------------------------------------

describe('#7 counts', () => {
  it('#7 counts が { manual_pending: 2, awaiting_approval: 2, scheduled: 4 }', async () => {
    const page = await listSocialPendingPosts(admin, input());

    expect(page.counts).toEqual({ manual_pending: 2, awaiting_approval: 2, scheduled: 4 });
  });

  it("#7 kind: 'awaiting_approval' でも counts は同じ（状態を掛ける前の数）", async () => {
    const page = await listSocialPendingPosts(admin, input({ kind: 'awaiting_approval' }));

    expect(page.counts).toEqual({ manual_pending: 2, awaiting_approval: 2, scheduled: 4 });
  });

  it("#7 kind: 'awaiting_approval' の items は A1, A2・total 2", async () => {
    const page = await listSocialPendingPosts(admin, input({ kind: 'awaiting_approval' }));

    expect(namesOf(page)).toEqual(['A1', 'A2']);
    expect(page.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #8 区分ごとの並び
// ---------------------------------------------------------------------------

describe('#8 区分で絞ったときの並び', () => {
  it("#8 kind: 'manual_pending' → P1, P2", async () => {
    const page = await listSocialPendingPosts(admin, input({ kind: 'manual_pending' }));

    expect(namesOf(page)).toEqual(['P1', 'P2']);
  });

  it("#8 kind: 'scheduled'（sort: 'action'）→ S3, S1, S2, S0", async () => {
    const page = await listSocialPendingPosts(admin, input({ kind: 'scheduled', sort: 'action' }));

    expect(namesOf(page)).toEqual(['S3', 'S1', 'S2', 'S0']);
  });

  it("#8 kind: 'scheduled'（sort: 'time'）→ S3, S1, S2, S0", async () => {
    const page = await listSocialPendingPosts(admin, input({ kind: 'scheduled', sort: 'time' }));

    expect(namesOf(page)).toEqual(['S3', 'S1', 'S2', 'S0']);
  });

  it("#8 kind: 'awaiting_approval'（sort: 'time'）→ A1, A2", async () => {
    const page = await listSocialPendingPosts(
      admin,
      input({ kind: 'awaiting_approval', sort: 'time' }),
    );

    expect(namesOf(page)).toEqual(['A1', 'A2']);
  });
});

// ---------------------------------------------------------------------------
// #9 区分の境目は入力の now
// ---------------------------------------------------------------------------

describe('#9 区分の境目は入力の now（SQL の now() ではない）', () => {
  async function p2ScheduledAt(): Promise<Date> {
    return withConnection(async (connection) => {
      const row = await connection.db
        .selectFrom('social_posts')
        .select('scheduled_at')
        .where('id', '=', ids['P2'] ?? '')
        .executeTakeFirstOrThrow();
      if (row.scheduled_at === null) throw new Error('P2 に予約日時が無い');
      return new Date(row.scheduled_at);
    });
  }

  it('#9 now = P2 の予約日時ちょうど → P2 は manual_pending（items と counts）', async () => {
    const now = await p2ScheduledAt();

    const manual = await listSocialPendingPosts(admin, input({ kind: 'manual_pending', now }));

    expect(namesOf(manual)).toEqual(['P1', 'P2']);
    expect(manual.counts).toEqual({ manual_pending: 2, awaiting_approval: 2, scheduled: 4 });
  });

  it('#9 now = P2 の予約日時 − 1ms → P2 は scheduled（items と counts）', async () => {
    const now = new Date((await p2ScheduledAt()).getTime() - 1);

    const manual = await listSocialPendingPosts(admin, input({ kind: 'manual_pending', now }));
    const scheduled = await listSocialPendingPosts(admin, input({ kind: 'scheduled', now }));

    expect(namesOf(manual)).toEqual(['P1']);
    expect(namesOf(scheduled)).toContain('P2');
    expect(manual.counts).toEqual({ manual_pending: 1, awaiting_approval: 2, scheduled: 5 });
  });

  it('#9 now = P2 の予約日時 − 1ms の既定の並びでは P2 が予約済みの先頭（予約日時の近い順）', async () => {
    const now = new Date((await p2ScheduledAt()).getTime() - 1);

    const page = await listSocialPendingPosts(admin, input({ now }));

    expect(namesOf(page)).toEqual(['P1', 'A1', 'A2', 'P2', 'S3', 'S1', 'S2', 'S0']);
  });
});

// ---------------------------------------------------------------------------
// #10 アカウントの絞り込み
// ---------------------------------------------------------------------------

describe('#10 socialAccountId の絞り込みは items と counts に掛かる', () => {
  it('#10 socialAccountId = accAuto → ちょうど A1, S3, S2（action）', async () => {
    const page = await listSocialPendingPosts(admin, input({ socialAccountId: accAuto }));

    expect(namesOf(page)).toEqual(['A1', 'S3', 'S2']);
  });

  it('#10 counts もアカウントを掛けた数 { manual_pending: 0, awaiting_approval: 1, scheduled: 2 }', async () => {
    const page = await listSocialPendingPosts(admin, input({ socialAccountId: accAuto }));

    expect(page.counts).toEqual({ manual_pending: 0, awaiting_approval: 1, scheduled: 2 });
  });

  it('#10 total もアカウントを掛けた数（3）', async () => {
    const page = await listSocialPendingPosts(admin, input({ socialAccountId: accAuto }));

    expect(page.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// #12 ページ送り
// ---------------------------------------------------------------------------

describe('#12 ページ送り', () => {
  it('#12 perPage: 3, page: 2 → A2, S3, S1（total は 8 のまま）', async () => {
    const page = await listSocialPendingPosts(admin, input({ perPage: 3, page: 2 }));

    expect(namesOf(page)).toEqual(['A2', 'S3', 'S1']);
    expect(page.total).toBe(8);
  });

  it("#12 sort: 'time'・perPage: 3, page: 2 → A1, S1, S2（#75 の並びの 4〜6 件目）", async () => {
    const page = await listSocialPendingPosts(admin, input({ perPage: 3, page: 2, sort: 'time' }));

    expect(namesOf(page)).toEqual(['A1', 'S1', 'S2']);
    expect(page.total).toBe(8);
  });

  it('#12 ページ送りでも counts は変わらない', async () => {
    const page = await listSocialPendingPosts(admin, input({ perPage: 3, page: 2 }));

    expect(page.counts).toEqual({ manual_pending: 2, awaiting_approval: 2, scheduled: 4 });
  });
});

// ---------------------------------------------------------------------------
// #75 予定の時刻順
// ---------------------------------------------------------------------------

describe('#75 sort: time（予定の時刻順）', () => {
  it('#75 kind: null → ちょうど P1, P2, S3, A1, S1, S2, S0, A2', async () => {
    const page = await listSocialPendingPosts(admin, input({ sort: 'time' }));

    expect(namesOf(page)).toEqual(['P1', 'P2', 'S3', 'A1', 'S1', 'S2', 'S0', 'A2']);
  });

  it('#75 counts・total は #6・#7 と同じ', async () => {
    const page = await listSocialPendingPosts(admin, input({ sort: 'time' }));

    expect(page.counts).toEqual({ manual_pending: 2, awaiting_approval: 2, scheduled: 4 });
    expect(page.total).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// #14 権限
// ---------------------------------------------------------------------------

describe('#14 Permission social.read', () => {
  it('#14 閲覧者（social.read）で呼べる', async () => {
    const page = await listSocialPendingPosts(viewer, input());

    expect(namesOf(page)).toEqual(['P1', 'P2', 'A1', 'A2', 'S3', 'S1', 'S2', 'S0']);
  });

  it('#14 social.read の無い文脈 → ForbiddenError', async () => {
    const without: AuthorizationContext = { ...viewer, permissions: new Set<never>() };

    await expect(listSocialPendingPosts(without, input())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// #11 登録元の絞り込み（トークンで登録した投稿を足す。終わったら消す）
// ---------------------------------------------------------------------------

describe('#11 source の絞り込みは items と counts に掛かる', () => {
  let tokenId = '';
  const added: string[] = [];

  beforeAll(async () => {
    const created = await createApiToken(admin, {
      name: 'ブログ連携',
      scopes: SNS_SCOPES,
      expiresAt: null,
    });
    tokenId = created.token.id;
    const tokenContext = await buildApiTokenContext(created.plaintext, REQUEST_INFO);
    if (tokenContext.identity === null) throw new Error('トークンの文脈を作れない');
    added.push(
      await make('T1', {
        context: tokenContext,
        accountId: acc,
        deliveryMode: 'manual',
        scheduledAt: at(-30 * MINUTE),
        kind: 'scheduled',
      }),
      await make('T2', {
        context: tokenContext,
        accountId: acc,
        deliveryMode: 'manual',
        scheduledAt: null,
        kind: 'awaiting',
      }),
      await make('T3', {
        context: tokenContext,
        accountId: acc,
        deliveryMode: 'manual',
        scheduledAt: null,
        kind: 'draft',
      }),
    );
  });

  afterAll(async () => {
    await deletePosts(added);
  });

  it("#11 { kind: 'token' } → そのトークンで登録した送信待ちだけ（T1, T2。下書き T3 は出ない）", async () => {
    const page = await listSocialPendingPosts(admin, input({ source: { kind: 'token', tokenId } }));

    expect(namesOf(page)).toEqual(['T1', 'T2']);
    expect(page.total).toBe(2);
  });

  it("#11 { kind: 'token' } の counts も登録元を掛けた数 { 1, 1, 0 }", async () => {
    const page = await listSocialPendingPosts(admin, input({ source: { kind: 'token', tokenId } }));

    expect(page.counts).toEqual({ manual_pending: 1, awaiting_approval: 1, scheduled: 0 });
  });

  it("#11 { kind: 'screen' } → 画面で登録した 8 件だけ（並びは #6 と同じ）", async () => {
    const page = await listSocialPendingPosts(admin, input({ source: { kind: 'screen' } }));

    expect(namesOf(page)).toEqual(['P1', 'P2', 'A1', 'A2', 'S3', 'S1', 'S2', 'S0']);
    expect(page.counts).toEqual({ manual_pending: 2, awaiting_approval: 2, scheduled: 4 });
  });

  it('#11 source: null → トークンの投稿も含む（絞らない）', async () => {
    const page = await listSocialPendingPosts(admin, input({ source: null }));

    expect(page.total).toBe(10);
    expect(page.counts).toEqual({ manual_pending: 3, awaiting_approval: 3, scheduled: 4 });
  });
});

// ---------------------------------------------------------------------------
// #13 区画（サイトに紐づいたトークンの文脈。終わったら消す）
// ---------------------------------------------------------------------------

describe('#13 区画の外の投稿は items にも counts にも入らない', () => {
  let siteContext: AuthorizationContext;
  const added: string[] = [];

  beforeAll(async () => {
    const siteA = uuidv7();
    const siteB = uuidv7();
    await withConnection(async (connection) => {
      await sql`INSERT INTO sites (id, name, url)
                VALUES (${siteA}, 'サイト A', 'https://a.example.com/'),
                       (${siteB}, 'サイト B', 'https://b.example.com/')`.execute(connection.db);
    });
    const accSiteA = await makeAccount(BOTH_PROVIDER, 'サイト A のアカウント', siteA);
    const accSiteB = await makeAccount(BOTH_PROVIDER, 'サイト B のアカウント', siteB);
    added.push(
      await make('SA1', {
        accountId: accSiteA,
        deliveryMode: 'manual',
        scheduledAt: at(-10 * MINUTE),
        kind: 'scheduled',
      }),
      await make('SB1', {
        accountId: accSiteB,
        deliveryMode: 'manual',
        scheduledAt: at(-20 * MINUTE),
        kind: 'scheduled',
      }),
      await make('SB2', {
        accountId: accSiteB,
        deliveryMode: 'manual',
        scheduledAt: null,
        kind: 'awaiting',
      }),
    );
    const created = await createApiToken(admin, {
      name: 'サイト A 連携',
      scopes: SNS_SCOPES,
      expiresAt: null,
      siteId: siteA,
    });
    siteContext = await buildApiTokenContext(created.plaintext, REQUEST_INFO);
    if (siteContext.identity === null) throw new Error('トークンの文脈を作れない');
  });

  afterAll(async () => {
    await deletePosts(added);
  });

  it('#13 サイト A のトークンの文脈 → items はサイト A のアカウントの SA1 だけ', async () => {
    const page = await listSocialPendingPosts(siteContext, input());

    expect(namesOf(page)).toEqual(['SA1']);
    expect(page.total).toBe(1);
  });

  it('#13 サイト A のトークンの文脈 → counts にもサイト B・共通（画面の登録）の投稿が入らない', async () => {
    const page = await listSocialPendingPosts(siteContext, input());

    expect(page.counts).toEqual({ manual_pending: 1, awaiting_approval: 0, scheduled: 0 });
  });

  it('#13 対照：画面（区画 all）からはサイト B の投稿も見える', async () => {
    const page = await listSocialPendingPosts(admin, input());

    expect(namesOf(page)).toEqual(expect.arrayContaining(['SA1', 'SB1', 'SB2']));
    expect(page.counts).toEqual({ manual_pending: 4, awaiting_approval: 3, scheduled: 4 });
  });

  it('#13 サイト A のトークンの文脈でサイト B のアカウントを指定しても空（区画の中で絞る）', async () => {
    const accSiteB = await withConnection(async (connection) => {
      const row = await connection.db
        .selectFrom('social_accounts')
        .select('id')
        .where('display_name', '=', 'サイト B のアカウント')
        .executeTakeFirstOrThrow();
      return row.id;
    });

    const page = await listSocialPendingPosts(siteContext, input({ socialAccountId: accSiteB }));

    expect(namesOf(page)).toEqual([]);
    expect(page.counts).toEqual({ manual_pending: 0, awaiting_approval: 0, scheduled: 0 });
  });
});

// ---------------------------------------------------------------------------
// #8 承認待ちの並びの鍵（作成順と希望日時の順が逆の組。別のアカウントで足し、終わったら消す。G12・検証 1 回目 spec 中-2）
// ---------------------------------------------------------------------------

describe('#8 作成順と希望日時の順が逆の承認待ちの組（設計 §5.3 (A)・§13.2 の 8）', () => {
  let accOrder = '';
  const added: string[] = [];

  beforeAll(async () => {
    accOrder = await makeAccount(BOTH_PROVIDER, '並びの鍵のアカウント');
    // 先に作った B1 ほど希望日時が遅い。created_at は SQL で固定して、作成の順を確かにする。
    const b1 = await make('B1', {
      accountId: accOrder,
      deliveryMode: 'manual',
      scheduledAt: at(3 * HOUR),
      kind: 'awaiting',
    });
    const b2 = await make('B2', {
      accountId: accOrder,
      deliveryMode: 'auto',
      scheduledAt: at(10 * MINUTE),
      kind: 'awaiting',
    });
    await rewrite(b1, sql`created_at = ${at(-2 * HOUR)}`);
    await rewrite(b2, sql`created_at = ${at(-HOUR)}`);
    added.push(b1, b2);
  });

  afterAll(async () => {
    await deletePosts(added);
  });

  it("#8 kind: 'awaiting_approval'・sort: 'action' → 依頼の古い順（created_at）の B1, B2", async () => {
    const page = await listSocialPendingPosts(
      admin,
      input({ kind: 'awaiting_approval', sort: 'action', socialAccountId: accOrder }),
    );

    expect(namesOf(page)).toEqual(['B1', 'B2']);
  });

  it('#8 kind: null・sort 省略（手が要るもの順）でも承認待ちは B1, B2', async () => {
    const page = await listSocialPendingPosts(admin, input({ socialAccountId: accOrder }));

    expect(namesOf(page)).toEqual(['B1', 'B2']);
  });

  it("#8 対照：sort: 'time' は予定の時刻順の B2, B1", async () => {
    const page = await listSocialPendingPosts(
      admin,
      input({ kind: 'awaiting_approval', sort: 'time', socialAccountId: accOrder }),
    );

    expect(namesOf(page)).toEqual(['B2', 'B1']);
  });
});
