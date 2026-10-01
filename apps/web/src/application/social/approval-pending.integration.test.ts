import type { PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  listApprovalPendingPosts,
  listManualPendingPosts,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { PostStatus } from '@/domain/social/social';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信ジョブ・手動投稿待ちは承認待ちを拾わない／承認待ちの一覧
 * （048-social-post-approval 設計 §6.5・§6.10、受け入れ条件 #49〜#51・#55）。
 *
 * **配信ジョブ（`publish.ts`）は変えない**（設計 §6.10）ので、#49・#50 は実装の前から緑になりうる。
 * 判別力は「`status` を `scheduled` に書き換えた同じ行は拾われる」対照で確かめる（実装プラン T13）。
 */

const PROVIDER = 'apr_pending';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
let publishCalls: number;

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `w${suffix}`,
        email: `w${suffix}@example.com`,
        display_name: 'approval pending test',
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
    loginId: `w${suffix}`,
    displayName: 'approval pending test',
    email: `w${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** `publish` と `manual` を持つ偽の publisher（資格情報の宣言つき）。 */
function bothPublisher(): PublisherRegistration {
  return {
    provider: PROVIDER,
    label: '両方（テスト）',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
    publish: async () => {
      publishCalls += 1;
      return { ok: true };
    },
    manual: () => ({ url: 'https://example.com/intent/post' }),
  };
}

async function makePost(
  status: PostStatus,
  deliveryMode: 'auto' | 'manual',
  body = '承認待ちの本文',
): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body,
    // 期限は過ぎている（承認待ちでなければ取り出し・手動投稿待ちの対象になる時刻）。
    scheduledAt: new Date(Date.now() - 60_000),
    status,
    deliveryMode,
  });
  return post.id;
}

interface JobRow {
  readonly status: string;
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly skip_count: number;
}

async function jobRowOf(id: string): Promise<JobRow> {
  return withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status', 'attempt_count', 'next_attempt_at', 'skip_count'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(),
  );
}

async function setStatus(id: string, status: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db.updateTable('social_posts').set({ status }).where('id', '=', id).execute();
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('approvalpending');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  publishCalls = 0;
  admin = await contextFor(['administrator']);
  registerPublisher('test-plugin', bothPublisher());
  accountId = (
    await createSocialAccount(admin, {
      provider: PROVIDER,
      displayName: '承認待ちの一覧',
      handle: '@pending',
      credential: null,
      credentials: { token: 'secret-token' },
      status: 'connected',
    })
  ).id;
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #49 配信ジョブ
// ---------------------------------------------------------------------------

describe('#49 承認待ちは publishDuePosts に拾われない', () => {
  it('#49 auto・期限切れ・資格情報あり・両方の publisher でも publish() は呼ばれず summary.due は 0', async () => {
    await makePost('awaiting_approval', 'auto');

    const summary = await withConnection((connection) => publishDuePosts(connection));

    expect(publishCalls).toBe(0);
    expect(summary.due).toBe(0);
  });

  it('#49 行の attempt_count / next_attempt_at / skip_count は変わらない', async () => {
    const id = await makePost('awaiting_approval', 'auto');
    const before = await jobRowOf(id);

    await withConnection((connection) => publishDuePosts(connection));

    expect(await jobRowOf(id)).toEqual(before);
    expect(before.status).toBe('awaiting_approval');
  });

  it('#49 対照：status を scheduled に書き換えた同じ行は拾われ publish() が 1 回呼ばれる', async () => {
    const id = await makePost('awaiting_approval', 'auto');
    await setStatus(id, 'scheduled');

    const summary = await withConnection((connection) => publishDuePosts(connection));

    expect(publishCalls).toBe(1);
    expect(summary.due).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #50 手動投稿待ち
// ---------------------------------------------------------------------------

describe('#50 承認待ちの手動投稿は手動投稿待ちに含まれない', () => {
  it('#50 manual・期限切れの承認待ちは items にも total にも入らない', async () => {
    const id = await makePost('awaiting_approval', 'manual');

    const pending = await listManualPendingPosts(admin, { limit: 50 });

    expect(pending.items.map((item) => item.id)).not.toContain(id);
    expect(pending.total).toBe(0);
  });

  it('#50 対照：status を scheduled に書き換えた同じ行は手動投稿待ちに入る', async () => {
    const id = await makePost('awaiting_approval', 'manual');
    await setStatus(id, 'scheduled');

    const pending = await listManualPendingPosts(admin, { limit: 50 });

    expect(pending.items.map((item) => item.id)).toEqual([id]);
    expect(pending.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #51 承認待ちの一覧
// ---------------------------------------------------------------------------

describe('#51 listApprovalPendingPosts', () => {
  it('#51 limit: 2 → 承認待ちだけを作成の古い順に 2 件、total: 3', async () => {
    const first = await makePost('awaiting_approval', 'auto', '1 件目');
    await makePost('draft', 'auto', '下書き');
    const second = await makePost('awaiting_approval', 'manual', '2 件目');
    await makePost('scheduled', 'auto', '予約');
    await makePost('awaiting_approval', 'auto', '3 件目');

    const page = await listApprovalPendingPosts(admin, { limit: 2 });

    expect(page.items.map((item) => item.id)).toEqual([first, second]);
    expect(page.total).toBe(3);
  });

  it('#51 返る行はすべて awaiting_approval', async () => {
    await makePost('awaiting_approval', 'auto');
    await makePost('draft', 'auto');

    const page = await listApprovalPendingPosts(admin, { limit: 50 });

    expect(page.items.map((item) => item.status)).toEqual(['awaiting_approval']);
  });

  it('#51 承認待ちが無ければ items は空で total: 0', async () => {
    await makePost('draft', 'auto');

    const page = await listApprovalPendingPosts(admin, { limit: 50 });

    expect(page).toMatchObject({ items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// #55 権限
// ---------------------------------------------------------------------------

describe('#55 listApprovalPendingPosts の権限', () => {
  it('#55 social.read の無い文脈では ForbiddenError（403 に写る）', async () => {
    const nobody = await contextFor([]);

    await expect(listApprovalPendingPosts(nobody, { limit: 50 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('#55 social.read を持つ閲覧者は呼べる', async () => {
    await makePost('awaiting_approval', 'auto');
    const viewer = await contextFor(['viewer']);

    const page = await listApprovalPendingPosts(viewer, { limit: 50 });

    expect(page.total).toBe(1);
  });
});
