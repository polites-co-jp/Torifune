import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createCampaign, updateCampaign } from '@/application/campaign/campaign-use-cases';
import { resetEventHandlers } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * キャンペーンの保存と、紐づけ先のサイトの削除が重なったとき（045-campaign-input-500 設計 §6.4）。
 *
 * 検証の指摘への処置として足したテスト（実装プラン §8「検証の指摘への処置」）。
 *
 * 1. **存在の確かめは書き込みと同じトランザクションの中で行う**（spec 軽微-1）。
 *    `lockExistingLinks` をトランザクションの外（`context.connection`）で呼ぶと、確かめた後に
 *    サイトが消され、`campaign_sites` への INSERT が外部キー違反（`23503`。HTTP では 500）になる。
 *    UseCase を通してこれを確かめる：`campaign_sites` の BEFORE INSERT トリガで保存を止めておき、
 *    その間に別の接続からサイトを `DELETE` する。正しければ `DELETE` は保存が終わるまで待ち、
 *    保存は成功する（422 でもよいが、`23503` は許さない）。
 *
 * 止めるのは `sleep` ではなく advisory lock（`gate`）で行い、待ちの有無は `pg_locks` /
 * `pg_stat_activity` で確かめる（時間に頼らない。設計 §13 の 4）。
 */

/** `campaign_sites` の INSERT を止める advisory lock の鍵。 */
const GATE_KEY = 45045;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
/** 状況を覗く接続（待ちの確かめ）。 */
let monitor: pg.Client;
/** テスト中に開いた別の接続。後始末で必ず閉じる。 */
const clients: pg.Client[] = [];

