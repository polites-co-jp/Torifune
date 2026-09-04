import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  listAnalytics,
  listAnalyticsPage,
  listTopPaths,
  listTopPathsPage,
  listTrackedSites,
  recordAnalytics,
} from '@/application/analytics/analytics-use-cases';
import { collectAccess, resetDailySalts } from '@/application/analytics/collect';
import { analyticsTimeZone, resetTimeZoneWarning } from '@/application/analytics/timezone';
import { pruneAccessLogs, rollupAnalytics } from '@/application/analytics/rollup';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { createSite } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import type { AnalyticsPoint } from '@/domain/analytics/analytics';
import { daysAgoInTimeZone, todayInTimeZone } from '@/domain/analytics/day';
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

/**
 * 集計と同じ境目での「今日」。
 *
 * **サーバーのローカル日付で作らない。** 集計は運用タイムゾーンで畳むため、
 * ローカルで作ると境目をまたぐ時間帯だけテストが落ちる。
 */
function today(): string {
  return todayInTimeZone(analyticsTimeZone());
}

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

/**
 * ロールアップ再設計（028 設計 §5.3）のための生ログの直接投入。
 *
 * `collectAccess` は `occurred_at` を今にするので、間隔や境目を作れない。
 * `occurred_at` / `visitor_hash` / `device` / `referrer_host` / `path` を指定して直接 INSERT する。
 */
interface LogInput {
  /** ISO 8601（UTC）。 */
  readonly at: string;
  readonly visitor: string;
  readonly path?: string;
  readonly device?: 'desktop' | 'mobile' | 'tablet' | 'bot';
  readonly referrer?: string | null;
}

async function insertLogs(siteId: string, logs: readonly LogInput[]): Promise<void> {
  await withConnection(async (connection) => {
    for (const entry of logs) {
      await connection.db
        .insertInto('access_logs')
        .values({
          id: uuidv7(),
          site_id: siteId,
          occurred_at: entry.at,
          path: entry.path ?? '/',
          referrer_host: entry.referrer ?? null,
          visitor_hash: entry.visitor,
          device: entry.device ?? 'desktop',
        })
        .execute();
    }
  });
}

/** 既定のタイムゾーン（UTC）で境目に掛からない日。 */
const DAY = '2026-06-10';
const NEXT_DAY = '2026-06-11';

/** `HH:mm` または `HH:mm:ss`（UTC）を DAY 上の瞬間にする。 */
function at(time: string, day: string = DAY): string {
  const clock = time.length === 5 ? `${time}:00` : time;
  return `${day}T${clock}Z`;
}

async function rollup(from: string, to: string = from): Promise<{ days: number; points: number }> {
  return withConnection((connection) => rollupAnalytics(connection, { from, to }));
}

/** Core の点を全部読む（key 付きを含む）。 */
async function corePoints(siteId: string, from: string, to: string = from) {
  return listAnalytics(admin, { siteId, from, to, source: 'core' });
}

/** `{ metric, key }` で値を引く。無ければ undefined。 */
function valueOf(points: readonly AnalyticsPoint[], metric: string, key = ''): number | undefined {
  return points.find((point) => point.metric === metric && point.key === key)?.value;
}

/** その指標が持つ key の一覧（昇順）。 */
function keysOf(points: readonly AnalyticsPoint[], metric: string): string[] {
  return points
    .filter((point) => point.metric === metric)
    .map((point) => point.key)
    .sort();
}

async function lastSeenOf(siteId: string): Promise<Date | null> {
  const row = await withConnection((connection) =>
    connection.db
      .selectFrom('sites')
      .select('analytics_last_seen_at')
      .where('id', '=', siteId)
      .executeTakeFirstOrThrow(),
  );
  return row.analytics_last_seen_at;
}

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

