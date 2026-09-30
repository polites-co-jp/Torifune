import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign, updateCampaign } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { createSite, deleteSite } from '@/application/site/site-use-cases';
import {
  createSocialAccount,
  createSocialPost,
  deleteSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 画面を開いた後に紐づけ先が消えた場合の UseCase（045-campaign-input-500 設計 §1.1・§6.3・§6.4、受け入れ条件 #23）。
 *
 * 編集画面は開いた時点のサイト・投稿を送る。その間に対象が消されると、いまは外部キー違反（Postgres の例外）で
 * 保存が 500 になる。`createCampaign` / `updateCampaign` は DB の例外ではなく `ValidationError`
 * （`field === 'siteIds'` / `'socialPostIds'`）で断り、何も書かない。
 *
 * UseCase を直接呼ぶ（Server Component・Data API と同じ経路）。サイト・投稿は UseCase で作って消す。
 */

const NOT_FOUND_SITE = '存在しないWebサイトが含まれています。';
const NOT_FOUND_POST = '存在しないSNS投稿が含まれています。';

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** 実在するサイト S1。 */
let s1: string;
/** 作ってから消したサイト S3。 */
let s3: string;
/** 作ってから消した SNS 投稿。 */
let deletedPost: string;

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `v${suffix}`,
        email: `v${suffix}@example.com`,
        display_name: 'campaign link use case test',
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
    loginId: `v${suffix}`,
    displayName: 'campaign link use case test',
    email: `v${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

async function makeSite(label: string): Promise<string> {
  const site = await createSite(admin, {
    name: label,
    url: `https://${label}.example.com`,
    description: '',
    status: 'active',
  });
  return site.id;
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

function createInput(overrides: {
  readonly siteIds?: readonly string[];
  readonly socialPostIds?: readonly string[];
}): Parameters<typeof createCampaign>[1] {
  return {
    name: 'キャンペーン',
    description: '',
    status: 'draft',
    startsOn: '2026-01-01',
    endsOn: null,
    siteIds: overrides.siteIds ?? [],
    ...(overrides.socialPostIds === undefined ? {} : { socialPostIds: overrides.socialPostIds }),
  };
}

async function countCampaigns(): Promise<number> {
  return withConnection(async (connection) => {
    const rows = await connection.db.selectFrom('campaigns').select('id').execute();
    return rows.length;
  });
}

beforeAll(async () => {
  scratch = await useScratchDatabase('campaignlinkusecase');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
  s1 = await makeSite('s1');
  s3 = await makeSite('s3');
  await deleteSite(admin, { id: s3 });

  const account = await createSocialAccount(admin, {
    provider: 'x',
    displayName: 'アカウント',
    handle: '@usecase',
    credential: null,
    status: 'connected',
  });
  deletedPost = (
    await createSocialPost(admin, {
      socialAccountId: account.id,
      body: '消す投稿',
      scheduledAt: null,
      status: 'draft',
    })
  ).post.id;
  await deleteSocialPost(admin, { id: deletedPost });
});

afterEach(async () => {
  resetEventHandlers();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* #23 createCampaign                                                          */
/* -------------------------------------------------------------------------- */

describe('#23 createCampaign に消えたサイトを渡すと ValidationError（DB の例外ではない）', () => {
  it('#23 siteIds: [S3（削除済み）] → ValidationError', async () => {
    const error = await rejectionOf(createCampaign(admin, createInput({ siteIds: [s3] })));

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('#23 siteIds: [S3（削除済み）] → field === "siteIds"', async () => {
    const error = await rejectionOf(createCampaign(admin, createInput({ siteIds: [s3] })));

    expect((error as { field?: unknown }).field).toBe('siteIds');
  });

  it(`#23 siteIds: [S3（削除済み）] → detail が「${NOT_FOUND_SITE}」`, async () => {
    const error = await rejectionOf(createCampaign(admin, createInput({ siteIds: [s3] })));

    expect((error as { detail?: unknown }).detail).toBe(NOT_FOUND_SITE);
  });

  it('#23 siteIds: [S3（削除済み）] → pg の DatabaseError ではない', async () => {
    const error = await rejectionOf(createCampaign(admin, createInput({ siteIds: [s3] })));

    expect(error).not.toBeInstanceOf(pg.DatabaseError);
  });

  it('#23 siteIds: [S3（削除済み）] → キャンペーンが作られていない', async () => {
    await rejectionOf(createCampaign(admin, createInput({ siteIds: [s3] })));

    expect(await countCampaigns()).toBe(0);
  });

  it('#23 socialPostIds: [削除済みの投稿] → ValidationError、field === "socialPostIds"', async () => {
    const error = await rejectionOf(
      createCampaign(admin, createInput({ socialPostIds: [deletedPost] })),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: unknown }).field).toBe('socialPostIds');
  });

  it(`#23 socialPostIds: [削除済みの投稿] → detail が「${NOT_FOUND_POST}」`, async () => {
    const error = await rejectionOf(
      createCampaign(admin, createInput({ socialPostIds: [deletedPost] })),
    );

    expect((error as { detail?: unknown }).detail).toBe(NOT_FOUND_POST);
  });
});

/* -------------------------------------------------------------------------- */
/* #23 updateCampaign                                                          */
/* -------------------------------------------------------------------------- */

describe('#23 updateCampaign に消えたサイトを渡すと ValidationError（DB の例外ではない）', () => {
  async function campaignOnS1(): Promise<string> {
    return (await createCampaign(admin, createInput({ siteIds: [s1] }))).id;
  }

  it('#23 siteIds: [S3（削除済み）] → ValidationError', async () => {
    const id = await campaignOnS1();

    const error = await rejectionOf(updateCampaign(admin, { id, siteIds: [s3] }));

    expect(error).toBeInstanceOf(ValidationError);
  });

  it('#23 siteIds: [S3（削除済み）] → field === "siteIds"', async () => {
    const id = await campaignOnS1();

    const error = await rejectionOf(updateCampaign(admin, { id, siteIds: [s3] }));

    expect((error as { field?: unknown }).field).toBe('siteIds');
  });

  it('#23 siteIds: [S3（削除済み）] → pg の DatabaseError ではない', async () => {
    const id = await campaignOnS1();

    const error = await rejectionOf(updateCampaign(admin, { id, siteIds: [s3] }));

    expect(error).not.toBeInstanceOf(pg.DatabaseError);
  });

  it('#23 失敗の後もキャンペーンの名前と siteIds（[S1]）が変わっていない', async () => {
    const id = await campaignOnS1();

    await rejectionOf(updateCampaign(admin, { id, name: '変えた名前', siteIds: [s3] }));

    const rows = await withConnection((connection) =>
      connection.db
        .selectFrom('campaign_sites')
        .select('site_id')
        .where('campaign_id', '=', id)
        .execute(),
    );
    const campaign = await withConnection((connection) =>
      connection.db
        .selectFrom('campaigns')
        .select('name')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    expect(campaign.name).toBe('キャンペーン');
    expect(rows.map((row) => row.site_id)).toEqual([s1]);
  });

  it('#23 socialPostIds: [削除済みの投稿] → ValidationError、field === "socialPostIds"', async () => {
    const id = await campaignOnS1();

    const error = await rejectionOf(updateCampaign(admin, { id, socialPostIds: [deletedPost] }));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as { field?: unknown }).field).toBe('socialPostIds');
  });
});
