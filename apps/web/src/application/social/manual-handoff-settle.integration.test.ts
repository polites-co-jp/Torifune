import type { PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  listSocialPendingPosts,
  resolveManualHandoff,
  type ManualHandoffOutcome,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { canOpenManualHandoff } from '@/domain/social/pending';
import { MANUAL_HANDOFF_BUDGET_MS } from '@/domain/social/publishing';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 描画の途中で行が変わったとき（055-social-pending-tab 設計 §8.3・§9.3.4・§13.12、受け入れ条件 #82。検証 1 回目 security S1）。
 *
 * **UseCase を直接呼ぶ結合テスト（B）。** `app/social/page.tsx` の送信待ちタブの組み立てと同じ順に、
 * 一覧（`listSocialPendingPosts`）を読んでから、手動の予約の行ごとに `resolveManualHandoff` を `Promise.all` で呼ぶ。
 * その間（読んだ後・解決の前）に 1 件の配信方法を SQL で `auto` に変え、1 件を消す。
 *
 * * 包まない呼び出しは `Promise.all` ごと reject する（今の形。タブ全体がエラー画面になる。S1 の再現）
 * * `settleManualHandoff` で包むと reject せず、変えていない行は `{ ok: true, url }`、変えた行・消した行はちょうど
 *   `{ ok: false, reason: 'changed' }`
 *
 * `settleManualHandoff`（`application/social/manual-handoff-settle.ts`）はまだ無いので、指定子を `string` の定数に置いた
 * 動的 import で読む（054 実装プラン §8 の 43）。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'mhset_both';
const HOUR = 60 * 60_000;
const URL = 'https://example.test/intent/settle';

type Settle = (pending: Promise<ManualHandoffOutcome>) => Promise<ManualHandoffOutcome>;

const SETTLE_MODULE: string = '@/application/social/manual-handoff-settle';

async function loadSettle(): Promise<Settle> {
  const module = (await import(/* @vite-ignore */ SETTLE_MODULE)) as {
    settleManualHandoff?: Settle;
  };
  if (typeof module.settleManualHandoff !== 'function') {
    throw new Error('application/social/manual-handoff-settle.ts に settleManualHandoff が無い');
  }
  return module.settleManualHandoff;
}

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `mst${suffix}`,
        email: `mst${suffix}@example.com`,
        display_name: 'manual handoff settle test',
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
    loginId: `mst${suffix}`,
    displayName: 'manual handoff settle test',
    email: `mst${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function publisher(): PublisherRegistration {
  return {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: () => ({ url: URL }),
  };
}

/** 手動の予約（予約時刻の前）を作る。本文に名前を入れる。 */
async function makeManualScheduled(name: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: `描画の途中 ${name}`,
    scheduledAt: new Date(Date.now() + HOUR),
    deliveryMode: 'manual',
    status: 'scheduled',
  });
  return post.id;
}

async function rewrite(id: string, set: RawBuilder<unknown>): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
}

async function deletePost(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').where('id', '=', id).execute();
  });
}

interface Prepared {
  readonly kept: string;
  readonly toAuto: string;
  readonly removed: string;
  /** 一覧で読んだ手動の予約の行の ID（表の並びの順）。 */
  readonly listed: readonly string[];
}

/** 3 件を作って一覧で読み、読んだ後に 1 件を自動へ変え、1 件を消す。 */
async function prepare(): Promise<Prepared> {
  const kept = await makeManualScheduled('そのまま');
  const toAuto = await makeManualScheduled('自動へ変わる');
  const removed = await makeManualScheduled('消される');

  const now = new Date();
  const page = await listSocialPendingPosts(admin, {
    page: 1,
    perPage: 100,
    kind: null,
    socialAccountId: accountId,
    now,
  });
  const listed = page.items.filter((post) => canOpenManualHandoff(post)).map((post) => post.id);
  expect([...listed].sort(), '一覧で 3 件とも手動の予約として読めている').toEqual(
    [kept, toAuto, removed].sort(),
  );

  // 読んだ後・解決の前に、別の要求が行を変えた。
  await rewrite(toAuto, sql`delivery_mode = 'auto'`);
  await deletePost(removed);

  return { kept, toAuto, removed, listed };
}

function deadline(): Date {
  return new Date(Date.now() + MANUAL_HANDOFF_BUDGET_MS);
}

beforeAll(async () => {
  scratch = await useScratchDatabase('manualhandoffsettle');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  registerPublisher(PLUGIN_ID, publisher());
  admin = await contextFor('administrator');
  accountId = (
    await createSocialAccount(admin, {
      provider: PROVIDER,
      displayName: 'とりふね公式',
      handle: '@torifune',
      credential: null,
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
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

describe('#82 描画の途中で行が変わっても送信待ちタブの行の解決は reject しない', () => {
  it('#82 前提：包まない呼び出しは Promise.all ごと reject する（S1 の再現）', async () => {
    const { listed } = await prepare();
    const handoffDeadline = deadline();

    await expect(
      Promise.all(
        listed.map((id) => resolveManualHandoff(admin, { id, deadline: handoffDeadline })),
      ),
    ).rejects.toThrow();
  });

  it('#82 settleManualHandoff で包むと Promise.all は reject しない', async () => {
    const settleManualHandoff = await loadSettle();
    const { listed } = await prepare();
    const handoffDeadline = deadline();

    await expect(
      Promise.all(
        listed.map((id) =>
          settleManualHandoff(resolveManualHandoff(admin, { id, deadline: handoffDeadline })),
        ),
      ),
    ).resolves.toHaveLength(3);
  });

  it('#82 変えていない行は { ok: true, url }、自動へ変えた行・消した行はちょうど { ok: false, reason: changed }', async () => {
    const settleManualHandoff = await loadSettle();
    const { kept, toAuto, removed, listed } = await prepare();
    const handoffDeadline = deadline();

    const outcomes = await Promise.all(
      listed.map((id) =>
        settleManualHandoff(resolveManualHandoff(admin, { id, deadline: handoffDeadline })),
      ),
    );
    const byId = new Map(listed.map((id, index) => [id, outcomes[index]]));

    expect(byId.get(kept)).toMatchObject({ ok: true, url: URL });
    expect(byId.get(toAuto)).toEqual({ ok: false, reason: 'changed' });
    expect(byId.get(removed)).toEqual({ ok: false, reason: 'changed' });
  });
});
