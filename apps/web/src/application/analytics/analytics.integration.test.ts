import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getAnalyticsStatus,
  getTodayAnalytics,
  listAnalytics,
  listAnalyticsBreakdown,
  listAnalyticsPage,
  listTopPathsPage,
  listTrackedSites,
  recordAnalytics,
} from '@/application/analytics/analytics-use-cases';
import { collectAccess, resetDailySalts } from '@/application/analytics/collect';
import {
  analyticsTimeZone,
  resetAnalyticsTimeZoneForTests,
  resetTimeZoneWarning,
  resolveAnalyticsTimeZone,
} from '@/application/analytics/timezone';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';
import { pruneAccessLogs, rollupAnalytics } from '@/application/analytics/rollup';
import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers, subscribe } from '@/application/events';
import { ROLLUP_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { createSite, regenerateSitePublicKey } from '@/application/site/site-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import {
  CORE_SOURCE,
  isValidBreakdownKey,
  KEYLESS_CORE_METRICS,
  type AnalyticsPoint,
} from '@/domain/analytics/analytics';
import { daysAgoInTimeZone, todayInTimeZone } from '@/domain/analytics/day';
import { summarize } from '@/domain/analytics/summary';
import { NotFoundError, ValidationError } from '@/domain/repository';
import {
  analyticsRepository,
  TODAY_AGGREGATION_TIMEOUT_MS,
  type DailyBreakdownRow,
} from '@/infrastructure/analytics-repository';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
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

