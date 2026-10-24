import type { ManualInput, PublisherRegistration } from '@torifune/plugin-api';
import { sql, type RawBuilder } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  approveSocialPost,
  createSocialAccount,
  createSocialPost,
  resolveManualHandoff,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * `resolveManualHandoff` の状態の検査（055-social-pending-tab 設計 §5.5・§8.3、受け入れ条件 #28〜#30）。
 *
 * **UseCase を直接呼ぶ結合テスト（B）。**
 *
 * * #28：予約時刻の**前**・承認済み・予約日時なしの手動の予約 → `{ ok: true, url }`、`manual()` が 1 回（変えないことの固定。
 *   今も緑）
 * * #29：承認待ち・下書き・配信済みの手動投稿 → `{ ok: false, reason: 'not_scheduled' }`、`manual()` は 0 回。
 *   締切を過ぎた `deadline` を渡しても `not_scheduled`（状態の検査は締切の検査より前。設計 §8.3）
 * * #30：自動配信 → `ValidationError`、Plugin の無い provider → `unsupported`、締切を過ぎた → `plugin_error`（今のまま）
 *
 * `manual()` の回数は、呼ばれた引数を貯める偽物の publisher で数える（`manual-handoff.integration.test.ts` の
 * `recordManualCalls` を写す）。予約日時なしの予約は作成の検査が断るので、作った後に SQL で `scheduled_at = NULL` にする。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'mhs_both';
const HOUR = 60 * 60_000;
const URL = 'https://example.test/intent/compose';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;
let manualCalls: ManualInput[];

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `mhs${suffix}`,
        email: `mhs${suffix}@example.com`,
        display_name: 'manual handoff status test',
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
    loginId: `mhs${suffix}`,
    displayName: 'manual handoff status test',
    email: `mhs${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };
  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** `manual()` が受け取った引数を貯める publisher（`publish` も持つ。承認待ちを作れるように）。 */
function recordingPublisher(): PublisherRegistration {
  return {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [],
    publish: async () => ({ ok: true, externalId: 'e1' }),
    manual: (input) => {
      manualCalls.push(input);
      return { url: URL };
    },
  };
}

interface PostOptions {
  readonly deliveryMode?: 'auto' | 'manual';
  readonly scheduledAt?: Date | null;
  readonly kind?: 'scheduled' | 'awaiting' | 'draft';
}

async function makePost(options: PostOptions = {}): Promise<{ id: string; updatedAt: Date }> {
  const kind = options.kind ?? 'scheduled';
  const base = {
    socialAccountId: accountId,
    body: '手動で投稿する本文',
    scheduledAt:
      options.scheduledAt === undefined ? new Date(Date.now() + HOUR) : options.scheduledAt,
    deliveryMode: options.deliveryMode ?? 'manual',
  };
  const input =
    kind === 'awaiting'
      ? { ...base, publishTiming: 'after_approval' as const }
      : { ...base, status: kind };
  const { post } = await createSocialPost(admin, input);
  return { id: post.id, updatedAt: post.updatedAt };
}

async function rewrite(id: string, set: RawBuilder<unknown>): Promise<void> {
  await withConnection(async (connection) => {
    await sql`UPDATE social_posts SET ${set} WHERE id = ${id}`.execute(connection.db);
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('manualhandoffstatus');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  manualCalls = [];
  registerPublisher(PLUGIN_ID, recordingPublisher());
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

// ---------------------------------------------------------------------------
// #28 予約時刻の前の手動の予約（変えないことの固定）
// ---------------------------------------------------------------------------

describe('#28 予約済みの手動投稿は予約時刻の前でも URL を返す', () => {
  it('#28 予約時刻の前（now+1h）→ { ok: true, url }、manual() が 1 回', async () => {
    const { id } = await makePost({ scheduledAt: new Date(Date.now() + HOUR) });

    const outcome = await resolveManualHandoff(admin, { id });

    expect(outcome).toMatchObject({ ok: true, url: URL });
    expect(manualCalls).toHaveLength(1);
  });

  it('#28 承認済みの手動の予約 → { ok: true, url }、manual() が 1 回', async () => {
    const awaiting = await makePost({ kind: 'awaiting', scheduledAt: new Date(Date.now() + HOUR) });
    await approveSocialPost(admin, {
      id: awaiting.id,
      publishTiming: 'scheduled',
      expectedUpdatedAt: awaiting.updatedAt,
    });

    const outcome = await resolveManualHandoff(admin, { id: awaiting.id });

    expect(outcome).toMatchObject({ ok: true, url: URL });
    expect(manualCalls).toHaveLength(1);
  });

  it('#28 予約日時の無い手動の予約（SQL で NULL）→ { ok: true, url }、manual() が 1 回', async () => {
    const { id } = await makePost();
    await rewrite(id, sql`scheduled_at = NULL`);

    const outcome = await resolveManualHandoff(admin, { id });

    expect(outcome).toMatchObject({ ok: true, url: URL });
    expect(manualCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #29 予約済みでない手動投稿
// ---------------------------------------------------------------------------

describe('#29 予約済みでない手動投稿は not_scheduled で manual() を呼ばない', () => {
  const cases: readonly (readonly [string, () => Promise<string>])[] = [
    [
      '承認待ちの手動投稿',
      async () => (await makePost({ kind: 'awaiting', scheduledAt: null })).id,
    ],
    ['下書きの手動投稿', async () => (await makePost({ kind: 'draft', scheduledAt: null })).id],
    [
      '配信済みの手動投稿',
      async () => {
        const { id } = await makePost({ scheduledAt: new Date(Date.now() - HOUR) });
        await rewrite(id, sql`status = 'published', published_at = now()`);
        return id;
      },
    ],
  ];

  it.each(cases)("#29 %s → { ok: false, reason: 'not_scheduled' }", async (_title, make) => {
    const id = await make();

    await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
      ok: false,
      reason: 'not_scheduled',
    });
  });

  it.each(cases)('#29 %s → manual() は 0 回', async (_title, make) => {
    const id = await make();

    await resolveManualHandoff(admin, { id });

    expect(manualCalls).toHaveLength(0);
  });

  it.each(cases)(
    '#29 %s：締切を過ぎた deadline を渡しても not_scheduled（状態の検査が締切より前）',
    async (_title, make) => {
      const id = await make();

      await expect(
        resolveManualHandoff(admin, { id, deadline: new Date(Date.now() - 1) }),
      ).resolves.toEqual({ ok: false, reason: 'not_scheduled' });
      expect(manualCalls).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// #30 今のままの振る舞い（固定）
// ---------------------------------------------------------------------------

describe('#30 自動配信・Plugin なし・締切は今のまま', () => {
  it('#30 自動配信の投稿 → ValidationError（フィールド deliveryMode）', async () => {
    const { id } = await makePost({ deliveryMode: 'auto' });

    const error = await resolveManualHandoff(admin, { id }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe('deliveryMode');
    expect(manualCalls).toHaveLength(0);
  });

  it('#30 Plugin の無い provider の手動の予約 → unsupported', async () => {
    const { id } = await makePost();
    resetPublisherRegistry();

    await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('#30 締切を過ぎた手動の予約 → plugin_error、manual() は 0 回', async () => {
    const { id } = await makePost();

    await expect(
      resolveManualHandoff(admin, { id, deadline: new Date(Date.now() - 1) }),
    ).resolves.toEqual({ ok: false, reason: 'plugin_error' });
    expect(manualCalls).toHaveLength(0);
  });
});