describe('1日の境目', () => {
  afterEach(() => {
    delete process.env['TORIFUNE_TIMEZONE'];
    resetTimeZoneWarning();
    resetDailySalts();
  });

  it('既定は UTC', () => {
    delete process.env['TORIFUNE_TIMEZONE'];

    expect(analyticsTimeZone()).toBe('UTC');
  });

  it('設定したタイムゾーンを使う', () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    expect(analyticsTimeZone()).toBe('Asia/Tokyo');
  });

  it('不正な指定では UTC へ落ちる', () => {
    // 設定の誤りでアクセス記録まで止まると被害が大きい。
    process.env['TORIFUNE_TIMEZONE'] = 'Mars/Olympus';

    expect(analyticsTimeZone()).toBe('UTC');
  });

  it('タイムゾーンによって同じ瞬間が別の日になる', () => {
    // 2026-09-02T15:30Z は JST では 9/3 の 00:30。
    const instant = new Date('2026-09-02T15:30:00Z');

    expect(todayInTimeZone('UTC', instant)).toBe('2026-09-02');
    expect(todayInTimeZone('Asia/Tokyo', instant)).toBe('2026-09-03');
  });

  it('日数を戻すときも、そのタイムゾーンの暦で数える', () => {
    const instant = new Date('2026-09-02T15:30:00Z');

    expect(daysAgoInTimeZone(1, 'Asia/Tokyo', instant)).toBe('2026-09-02');
    expect(daysAgoInTimeZone(1, 'UTC', instant)).toBe('2026-09-01');
  });

  it('設定したタイムゾーンの1日として集計される', async () => {
    // **これが揃っていないと、JST の 00:00〜09:00 に見る「今日」が常に空になる。**
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    const site = await makeSite();
    await collectAccess({
      publicKey: site.publicKey,
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.9',
      userAgent: BROWSER,
    });

    const day = todayInTimeZone('Asia/Tokyo');
    await withConnection((connection) => rollupAnalytics(connection, { from: day, to: day }));

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: day,
      to: day,
      source: null,
    });

    expect(points.find((point) => point.metric === 'pageviews')?.value).toBe(1);
  });

  it('境目をまたぐアクセスが別の日に入る', async () => {
    // JST では 9/2 23:30Z（= 9/3 08:30）と 9/3 00:30Z（= 9/3 09:30）が同じ日。
    // UTC では別の日になる。畳み方がタイムゾーンで変わることを確かめる。
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    const site = await makeSite();
    await withConnection(async (connection) => {
      for (const at of ['2026-09-02T23:30:00Z', '2026-09-03T00:30:00Z']) {
        await connection.db
          .insertInto('access_logs')
          .values({
            id: uuidv7(),
            site_id: site.id,
            occurred_at: at,
            path: '/',
            visitor_hash: `h-${at}`,
            device: 'desktop',
          })
          .execute();
      }
    });

    await withConnection((connection) =>
      rollupAnalytics(connection, { from: '2026-09-03', to: '2026-09-03' }),
    );

    const points = await listAnalytics(admin, {
      siteId: site.id,
      from: '2026-09-03',
      to: '2026-09-03',
      source: null,
    });

    expect(points.find((point) => point.metric === 'pageviews')?.value).toBe(2);
  });
});