async function makeSite(
  overrides: { readonly status?: 'active' | 'paused' | 'archived'; readonly url?: string } = {},
): Promise<{ id: string; publicKey: string }> {
  const site = await createSite(admin, {
    name: `site-${Math.random().toString(36).slice(2, 8)}`,
    url: overrides.url ?? 'https://example.com',
    description: '',
    status: overrides.status ?? 'active',
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

/**
 * 制御文字（U+0001）を含むパス。
 *
 * 028 の検証で見つかった指摘：受け口がこれをそのまま保存すると、ロールアップが
 * この key で `path_pageviews` 等を書き、画面がその key を `listAnalyticsBreakdown` の
 * `keys` へ渡したときに `isValidBreakdownKey` で弾かれて「ページ」タブが落ちる。
 *
 * NUL（U+0000）は PostgreSQL の text 型に入らないので、直接 INSERT する検証には U+0001 を使う。
 */
const CONTROL_PATH = `/x${String.fromCharCode(0x01)}y`;

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

  /**
   * 028 設計 §6.5 / 受け入れ条件 #42。
   * 画面のサイト選択と受信状況のために `url` / `status` / `analyticsLastSeenAt` を足す。
   */

  /** #42 */
  it('url と status を添えて返す', async () => {
    const site = await makeSite({ url: 'https://tracked.example.com', status: 'paused' });

    const tracked = await listTrackedSites(admin, {});
    const entry = tracked.find((row) => row.id === site.id);

    expect(entry?.url).toBe('https://tracked.example.com');
    expect(entry?.status).toBe('paused');
  });

  /** #42。計測したことが無いサイトは null（画面で「（未設置）」を付ける）。 */
  it('計測したことが無いサイトの analyticsLastSeenAt は null', async () => {
    const site = await makeSite();

    const tracked = await listTrackedSites(admin, {});

    expect(tracked.find((row) => row.id === site.id)?.analyticsLastSeenAt).toBeNull();
  });

  /** #42。ロールアップ後は最終受信が入る。 */
  it('ロールアップ後は analyticsLastSeenAt に最終受信が入る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);
    await rollup(DAY);

    const tracked = await listTrackedSites(admin, {});

    expect(tracked.find((row) => row.id === site.id)?.analyticsLastSeenAt?.toISOString()).toBe(
      '2026-06-10T10:00:00.000Z',
    );
  });

  /** #42。計測タグを貼ったままの archived サイトの受信状況も見られる。 */
  it('archived のサイトも返す', async () => {
    const archived = await makeSite({ status: 'archived' });

    const tracked = await listTrackedSites(admin, {});
    const entry = tracked.find((row) => row.id === archived.id);

    expect(entry).toBeDefined();
    expect(entry?.status).toBe('archived');
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

  /**
   * 制御文字を含むパスは記録しない（018 設計 §3.2 の正規化規則、028 の検証で追記）。
   * 入口で落とせば、ロールアップにも画面にも制御文字入りの key が流れない。
   */
  it('制御文字を含むパスでは ok: false になる', async () => {
    const site = await makeSite();

    const outcome = await collectAccess({
      publicKey: site.publicKey,
      path: CONTROL_PATH,
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    expect(outcome.ok).toBe(false);
  });

  it('制御文字を含むパスでは access_logs が増えない', async () => {
    const site = await makeSite();

    await collectAccess({
      publicKey: site.publicKey,
      path: CONTROL_PATH,
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').select('id').execute(),
    );
    expect(rows).toHaveLength(0);
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

  /**
   * 028 設計 §6.3。上位ページは生ログではなく集計値（`path_pageviews`）から引く。
   * 集計を流してから読む。
   */
  it('上位ページを出す', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/popular', '203.0.113.1');
    await hit(site.publicKey, '/popular', '203.0.113.2');
    await hit(site.publicKey, '/rare', '203.0.113.3');

    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );

    const top = await listTopPathsPage(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
      page: 1,
      perPage: 10,
    });

    expect(top.items.map((row) => row.path)).toEqual(['/popular', '/rare']);
    expect(top.items[0]?.pageviews).toBe(2);
    expect(top.total).toBe(2);
  });

  /** 028 設計 §6.3 / 影響範囲。生ログを読まなくなるため、集計を流すまで上位ページは出ない。 */
  it('集計を流す前は上位ページが出ない', async () => {
    const site = await makeSite();
    await hit(site.publicKey, '/popular', '203.0.113.1');

    const top = await listTopPathsPage(admin, {
      siteId: site.id,
      from: today(),
      to: today(),
      source: null,
      page: 1,
      perPage: 10,
    });

    expect(top.items).toEqual([]);
    expect(top.total).toBe(0);
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
      .sort((a, b) => `${a.metric}\u0000${a.key}`.localeCompare(`${b.metric}\u0000${b.key}`));
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
 * 制御文字を含むパスが**既に生ログに入っている**場合（028 の検証で追記）。
 *
 * 受け口で落とす前に届いた行が残っていても、ロールアップは制御文字入りのパスを
 * key に出さない（`aggregateDailyBreakdown` で除外）。出すと、画面が `keys` へ渡したときに
 * 422 になり「ページ」タブが落ちる。**その PV 自体は正常な PV として数える**
 * （key 無しの `pageviews` 等には入る）。
 *
 * 生ログ（同じ日）：
 * - v1: 10:00 制御文字パス → 10:05 `/ok`（制御文字パスがランディングで、滞在の標本を持つ）
 * - v2: 11:00 制御文字パス だけ（制御文字パスが直帰）
 * - v3: 12:00 `/ok` だけ
 */
describe('制御文字を含むパスの生ログ', () => {
  const PATH_METRICS = [
    'path_pageviews',
    'path_visitors',
    'landing',
    'path_bounces',
    'path_dwell_ms',
    'path_dwell_samples',
  ] as const;

  async function seedWithControlPath(siteId: string): Promise<void> {
    await insertLogs(siteId, [
      { at: at('10:00'), visitor: 'v1', path: CONTROL_PATH },
      { at: at('10:05'), visitor: 'v1', path: '/ok' },
      { at: at('11:00'), visitor: 'v2', path: CONTROL_PATH },
      { at: at('12:00'), visitor: 'v3', path: '/ok' },
    ]);
    await rollup(DAY);
  }

  it.each(PATH_METRICS)('%s の key に制御文字を含むパスが現れない', async (metric) => {
    const site = await makeSite();
    await seedWithControlPath(site.id);

    const points = await corePoints(site.id, DAY);

    expect(keysOf(points, metric)).not.toContain(CONTROL_PATH);
  });

  /** どの指標でも、書いた key はすべて内訳キーとして妥当。 */
  it('書かれた key はすべて isValidBreakdownKey を満たす', async () => {
    const site = await makeSite();
    await seedWithControlPath(site.id);

    const points = await corePoints(site.id, DAY);

    expect(points.length).toBeGreaterThan(0);
    expect(points.filter((point) => !isValidBreakdownKey(point.key))).toEqual([]);
  });

  /** 同じ日の正常なパスは従来どおり出る。 */
  it('同じ日の正常なパスは path_pageviews に出る', async () => {
    const site = await makeSite();
    await seedWithControlPath(site.id);

    const points = await corePoints(site.id, DAY);

    expect(keysOf(points, 'path_pageviews')).toEqual(['/ok']);
    expect(valueOf(points, 'path_pageviews', '/ok')).toBe(2);
  });

  /** 制御文字入りの PV も PV として数える（key 無しの指標には入る）。 */
  it('制御文字を含むパスの PV も pageviews には数える', async () => {
    const site = await makeSite();
    await seedWithControlPath(site.id);

    const points = await corePoints(site.id, DAY);

    expect(valueOf(points, 'pageviews')).toBe(4);
    expect(valueOf(points, 'visitors')).toBe(3);
  });

  /**
   * 画面の経路の再現。「ページ」タブは `path_pageviews` の内訳で読んだ key を
   * そのまま `keys` に渡して `path_visitors` 等を引く。制御文字入りの生ログがある期間でも、
   * この操作が例外にならない。
   */
  it('path_pageviews の key を keys に渡して path_visitors を引いても例外にならない', async () => {
    const site = await makeSite();
    await seedWithControlPath(site.id);
    const base = { siteId: site.id, from: DAY, to: DAY, source: null, page: 1, perPage: 50 };

    const pages = await listAnalyticsBreakdown(admin, { ...base, metric: 'path_pageviews' });
    const keys = pages.items.map((item) => item.key);

    await expect(
      listAnalyticsBreakdown(admin, { ...base, metric: 'path_visitors', keys }),
    ).resolves.toEqual({ items: [{ key: '/ok', value: 2 }], total: 1 });
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

  /**
   * UUID でない `siteId` は空結果（028 の検証で追記）。
   * `uuid` へのキャストで PG エラーになり API が 500 を返していた。`findSiteLastSeen` と同じ扱いにする。
   */
  it('UUID でない siteId なら空を返す', async () => {
    // 同じ期間に本物の行があっても、その ID に合う行は無い。
    const site = await makeSite();
    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: DAY,
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 1,
    });

    await expect(
      listAnalytics(admin, { siteId: 'not-a-uuid', from: DAY, to: DAY, source: null }),
    ).resolves.toEqual([]);
  });

  /**
   * 絞り込みの追加（028 設計 §6.1、受け入れ条件 #27〜#29）。
   *
   * 画面は必ず `key: ''` と `metrics` を渡す。渡さないとパス別の行を全部読むことになる。
   */
  describe('絞り込み', () => {
    /** Plugin の値として key 付き・key 無しを混ぜて入れる。 */
    async function seedMixed(siteId: string): Promise<void> {
      const rows = [
        { metric: 'pageviews', key: '', value: 10 },
        { metric: 'visitors', key: '', value: 5 },
        { metric: 'path_pageviews', key: '/a', value: 7 },
        { metric: 'path_pageviews', key: '/b', value: 3 },
      ];
      for (const row of rows) {
        await recordAnalytics(admin, {
          siteId,
          metricDate: DAY,
          source: 'com.example.ga',
          ...row,
        });
      }
    }

    /** #27 */
    it("key: '' でキー付きの行を返さない", async () => {
      const site = await makeSite();
      await seedMixed(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: DAY,
        source: null,
        key: '',
      });

      expect(points.every((point) => point.key === '')).toBe(true);
      expect(points.map((point) => point.metric).sort()).toEqual(['pageviews', 'visitors']);
    });

    /** #27。key を指定すると、その key の行だけ。 */
    it('key を指定するとその key の行だけを返す', async () => {
      const site = await makeSite();
      await seedMixed(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: DAY,
        source: null,
        key: '/a',
      });

      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ metric: 'path_pageviews', key: '/a', value: 7 });
    });

    /** #27。省略は既存の挙動（全行）。 */
    it('key を省略すると key 付きの行も返す', async () => {
      const site = await makeSite();
      await seedMixed(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: DAY,
        source: null,
      });

      expect(points).toHaveLength(4);
      expect(points.filter((point) => point.key !== '')).toHaveLength(2);
    });

    /** #28 */
    it('metrics で指標を絞ると他の指標を返さない', async () => {
      const site = await makeSite();
      await seedMixed(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: DAY,
        source: null,
        metrics: ['pageviews'],
      });

      expect(points).toHaveLength(1);
      expect(points[0]?.metric).toBe('pageviews');
    });

    /** #28。複数の指標を並べて絞れる。 */
    it('metrics に複数並べると、そのどれかに当たる行だけを返す', async () => {
      const site = await makeSite();
      await seedMixed(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: DAY,
        source: null,
        metrics: ['pageviews', 'visitors'],
      });

      expect(points.map((point) => point.metric).sort()).toEqual(['pageviews', 'visitors']);
    });

    /** #28。境界：20 個までは受け付ける。 */
    it('metrics は 20 個まで受け付ける', async () => {
      const site = await makeSite();
      const metrics = Array.from({ length: 20 }, (_, index) => `metric_${index}`);

      await expect(
        listAnalytics(admin, { siteId: site.id, from: DAY, to: DAY, source: null, metrics }),
      ).resolves.toEqual([]);
    });

    /** #28。境界：21 個は 422。 */
    it('metrics が 21 個以上なら拒否する', async () => {
      const site = await makeSite();
      const metrics = Array.from({ length: 21 }, (_, index) => `metric_${index}`);

      await expect(
        listAnalytics(admin, { siteId: site.id, from: DAY, to: DAY, source: null, metrics }),
      ).rejects.toThrow(ValidationError);
    });

    /** #28。各要素は指標名として妥当でなければならない。 */
    it('metrics に不正な指標名があれば拒否する', async () => {
      const site = await makeSite();

      await expect(
        listAnalytics(admin, {
          siteId: site.id,
          from: DAY,
          to: DAY,
          source: null,
          metrics: ['pageviews', 'Page Views'],
        }),
      ).rejects.toThrow(ValidationError);
    });

    /** #27 + #28。画面が渡す組み合わせ。 */
    it("metrics と key: '' を同時に渡せる", async () => {
      const site = await makeSite();
      await seedMixed(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: DAY,
        source: null,
        metrics: ['pageviews', 'path_pageviews'],
        key: '',
      });

      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({ metric: 'pageviews', key: '' });
    });

    /** #27 の前提。別サイトの同じ key の行が混ざらない。 */
    it('siteId を指定すると他サイトの同じ key の行は返さない', async () => {
      const mine = await makeSite();
      const other = await makeSite();
      await seedMixed(mine.id);
      await seedMixed(other.id);

      const points = await listAnalytics(admin, {
        siteId: mine.id,
        from: DAY,
        to: DAY,
        source: null,
        key: '/a',
      });

      expect(points).toHaveLength(1);
      expect(points[0]?.siteId).toBe(mine.id);
    });
  });

  /**
   * 並び（028 設計 §6.1、受け入れ条件 #29）。
   *
   * `(metric_date, source, metric, key)` で一意に並ぶ。Pagination のページ境界で
   * 行が重複・欠落しないための前提。
   */
  describe('並び', () => {
    /** 並び順が決まる 5 行。挿入は意図的にバラバラの順にする。 */
    const ROWS = [
      { metricDate: NEXT_DAY, source: 'com.example.a', metric: 'pageviews', key: '' },
      { metricDate: DAY, source: 'com.example.a', metric: 'path_pageviews', key: '/b' },
      { metricDate: DAY, source: 'com.example.b', metric: 'pageviews', key: '' },
      { metricDate: DAY, source: 'com.example.a', metric: 'pageviews', key: '' },
      { metricDate: DAY, source: 'com.example.a', metric: 'path_pageviews', key: '/a' },
    ] as const;

    /** (metric_date, source, metric, key) 昇順。 */
    const EXPECTED_ORDER = [
      `${DAY} com.example.a pageviews `,
      `${DAY} com.example.a path_pageviews /a`,
      `${DAY} com.example.a path_pageviews /b`,
      `${DAY} com.example.b pageviews `,
      `${NEXT_DAY} com.example.a pageviews `,
    ];

    function shape(point: AnalyticsPoint): string {
      return `${point.metricDate} ${point.source} ${point.metric} ${point.key}`;
    }

    async function seedRows(siteId: string): Promise<void> {
      for (const row of ROWS) {
        await recordAnalytics(admin, { siteId, value: 1, ...row });
      }
    }

    /** #29 */
    it('listAnalytics が (metric_date, source, metric, key) の順で返す', async () => {
      const site = await makeSite();
      await seedRows(site.id);

      const points = await listAnalytics(admin, {
        siteId: site.id,
        from: DAY,
        to: NEXT_DAY,
        source: null,
      });

      expect(points.map(shape)).toEqual(EXPECTED_ORDER);
    });

    /** #29。key 付きの行を混ぜて perPage: 2 でページを切っても、重複も欠落も無い。 */
    it('listAnalyticsPage のページ境界で行が重複・欠落しない', async () => {
      const site = await makeSite();
      await seedRows(site.id);

      const query = { siteId: site.id, from: DAY, to: NEXT_DAY, source: null, perPage: 2 };
      const pages = await Promise.all(
        [1, 2, 3].map((page) => listAnalyticsPage(admin, { ...query, page })),
      );

      expect(pages.map((page) => page.total)).toEqual([5, 5, 5]);
      expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
      expect(pages.flatMap((page) => page.items.map(shape))).toEqual(EXPECTED_ORDER);
    });
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
    // 028 設計 §6.3。上位ページは集計値から引くので、先に集計を流す。
    await withConnection((connection) =>
      rollupAnalytics(connection, { from: today(), to: today() }),
    );

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

  /** `GET /api/v1/analytics?siteId=abc` の経路。UUID でない siteId は空結果（028 の検証で追記）。 */
  it('UUID でない siteId なら items が空で total は 0', async () => {
    const site = await makeSite();
    await seedPoints(site.id, ['pageviews']);

    await expect(
      listAnalyticsPage(admin, {
        ...range,
        siteId: 'not-a-uuid',
        from: today(),
        to: today(),
        page: 1,
        perPage: 20,
      }),
    ).resolves.toEqual({ items: [], total: 0 });
  });
});

/**
 * 内訳（028 設計 §6.2、受け入れ条件 #30〜#35）。
 *
 * `listAnalyticsBreakdown` は期間内の日ごとの値を key ごとに合算し、
 * value 降順・key 昇順で返す。`total` は key の種類数。UseCase 名 `analytics.breakdown`、
 * Permission `analytics.read`。
 */
describe('内訳', () => {
  const base = { from: DAY, to: NEXT_DAY, metric: 'path_pageviews', source: null, page: 1 };

  /** DAY: /a × 2, /b × 1。NEXT_DAY: /a × 1, /c × 1。合算は /a = 3, /b = 1, /c = 1。 */
  async function seedTwoDays(siteId: string): Promise<void> {
    await insertLogs(siteId, [
      { at: at('10:00'), visitor: 'v1', path: '/a' },
      { at: at('10:00'), visitor: 'v2', path: '/a' },
      { at: at('10:00'), visitor: 'v3', path: '/b' },
      { at: at('10:00', NEXT_DAY), visitor: 'v4', path: '/a' },
      { at: at('10:00', NEXT_DAY), visitor: 'v5', path: '/c' },
    ]);
    await rollup(DAY, NEXT_DAY);
  }

  /** #30 */
  it('期間内の日ごとの値を key ごとに合算する', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    const page = await listAnalyticsBreakdown(admin, { ...base, siteId: site.id, perPage: 50 });

    expect(page.items.find((item) => item.key === '/a')?.value).toBe(3);
    expect(page.items.find((item) => item.key === '/b')?.value).toBe(1);
    expect(page.items.find((item) => item.key === '/c')?.value).toBe(1);
  });

  /** #30。value 降順・key 昇順。 */
  it('value 降順・key 昇順で返す', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    const page = await listAnalyticsBreakdown(admin, { ...base, siteId: site.id, perPage: 50 });

    expect(page.items).toEqual([
      { key: '/a', value: 3 },
      { key: '/b', value: 1 },
      { key: '/c', value: 1 },
    ]);
  });

  /** #30。total は行数ではなく key の種類数。 */
  it('total は key の種類数', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    const page = await listAnalyticsBreakdown(admin, { ...base, siteId: site.id, perPage: 2 });

    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  /** #30。ページ境界。 */
  it('次のページに残りが出て、前のページと重ならない', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    const query = { ...base, siteId: site.id, perPage: 2 };
    const first = await listAnalyticsBreakdown(admin, { ...query, page: 1 });
    const second = await listAnalyticsBreakdown(admin, { ...query, page: 2 });

    expect(first.items.map((item) => item.key)).toEqual(['/a', '/b']);
    expect(second.items.map((item) => item.key)).toEqual(['/c']);
    expect(second.total).toBe(3);
  });

  /** #30。期間の外の日は合算に入らない。 */
  it('期間の外の日の値は合算しない', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    const page = await listAnalyticsBreakdown(admin, {
      ...base,
      siteId: site.id,
      from: DAY,
      to: DAY,
      perPage: 50,
    });

    expect(page.items).toEqual([
      { key: '/a', value: 2 },
      { key: '/b', value: 1 },
    ]);
    expect(page.total).toBe(2);
  });

  /** #30。値の無い指標は空。 */
  it('該当する行が無ければ空で total は 0', async () => {
    const site = await makeSite();

    const page = await listAnalyticsBreakdown(admin, { ...base, siteId: site.id, perPage: 50 });

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  /** #31。**ID を差し替えるだけで他サイトの値が取れない。** 同じパスをサイト A・B に入れる。 */
  it('siteId を指定すると他のサイトの同じ key の値が混ざらない', async () => {
    const siteA = await makeSite();
    const siteB = await makeSite();
    await insertLogs(siteA.id, [{ at: at('10:00'), visitor: 'v1', path: '/same' }]);
    await insertLogs(siteB.id, [
      { at: at('10:00'), visitor: 'v1', path: '/same' },
      { at: at('10:00'), visitor: 'v2', path: '/same' },
      { at: at('10:00'), visitor: 'v3', path: '/only-b' },
    ]);
    await rollup(DAY);

    const page = await listAnalyticsBreakdown(admin, {
      ...base,
      siteId: siteA.id,
      from: DAY,
      to: DAY,
      perPage: 50,
    });

    expect(page.items).toEqual([{ key: '/same', value: 1 }]);
    expect(page.total).toBe(1);
  });

  /**
   * UUID でない `siteId` は空結果（028 の検証で追記）。
   * `GET /api/v1/analytics/breakdown?siteId=abc` が `uuid` キャストの PG エラーで 500 になっていた。
   */
  it('UUID でない siteId なら items が空で total は 0', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    await expect(
      listAnalyticsBreakdown(admin, { ...base, siteId: 'not-a-uuid', perPage: 50 }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  /** #32 */
  it('siteId が null なら全サイトを合算する', async () => {
    const siteA = await makeSite();
    const siteB = await makeSite();
    await insertLogs(siteA.id, [{ at: at('10:00'), visitor: 'v1', path: '/same' }]);
    await insertLogs(siteB.id, [
      { at: at('10:00'), visitor: 'v1', path: '/same' },
      { at: at('10:00'), visitor: 'v2', path: '/same' },
      { at: at('10:00'), visitor: 'v3', path: '/only-b' },
    ]);
    await rollup(DAY);

    const page = await listAnalyticsBreakdown(admin, {
      ...base,
      siteId: null,
      from: DAY,
      to: DAY,
      perPage: 50,
    });

    expect(page.items).toEqual([
      { key: '/same', value: 3 },
      { key: '/only-b', value: 1 },
    ]);
    expect(page.total).toBe(2);
  });

  /** §6.2。source が null なら全出所を合算し、指定すればその出所だけ。 */
  it('source が null なら全出所を合算し、指定すればその出所だけ', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1', path: '/a' }]);
    await rollup(DAY);
    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: DAY,
      source: 'com.example.ga',
      metric: 'path_pageviews',
      key: '/a',
      value: 100,
    });

    const all = await listAnalyticsBreakdown(admin, {
      ...base,
      siteId: site.id,
      from: DAY,
      to: DAY,
      perPage: 50,
    });
    const coreOnly = await listAnalyticsBreakdown(admin, {
      ...base,
      siteId: site.id,
      from: DAY,
      to: DAY,
      source: 'core',
      perPage: 50,
    });

    expect(all.items).toEqual([{ key: '/a', value: 101 }]);
    expect(coreOnly.items).toEqual([{ key: '/a', value: 1 }]);
  });

  /** #33 */
  it('keys を指定するとその key だけが返る', async () => {
    const site = await makeSite();
    await seedTwoDays(site.id);

    const page = await listAnalyticsBreakdown(admin, {
      ...base,
      siteId: site.id,
      perPage: 50,
      keys: ['/a', '/c'],
    });

    expect(page.items).toEqual([
      { key: '/a', value: 3 },
      { key: '/c', value: 1 },
    ]);
    expect(page.total).toBe(2);
  });

  /** #33。境界：100 個までは受け付ける。 */
  it('keys は 100 個まで受け付ける', async () => {
    const site = await makeSite();
    const keys = Array.from({ length: 100 }, (_, index) => `/k${index}`);

    await expect(
      listAnalyticsBreakdown(admin, { ...base, siteId: site.id, perPage: 50, keys }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  /** #33。境界：101 個は 422。 */
  it('keys が 101 個以上なら拒否する', async () => {
    const site = await makeSite();
    const keys = Array.from({ length: 101 }, (_, index) => `/k${index}`);

    await expect(
      listAnalyticsBreakdown(admin, { ...base, siteId: site.id, perPage: 50, keys }),
    ).rejects.toThrow(ValidationError);
  });

  /** #34 */
  it('期間が逆転していれば拒否する', async () => {
    await expect(
      listAnalyticsBreakdown(admin, {
        ...base,
        siteId: null,
        from: '2026-05-01',
        to: '2026-04-01',
        perPage: 50,
      }),
    ).rejects.toThrow(ValidationError);
  });

  /** #34。境界：400 日（2025-01-01〜2026-02-04）は通る。 */
  it('期間が 400 日なら受け付ける', async () => {
    await expect(
      listAnalyticsBreakdown(admin, {
        ...base,
        siteId: null,
        from: '2025-01-01',
        to: '2026-02-04',
        perPage: 50,
      }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  /** #34。境界：401 日は 422。 */
  it('期間が 401 日なら拒否する', async () => {
    await expect(
      listAnalyticsBreakdown(admin, {
        ...base,
        siteId: null,
        from: '2025-01-01',
        to: '2026-02-05',
        perPage: 50,
      }),
    ).rejects.toThrow(ValidationError);
  });

  /** #34 */
  it('metric が指標名の形式でなければ拒否する', async () => {
    await expect(
      listAnalyticsBreakdown(admin, { ...base, siteId: null, metric: 'Path Views', perPage: 50 }),
    ).rejects.toThrow(ValidationError);
  });

  /** #34。制御文字を含む key、501 文字の key。 */
  it('keys に不正な要素があれば拒否する', async () => {
    await expect(
      listAnalyticsBreakdown(admin, {
        ...base,
        siteId: null,
        perPage: 50,
        keys: ['/ok', '/bad\u0000'],
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      listAnalyticsBreakdown(admin, {
        ...base,
        siteId: null,
        perPage: 50,
        keys: ['x'.repeat(501)],
      }),
    ).rejects.toThrow(ValidationError);
  });

  /** #35。Permission あり → 通る（admin）。無し → ForbiddenError。 */
  it('analytics.read が無ければ ForbiddenError', async () => {
    const noRole = await contextFor('viewer');
    const stripped: AuthorizationContext = { ...noRole, permissions: new Set() };

    await expect(
      listAnalyticsBreakdown(stripped, { ...base, siteId: null, perPage: 50 }),
    ).rejects.toThrow(ForbiddenError);
  });

  /** #35 の対。analytics.read を持つ viewer は読める。 */
  it('analytics.read を持てば読める', async () => {
    const viewer = await contextFor('viewer');
    const site = await makeSite();
    await seedTwoDays(site.id);

    const page = await listAnalyticsBreakdown(viewer, { ...base, siteId: site.id, perPage: 50 });

    expect(page.total).toBe(3);
  });
});

/**
 * 受信状況（028 設計 §6.4、受け入れ条件 #41。029 設計 §5.4 / §6.4、受け入れ条件 #46〜#51 で拡張）。
 *
 * `getAnalyticsStatus({ siteId })` → `AnalyticsStatus`：
 * 既存の `siteId` / `analyticsLastSeenAt` / `lastRollupAt`（`source = 'core'` の `max(updated_at)`。残す。裁定 #7）に、
 * `lastReceivedAt`（生ログの最終受信。Bot 含む）、`pending`（最終集計以降の未集計件数。上限 1000）、
 * `rollup`（`job_runs` と基盤のスナップショット）を足す。UseCase 名 `analytics.status`、Permission `analytics.read`。
 *
 * `runJob` で流したテストの `job_runs` の行が次のテストの `since` に効くので、この describe の後始末で消す。
 */
describe('受信状況', () => {
  afterEach(async () => {
    await withConnection((connection) => sql`DELETE FROM job_runs`.execute(connection.db));
  });

  /** 生ログを `occurred_at = 今` で 1 件入れ、その時刻を返す。 */
  async function insertLogNow(siteId: string, device: 'desktop' | 'bot' = 'desktop') {
    const now = new Date();
    await insertLogs(siteId, [{ at: now.toISOString(), visitor: `v-${now.getTime()}`, device }]);
    return now;
  }

  /** ロールアップを `runJob` で流す（`job_runs` に ok の行が入る）。 */
  async function runRollup(from: string, to: string = from) {
    const outcome = await withConnection((connection) =>
      runJob(connection, ROLLUP_JOB, { trigger: 'manual', wait: true, input: { from, to } }),
    );
    expect(outcome.outcome).toBe('ok');
    // `RunOutcome.run` は skipped / ロック失敗のとき null になりうる（設計 §6.1.5）。
    if (outcome.run === null) throw new Error('job_runs に記録されていない');
    return outcome.run;
  }

  /** #41 / #46。計測も集計もしていないサイトはすべて null / 0。 */
  it('計測も集計もしていなければ両方 null', async () => {
    const site = await makeSite();

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status).toMatchObject({
      siteId: site.id,
      analyticsLastSeenAt: null,
      lastRollupAt: null,
    });
  });

  /** #46 */
  it('生ログが無いサイトは lastReceivedAt が null で pending が 0、rollup も空', async () => {
    const site = await makeSite();

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.lastReceivedAt).toBeNull();
    expect(status.pending).toEqual({ total: 0, bots: 0, capped: false, since: null });
    expect(status.rollup).toMatchObject({
      lastSucceededAt: null,
      lastRun: null,
      // テストでは基盤が起動していない。
      scheduled: false,
      nextRunAt: null,
    });
    expect(status.rollup.intervalMinutes).toBe(15);
  });

  /** #47。最終受信は Bot でも数える。 */
  it('人の生ログ 2 件と Bot 1 件を入れると、lastReceivedAt は最新の occurred_at（Bot でも）', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1' },
      { at: at('10:05'), visitor: 'v2' },
      { at: at('11:00'), visitor: 'b1', device: 'bot' },
    ]);

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.lastReceivedAt?.toISOString()).toBe('2026-06-10T11:00:00.000Z');
  });

  /** #47。集計したことが無ければ since = null で全件が未集計。 */
  it('集計したことが無ければ pending は全件（total 3、bots 1、since null）', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1' },
      { at: at('10:05'), visitor: 'v2' },
      { at: at('11:00'), visitor: 'b1', device: 'bot' },
    ]);

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.pending).toEqual({ total: 3, bots: 1, capped: false, since: null });
  });

  /** #48。境目は最後に成功したロールアップの開始時刻。 */
  it('runJob(ROLLUP_JOB) の後に足した生ログだけが pending に数えられ、since はその実行の started_at', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);
    const run = await runRollup(DAY);
    await insertLogNow(site.id);

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.pending.total).toBe(1);
    expect(status.pending.bots).toBe(0);
    expect(status.pending.since?.getTime()).toBe(run.startedAt.getTime());
  });

  /** #48。rollup.lastSucceededAt は成功した実行の終了時刻、lastRun は直近の実行。 */
  it('runJob(ROLLUP_JOB) の後、rollup.lastSucceededAt がその finished_at で lastRun.status が ok', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);
    const run = await runRollup(DAY);

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(status.rollup.lastSucceededAt?.getTime()).toBe(run.finishedAt?.getTime());
    expect(status.rollup.lastRun?.status).toBe('ok');
    expect(status.rollup.lastRun?.startedAt.getTime()).toBe(run.startedAt.getTime());
    expect(status.rollup.lastRun?.finishedAt?.getTime()).toBe(run.finishedAt?.getTime());
    // error の文字列は画面に出さない（結果だけ）。
    expect(status.rollup.lastRun).not.toHaveProperty('error');
  });

  /** #49。生ログの期間全体を舐めない。1000 件で打ち切る。 */
  it('生ログを 1001 件入れると pending.total は 1000 で capped が true', async () => {
    const site = await makeSite();
    const base = Date.parse('2026-06-10T00:00:00Z');
    await withConnection((connection) =>
      connection.db
        .insertInto('access_logs')
        .values(
          Array.from({ length: 1001 }, (_, index) => ({
            id: uuidv7(),
            site_id: site.id,
            occurred_at: new Date(base + index * 1000).toISOString(),
            path: '/',
            referrer_host: null,
            visitor_hash: `v${index % 7}`,
            device: index % 10 === 0 ? ('bot' as const) : ('desktop' as const),
          })),
        )
        .execute(),
    );

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.pending.total).toBe(1000);
    expect(status.pending.capped).toBe(true);
    expect(status.pending.bots).toBeGreaterThan(0);
    expect(status.pending.bots).toBeLessThanOrEqual(1000);
  });

  /** #49 の対。ちょうど 1000 件は capped（実際はもっと多いかもしれないので打ち切り扱い）。1 件は打ち切らない。 */
  it('生ログが 1 件なら capped は false', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.pending).toMatchObject({ total: 1, capped: false });
  });

  /** #50。直近が失敗でも「最後にいつ集計できたか」は消えない。 */
  it('ロールアップの error 行を記録した後、lastRun.status は error で lastSucceededAt は直前の ok のまま', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);
    const run = await runRollup(DAY);
    await withConnection((connection) =>
      sql`
        INSERT INTO job_runs (id, job_name, triggered_by, status, started_at, finished_at, error, summary)
        VALUES (${uuidv7()}, 'analytics.rollup', 'scheduled', 'error', now(), now(), '失敗', '{}'::jsonb)
      `.execute(connection.db),
    );

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.rollup.lastRun?.status).toBe('error');
    expect(status.rollup.lastSucceededAt?.getTime()).toBe(run.finishedAt?.getTime());
    // 未集計の境目も最後の成功のまま。
    expect(status.pending.since?.getTime()).toBe(run.startedAt.getTime());
  });

  /** #51（裁定 #7）。`lastRollupAt`（サイトごと）と `rollup.lastSucceededAt`（全体）の両方がある。 */
  it('サイト A だけをロールアップした後、B の lastRollupAt は null のままで rollup.lastSucceededAt は A・B とも同じ', async () => {
    const siteA = await makeSite();
    const siteB = await makeSite();
    await insertLogs(siteA.id, [{ at: at('10:00'), visitor: 'v1' }]);
    const run = await runRollup(DAY);

    const statusA = await getAnalyticsStatus(admin, { siteId: siteA.id });
    const statusB = await getAnalyticsStatus(admin, { siteId: siteB.id });

    expect(statusA.lastRollupAt).toBeInstanceOf(Date);
    expect(statusB.lastRollupAt).toBeNull();
    expect(statusA.rollup.lastSucceededAt?.getTime()).toBe(run.finishedAt?.getTime());
    expect(statusB.rollup.lastSucceededAt?.getTime()).toBe(run.finishedAt?.getTime());
  });

  /** #51。**ID を差し替えても他サイトの生ログ（最終受信・未集計）にならない。** */
  it('他のサイトの生ログは自分の lastReceivedAt / pending に現れない', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(other.id, [
      { at: at('10:00'), visitor: 'v1' },
      { at: at('11:00'), visitor: 'b1', device: 'bot' },
    ]);

    const status = await getAnalyticsStatus(admin, { siteId: mine.id });

    expect(status.lastReceivedAt).toBeNull();
    expect(status.pending).toEqual({ total: 0, bots: 0, capped: false, since: null });
  });

  /** #41 */
  it('ロールアップ後、最終受信と最終集計が入る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);
    const before = Date.now();

    await rollup(DAY);
    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.analyticsLastSeenAt?.toISOString()).toBe('2026-06-10T10:00:00.000Z');
    expect(status.lastRollupAt).toBeInstanceOf(Date);
    // 最終集計は「いま」に近い（生ログの時刻ではない）。
    expect(status.lastRollupAt?.getTime() ?? 0).toBeGreaterThanOrEqual(before - 1000);
  });

  /** #41。Plugin の行の updated_at が新しくても lastRollupAt は動かない。 */
  it('Plugin の record を後から入れても lastRollupAt が動かない', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);
    await rollup(DAY);
    const rolled = await getAnalyticsStatus(admin, { siteId: site.id });

    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: DAY,
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 999,
    });
    // Plugin の行の updated_at を確実に新しくする。
    await withConnection((connection) =>
      sql`UPDATE analytics SET updated_at = now() + interval '1 day' WHERE source <> 'core'`.execute(
        connection.db,
      ),
    );
    const after = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(rolled.lastRollupAt).not.toBeNull();
    expect(after.lastRollupAt?.getTime()).toBe(rolled.lastRollupAt?.getTime());
  });

  /** #41。Plugin の値しか無いサイトは lastRollupAt が null。 */
  it('Plugin の値しか無ければ lastRollupAt は null', async () => {
    const site = await makeSite();
    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: DAY,
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 1,
    });

    const status = await getAnalyticsStatus(admin, { siteId: site.id });

    expect(status.lastRollupAt).toBeNull();
    expect(status.analyticsLastSeenAt).toBeNull();
  });

  /** #41 の前提。**ID を差し替えても他サイトの状況にならない。** */
  it('他のサイトの集計は自分の状況に影響しない', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(other.id, [{ at: at('10:00'), visitor: 'v1' }]);
    await rollup(DAY);

    const status = await getAnalyticsStatus(admin, { siteId: mine.id });

    expect(status).toMatchObject({
      siteId: mine.id,
      analyticsLastSeenAt: null,
      lastRollupAt: null,
    });
    expect(status.lastReceivedAt).toBeNull();
    expect(status.pending.total).toBe(0);
  });

  /** #41 */
  it('存在しないサイトは NotFoundError', async () => {
    await expect(getAnalyticsStatus(admin, { siteId: uuidv7() })).rejects.toThrow(NotFoundError);
  });

  /** #41。UUID でない ID も NotFoundError（500 にしない）。 */
  it('UUID でない ID も NotFoundError', async () => {
    await expect(getAnalyticsStatus(admin, { siteId: 'not-a-uuid' })).rejects.toThrow(
      NotFoundError,
    );
  });

  /** #41 */
  it('analytics.read が無ければ ForbiddenError', async () => {
    const site = await makeSite();
    const noRole = await contextFor('viewer');
    const stripped: AuthorizationContext = { ...noRole, permissions: new Set() };

    await expect(getAnalyticsStatus(stripped, { siteId: site.id })).rejects.toThrow(ForbiddenError);
  });

  /** #41 の対。analytics.read を持つ viewer は読める。 */
  it('analytics.read を持てば読める', async () => {
    const site = await makeSite();
    const viewer = await contextFor('viewer');

    await expect(getAnalyticsStatus(viewer, { siteId: site.id })).resolves.toMatchObject({
      siteId: site.id,
    });
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

/**
 * 公開キーの再発行と計測（028 設計 §6.6、受け入れ条件 #44）。
 *
 * 旧キーは即時に無効。`findSiteByPublicKey` が引けなくなるので、
 * 旧タグからの `collect` は `{ ok: false }` で、何も記録されない。
 */
describe('公開キーの再発行と計測', () => {
  async function hit(publicKey: string): Promise<{ ok: boolean }> {
    return collectAccess({
      publicKey,
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });
  }

  async function accessLogCount(): Promise<number> {
    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').select('id').execute(),
    );
    return rows.length;
  }

  /** #44 */
  it('再発行後、旧キーで collectAccess を呼んでも ok: false になる', async () => {
    const site = await makeSite();
    await regenerateSitePublicKey(admin, { id: site.id });

    const outcome = await hit(site.publicKey);

    expect(outcome.ok).toBe(false);
  });

  /** #44 */
  it('再発行後、旧キーでは access_logs が増えない', async () => {
    const site = await makeSite();
    await regenerateSitePublicKey(admin, { id: site.id });

    await hit(site.publicKey);

    expect(await accessLogCount()).toBe(0);
  });

  /** #44 */
  it('再発行後、新キーでは ok: true で記録される', async () => {
    const site = await makeSite();
    const { publicKey } = await regenerateSitePublicKey(admin, { id: site.id });

    const outcome = await hit(publicKey);

    expect(outcome.ok).toBe(true);
    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').select('site_id').execute(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.site_id).toBe(site.id);
  });

  /** #44。再発行前に旧キーで積んだ記録は残る（キーの切り替えで過去の記録は消えない）。 */
  it('再発行前に旧キーで記録した分は残る', async () => {
    const site = await makeSite();
    await hit(site.publicKey);

    await regenerateSitePublicKey(admin, { id: site.id });

    expect(await accessLogCount()).toBe(1);
  });

  /** 他のサイトのキーは無効にならない。 */
  it('別のサイトを再発行しても、このサイトの旧キーは有効なまま', async () => {
    const site = await makeSite();
    const other = await makeSite();

    await regenerateSitePublicKey(admin, { id: other.id });

    const outcome = await hit(site.publicKey);
    expect(outcome.ok).toBe(true);
  });
});

/**
 * 当日 1 日分の集計（030-analytics-today 設計 §5.2 / §11.2、受け入れ条件 #21〜#28）。
 *
 * `aggregateDailyBreakdown` の引数を広げる。**SQL の本体は変えない。**
 *
 * ```ts
 * aggregateDailyBreakdown(connection, {
 *   from, to, timeZone,
 *   siteId?: string | null,        // 追加。null / 省略は全サイト（ロールアップの現行動作）
 *   statementTimeoutMs?: number,   // 追加。省略なら設定しない（ロールアップの現行動作）
 * })
 * ```
 *
 * `siteId` を渡したときだけ `logs` CTE の `WHERE` に一致条件を足す。
 * **UUID でない値は「どの行にも当たらない条件」**にする（キャストエラーで 500 にしない）。
 * 窓関数のパーティションは元から `site_id` を含むので、絞っても値は変わらない。
 */
describe('当日 1 日分の集計（aggregateDailyBreakdown）', () => {
  afterEach(() => {
    delete process.env['TORIFUNE_TIMEZONE'];
    resetTimeZoneWarning();
  });

  function aggregate(options: {
    readonly from: string;
    readonly to?: string;
    readonly timeZone?: string;
    readonly siteId?: string | null;
    readonly statementTimeoutMs?: number;
  }): Promise<readonly DailyBreakdownRow[]> {
    return withConnection((connection) =>
      analyticsRepository.aggregateDailyBreakdown(connection, {
        from: options.from,
        to: options.to ?? options.from,
        timeZone: options.timeZone ?? 'UTC',
        ...(options.siteId === undefined ? {} : { siteId: options.siteId }),
        ...(options.statementTimeoutMs === undefined
          ? {}
          : { statementTimeoutMs: options.statementTimeoutMs }),
      }),
    );
  }

  /** `{ metric, key, value }` だけを取り出して並べる（比較しやすい形）。 */
  function shapeOf(
    rows: readonly { readonly metric: string; readonly key: string; readonly value: number }[],
  ): { metric: string; key: string; value: number }[] {
    return rows
      .map((row) => ({ metric: row.metric, key: row.key, value: row.value }))
      .sort((a, b) =>
        a.metric === b.metric ? a.key.localeCompare(b.key) : a.metric.localeCompare(b.metric),
      );
  }

  /**
   * #21。**他のサイトの生ログが 1 行も混ざらない。**
   *
   * ID を差し替えるだけで別サイトのアクセスが見えるようでは、当日タブが漏れの口になる。
   */
  it('siteId を渡すと、そのサイトの行だけが返る', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(mine.id, [{ at: at('10:00'), visitor: 'v1', path: '/mine' }]);
    await insertLogs(other.id, [{ at: at('10:00'), visitor: 'v2', path: '/other' }]);

    const rows = await aggregate({ from: DAY, siteId: mine.id });

    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((row) => row.siteId))]).toEqual([mine.id]);
    expect(rows.map((row) => row.key)).not.toContain('/other');
  });

  /** #21。絞っても値は変わらない（窓関数のパーティションが元から site_id を含む）。 */
  it('siteId で絞っても、そのサイトの値は全サイトで集計したときと同じ', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(mine.id, [
      { at: at('10:00'), visitor: 'v1', path: '/a' },
      { at: at('10:10'), visitor: 'v1', path: '/b' },
    ]);
    await insertLogs(other.id, [{ at: at('10:00'), visitor: 'v1', path: '/a' }]);

    const filtered = await aggregate({ from: DAY, siteId: mine.id });
    const all = await aggregate({ from: DAY });

    expect(shapeOf(filtered)).toEqual(shapeOf(all.filter((row) => row.siteId === mine.id)));
  });

  /** #22。ロールアップの経路（引数を渡さない）が変わらない。 */
  it('siteId を省略すると全サイトの行が返る', async () => {
    const first = await makeSite();
    const second = await makeSite();
    await insertLogs(first.id, [{ at: at('10:00'), visitor: 'v1' }]);
    await insertLogs(second.id, [{ at: at('10:00'), visitor: 'v2' }]);

    const rows = await aggregate({ from: DAY });

    expect([...new Set(rows.map((row) => row.siteId))].sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  /** #22。`null` は「全サイト」（省略と同じ）。 */
  it('siteId に null を渡しても全サイトの行が返る', async () => {
    const first = await makeSite();
    const second = await makeSite();
    await insertLogs(first.id, [{ at: at('10:00'), visitor: 'v1' }]);
    await insertLogs(second.id, [{ at: at('10:00'), visitor: 'v2' }]);

    expect(shapeOf(await aggregate({ from: DAY, siteId: null }))).toEqual(
      shapeOf(await aggregate({ from: DAY })),
    );
  });

  /** #23。UUID でない値でキャストエラーにして 500 を返さない（既存の `siteCondition` と同じ規則）。 */
  it('siteId が UUID でなければ、例外にならず空配列', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await expect(aggregate({ from: DAY, siteId: 'not-a-uuid' })).resolves.toEqual([]);
  });

  /** #23。SQL を差し込む形の値でも同じ（例外にも全件にもならない）。 */
  it('siteId が SQL の断片でも空配列', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await expect(aggregate({ from: DAY, siteId: `' OR 1=1 --` })).resolves.toEqual([]);
  });

  /**
   * #24。**同じ定義であることの担保**（設計 §13-2）。
   *
   * 当日の値がロールアップ済みの本日分と食い違うと、15 分後に数字が変わって見える。
   * 進行中セッションを除く・直帰の数え方を変える、といった補正を入れていないことを
   * ここで固定する。
   */
  it('from = to = 今日 の結果が、rollupAnalytics が書く本日分と metric / key / value まで一致する', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: `${today()}T00:10:00Z`, visitor: 'v1', path: '/', referrer: 'ref.example' },
      { at: `${today()}T00:20:00Z`, visitor: 'v1', path: '/pricing' },
      { at: `${today()}T01:30:00Z`, visitor: 'v2', path: '/', device: 'mobile' },
      { at: `${today()}T02:00:00Z`, visitor: 'b1', path: '/', device: 'bot' },
    ]);

    const direct = await aggregate({ from: today(), siteId: site.id });
    await rollup(today());
    const rolledUp = await corePoints(site.id, today());

    expect(shapeOf(direct)).toEqual(shapeOf(rolledUp));
  });

  /** #25。0 行の指標も作らない（消された生ログの日を 0 で埋めない）。 */
  it('その日の生ログが 1 行も無いサイトでは空配列', async () => {
    const site = await makeSite();
    const other = await makeSite();
    // 別サイトには生ログがある。絞り込みが効いていなければここで空にならない。
    await insertLogs(other.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await expect(aggregate({ from: DAY, siteId: site.id })).resolves.toEqual([]);
  });

  /** #25。日をずらせば同じサイトでも空。 */
  it('その日に生ログが無ければ空配列（別の日にはある）', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await expect(aggregate({ from: NEXT_DAY, siteId: site.id })).resolves.toEqual([]);
  });

  /**
   * #26。生ログが 1 行でもあれば `key = ''` の 8 指標を 0 でも出す。
   *
   * Bot だけの日でも、人の指標が 0 として並ぶ（画面が「0」を出せる）。
   */
  it('生ログが 1 行でもあれば、key が空の 8 指標が値 0 でも返る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'b1', device: 'bot' }]);

    const rows = await aggregate({ from: DAY, siteId: site.id });
    const keyless = new Map(
      rows.filter((row) => row.key === '').map((row) => [row.metric, row.value]),
    );

    expect([...keyless.keys()].sort()).toEqual([...KEYLESS_CORE_METRICS].sort());
    expect(keyless.get('pageviews')).toBe(0);
    expect(keyless.get('visitors')).toBe(0);
    expect(keyless.get('sessions')).toBe(0);
    expect(keyless.get('bot_pageviews')).toBe(1);
    expect(keyless.get('bot_visitors')).toBe(1);
  });

  /**
   * #27。運用タイムゾーンの日の境目で切られる。
   *
   * JST（UTC+9）では 2026-09-02T23:00Z は 9/3 08:00 なので「9/3」に入る。
   * ここがずれると、JST の朝に見る「当日」が常に空になる。
   */
  it('Asia/Tokyo では UTC で前日 23:00 の生ログが「今日」に入る', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';
    const site = await makeSite();
    await insertLogs(site.id, [{ at: '2026-09-02T23:00:00Z', visitor: 'v1' }]);

    const rows = await aggregate({
      from: '2026-09-03',
      timeZone: 'Asia/Tokyo',
      siteId: site.id,
    });

    expect(rows.find((row) => row.metric === 'pageviews' && row.key === '')?.value).toBe(1);
    expect([...new Set(rows.map((row) => row.metricDate))]).toEqual(['2026-09-03']);
  });

  /** #27 の対。UTC で切ると同じ生ログは前日に入る。 */
  it('UTC では同じ生ログが前日に入る', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: '2026-09-02T23:00:00Z', visitor: 'v1' }]);

    await expect(
      aggregate({ from: '2026-09-03', timeZone: 'UTC', siteId: site.id }),
    ).resolves.toEqual([]);
    await expect(
      aggregate({ from: '2026-09-02', timeZone: 'UTC', siteId: site.id }),
    ).resolves.not.toEqual([]);
  });

  /**
   * #28。`SET LOCAL` はトランザクション終了で戻るので、プールされた接続に設定が残らない。
   *
   * ここが漏れると、当日タブを 1 度開いただけで、以後その接続を使うすべての処理
   * （ロールアップを含む）が 5 秒で打ち切られるようになる。
   *
   * **「時間切れが実際に起きる」ことは決定的に検査できない**（行数依存で、
   * 小さな scratch DB では必ず間に合う）。縮退の経路は #37 で担保する。
   */
  it('statementTimeoutMs を渡した呼び出しのあと、プールの接続に statement_timeout が残らない', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [{ at: at('10:00'), visitor: 'v1' }]);

    await aggregate({
      from: DAY,
      siteId: site.id,
      statementTimeoutMs: TODAY_AGGREGATION_TIMEOUT_MS,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const shown = await withConnection((connection) =>
        sql<{ statement_timeout: string }>`SHOW statement_timeout`.execute(connection.db),
      );
      expect(shown.rows[0]?.statement_timeout).toBe('0');
    }
  });

  /** #28。`statementTimeoutMs` を渡しても結果は変わらない（実行の器だけの違い）。 */
  it('statementTimeoutMs の有無で結果が変わらない', async () => {
    const site = await makeSite();
    await insertLogs(site.id, [
      { at: at('10:00'), visitor: 'v1', path: '/a' },
      { at: at('10:10'), visitor: 'v1', path: '/b' },
    ]);

    const withTimeout = await aggregate({
      from: DAY,
      siteId: site.id,
      statementTimeoutMs: TODAY_AGGREGATION_TIMEOUT_MS,
    });
    const without = await aggregate({ from: DAY, siteId: site.id });

    expect(shapeOf(withTimeout)).toEqual(shapeOf(without));
  });

  /** #28。定数は Infrastructure が持ち、UseCase が渡す（環境変数を増やさない）。 */
  it('TODAY_AGGREGATION_TIMEOUT_MS が 5000', () => {
    expect(TODAY_AGGREGATION_TIMEOUT_MS).toBe(5000);
  });
});