async function contextFor(roleNames: readonly string[]): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `c${suffix}`,
        email: `c${suffix}@example.com`,
        display_name: 'campaign link concurrency test',
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
    loginId: `c${suffix}`,
    displayName: 'campaign link concurrency test',
    email: `c${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection((connection) => authorizationContextFor(connection, identity));
}

/** 同じ DB へ別に張った接続。 */
async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  clients.push(client);
  return client;
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

/** 決着を待たずに結果を記録する Promise。`done` で決着したかを覗ける。 */
interface Settled<T> {
  done: boolean;
  readonly result: Promise<{ ok: true; value: T } | { ok: false; error: unknown }>;
}

function settle<T>(promise: Promise<T>): Settled<T> {
  const settled: Settled<T> = {
    done: false,
    result: promise.then(
      (value) => {
        settled.done = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled.done = true;
        return { ok: false as const, error };
      },
    ),
  };
  return settled;
}

/** 条件が満たされるまで問い合わせを繰り返す。5 秒で満たされなければテストを落とす。 */
async function waitUntil(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`待ちきれなかった: ${what}`);
}

/** この DB の中で advisory lock を待っている接続があるか（保存がトリガで止まったか）。 */
async function someoneWaitsOnGate(): Promise<boolean> {
  const result = await monitor.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/** その接続が行ロックなどの待ちに入っているか。 */
async function isWaitingOnLock(pid: number): Promise<boolean> {
  const result = await monitor.query<{ wait_event_type: string | null }>(
    'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
    [pid],
  );
  return result.rows[0]?.wait_event_type === 'Lock';
}

async function backendPid(client: pg.Client): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0]?.pid ?? -1;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('campaignlinkconcurrency');
  monitor = new pg.Client({ connectionString: scratch.connectionString });
  await monitor.connect();
});

afterAll(async () => {
  await monitor.end();
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor(['administrator']);
});

afterEach(async () => {
  resetEventHandlers();
  for (const client of clients.splice(0)) {
    await client.end().catch(() => undefined);
  }
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('campaigns').execute();
    await connection.db.deleteFrom('sites').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/* -------------------------------------------------------------------------- */
/* 1. 存在の確かめは書き込みと同じトランザクション（spec 軽微-1）                       */
/* -------------------------------------------------------------------------- */

interface RaceOutcome {
  readonly saved: { ok: true; value: unknown } | { ok: false; error: unknown };
  /** 保存を先へ進めた時点で、サイトの DELETE が終わっていたか。 */
  readonly deleteFinishedBeforeRelease: boolean;
  readonly deletedRows: number;
}

/**
 * `save` を `campaign_sites` の INSERT の直前で止め、その間に別の接続から `siteId` を消し、
 * DELETE が「待っている」か「終わった」かを見届けてから保存を先へ進める。
 */
async function raceSaveWithSiteDelete(
  save: () => Promise<unknown>,
  siteId: string,
): Promise<RaceOutcome> {
  const gate = await openClient();
  await gate.query('SELECT pg_advisory_lock($1)', [GATE_KEY]);
  let released = false;
  try {
    const saving = settle(save());
    await waitUntil(someoneWaitsOnGate, '保存が campaign_sites の INSERT の前で止まる');

    const deleter = await openClient();
    const deleterPid = await backendPid(deleter);
    const deleting = settle(deleter.query('DELETE FROM sites WHERE id = $1', [siteId]));
    await waitUntil(
      async () => deleting.done || (await isWaitingOnLock(deleterPid)),
      'サイトの DELETE が終わるか、ロックを待つ',
    );
    const deleteFinishedBeforeRelease = deleting.done;

    await gate.query('SELECT pg_advisory_unlock($1)', [GATE_KEY]);
    released = true;

    const saved = await saving.result;
    const deleted = await deleting.result;
    if (!deleted.ok) throw deleted.error;
    return { saved, deleteFinishedBeforeRelease, deletedRows: deleted.value.rowCount ?? 0 };
  } finally {
    if (!released) {
      await gate.query('SELECT pg_advisory_unlock($1)', [GATE_KEY]);
    }
  }
}

/** 成功、または 422 になる `ValidationError`。外部キー違反（`pg.DatabaseError`）は許さない。 */
function expectSuccessOr422(saved: RaceOutcome['saved']): void {
  if (saved.ok) return;
  expect(saved.error).not.toBeInstanceOf(pg.DatabaseError);
  expect((saved.error as { code?: unknown }).code).not.toBe('23503');
  expect(saved.error).toBeInstanceOf(ValidationError);
}

describe('保存の途中で紐づけ先のサイトが消されても、外部キー違反（500）にならない', () => {
  beforeAll(async () => {
    // BEFORE INSERT で共有の advisory lock を取る。誰も gate を持っていなければ素通りする。
    const setup = new pg.Client({ connectionString: scratch.connectionString });
    await setup.connect();
    try {
      await setup.query(`
        CREATE FUNCTION test_045_gate_campaign_sites() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock_shared(${GATE_KEY});
          RETURN NEW;
        END
        $$`);
      await setup.query(`
        CREATE TRIGGER test_045_gate BEFORE INSERT ON campaign_sites
        FOR EACH ROW EXECUTE FUNCTION test_045_gate_campaign_sites()`);
    } finally {
      await setup.end();
    }
  });

  afterAll(async () => {
    const cleanup = new pg.Client({ connectionString: scratch.connectionString });
    await cleanup.connect();
    try {
      await cleanup.query('DROP TRIGGER IF EXISTS test_045_gate ON campaign_sites');
      await cleanup.query('DROP FUNCTION IF EXISTS test_045_gate_campaign_sites()');
    } finally {
      await cleanup.end();
    }
  });

  function createOn(siteId: string): () => Promise<unknown> {
    return () =>
      createCampaign(admin, {
        name: 'キャンペーン',
        description: '',
        status: 'draft',
        startsOn: '2026-01-01',
        endsOn: null,
        siteIds: [siteId],
      });
  }

  it('createCampaign：成功か 422 で、外部キー違反（23503）にならない', async () => {
    const site = await makeSite('race-create');

    const outcome = await raceSaveWithSiteDelete(createOn(site), site);

    expectSuccessOr422(outcome.saved);
  });

  it('createCampaign：サイトの DELETE は保存が終わるまで待つ', async () => {
    const site = await makeSite('race-create-wait');

    const outcome = await raceSaveWithSiteDelete(createOn(site), site);

    expect(outcome.deleteFinishedBeforeRelease).toBe(false);
  });

  it('createCampaign：待った DELETE は保存の後でサイトを消す（紐づけも CASCADE で消える）', async () => {
    const site = await makeSite('race-create-after');

    const outcome = await raceSaveWithSiteDelete(createOn(site), site);

    expect(outcome.deletedRows).toBe(1);
    const links = await withConnection((connection) =>
      connection.db.selectFrom('campaign_sites').select('site_id').execute(),
    );
    expect(links).toEqual([]);
  });

  it('updateCampaign：成功か 422 で、外部キー違反（23503）にならない', async () => {
    const campaign = await createOn(await makeSite('race-update-s1'))();
    const target = await makeSite('race-update-s2');

    const outcome = await raceSaveWithSiteDelete(
      () => updateCampaign(admin, { id: (campaign as { id: string }).id, siteIds: [target] }),
      target,
    );

    expectSuccessOr422(outcome.saved);
  });

  it('updateCampaign：サイトの DELETE は保存が終わるまで待つ', async () => {
    const campaign = await createOn(await makeSite('race-update-wait-s1'))();
    const target = await makeSite('race-update-wait-s2');

    const outcome = await raceSaveWithSiteDelete(
      () => updateCampaign(admin, { id: (campaign as { id: string }).id, siteIds: [target] }),
      target,
    );

    expect(outcome.deleteFinishedBeforeRelease).toBe(false);
  });
});