describe('計測タグを出すためのサイト一覧', () => {
  it('登録したサイトがすぐ一覧に出る', async () => {
    // 計測タグは絞り込みを待たずに出す。出ないと、
    // 登録したサイトが見当たらないように見える。
    const site = await makeSite();

    const tracked = await listTrackedSites(admin, {});

    expect(tracked.map((entry) => entry.id)).toContain(site.id);
  });

  it('公開キーを添えて返す', async () => {
    // これが無いと計測タグを組み立てられない。
    const site = await makeSite();

    const tracked = await listTrackedSites(admin, {});

    expect(tracked.find((entry) => entry.id === site.id)?.publicKey).toBe(site.publicKey);
  });

  it('登録したサイトを取りこぼさない', async () => {
    const first = await makeSite();
    const second = await makeSite();

    const tracked = await listTrackedSites(admin, {});

    expect(tracked.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('site.read を持たないユーザーは取れない', async () => {
    // 公開キーは Site の一覧 API では返していない値。
    const outsider = await contextFor('viewer');
    await withConnection((connection) =>
      connection.db
        .deleteFrom('user_roles')
        .where('user_id', '=', outsider.identity?.userId ?? '')
        .execute(),
    );
    const stripped = { ...outsider, permissions: new Set<string>() } as typeof outsider;

    await expect(listTrackedSites(stripped, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('サイトが無ければ空を返す', async () => {
    const tracked = await listTrackedSites(admin, {});

    expect(tracked).toEqual([]);
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

/**
 * ロールアップの再設計（028 設計 §5.2 / §5.3.1 / §5.3.2、受け入れ条件 #7〜#19）。
 *
 * セッション：同一 (site, 集計日, visitor_hash) の PV を時刻順に並べ、直前から 30 分を超えて空いたら新しいセッション。
 * ちょうど 30 分は同じセッション。日をまたがない。Bot はセッション化しない。
 */
describe('セッションと指標', () => {
  afterEach(() => {
    delete process.env['TORIFUNE_TIMEZONE'];
    resetTimeZoneWarning();
  });

  /** #7 */
  it('10 分間隔の 3 PV は 1 セッションで、滞在の標本が 2 つ', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('12:00'), visitor: 'v1', path: '/a' },
      { at: at('12:10'), visitor: 'v1', path: '/b' },
      { at: at('12:20'), visitor: 'v1', path: '/c' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'sessions')).toBe(1);
    expect(valueOf(points, 'bounces')).toBe(0);
    expect(valueOf(points, 'dwell_samples')).toBe(2);
    expect(valueOf(points, 'dwell_ms')).toBe(1_200_000);
  });

  /** #8。境界：ちょうど 30 分は同じセッション。 */
  it('ちょうど 30 分空いた 2 PV は同じセッション', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('12:00'), visitor: 'v1' },
      { at: at('12:30:00'), visitor: 'v1' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'sessions')).toBe(1);
    expect(valueOf(points, 'dwell_samples')).toBe(1);
    expect(valueOf(points, 'dwell_ms')).toBe(1_800_000);
  });

  /** #9。30 分 + 1 秒で別セッション。どちらも 1 PV なので直帰。 */
  it('30 分 + 1 秒空いた 2 PV は別セッションで、両方が直帰', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('12:00'), visitor: 'v1' },
      { at: at('12:30:01'), visitor: 'v1' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'sessions')).toBe(2);
    expect(valueOf(points, 'bounces')).toBe(2);
    expect(valueOf(points, 'dwell_samples')).toBe(0);
    expect(valueOf(points, 'dwell_ms')).toBe(0);
    // 訪問者は同じ人。
    expect(valueOf(points, 'visitors')).toBe(1);
  });

  /** #10。日をまたがない（ソルトの回り方に依存せず、SQL で集計日をパーティションに含める）。 */
  it('タイムゾーンの日付境界をまたぐ 2 PV は各日で別のセッション', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    const site = await makeSite();
    // 23:50 JST（= 14:50Z）と翌 00:05 JST（= 15:05Z）。間隔は 15 分だが日が違う。
    await insertLogs(site.id, [
      { at: '2026-06-10T14:50:00Z', visitor: 'v1' },
      { at: '2026-06-10T15:05:00Z', visitor: 'v1' },
    ]);

    await rollup(DAY, NEXT_DAY);
    const first = await corePoints(site.id, DAY);
    const second = await corePoints(site.id, NEXT_DAY);

    expect(valueOf(first, 'sessions')).toBe(1);
    expect(valueOf(second, 'sessions')).toBe(1);
    expect(valueOf(first, 'dwell_samples')).toBe(0);
    expect(valueOf(second, 'dwell_samples')).toBe(0);
  });

  /** #11 */
  it('1 PV の訪問者 2 人と 3 PV の訪問者 1 人', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('09:00'), visitor: 'v1' },
      { at: at('09:00'), visitor: 'v2' },
      { at: at('10:00'), visitor: 'v3', path: '/a' },
      { at: at('10:05'), visitor: 'v3', path: '/b' },
      { at: at('10:10'), visitor: 'v3', path: '/c' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'pageviews')).toBe(5);
    expect(valueOf(points, 'visitors')).toBe(3);
    expect(valueOf(points, 'sessions')).toBe(3);
    expect(valueOf(points, 'bounces')).toBe(2);
  });

  /** #12。Bot は bot_* にだけ数え、他の指標に現れない。 */
  it('Bot は bot_pageviews / bot_visitors にだけ数える', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('03:00'), visitor: 'b1', device: 'bot', path: '/bot-only', referrer: 'bot.example' },
      { at: at('03:01'), visitor: 'b1', device: 'bot', path: '/bot-only', referrer: 'bot.example' },
      { at: at('03:02'), visitor: 'b2', device: 'bot', path: '/bot-only', referrer: 'bot.example' },
      { at: at('03:03'), visitor: 'b2', device: 'bot', path: '/bot-only', referrer: 'bot.example' },
      { at: at('10:00'), visitor: 'h1', device: 'desktop', path: '/', referrer: null },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'bot_pageviews')).toBe(4);
    expect(valueOf(points, 'bot_visitors')).toBe(2);
    expect(valueOf(points, 'pageviews')).toBe(1);
    expect(valueOf(points, 'visitors')).toBe(1);
    expect(valueOf(points, 'sessions')).toBe(1);
  });

  /** #12 */
  it('Bot は時間帯・デバイス・パス・参照元・ランディングに現れない', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('03:00'), visitor: 'b1', device: 'bot', path: '/bot-only', referrer: 'bot.example' },
      { at: at('03:02'), visitor: 'b2', device: 'bot', path: '/bot-only', referrer: 'bot.example' },
      { at: at('10:00'), visitor: 'h1', device: 'desktop', path: '/', referrer: null },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(keysOf(points, 'pageviews_hour')).toEqual(['10']);
    expect(keysOf(points, 'pageviews_device')).toEqual(['desktop']);
    expect(keysOf(points, 'path_pageviews')).toEqual(['/']);
    expect(keysOf(points, 'path_visitors')).toEqual(['/']);
    expect(keysOf(points, 'landing')).toEqual(['/']);
    expect(keysOf(points, 'referrer')).toEqual(['(direct)']);
    expect(points.some((point) => point.key === '/bot-only')).toBe(false);
    expect(points.some((point) => point.key === 'bot.example')).toBe(false);
  });

  /** #13。「集計したが 0 だった」と「集計していない」を区別する。 */
  it('Bot の PV しか無い日は、人の指標が 0 で出る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('03:00'), visitor: 'b1', device: 'bot' },
      { at: at('03:01'), visitor: 'b1', device: 'bot' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'pageviews')).toBe(0);
    expect(valueOf(points, 'visitors')).toBe(0);
    expect(valueOf(points, 'sessions')).toBe(0);
    expect(valueOf(points, 'bounces')).toBe(0);
    expect(valueOf(points, 'bot_pageviews')).toBeGreaterThan(0);
  });

  /** §5.3.2 出力の規則。key = '' の 8 指標は、生ログが 1 行でもあれば 0 でも出す。 */
  it('生ログが 1 件でもあれば key 無しの 8 指標がすべて出る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    const keyless = points.filter((point) => point.key === '').map((point) => point.metric);
    expect(keyless.sort()).toEqual(
      [
        'pageviews',
        'visitors',
        'sessions',
        'bounces',
        'dwell_ms',
        'dwell_samples',
        'bot_pageviews',
        'bot_visitors',
      ].sort(),
    );
    expect(valueOf(points, 'bot_pageviews')).toBe(0);
    expect(valueOf(points, 'bot_visitors')).toBe(0);
  });

  /** #14。時間帯も日付も TORIFUNE_TIMEZONE で区切る。 */
  it('時間帯の key と集計日が運用タイムゾーンで決まる', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    const site = await makeSite();
    // 06-10 23:30Z = 06-11 08:30 JST。
    await insertLogs(site.id, [{ at: '2026-06-10T23:30:00Z', visitor: 'v1' }]);

    await rollup(DAY, NEXT_DAY);
    const first = await corePoints(site.id, DAY);
    const second = await corePoints(site.id, NEXT_DAY);

    expect(first).toEqual([]);
    expect(valueOf(second, 'pageviews_hour', '08')).toBe(1);
    expect(keysOf(second, 'pageviews_hour')).toEqual(['08']);
    expect(second.every((point) => point.metricDate === NEXT_DAY)).toBe(true);
  });

  /** #15。値 0 の key は出さない。 */
  it('デバイス別 PV は、あるデバイスだけ出る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', device: 'desktop' },
      { at: at('10:00'), visitor: 'v2', device: 'desktop' },
      { at: at('10:00'), visitor: 'v3', device: 'mobile' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'pageviews_device', 'desktop')).toBe(2);
    expect(valueOf(points, 'pageviews_device', 'mobile')).toBe(1);
    expect(valueOf(points, 'pageviews_device', 'tablet')).toBeUndefined();
    expect(keysOf(points, 'pageviews_device')).toEqual(['desktop', 'mobile']);
  });

  /** #16。参照元はセッション最初の PV のもの。NULL は '(direct)'。 */
  it('セッション最初の PV の参照元が無ければ (direct)', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', path: '/', referrer: null },
      { at: at('10:05'), visitor: 'v1', path: '/b', referrer: 'google.com' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'referrer', '(direct)')).toBe(1);
    expect(valueOf(points, 'referrer', 'google.com')).toBeUndefined();
    expect(keysOf(points, 'referrer')).toEqual(['(direct)']);
  });

  /** #17。ランディングは最初の PV。滞在は次の PV までの間隔で、最後の PV は標本に入らない。 */
  it('/a → /b のセッションはランディングが /a で、滞在の標本は /a だけ', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', path: '/a' },
      { at: at('10:05'), visitor: 'v1', path: '/b' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'landing', '/a')).toBe(1);
    expect(valueOf(points, 'landing', '/b')).toBeUndefined();
    expect(valueOf(points, 'path_pageviews', '/a')).toBe(1);
    expect(valueOf(points, 'path_pageviews', '/b')).toBe(1);
    expect(valueOf(points, 'path_visitors', '/a')).toBe(1);
    expect(valueOf(points, 'path_visitors', '/b')).toBe(1);
    expect(valueOf(points, 'path_dwell_samples', '/a')).toBe(1);
    expect(valueOf(points, 'path_dwell_ms', '/a')).toBe(300_000);
    expect(valueOf(points, 'path_dwell_samples', '/b')).toBeUndefined();
    expect(valueOf(points, 'path_dwell_ms', '/b')).toBeUndefined();
  });

  /** #18。直帰率（パス別）= path_bounces / landing。 */
  it('/a だけ見て離脱したセッションは path_bounces と bounces に数える', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1', path: '/a' }]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'path_bounces', '/a')).toBe(1);
    expect(valueOf(points, 'landing', '/a')).toBe(1);
    expect(valueOf(points, 'bounces')).toBe(1);
  });

  /** #19。参照元タブの「訪問者 / 直帰率」列のため。 */
  it('同じ参照元から始まる 2 セッション（同一訪問者、1 つは直帰）', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', path: '/a', referrer: 'www.example.com' },
      { at: at('10:05'), visitor: 'v1', path: '/b', referrer: null },
      // 30 分を超えて空くので別セッション。1 PV なので直帰。
      { at: at('12:00'), visitor: 'v1', path: '/a', referrer: 'www.example.com' },
    ]);

    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'referrer', 'www.example.com')).toBe(2);
    expect(valueOf(points, 'referrer_visitors', 'www.example.com')).toBe(1);
    expect(valueOf(points, 'referrer_bounces', 'www.example.com')).toBe(1);
    expect(valueOf(points, 'sessions')).toBe(2);
  });

  /** #7〜#19 の前提。別サイトの生ログは混ざらない。 */
  it('別のサイトの生ログは混ざらない', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(mine.id, [{ at: at('10:00'), visitor: 'v1', path: '/mine' }]);
    await insertLogs(other.id, [
      { at: at('10:00'), visitor: 'v1', path: '/other' },
      { at: at('10:05'), visitor: 'v2', path: '/other' },
    ]);

    await rollup(DAY);
    const points = await corePoints(mine.id, DAY);

    expect(valueOf(points, 'pageviews')).toBe(1);
    expect(valueOf(points, 'path_pageviews', '/other')).toBeUndefined();
    expect(keysOf(points, 'path_pageviews')).toEqual(['/mine']);
  });
});