/**
 * 当日の UseCase（030-analytics-today 設計 §12.1 / §8 / §11.2 / §13-3、
 * 受け入れ条件 #29〜#38、#70、#71）。
 *
 * ```ts
 * interface TodayAnalytics {
 *   readonly date: string;                       // 運用タイムゾーンの今日（YYYY-MM-DD）
 *   readonly generatedAt: Date;                  // 集計した瞬間（サーバーの時計）
 *   readonly unavailable: boolean;               // 集計できなかった（打ち切り等）。true なら points は空
 *   readonly points: readonly AnalyticsPoint[];  // source は常に CORE_SOURCE
 * }
 *
 * getTodayAnalytics: UseCase<{ readonly siteId: string }, TodayAnalytics>
 * // name: 'analytics.today' / permission: 'analytics.read' / audit: なし（参照系）
 * ```
 *
 * **期間を引数で受けない。** 日付は自分で決める（例外の範囲を 1 日 × 1 サイトに固定する。§4.1）。
 * **当日は `analytics` を読まない。生ログだけを見る**（§13-3）。足す・混ぜる・優先するをしない。
 * **書き込まない**（`replaceCorePoints` / `putPoint` / `touchLastSeen` を呼ばない。§5.3）。
 */
describe('当日（getTodayAnalytics）', () => {
  /** 未認証の文脈。`identity` が null。 */
  async function anonymousContext(): Promise<AuthorizationContext> {
    return withConnection(async (connection) => ({
      identity: null,
      permissions: new Set<string>(),
      connection,
    }));
  }

  /** ログを差し替えて記録を貯める（`logging.test.ts` と同じ形）。 */
  function captureLogs(): { records: LogRecord[] } {
    const records: LogRecord[] = [];
    setLogger({
      log(level, message, fields) {
        records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
      },
    });
    return { records };
  }

  afterEach(() => {
    resetLogger();
    vi.restoreAllMocks();
  });

  /** `{ metric, key }` の値を引く。 */
  function todayValue(result: { points: readonly AnalyticsPoint[] }, metric: string, key = '') {
    return result.points.find((point) => point.metric === metric && point.key === key)?.value;
  }

  /** 今日の生ログを 3 件（人 2 訪問者 + Bot 1）入れる。 */
  async function seedTodayLogs(siteId: string): Promise<void> {
    await insertLogs(siteId, [
      { at: `${today()}T00:10:00Z`, visitor: 'v1', path: '/' },
      { at: `${today()}T00:20:00Z`, visitor: 'v1', path: '/pricing' },
      { at: `${today()}T01:30:00Z`, visitor: 'v2', path: '/' },
      { at: `${today()}T02:00:00Z`, visitor: 'b1', path: '/', device: 'bot' },
    ]);
  }

  /** #29 */
  it('analytics.read を持つ主体が呼ぶと成功し、date が運用タイムゾーンの今日', async () => {
    const site = await makeSite();
    const viewer = await contextFor('viewer');
    await seedTodayLogs(site.id);

    const result = await getTodayAnalytics(viewer, { siteId: site.id });

    expect(result.date).toBe(todayInTimeZone(analyticsTimeZone()));
    expect(result.unavailable).toBe(false);
    expect(todayValue(result, 'pageviews')).toBe(3);
    expect(todayValue(result, 'visitors')).toBe(2);
  });

  /** #29。集計した瞬間はサーバーの時計（ブラウザの時計ではない）。 */
  it('generatedAt に集計した瞬間が入る', async () => {
    const site = await makeSite();
    const before = Date.now();

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(result.generatedAt).toBeInstanceOf(Date);
    expect(result.generatedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.generatedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  /** #30。**権限なし → ForbiddenError（API 経由なら 403）。** */
  it('analytics.read を持たない主体が呼ぶと ForbiddenError', async () => {
    const site = await makeSite();
    const noRole = await contextFor('viewer');
    const stripped: AuthorizationContext = { ...noRole, permissions: new Set() };

    await expect(getTodayAnalytics(stripped, { siteId: site.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  /** #31。**未認証 → UnauthenticatedError（API 経由なら 401）。** */
  it('未認証で呼ぶと UnauthenticatedError', async () => {
    const site = await makeSite();
    const anonymous = await anonymousContext();

    await expect(getTodayAnalytics(anonymous, { siteId: site.id })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  /** #30 / #31。未認証は 403 ではなく 401（ログインを促せなくなる）。 */
  it('未認証は ForbiddenError ではない', async () => {
    const site = await makeSite();
    const anonymous = await anonymousContext();

    await expect(getTodayAnalytics(anonymous, { siteId: site.id })).rejects.not.toBeInstanceOf(
      ForbiddenError,
    );
  });

  /**
   * #21 の UseCase 側。**ID を差し替えても他サイトの値は取れない。**
   */
  it('別サイトの生ログは 1 行も混ざらない', async () => {
    const mine = await makeSite();
    const other = await makeSite();
    await insertLogs(mine.id, [{ at: `${today()}T00:10:00Z`, visitor: 'v1', path: '/mine' }]);
    await insertLogs(other.id, [
      { at: `${today()}T00:10:00Z`, visitor: 'v2', path: '/other' },
      { at: `${today()}T00:20:00Z`, visitor: 'v3', path: '/other' },
    ]);

    const result = await getTodayAnalytics(admin, { siteId: mine.id });

    expect(todayValue(result, 'pageviews')).toBe(1);
    expect(result.points.map((point) => point.key)).not.toContain('/other');
    expect([...new Set(result.points.map((point) => point.siteId))]).toEqual([mine.id]);
  });

  /** #32。写すだけで指標も値も変換しない。出所は常に core。 */
  it('返る点の source がすべて CORE_SOURCE で、metricDate がすべて date と等しい', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(result.points.length).toBeGreaterThan(0);
    expect([...new Set(result.points.map((point) => point.source))]).toEqual([CORE_SOURCE]);
    expect([...new Set(result.points.map((point) => point.metricDate))]).toEqual([result.date]);
  });

  /**
   * #33。**計測タグを貼った直後の確認**（要件 §1）。
   *
   * ロールアップを 1 度も流していなくても、生ログから値が出る。
   */
  it('analytics に本日の集計値が 1 行も無い状態でも、生ログから値が出る', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);

    const stored = await withConnection((connection) =>
      connection.db.selectFrom('analytics').selectAll().execute(),
    );
    expect(stored).toHaveLength(0);

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(todayValue(result, 'pageviews')).toBe(3);
    expect(todayValue(result, 'bot_pageviews')).toBe(1);
  });

  /**
   * #34。**二重計上を構造的に起こせなくする**（§13-3）。
   *
   * 足せば必ず 2 倍になる。生ログの方が常に新しく、常に正しい。
   */
  it('analytics に本日の集計値が既にあっても、返る値は生ログの集計だけ', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);
    await rollup(today());

    // 集計値は入っている（前提の確認）。
    expect((await corePoints(site.id, today())).length).toBeGreaterThan(0);

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(todayValue(result, 'pageviews')).toBe(3);
    expect(todayValue(result, 'visitors')).toBe(2);
  });

  /**
   * #35。Plugin が `analytics.record` で入れた本日分（`source <> 'core'`）は当日タブに出ない。
   *
   * 当日は生ログだけを見るため。仕様であり、画面のバナーで説明する（§9）。
   */
  it('source が core でない本日の点は結果に含まれない', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);
    await recordAnalytics(admin, {
      siteId: site.id,
      metricDate: today(),
      source: 'com.example.ga',
      metric: 'pageviews',
      value: 1000,
    });

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(todayValue(result, 'pageviews')).toBe(3);
    expect(result.points.every((point) => point.source === CORE_SOURCE)).toBe(true);
  });

  /** #36。今日まだ 1 件も届いていない日でも落ちない（画面は 0 を並べる）。 */
  it('生ログが 1 件も無い日でも例外にならず、points が空で unavailable が false', async () => {
    const site = await makeSite();

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(result.points).toEqual([]);
    expect(result.unavailable).toBe(false);
    expect(result.date).toBe(todayInTimeZone(analyticsTimeZone()));
  });

  /**
   * #37。**縮退する。** 当日の集計が重い環境で画面全体を止めない。
   *
   * 確定値は別経路（`analytics`）で必ず見られるので、当日だけ諦める方が損害が小さい。
   * ただし**握り潰さない**。原因の切り分けは運用者の仕事で、ログに残っている必要がある。
   */
  it('Repository が例外を投げたとき、伝播せず unavailable: true と空の points を返す', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);
    captureLogs();
    vi.spyOn(analyticsRepository, 'aggregateDailyBreakdown').mockRejectedValueOnce(
      new Error('canceling statement due to statement timeout'),
    );

    const result = await getTodayAnalytics(admin, { siteId: site.id });

    expect(result.unavailable).toBe(true);
    expect(result.points).toEqual([]);
    expect(result.date).toBe(todayInTimeZone(analyticsTimeZone()));
    expect(result.generatedAt).toBeInstanceOf(Date);
  });

  /** #37。警告ログを 1 件残す。 */
  it('Repository が例外を投げたとき、警告ログを 1 件残す', async () => {
    const site = await makeSite();
    const { records } = captureLogs();
    vi.spyOn(analyticsRepository, 'aggregateDailyBreakdown').mockRejectedValueOnce(
      new Error('canceling statement due to statement timeout'),
    );

    await getTodayAnalytics(admin, { siteId: site.id });

    const warnings = records.filter((record) => record.level === 'warn');
    expect(warnings).toHaveLength(1);
  });

  /**
   * #38。**当日の値とロールアップ後の値が食い違わない**（要件 §4 の 2 つ目）。
   *
   * 同じ生ログから同じ定義で出しているので、`summarize` に通しても一致する。
   * 一致しなくなったら、当日にだけ補正が入ったということ。
   */
  it('summarize に通した値が、ロールアップ後の listAnalytics → summarize と一致する', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);

    const beforeRollup = await getTodayAnalytics(admin, { siteId: site.id });
    await rollup(today());
    const stored = await corePoints(site.id, today());

    for (const includeBots of [false, true]) {
      expect(summarize(beforeRollup.points, { includeBots }), String(includeBots)).toEqual(
        summarize(stored, { includeBots }),
      );
    }
  });

  /**
   * #70。**画面の表示が DB 書き込みを起こす作りにしない**（裁定 3.1）。
   *
   * E2E にしない理由：定期ロールアップが 1 分間隔で `analytics` を書き換えるので
   * 「表示の前後で変わらない」は E2E では必ず不安定になる。UseCase の前後で見れば決定的。
   */
  it('呼び出しの前後で analytics の行が 1 つも変わらない', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);
    await rollup(today());

    const readRows = () =>
      withConnection((connection) =>
        connection.db
          .selectFrom('analytics')
          .selectAll()
          .orderBy('site_id')
          .orderBy('metric_date')
          .orderBy('source')
          .orderBy('metric')
          .orderBy('key')
          .execute(),
      );

    const before = await readRows();
    expect(before.length).toBeGreaterThan(0);

    await getTodayAnalytics(admin, { siteId: site.id });

    expect(await readRows()).toEqual(before);
  });

  /** #70。集計値が 1 行も無い状態から呼んでも、行が生まれない。 */
  it('集計値が無い状態で呼んでも analytics に行が増えない', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);

    await getTodayAnalytics(admin, { siteId: site.id });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('analytics').selectAll().execute(),
    );
    expect(rows).toEqual([]);
  });

  /** #71。最終受信は `findLatestAccessAt`（生ログ 1 行）から出すので、書き戻す必要が無い。 */
  it('呼び出しで sites.analytics_last_seen_at が更新されない', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);

    const before = await lastSeenOf(site.id);
    expect(before).toBeNull();

    await getTodayAnalytics(admin, { siteId: site.id });

    expect(await lastSeenOf(site.id)).toBeNull();
  });

  /** #71。既に値がある場合も動かさない。 */
  it('既に analytics_last_seen_at がある場合も値が変わらない', async () => {
    const site = await makeSite();
    await seedTodayLogs(site.id);
    await rollup(today());

    const before = await lastSeenOf(site.id);
    expect(before).not.toBeNull();

    await getTodayAnalytics(admin, { siteId: site.id });

    expect((await lastSeenOf(site.id))?.getTime()).toBe(before?.getTime());
  });

  /** §8。UseCase 名と Permission を宣言で持つ（認可を書く場所は Application）。 */
  it('UseCase 名が analytics.today で Permission が analytics.read', () => {
    expect(getTodayAnalytics.name).toBe('analytics.today');
    expect(getTodayAnalytics.permission).toBe('analytics.read');
  });
});

