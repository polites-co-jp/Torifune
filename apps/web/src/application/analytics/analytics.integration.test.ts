import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  listAnalytics,
  listAnalyticsPage,
  listTopPaths,
  listTopPathsPage,
  recordAnalytics,
} from '@/application/analytics/analytics-use-cases';
import { collectAccess, resetDailySalts } from '@/application/analytics/collect';
import { pruneAccessLogs, rollupAnalytics } from '@/application/analytics/rollup';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * アクセス・分析データ（018-analytics）。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `a${suffix}`,
        email: `a${suffix}@example.com`,
        display_name: 'analytics test',
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
    loginId: `a${suffix}`,
    displayName: 'analytics test',
    email: `a${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function makeSite(): Promise<{ id: string; publicKey: string }> {
  const site = await createSite(admin, {
    name: `site-${Math.random().toString(36).slice(2, 8)}`,
    url: 'https://example.com',
    description: '',
    status: 'active',
  });

  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('sites')
      .select('public_key')
      .where('id', '=', site.id)
      .executeTakeFirstOrThrow(),
  );

  return { id: site.id, publicKey: row.public_key };
}

/** ローカルの `YYYY-MM-DD`。 */
function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

beforeAll(async () => {
  scratch = await useScratchDatabase('analytics');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  resetDailySalts();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('access_logs').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('sites').execute();
  });
});

describe('計測', () => {
  it('計測タグからのアクセスが記録される', async () => {
    const site = await makeSite();

    const outcome = await collectAccess({
      publicKey: site.publicKey,
      path: '/blog/post',
      referrer: 'https://google.com/search?q=x',
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    expect(outcome.ok).toBe(true);

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').selectAll().execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.path).toBe('/blog/post');
    // リファラはホストだけ。パスまで持つと他サイト上の閲覧内容が残る。
    expect(rows[0]?.referrer_host).toBe('google.com');
  });

  /** 設計 §3.2 の核心。 */
  it('IPアドレスと User-Agent の生値を保存しない', async () => {
    const site = await makeSite();

    await collectAccess({
      publicKey: site.publicKey,
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').selectAll().execute(),
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('203.0.113.5');
    expect(serialized).not.toContain('Mozilla');
  });

  it('クエリ文字列を保存しない', async () => {
    const site = await makeSite();

    await collectAccess({
      publicKey: site.publicKey,
      path: '/search?token=secret',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').select('path').execute(),
    );
    expect(rows[0]?.path).toBe('/search');
  });

  it('不正なサイトキーでは記録されない', async () => {
    await makeSite();

    const outcome = await collectAccess({
      publicKey: 'not-a-real-key',
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    expect(outcome.ok).toBe(false);
    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').selectAll().execute(),
    );
    expect(rows).toHaveLength(0);
  });

  it('パスが不正なら記録されない', async () => {
    const site = await makeSite();

    const outcome = await collectAccess({
      publicKey: site.publicKey,
      path: 'javascript:alert(1)',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    expect(outcome.ok).toBe(false);
  });

  it('Bot は記録される', async () => {
    const site = await makeSite();

    await collectAccess({
      publicKey: site.publicKey,
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: 'Googlebot/2.1',
    });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').select('device').execute(),
    );
    expect(rows[0]?.device).toBe('bot');
  });
});

describe('ロールアップ', () => {
  async function hit(publicKey: string, path: string, ip: string, ua = BROWSER): Promise<void> {
    await collectAccess({ publicKey, path, referrer: null, ipAddress: ip, userAgent: ua });
  }

  it('生ログを日次へ集計する', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/a', '203.0.113.1');
    await hit(site.publicKey, '/b', '203.0.113.1');
    await hit(site.publicKey, '/a', '203.0.113.2');

    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
    });

    const byMetric = new Map(points.map((point) => [point.metric, point.value]));
    expect(byMetric.get('pageviews')).toBe(3);
    expect(byMetric.get('visitors')).toBe(2);
  });

  /** 一度きりの処理にすると、失敗したときに手で直すことになる。 */
  it('2回流しても値が二重にならない', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/a', '203.0.113.1');

    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );
    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
    });

    expect(points.find((point) => point.metric === 'pageviews')?.value).toBe(1);
  });

  /** 数えると、数字が実態から離れる。 */
  it('Bot を集計に含めない', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/a', '203.0.113.1');
    await hit(site.publicKey, '/a', '203.0.113.2', 'Googlebot/2.1');

    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
    });

    expect(points.find((point) => point.metric === 'pageviews')?.value).toBe(1);
  });

  it('上位ページを出す', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/popular', '203.0.113.1');
    await hit(site.publicKey, '/popular', '203.0.113.2');
    await hit(site.publicKey, '/rare', '203.0.113.3');

    const top = await listTopPaths(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
      limit: 10,
    });

    expect(top.map((row) => row.path)).toEqual(['/popular', '/rare']);
    expect(top[0]?.pageviews).toBe(2);
  });

  /** 集計値は小さく、過去との比較に要る。生ログだけ消す。 */
  it('古い生ログを消しても集計値は残る', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/a', '203.0.113.1');
    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );

    // 生ログを過去へずらしてから消す。
    await withConnection(async (connection) => {
      // occurred_at は本番では更新しない列なので、型からも外してある。
      // 過去のログを作るためだけの操作なので、生SQLで行う。
      await sql`UPDATE access_logs SET occurred_at = now() - interval '100 days'`.execute(
        connection.db,
      );
      await pruneAccessLogs(connection, 30);
    });

    const logs = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').selectAll().execute(),
    );
    expect(logs).toHaveLength(0);

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
    });
    expect(points.length).toBeGreaterThan(0);
  });
});

describe('参照', () => {
  it('analytics.read が無ければ読めない', async () => {
    const noRole = await contextFor('viewer');
    // viewer には analytics.read を与えているので、権限を持たない文脈を作る。
    const stripped: AuthorizationContext = { ...noRole, permissions: new Set() };

    await expect(
      listAnalytics(stripped, { siteId: null, from: today(), to: today(), source: null }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('期間が逆転していれば拒否する', async () => {
    await expect(
      listAnalytics(admin, {
        siteId: null,
        from: '2026-05-01',
        to: '2026-04-01',
        source: null,
      }),
    ).rejects.toThrow(ValidationError);
  });

  /** 広すぎる期間で画面と DB を止めない。 */
  it('期間が長すぎれば拒否する', async () => {
    await expect(
      listAnalytics(admin, {
        siteId: null,
        from: '2020-01-01',
        to: '2026-01-01',
        source: null,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

/**
 * Pagination（05_API設計.md §33）。
 *
 * **analytics に単一リソースの id は無い**（複合キーの集計値）ため、
 * `GET /{id}` は提供しない。必要な範囲は期間指定・絞り込みと Pagination で取る。
 */
describe('Pagination', () => {
  const range = { siteId: null as string | null, source: null as string | null };

  async function seedPoints(siteId: string, metrics: readonly string[]): Promise<void> {
    for (const metric of metrics) {
      await recordAnalytics(admin, {
        siteId,
        metricDate: today(),
        source: 'com.example.ga',
        metric,
        value: 1,
      });
    }
  }

  it('total は条件に合う全件数で、items はそのページの分だけ', async () => {
    const site = await makeSite();
    await seedPoints(site.id, ['pageviews', 'visitors', 'sessions']);

    const first = await listAnalyticsPage(admin, {
      ...range,
      siteId: site.id,
      from: today(),
      to: today(),
      page: 1,
      perPage: 2,
    });

    // 「そのページの件数」ではなく全件数を返す。
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
  });

  it('次のページに残りが出て、前のページと重ならない', async () => {
    const site = await makeSite();
    await seedPoints(site.id, ['pageviews', 'visitors', 'sessions']);

    const query = { ...range, siteId: site.id, from: today(), to: today(), perPage: 2 };
    const first = await listAnalyticsPage(admin, { ...query, page: 1 });
    const second = await listAnalyticsPage(admin, { ...query, page: 2 });

    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);

    const seen = [...first.items, ...second.items].map((point) => point.metric);
    expect(new Set(seen).size).toBe(3);
  });

  it('範囲外のページは空になる（total は変わらない）', async () => {
    const site = await makeSite();
    await seedPoints(site.id, ['pageviews']);

    const page = await listAnalyticsPage(admin, {
      ...range,
      siteId: site.id,
      from: today(),
      to: today(),
      page: 99,
      perPage: 20,
    });

    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(1);
  });

  it('絞り込みは total にも効く', async () => {
    const site = await makeSite();
    await seedPoints(site.id, ['pageviews', 'visitors']);

    const filtered = await listAnalyticsPage(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: 'com.example.other',
      page: 1,
      perPage: 20,
    });

    expect(filtered.total).toBe(0);
    expect(filtered.items).toHaveLength(0);
  });

  it('上位ページもページ指定できる（total はパスの種類数）', async () => {
    const site = await makeSite();
    for (const path of ['/a', '/b', '/c']) {
      await collectAccess({
        publicKey: site.publicKey,
        path,
        referrer: null,
        ipAddress: '203.0.113.1',
        userAgent: BROWSER,
      });
    }

    const query = { ...range, siteId: site.id, from: today(), to: today(), perPage: 2 };
    const first = await listTopPathsPage(admin, { ...query, page: 1 });
    const second = await listTopPathsPage(admin, { ...query, page: 2 });

    // 行数（3件のアクセス）ではなくパスの種類（3種）を数える。
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);

    const seen = [...first.items, ...second.items].map((row) => row.path);
    expect(new Set(seen)).toEqual(new Set(['/a', '/b', '/c']));
  });

  it('analytics.read が無ければ読めない', async () => {
    const noRole = await contextFor('viewer');
    const stripped: AuthorizationContext = { ...noRole, permissions: new Set() };

    await expect(
      listAnalyticsPage(stripped, {
        ...range,
        from: today(),
        to: today(),
        page: 1,
        perPage: 20,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('期間の検証はページ指定でも効く', async () => {
    await expect(
      listAnalyticsPage(admin, {
        ...range,
        from: '2020-01-01',
        to: '2026-01-01',
        page: 1,
        perPage: 20,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('外部サービスからの取り込み', () => {
  it('出所を指定して集計値を入れられる', async () => {
    const site = await makeSite();

    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: today(),
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 1234,
    });

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: 'com.example.ga',
    });

    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(1234);
  });

  /** 名乗れると、外部の値が本体の集計として表示されてしまう。 */
  it('core を名乗れない', async () => {
    const site = await makeSite();

    await expect(
      recordAnalytics(admin, {
        siteId: site.id,
        metricDate: today(),
        source: 'core',
        metric: 'pageviews',
        value: 1,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('Core の集計と外部の値が混ざらない', async () => {
    const site = await makeSite();

    await collectAccess({
      publicKey: site.publicKey,
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.1',
      userAgent: BROWSER,
    });
    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );
    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: today(),
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 999,
    });

    const core = await listAnalytics(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: 'core',
    });
    expect(core.find((point) => point.metric === 'pageviews')?.value).toBe(1);
  });

  it('指標名の形式を検証する', async () => {
    const site = await makeSite();

    await expect(
      recordAnalytics(admin, {
        siteId: site.id,
        metricDate: today(),
        source: 'com.example.ga',
        metric: 'Page Views!',
        value: 1,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('負の値を拒否する', async () => {
    const site = await makeSite();

    await expect(
      recordAnalytics(admin, {
        siteId: site.id,
        metricDate: today(),
        source: 'com.example.ga',
        metric: 'pageviews',
        value: -1,
      }),
    ).rejects.toThrow(ValidationError);
  });
});