/**
 * 冪等な差し替え（028 設計 §5.3.3、受け入れ条件 #20〜#23）。
 *
 * (site, day) ごとに `source = 'core'` を DELETE → INSERT する。
 * upsert だけでは、前回あって今回無くなった key の行が残る。
 */
describe('冪等な差し替え', () => {
  function shapeOf(points: readonly AnalyticsPoint[]) {
    return points
      .map(({ metricDate, source, metric, key, value }) => ({
        metricDate,
        source,
        metric,
        key,
        value,
      }))
      .sort((a, b) => `${a.metric} ${a.key}`.localeCompare(`${b.metric} ${b.key}`));
  }

  const LOGS: readonly LogInput[] = [
    { at: at('09:00'), visitor: 'v1', path: '/a', referrer: 'www.example.com', device: 'desktop' },
    { at: at('09:05'), visitor: 'v1', path: '/b', device: 'desktop' },
    { at: at('10:00'), visitor: 'v2', path: '/a', device: 'mobile' },
    { at: at('11:00'), visitor: 'b1', path: '/a', device: 'bot' },
  ];

  /** #20 */
  it('同じ期間を 2 回ロールアップしても行数と値が変わらない', async () => {
    const site = await makeSite();
    await insertLogs(site.id, LOGS);

    await rollup(DAY);
    const first = shapeOf(await corePoints(site.id, DAY));
    await rollup(DAY);
    const second = shapeOf(await corePoints(site.id, DAY));

    // key 付きの行があることを確かめてから比べる（空同士の一致では意味が無い）。
    expect(first.some((point) => point.metric === 'path_pageviews' && point.key === '/a')).toBe(
      true,
    );
    expect(second).toEqual(first);
  });

  /** #21。upsert では残ってしまう行が消える。 */
  it('消えたパスの生ログを再ロールアップすると、そのパスの行が消える', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', path: '/keep' },
      { at: at('10:00'), visitor: 'v2', path: '/gone' },
    ]);
    await rollup(DAY);
    expect(valueOf(await corePoints(site.id, DAY), 'path_pageviews', '/gone')).toBe(1);

    await withConnection((connection) =>
      connection.db.deleteFrom('access_logs').where('path', '=', '/gone').execute(),
    );
    await rollup(DAY);
    const points = await corePoints(site.id, DAY);

    expect(points.filter((point) => point.key === '/gone')).toEqual([]);
    expect(valueOf(points, 'path_pageviews', '/keep')).toBe(1);
    expect(valueOf(points, 'pageviews')).toBe(1);
  });

  /** #22。`source <> 'core'`（Plugin の値）には触らない。 */
  it('Plugin が入れた行は同じ日をロールアップしても消えず変わらない', async () => {
    const site = await makeSite();
    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: DAY,
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 999,
    });
    await insertLogs(site.id, LOGS);

    await rollup(DAY);
    await rollup(DAY);

    const plugin = await listAnalytics(admin, {
      siteId: site.id,
      from: DAY,
      to: DAY,
      source: 'com.example.ga',
    });
    expect(plugin).toHaveLength(1);
    expect(plugin[0]?.metric).toBe('pageviews');
    expect(plugin[0]?.value).toBe(999);
  });

  /** #23。消された生ログの日を 0 で上書きしない。 */
  it('生ログが無い日には行を書かず、既にある行も消さない', async () => {
    const site = await makeSite();
    // DAY の生ログはもう無いが、集計値だけ残っている状態。
    await withConnection((connection) =>
      connection.db
        .insertInto('analytics')
        .values({
          site_id: site.id,
          metric_date: DAY,
          source: 'core',
          metric: 'pageviews',
          value: 7,
        })
        .execute(),
    );
    await insertLogs(site.id, [{ at: at('10:00', NEXT_DAY), visitor: 'v1' }]);

    await rollup(DAY, NEXT_DAY);

    const kept = await corePoints(site.id, DAY);
    expect(kept).toHaveLength(1);
    expect(valueOf(kept, 'pageviews')).toBe(7);
    expect(valueOf(await corePoints(site.id, NEXT_DAY), 'pageviews')).toBe(1);
  });
});