/**
 * `collect` のホットパス（032-timezone-setting 設計 §6.1.4、受け入れ条件 #29 / #30）。
 *
 * 基準タイムゾーンを DB 由来にしても、**1 リクエストあたりの問い合わせは 2 本のまま**
 * （公開キーの照合と記録）。`saltDay` が呼ぶのは同期の `analyticsTimeZone()` だけで、
 * その中に DB を読む経路が無い。
 *
 * **計測が落ちる経路を新たに作らない。** 設定を読めなくても記録は続く。
 */
describe('collect のホットパス', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAnalyticsTimeZoneForTests();
    delete process.env['TORIFUNE_TIMEZONE'];
    resetTimeZoneWarning();
  });

  /** #29。タイムゾーンのための問い合わせが増えていない。 */
  it('collectAccess が system_settings を読まず、access_logs に触るのは 2 本のまま', async () => {
    const site = await makeSite();
    // キャッシュを新しくしておく（TTL 超過の読み直しは別の非同期処理であって、要求を待たせない）。
    await resolveAnalyticsTimeZone();

    const settings = vi.spyOn(systemSettingsRepository, 'loadAll');
    const findSite = vi.spyOn(analyticsRepository, 'findSiteByPublicKey');
    const record = vi.spyOn(analyticsRepository, 'recordAccess');

    const outcome = await collectAccess({
      publicKey: site.publicKey,
      path: '/',
      referrer: null,
      ipAddress: '203.0.113.5',
      userAgent: BROWSER,
    });

    expect(outcome).toEqual({ ok: true });
    expect(settings, 'タイムゾーンのために DB を読んでいる').not.toHaveBeenCalled();
    expect(findSite).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
  });

  /** #30。異常系。設定を読めない状態でも計測は成功する。 */
  it('system_settings を読めない状態でも collectAccess が成功する', async () => {
    const site = await makeSite();
    resetAnalyticsTimeZoneForTests();
    vi.spyOn(systemSettingsRepository, 'loadAll').mockRejectedValue(new Error('db is down'));

    const outcome = await collectAccess({
      publicKey: site.publicKey,
      path: '/x',
      referrer: null,
      ipAddress: '203.0.113.6',
      userAgent: BROWSER,
    });

    expect(outcome).toEqual({ ok: true });
    const rows = await withConnection((connection) =>
      connection.db.selectFrom('access_logs').select('path').execute(),
    );
    expect(rows.map((row) => row.path)).toEqual(['/x']);
  });
});