/**
 * 最終受信の書き戻し（028 設計 §5.3.4、受け入れ条件 #24 / #25）。
 *
 * collect のたびに UPDATE せず、rollup が `max(occurred_at)`（Bot 含む）を `GREATEST` で書き戻す。
 */
describe('最終受信', () => {
  /** #24 */
  it('ロールアップ前は NULL', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    expect(await lastSeenOf(site.id)).toBeNull();
  });

  /** #24。Bot も含める（届いているかの確認が目的）。 */
  it('ロールアップ後、範囲内の max(occurred_at)（Bot 含む）になる', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', device: 'desktop' },
      { at: at('11:00'), visitor: 'b1', device: 'bot' },
      // 範囲外。
      { at: at('12:00', NEXT_DAY), visitor: 'v2' },
    ]);

    await rollup(DAY);

    expect((await lastSeenOf(site.id))?.toISOString()).toBe('2026-06-10T11:00:00.000Z');
  });

  /** #25。過去を流し直しても巻き戻らない。 */
  it('新しい日を先に集計してから古い日を集計しても巻き戻らない', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1' },
      { at: at('09:00', NEXT_DAY), visitor: 'v2' },
    ]);

    await rollup(NEXT_DAY);
    expect((await lastSeenOf(site.id))?.toISOString()).toBe('2026-06-11T09:00:00.000Z');

    await rollup(DAY);

    expect((await lastSeenOf(site.id))?.toISOString()).toBe('2026-06-11T09:00:00.000Z');
  });

  /** サイトごとに独立。 */
  it('他のサイトの受信で更新されない', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(other.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await rollup(DAY);

    expect(await lastSeenOf(mine.id)).toBeNull();
    expect(await lastSeenOf(other.id)).not.toBeNull();
  });
});

/**
 * `RollupResult` と Event（028 設計 §5.3.5、受け入れ条件 #26）。
 *
 * `days` = 書いた (site, day) の数、`points` = 書いた行数。`analytics.rolledUp` は 1 回だけ。
 */
describe('RollupResult と Event', () => {
  afterEach(() => {
    resetEventHandlers();
  });

  /** #26 */
  it('days は書いた (site, day) の数、points は書いた行数', async () => {
    const first = await makeSite();
    const second = await makeSite();
    await insertLogs(first.id, [
      { at: at('10:00'), visitor: 'v1', path: '/a' },
      { at: at('10:05'), visitor: 'v1', path: '/b' },
      { at: at('10:00', NEXT_DAY), visitor: 'v2', path: '/a' },
    ]);
    await insertLogs(second.id, [{ at: at('10:00'), visitor: 'v1', path: '/a' }]);

    const result = await rollup(DAY, NEXT_DAY);

    expect(result.days).toBe(3);
    const written = await listAnalytics(admin, {
      siteId: null,
      from: DAY,
      to: NEXT_DAY,
      source: 'core',
    });
    expect(result.points).toBe(written.length);
    expect(result.points).toBeGreaterThan(3);
  });

  /** #26 */
  it('analytics.rolledUp が 1 回だけ発火し、from / to / points を載せる', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1' },
      { at: at('10:00', NEXT_DAY), visitor: 'v2' },
    ]);
    const payloads: unknown[] = [];
    subscribe('analytics.rolledUp', (payload) => void payloads.push(payload));

    const result = await rollup(DAY, NEXT_DAY);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({ from: DAY, to: NEXT_DAY, points: result.points });
  });

  /** 生ログが無ければ何も書かず、days / points は 0。 */
  it('生ログが無ければ 0', async () => {
    await makeSite();

    const result = await rollup(DAY);

    expect(result).toEqual({ days: 0, points: 0 });
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
