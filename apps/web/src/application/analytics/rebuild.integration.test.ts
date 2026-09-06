import { sql } from 'kysely';
import pg from 'pg';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CORE_EVENTS } from '@torifune/plugin-api';
import { rebuildAnalyticsForTimeZone, REBUILD_CHUNK_DAYS } from '@/application/analytics/rebuild';
import { resetAnalyticsTimeZoneForTests } from '@/application/analytics/timezone';
import { resetEventHandlers, subscribe } from '@/application/events';
import { ROLLUP_JOB, TIMEZONE_REBUILD_JOB } from '@/application/jobs/definitions';
import { runJob, type RunOutcome } from '@/application/jobs/run-job';
import type { JobContext } from '@/application/jobs/scheduler';
import { withConnection } from '@/application/transaction';
import { shiftDays } from '@/domain/analytics/day';
import { analyticsRepository } from '@/infrastructure/analytics-repository';
import { JOB_LOCK_NAMESPACE, jobLockKey } from '@/infrastructure/job-lock';
import { jobRunRepository } from '@/infrastructure/job-run-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 洗い替え（032-timezone-setting 設計 §5.4 / §5.4.1 / §6.2 / §9.3、受け入れ条件
 * #31〜#47、#89〜#94、#108、#109、#115、#116〜#120、#123〜#130）。
 *
 * 洗い替えは 2 段。
 *
 * 1. 生ログのある期間を**新しい境目で 30 日ずつ**畳み直す（古い日 → 今日）
 * 2. **すべてのチャンクが終わってから**、その日に生ログが 1 行も無い (サイト, 日) の
 *    集計値を**出所を問わず**消す（裁定 §3.3 ＋ `要件.md` §7-1 の追加裁定）
 *
 * **削除は最後。** 先に消すと「消したのにロールアップが終わっていない」という、
 * 取り返しのつかない中断点ができる（§6.2.2）。
 *
 * `analytics.integration.test.ts` とは別ファイルにする。401 日ぶんの生ログ・複数サイト・
 * `source <> 'core'` の行という、別の下ごしらえを要るため（実装プラン §2）。
 */

let scratch: ScratchDatabase;

/** 生ログが無い日の集計値を入れる Plugin（`source <> 'core'`）。 */
const PLUGIN_SOURCE = 'example-plugin';
const OTHER_PLUGIN_SOURCE = 'another-plugin';
const CORE = 'core';

interface AnalyticsRow {
  readonly site_id: string;
  readonly metric_date: string;
  readonly source: string;
  readonly metric: string;
  readonly key: string;
  readonly value: string;
}

async function makeSite(status: 'active' | 'paused' | 'archived' = 'active'): Promise<string> {
  const id = uuidv7();
  await withConnection((connection) =>
    connection.db
      .insertInto('sites')
      .values({
        id,
        name: `rebuild-${id.slice(-8)}`,
        url: 'https://example.com',
        description: '',
        status,
        public_key: `${id.replaceAll('-', '')}${id.replaceAll('-', '')}`.slice(0, 64),
      })
      .execute(),
  );
  return id;
}

interface LogInput {
  /** ISO 8601（UTC）。 */
  readonly at: string;
  readonly visitor?: string;
  readonly path?: string;
  readonly device?: 'desktop' | 'mobile' | 'tablet' | 'bot';
}

async function insertLogs(siteId: string, logs: readonly LogInput[]): Promise<void> {
  if (logs.length === 0) {
    return;
  }
  await withConnection((connection) =>
    connection.db
      .insertInto('access_logs')
      .values(
        logs.map((entry) => ({
          id: uuidv7(),
          site_id: siteId,
          occurred_at: entry.at,
          path: entry.path ?? '/',
          referrer_host: null,
          visitor_hash: entry.visitor ?? 'visitor-1',
          device: entry.device ?? 'desktop',
        })),
      )
      .execute(),
  );
}

async function insertPoint(input: {
  readonly siteId: string;
  readonly metricDate: string;
  readonly source?: string;
  readonly metric?: string;
  readonly key?: string;
  readonly value?: number;
}): Promise<void> {
  await withConnection((connection) =>
    connection.db
      .insertInto('analytics')
      .values({
        site_id: input.siteId,
        metric_date: input.metricDate,
        source: input.source ?? CORE,
        metric: input.metric ?? 'pageviews',
        key: input.key ?? '',
        value: input.value ?? 1,
      })
      .execute(),
  );
}

async function analyticsRows(): Promise<AnalyticsRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<AnalyticsRow>`
      SELECT site_id, to_char(metric_date, 'YYYY-MM-DD') AS metric_date, source, metric, key, value::text AS value
      FROM analytics
      ORDER BY site_id, metric_date, source, metric, key
    `.execute(connection.db);
    return result.rows;
  });
}

/** (サイト, 日) の組（出所は問わない）。 */
async function metricDays(): Promise<string[]> {
  const rows = await analyticsRows();
  return [...new Set(rows.map((row) => `${row.site_id}#${row.metric_date}`))].sort();
}

async function rowsOf(source: string): Promise<AnalyticsRow[]> {
  return (await analyticsRows()).filter((row) => row.source === source);
}

/** ジョブの記録を使わずに本体だけを走らせるための `JobContext`。 */
function fakeJob(): { context: JobContext; reports: Record<string, unknown>[] } {
  const reports: Record<string, unknown>[] = [];
  return {
    context: {
      runId: uuidv7(),
      async report(summary) {
        reports.push({ ...summary });
      },
    },
    reports,
  };
}

async function rebuild(
  timeZone: string,
  previousTimeZone = timeZone,
): Promise<{ summary: Record<string, unknown>; reports: Record<string, unknown>[] }> {
  const job = fakeJob();
  const summary = await withConnection((connection) =>
    rebuildAnalyticsForTimeZone(connection, { timeZone, previousTimeZone }, job.context),
  );
  return { summary: { ...summary }, reports: job.reports };
}

interface JobRunRow {
  readonly job_name: string;
  readonly status: string;
  readonly summary: Record<string, unknown>;
}

async function jobRuns(name?: string): Promise<JobRunRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<JobRunRow>`
      SELECT job_name, status, summary FROM job_runs
      ORDER BY started_at DESC, id DESC
    `.execute(connection.db);
    return name === undefined ? result.rows : result.rows.filter((row) => row.job_name === name);
  });
}

/** 別の接続で advisory lock を握る（`run-job.integration.test.ts` の先例）。 */
async function holdLock(name: string): Promise<{ release(): Promise<void> }> {
  const client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2) AS locked',
    [JOB_LOCK_NAMESPACE, jobLockKey(name)],
  );
  expect(result.rows[0]?.locked, `ロックが取れない: ${name}`).toBe(true);
  return {
    async release() {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        JOB_LOCK_NAMESPACE,
        jobLockKey(name),
      ]);
      await client.end();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 「今日」から十分に離れた過去の日（洗い替えの範囲に必ず入る）。 */
const OLD_DAY = '2026-01-10';

/**
 * サイトを「計測しているサイト」にするための生ログ 1 行の置き場（§5.4.1）。
 *
 * **生ログが 1 行も無いサイトは削除の対象外になった。**
 * 消えることを確かめたいテストは、消したい日とは**別の日**に 1 行置いて
 * 「計測しているサイト」にしてから確かめる。
 */
const TRACKING_DAY = '2026-03-15';

/** そのサイトを「計測しているサイト」にする（消したい日とは別の日に 1 行置く）。 */
async function markTracked(siteId: string, day: string = TRACKING_DAY): Promise<void> {
  await insertLogs(siteId, [{ at: `${day}T10:00:00Z`, visitor: 'tracking' }]);
}

/** UTC の今日（`YYYY-MM-DD`）。 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `analytics.purged` の Payload（§9.3.1）。 */
interface PurgedPayload {
  readonly timeZone: string;
  readonly rows: number;
  readonly sites: readonly {
    readonly siteId: string;
    readonly from: string;
    readonly to: string;
    readonly rows: number;
    readonly sources: readonly string[];
  }[];
}

/** `analytics.purged` を購読して、届いた Payload を集める。 */
function capturePurged(): PurgedPayload[] {
  const seen: PurgedPayload[] = [];
  subscribe('analytics.purged', (payload) => {
    seen.push(payload as PurgedPayload);
  });
  return seen;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('rebuild');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(() => {
  process.env['TORIFUNE_TIMEZONE'] = 'UTC';
  resetAnalyticsTimeZoneForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetEventHandlers();
  delete process.env['TORIFUNE_TIMEZONE'];
  resetAnalyticsTimeZoneForTests();

  await withConnection(async (connection) => {
    await connection.db.deleteFrom('access_logs').execute();
    await connection.db.deleteFrom('analytics').execute();
    await connection.db.deleteFrom('sites').execute();
    await sql`DELETE FROM job_runs`.execute(connection.db);
  });
});

/**
 * 洗い替えの範囲と削除条件（Infrastructure。#31〜#38、#89、#90、#92、#93）。
 */
describe('findOldestAccessAt', () => {
  /** #31 */
  it('生ログの最古の occurred_at を返す', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-03-02T05:00:00Z' }, { at: '2026-01-05T23:30:00Z' }]);

    const oldest = await withConnection((connection) =>
      analyticsRepository.findOldestAccessAt(connection),
    );

    expect(oldest?.toISOString()).toBe('2026-01-05T23:30:00.000Z');
  });

  /** #31。生ログが無ければ null（ロールアップの段を丸ごと飛ばす）。 */
  it('生ログが 1 行も無ければ null', async () => {
    await expect(
      withConnection((connection) => analyticsRepository.findOldestAccessAt(connection)),
    ).resolves.toBeNull();
  });

  /** #31。全サイトを見る（サイトごとではない）。 */
  it('サイトをまたいで最古を返す', async () => {
    const a = await makeSite();
    const b = await makeSite();
    await insertLogs(a, [{ at: '2026-03-02T05:00:00Z' }]);
    await insertLogs(b, [{ at: '2026-02-01T00:00:00Z' }]);

    const oldest = await withConnection((connection) =>
      analyticsRepository.findOldestAccessAt(connection),
    );

    expect(oldest?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('summarizeStaleDays', () => {
  /**
   * #32。**出所で絞らない。** 行数だけを `core` / `core 以外` に分けて返す。
   */
  it('生ログの無い (サイト, 日) の数・最古・最新と、出所ごとの行数を返す', async () => {
    const site = await makeSite();
    // §5.4.1：対象になるのは「計測しているサイト」だけ。
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02', metric: 'pageviews' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', metric: 'visitors' });
    await insertPoint({
      siteId: site,
      metricDate: '2026-01-05',
      source: PLUGIN_SOURCE,
      metric: 'pageviews',
    });

    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect(summary.days).toBe(2);
    expect(summary.sites).toBe(1);
    expect(summary.from).toBe('2026-01-02');
    expect(summary.to).toBe('2026-01-05');
    expect(summary.coreRows).toBe(2);
    expect(summary.pluginRows).toBe(1);
  });

  /** #33。生ログのある日は対象に含まれない。 */
  it('その日に生ログがある (サイト, 日) は含めない', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-02T10:00:00Z' }]);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-03' });

    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect(summary.days).toBe(1);
    expect(summary.from).toBe('2026-01-03');
    expect(summary.to).toBe('2026-01-03');
  });

  /**
   * #34。境界値。**タイムゾーンを変えると対象が変わる。**
   *
   * `2026-01-01T00:30Z` の生ログは `UTC` では `2026-01-01`、
   * `America/Los_Angeles`（−8）では `2025-12-31 16:30` になる。
   * 後者では旧 `2026-01-01` の行がどの生ログにも対応しなくなり、対象になる。
   */
  it('新しいタイムゾーンで見て生ログが無くなった日が対象に入る', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-01T00:30:00Z' }]);
    await insertPoint({ siteId: site, metricDate: '2026-01-01' });

    const inUtc = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );
    const inLosAngeles = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'America/Los_Angeles'),
    );

    expect(inUtc.days).toBe(0);
    expect(inLosAngeles.days).toBe(1);
    expect(inLosAngeles.from).toBe('2026-01-01');
  });

  /** #92。消える行を持つ Plugin の ID を重複なく返し、`'core'` を含めない。 */
  it('lostSources に Plugin の ID だけを重複なく返す', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', source: PLUGIN_SOURCE });
    await insertPoint({
      siteId: site,
      metricDate: '2026-01-03',
      source: PLUGIN_SOURCE,
      metric: 'visitors',
    });
    await insertPoint({ siteId: site, metricDate: '2026-01-03', source: OTHER_PLUGIN_SOURCE });

    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect([...summary.sources].sort()).toEqual([OTHER_PLUGIN_SOURCE, PLUGIN_SOURCE].sort());
    expect(summary.sources).not.toContain(CORE);
  });

  /** #93。境界値。Plugin の行が 1 件も消えないとき。 */
  it('Plugin の行が消えないなら pluginRows は 0、sources は空', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });

    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect(summary.pluginRows).toBe(0);
    expect(summary.sources).toEqual([]);
    expect(summary.coreRows).toBe(1);
  });

  /** #32。対象が無ければ 0 と null（画面が「消える集計値：ありません」を出す）。 */
  it('対象が無ければ 0 件で from / to は null', async () => {
    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect(summary).toMatchObject({
      days: 0,
      sites: 0,
      coreRows: 0,
      pluginRows: 0,
      from: null,
      to: null,
      sources: [],
    });
  });
});

describe('deleteStalePoints', () => {
  /**
   * #35 / #89。**`source = 'core'` と Plugin の行の両方を消す。**
   *
   * `要件.md` §7-1 の追加裁定。当初は Core の行だけを消す設計だったが、
   * 「洗い替え後の `analytics` には生ログのある期間だけが残る」を一律に適用する。
   */
  it('同じ (サイト, 日) の core と Plugin の行を両方消す', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', source: PLUGIN_SOURCE });

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 1, pluginRows: 1 });
    expect(await analyticsRows()).toEqual([]);
  });

  /** #36。消した行数を出所ごとに返し、2 回目は両方 0（冪等）。 */
  it('消した行数を出所ごとに返し、2 回目は 0 になる', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', metric: 'visitors' });
    await insertPoint({ siteId: site, metricDate: '2026-01-03', source: PLUGIN_SOURCE });

    const first = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );
    const second = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(first).toMatchObject({ coreRows: 2, pluginRows: 1 });
    expect(second).toMatchObject({ coreRows: 0, pluginRows: 0 });
  });

  /**
   * #120。異常系の回帰。**#37 と対をなす。**
   *
   * **生ログが 1 行も無い環境では 1 行も消さない**（§5.4.1。対象になるサイトが 1 つも無い）。
   * 初版はここで全件が消えており、計測タグを一度も貼っていないサイトの値まで失われていた。
   *
   * 対（#37）は「**生ログを 1 行でも持つサイト**では、生ログの残っていない期間が
   * Core も Plugin も含めて消える」。下の `#37` のテストで見る。
   */
  it('生ログが 1 行も無ければ Core も Plugin も 1 行も消さない', async () => {
    const a = await makeSite();
    const b = await makeSite();
    await insertPoint({ siteId: a, metricDate: '2026-01-02' });
    await insertPoint({ siteId: b, metricDate: '2026-02-02', source: PLUGIN_SOURCE });
    const before = await analyticsRows();

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 0, pluginRows: 0, sites: [] });
    expect(await analyticsRows()).toEqual(before);
  });

  /**
   * #37。**#120 と対をなす。**
   *
   * 生ログを 1 行でも持つサイトでは、生ログの残っていない期間の集計値が
   * **Core も Plugin も含めてすべて消え**、生ログのある日の集計値は残る
   * （裁定 §3.3 ＋ `要件.md` §7-1 を、§5.4.1 でサイトを絞ったあとの実態）。
   */
  it('生ログを持つサイトでは、生ログの無い期間だけが出所を問わず消える', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-05T10:00:00Z' }]);
    // 生ログのある日。残る。
    await insertPoint({ siteId: site, metricDate: '2026-01-05' });
    await insertPoint({ siteId: site, metricDate: '2026-01-05', source: PLUGIN_SOURCE });
    // 生ログの残っていない期間。Core も Plugin も消える。
    await insertPoint({ siteId: site, metricDate: '2026-01-01' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', source: PLUGIN_SOURCE });

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 1, pluginRows: 1 });
    const remaining = await analyticsRows();
    expect(remaining.map((row) => row.metric_date)).toEqual(['2026-01-05', '2026-01-05']);
    expect(remaining.map((row) => row.source).sort()).toEqual([CORE, PLUGIN_SOURCE].sort());
  });

  /** #38。サイトの状態で例外を作らない（残すと混在の説明が付かない）。 */
  it('archived のサイトの行も出所を問わず消える', async () => {
    const site = await makeSite('archived');
    // 状態で例外を作らないことを見るので、計測しているサイトにしてから確かめる（§5.4.1）。
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', source: PLUGIN_SOURCE });

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 1, pluginRows: 1 });
    expect(await analyticsRows()).toEqual([]);
  });

  /** #90。境界値。**消える条件は「その日に生ログが無い」だけで、出所ではない。** */
  it('生ログのある日の Plugin の行は残る', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-02T10:00:00Z' }]);
    await insertPoint({ siteId: site, metricDate: '2026-01-02', source: PLUGIN_SOURCE, value: 42 });
    await insertPoint({ siteId: site, metricDate: '2026-01-09', source: PLUGIN_SOURCE, value: 7 });

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 0, pluginRows: 1 });
    const remaining = await rowsOf(PLUGIN_SOURCE);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.metric_date).toBe('2026-01-02');
    expect(remaining[0]?.value).toBe('42');
  });

  /** #34 の削除側。タイムゾーンで対象が変わる。 */
  it('タイムゾーンを変えると消える対象が変わる', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-01T00:30:00Z' }]);
    await insertPoint({ siteId: site, metricDate: '2026-01-01' });

    const inUtc = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );
    expect(inUtc).toMatchObject({ coreRows: 0, pluginRows: 0 });

    const inLosAngeles = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'America/Los_Angeles'),
    );
    expect(inLosAngeles).toMatchObject({ coreRows: 1, pluginRows: 0 });
  });
});

/**
 * 洗い替えジョブの本体（#39〜#45、#91、#108、#115）。
 */
describe('rebuildAnalyticsForTimeZone', () => {
  /** チャンク幅は 30 日（設計 §6.2.1）。 */
  it('チャンク幅は 30 日', () => {
    expect(REBUILD_CHUNK_DAYS).toBe(30);
  });

  /**
   * #39。新しい境目で畳み直される。
   *
   * `2026-01-02T20:00Z` は `UTC` では 1/2、`Asia/Tokyo` では 1/3 の 05:00。
   */
  it('新しいタイムゾーンの境目で metric_date が決まる', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-02T20:00:00Z' }]);

    await rebuild('Asia/Tokyo');

    const core = await rowsOf(CORE);
    expect(core.length).toBeGreaterThan(0);
    expect([...new Set(core.map((row) => row.metric_date))]).toEqual(['2026-01-03']);
  });

  /** #39 の対。UTC なら 1/2 のまま。 */
  it('UTC のままなら metric_date は変わらない', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-02T20:00:00Z' }]);

    await rebuild('UTC');

    expect([...new Set((await rowsOf(CORE)).map((row) => row.metric_date))]).toEqual([
      '2026-01-02',
    ]);
  });

  /**
   * #40。境界値。**30 日ずつのチャンクに分かれても取りこぼさない。**
   *
   * 401 日ぶん（今日を含む）。チャンク境界の 30 日目・31 日目・401 日目が入る。
   */
  it('401 日ぶんの生ログでも全期間ぶんを畳む', async () => {
    const site = await makeSite();
    const today = new Date().toISOString().slice(0, 10);
    const logs: LogInput[] = [];
    for (let back = 400; back >= 0; back -= 1) {
      logs.push({ at: `${shiftDays(today, -back)}T12:00:00Z` });
    }
    await insertLogs(site, logs);

    const { summary } = await rebuild('UTC');

    expect(summary['from']).toBe(shiftDays(today, -400));
    expect(summary['to']).toBe(today);
    expect(summary['completedThrough']).toBe(today);
    expect(summary['days']).toBe(401);
    expect(await metricDays()).toHaveLength(401);
  }, 120_000);

  /**
   * #41。生ログが無ければロールアップの段を飛ばす。
   *
   * 削除の段は通るが、**対象になるサイトが 1 つも無いので 1 行も消えない**（§5.4.1、#120）。
   */
  it('生ログが 1 行も無ければ from / to は null で、1 行も消えない', async () => {
    const site = await makeSite();
    await insertPoint({ siteId: site, metricDate: OLD_DAY });
    await insertPoint({ siteId: site, metricDate: OLD_DAY, source: PLUGIN_SOURCE });
    const before = await analyticsRows();

    const { summary } = await rebuild('Asia/Tokyo');

    expect(summary['from']).toBeNull();
    expect(summary['to']).toBeNull();
    expect(summary['days']).toBe(0);
    expect(summary['points']).toBe(0);
    expect(summary['deletedCoreRows']).toBe(0);
    expect(summary['deletedPluginRows']).toBe(0);
    expect(await analyticsRows()).toEqual(before);
  });

  /** #42。冪等。 */
  it('同じ入力で 2 回走らせても行が二重にならない', async () => {
    const site = await makeSite();
    await insertLogs(site, [
      { at: `${OLD_DAY}T10:00:00Z`, visitor: 'a' },
      { at: `${OLD_DAY}T10:05:00Z`, visitor: 'b' },
    ]);

    await rebuild('UTC');
    const first = await analyticsRows();
    await rebuild('UTC');
    const second = await analyticsRows();

    expect(second).toEqual(first);
  });

  /** #43。チャンクごとに進捗を報告する。 */
  it('チャンクごとに completedThrough を報告する', async () => {
    const site = await makeSite();
    const today = new Date().toISOString().slice(0, 10);
    // 70 日ぶん = 30 / 30 / 10 の 3 チャンク。
    await insertLogs(site, [
      { at: `${shiftDays(today, -69)}T12:00:00Z` },
      { at: `${shiftDays(today, -35)}T12:00:00Z` },
      { at: `${today}T12:00:00Z` },
    ]);

    const { reports, summary } = await rebuild('UTC');

    const progress = reports
      .map((report) => report['completedThrough'])
      .filter((value): value is string => typeof value === 'string');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    // 単調に進み、最後は `to` と等しい。
    expect([...progress].sort()).toEqual(progress);
    expect(progress.at(-1)).toBe(summary['to']);
  }, 60_000);

  /**
   * #44。**削除はすべてのチャンクの後に 1 回だけ。**
   *
   * 途中で落ちたときに「消したのにロールアップが終わっていない」状態を作らない（§6.2.2）。
   */
  it('ロールアップが途中で失敗したら削除は実行されない', async () => {
    const site = await makeSite();
    const today = new Date().toISOString().slice(0, 10);
    await insertLogs(site, [
      { at: `${shiftDays(today, -69)}T12:00:00Z` },
      { at: `${today}T12:00:00Z` },
    ]);
    await insertPoint({ siteId: site, metricDate: OLD_DAY });

    const deleteSpy = vi.spyOn(analyticsRepository, 'deleteStalePoints');
    let calls = 0;
    const original = analyticsRepository.aggregateDailyBreakdown.bind(analyticsRepository);
    vi.spyOn(analyticsRepository, 'aggregateDailyBreakdown').mockImplementation(
      async (connection, range) => {
        calls += 1;
        if (calls >= 2) {
          throw new Error('チャンクの途中で落ちた');
        }
        return original(connection, range);
      },
    );

    await expect(rebuild('UTC')).rejects.toThrow('チャンクの途中で落ちた');

    expect(deleteSpy).not.toHaveBeenCalled();
    // 生ログの無い日の行はまだ残っている（失っていない）。
    expect(await rowsOf(CORE)).toEqual(
      expect.arrayContaining([expect.objectContaining({ metric_date: OLD_DAY })]),
    );
  }, 60_000);

  /** #44 の対。完走したら削除はちょうど 1 回。 */
  it('完走したら削除はちょうど 1 回だけ呼ばれる', async () => {
    const site = await makeSite();
    const today = new Date().toISOString().slice(0, 10);
    await insertLogs(site, [
      { at: `${shiftDays(today, -69)}T12:00:00Z` },
      { at: `${today}T12:00:00Z` },
    ]);

    const deleteSpy = vi.spyOn(analyticsRepository, 'deleteStalePoints');

    await rebuild('UTC');

    expect(deleteSpy).toHaveBeenCalledTimes(1);
  }, 60_000);

  /** #45。走行中に届いた生ログが、その日のチャンク処理前なら集計に含まれる。 */
  it('走行中に届いた生ログでも、その日のチャンク処理前なら含まれる', async () => {
    const site = await makeSite();
    const today = new Date().toISOString().slice(0, 10);
    const oldDay = shiftDays(today, -69);
    await insertLogs(site, [{ at: `${oldDay}T12:00:00Z` }, { at: `${today}T01:00:00Z` }]);

    let first = true;
    const original = analyticsRepository.aggregateDailyBreakdown.bind(analyticsRepository);
    vi.spyOn(analyticsRepository, 'aggregateDailyBreakdown').mockImplementation(
      async (connection, range) => {
        if (first) {
          first = false;
          // 最初のチャンクの処理中に「今日」へ 1 件届く。
          await insertLogs(site, [{ at: `${today}T02:00:00Z`, visitor: 'late-visitor' }]);
        }
        return original(connection, range);
      },
    );

    await rebuild('UTC');

    const todayViews = (await rowsOf(CORE)).find(
      (row) => row.metric_date === today && row.metric === 'pageviews' && row.key === '',
    );
    expect(todayViews?.value).toBe('2');
  }, 60_000);

  /**
   * #91。境界値。Plugin の行は**削除の対象にはなるが、洗い替え（再集計）の対象にはならない。**
   *
   * `replaceCorePoints` は従来どおり `source = 'core'` だけを差し替える。
   */
  it('生ログのある日の Plugin の行は、洗い替えで値を書き換えられない', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: `${OLD_DAY}T10:00:00Z` }]);
    await insertPoint({
      siteId: site,
      metricDate: OLD_DAY,
      source: PLUGIN_SOURCE,
      metric: 'pageviews',
      value: 999,
    });

    const before = await rowsOf(PLUGIN_SOURCE);
    await rebuild('UTC');
    const after = await rowsOf(PLUGIN_SOURCE);

    expect(after).toEqual(before);
    expect(after[0]?.value).toBe('999');
  });

  /**
   * #115。**`previousTimeZone` は記録専用。**
   *
   * 同じ `timeZone` で `previousTimeZone` だけ違う 2 通りの入力を与えると、
   * `analytics` の行も `summary` の数も一致する（§6.2.6）。
   */
  it('previousTimeZone を変えても洗い替えの結果が変わらない', async () => {
    async function runWith(previousTimeZone: string): Promise<{
      rows: AnalyticsRow[];
      counted: Record<string, unknown>;
    }> {
      // 同じ初期状態から始める。
      await withConnection(async (connection) => {
        await connection.db.deleteFrom('analytics').execute();
        await connection.db.deleteFrom('access_logs').execute();
      });
      await insertLogs(site, [
        { at: `${OLD_DAY}T10:00:00Z`, visitor: 'a' },
        { at: `${OLD_DAY}T10:10:00Z`, visitor: 'b' },
      ]);
      await insertPoint({ siteId: site, metricDate: '2026-01-01' });
      await insertPoint({ siteId: site, metricDate: '2026-01-01', source: PLUGIN_SOURCE });

      const { summary } = await rebuild('Asia/Tokyo', previousTimeZone);
      return {
        rows: await analyticsRows(),
        counted: {
          days: summary['days'],
          points: summary['points'],
          deletedCoreRows: summary['deletedCoreRows'],
          deletedPluginRows: summary['deletedPluginRows'],
        },
      };
    }

    const site = await makeSite();
    const a = await runWith('UTC');
    const b = await runWith('America/Los_Angeles');

    expect(b.rows).toEqual(a.rows);
    expect(b.counted).toEqual(a.counted);
    expect(a.counted['deletedCoreRows']).toBe(1);
    expect(a.counted['deletedPluginRows']).toBe(1);
  });
});

/**
 * ジョブとして走らせたとき（#43 の DB 側、#46〜#47、#94、#108、#109）。
 */
describe('analytics.timezoneRebuild をジョブとして走らせる', () => {
  /** 定期実行に載せない（周期を持たない）。 */
  it('TIMEZONE_REBUILD_JOB は周期を持たず、鍵はロールアップと同じ', () => {
    expect(TIMEZONE_REBUILD_JOB.name).toBe('analytics.timezoneRebuild');
    expect(TIMEZONE_REBUILD_JOB.lockName).toBe('analytics.rollup');
    expect(TIMEZONE_REBUILD_JOB).not.toHaveProperty('intervalMs');
  });

  /** #94。何をいくつ消したかが記録に残る（`要件.md` §7-1）。 */
  it('job_runs.summary に deletedCoreRows と deletedPluginRows が別々に残る', async () => {
    const site = await makeSite();
    // §5.4.1：対象になるのは計測しているサイトだけ。今日に 1 行だけ置く
    // （洗い替えの範囲が 1 チャンクで収まる）。
    await markTracked(site, todayUtc());
    await insertPoint({ siteId: site, metricDate: OLD_DAY });
    await insertPoint({ siteId: site, metricDate: OLD_DAY, metric: 'visitors' });
    await insertPoint({ siteId: site, metricDate: OLD_DAY, source: PLUGIN_SOURCE });

    const outcome = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'Asia/Tokyo', previousTimeZone: 'UTC' },
      }),
    );

    expect(outcome.outcome).toBe('ok');
    const runs = await jobRuns('analytics.timezoneRebuild');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.summary).toMatchObject({
      timeZone: 'Asia/Tokyo',
      previousTimeZone: 'UTC',
      deletedDays: 1,
      deletedCoreRows: 2,
      deletedPluginRows: 1,
    });
  });

  /** #43 の DB 側。チャンクごとに `job_runs.summary` を書き換える。 */
  it('チャンクごとに job_runs.summary を更新する', async () => {
    const site = await makeSite();
    const today = new Date().toISOString().slice(0, 10);
    await insertLogs(site, [
      { at: `${shiftDays(today, -69)}T12:00:00Z` },
      { at: `${shiftDays(today, -35)}T12:00:00Z` },
      { at: `${today}T12:00:00Z` },
    ]);

    const spy = vi.spyOn(jobRunRepository, 'updateSummary');

    await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'UTC', previousTimeZone: 'Asia/Tokyo' },
      }),
    );

    const progress = spy.mock.calls
      .map((call) => (call[2] as Record<string, unknown>)['completedThrough'])
      .filter((value): value is string => typeof value === 'string');
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toBe(today);
  }, 60_000);

  /**
   * #46。**同じ鍵で排他する。**
   *
   * 洗い替えが `analytics.rollup` の鍵を握っている間、定期ロールアップは `skipped` になる。
   */
  it('洗い替えの実行中に analytics.rollup を起こすと skipped になる', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: `${OLD_DAY}T10:00:00Z` }]);

    let rollupOutcome: RunOutcome | null = null;
    const original = analyticsRepository.aggregateDailyBreakdown.bind(analyticsRepository);
    vi.spyOn(analyticsRepository, 'aggregateDailyBreakdown').mockImplementation(
      async (connection, range) => {
        // 洗い替えが鍵を握っている最中に、定期ロールアップを起こす。
        if (rollupOutcome === null) {
          rollupOutcome = await withConnection((other) =>
            runJob(other, ROLLUP_JOB, {
              trigger: 'scheduled',
              wait: false,
              input: { from: OLD_DAY, to: OLD_DAY },
            }),
          );
        }
        return original(connection, range);
      },
    );

    const outcome = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'UTC', previousTimeZone: 'Asia/Tokyo' },
      }),
    );

    expect(outcome.outcome).toBe('ok');
    expect(rollupOutcome).not.toBeNull();
    expect((rollupOutcome as unknown as RunOutcome).outcome).toBe('skipped');
  }, 60_000);

  /** #47。逆も同じ。ロールアップが走っている間は洗い替えが `skipped` になる。 */
  it('analytics.rollup の実行中に洗い替えを待たせずに起こすと skipped になる', async () => {
    const lock = await holdLock('analytics.rollup');
    try {
      const outcome = await withConnection((connection) =>
        runJob(connection, TIMEZONE_REBUILD_JOB, {
          trigger: 'manual',
          wait: false,
          input: { timeZone: 'UTC', previousTimeZone: 'Asia/Tokyo' },
        }),
      );

      expect(outcome.outcome).toBe('skipped');
    } finally {
      await lock.release();
    }
  });

  /** #48 の対。記録されるのは**ジョブ名**であって鍵の名前ではない。 */
  it('skipped の job_runs.job_name は analytics.timezoneRebuild', async () => {
    const lock = await holdLock('analytics.rollup');
    try {
      await withConnection((connection) =>
        runJob(connection, TIMEZONE_REBUILD_JOB, {
          trigger: 'manual',
          wait: false,
          input: { timeZone: 'UTC', previousTimeZone: 'UTC' },
        }),
      );
    } finally {
      await lock.release();
    }

    const runs = await jobRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.job_name).toBe('analytics.timezoneRebuild');
    expect(runs[0]?.status).toBe('skipped');
  });

  /**
   * #108。失敗した洗い替えをやり直すと、**同じ結果に収束する**（冪等）。
   */
  it('失敗した洗い替えをやり直すと同じ結果に収束する', async () => {
    const site = await makeSite();
    await insertLogs(site, [
      { at: `${OLD_DAY}T10:00:00Z`, visitor: 'a' },
      { at: `${OLD_DAY}T10:10:00Z`, visitor: 'b' },
    ]);
    await insertPoint({ siteId: site, metricDate: '2026-01-01' });
    await insertPoint({ siteId: site, metricDate: '2026-01-01', source: PLUGIN_SOURCE });

    // 1 回目：ロールアップの最中に落ちる。
    const original = analyticsRepository.aggregateDailyBreakdown.bind(analyticsRepository);
    const failing = vi
      .spyOn(analyticsRepository, 'aggregateDailyBreakdown')
      .mockRejectedValueOnce(new Error('一時的な失敗'));

    const failed = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'Asia/Tokyo', previousTimeZone: 'UTC' },
      }),
    );
    expect(failed.outcome).toBe('error');
    // 失敗した時点では、生ログの無い日の行がまだ残っている。
    expect((await analyticsRows()).length).toBeGreaterThan(0);

    // 2 回目：やり直し（`previousTimeZone === timeZone`）。
    failing.mockImplementation(original);
    const retried = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'Asia/Tokyo', previousTimeZone: 'Asia/Tokyo' },
      }),
    );
    expect(retried.outcome).toBe('ok');
    const afterRetry = await analyticsRows();

    // 3 回目：最初から成功した場合と同じ状態になる。
    const third = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'Asia/Tokyo', previousTimeZone: 'Asia/Tokyo' },
      }),
    );
    expect(third.outcome).toBe('ok');
    expect(await analyticsRows()).toEqual(afterRetry);
    // 生ログの無い 2026-01-01 の行は Core も Plugin も消えている。
    expect(afterRetry.every((row) => row.metric_date !== '2026-01-01')).toBe(true);
  }, 60_000);

  /**
   * #109。**自動再試行が無い。**
   *
   * 失敗が繰り返す状況で重い集計が延々と走り続けるのを防ぐ（`要件.md` §7-2）。
   * 立て直しは人が押す（設定画面の再実行ボタン）。
   */
  it('error で終わったあと時間を進めても、新しい実行が始まらない', async () => {
    vi.spyOn(analyticsRepository, 'findOldestAccessAt').mockRejectedValue(new Error('落ちる'));

    const failed = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'Asia/Tokyo', previousTimeZone: 'UTC' },
      }),
    );
    expect(failed.outcome).toBe('error');
    expect(await jobRuns('analytics.timezoneRebuild')).toHaveLength(1);

    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();

    await sleep(200);
    expect(await jobRuns('analytics.timezoneRebuild')).toHaveLength(1);
  });
});

/**
 * 追加 A：生ログが 1 行も無いサイトは削除の対象外（設計 §5.4.1、受け入れ条件 #116〜#120）。
 *
 * **計測タグを一度も貼っていないサイト**——Plugin が外部サービスの数値を取り込むためだけに
 * 作られたサイト——は `access_logs` が 0 行であり、初版の条件では**保持期間に関係なく
 * 全期間・全件が消えていた。**
 *
 * 消す根拠は「**旧タイムゾーンで畳まれた値**が新しい境目の値に混ざるから」であり、
 * 本体が一度も畳んでいないサイトにはその値が 1 行も無い。**消す理由が無い。**
 *
 * 緩めたのは「**どのサイトを見るか**」だけ。対象になったサイトの中では
 * `要件.md` §7-1 の裁定（出所で例外を作らない）をそのまま維持する。
 */
describe('生ログが 1 行も無いサイト', () => {
  /** #116。Core も Plugin も残る。 */
  it('access_logs が 1 行も無いサイトの集計値は、洗い替えのあとも全件残る', async () => {
    const untracked = await makeSite();
    await insertPoint({ siteId: untracked, metricDate: '2026-01-02', metric: 'pageviews' });
    await insertPoint({ siteId: untracked, metricDate: '2026-01-02', metric: 'visitors' });
    await insertPoint({ siteId: untracked, metricDate: '2026-02-03', source: PLUGIN_SOURCE });
    const before = await analyticsRows();

    await rebuild('Asia/Tokyo');

    expect(await analyticsRows()).toEqual(before);
  });

  /**
   * #117。境界値。**緩めたのはサイトの選び方だけ。**
   *
   * 計測しているサイトでは、生ログの無い (サイト, 日) が従来どおり出所を問わず消える。
   */
  it('生ログを 1 行でも持つサイトでは、生ログの無い日が出所を問わず消える', async () => {
    const tracked = await makeSite();
    const untracked = await makeSite();
    await markTracked(tracked);
    await insertPoint({ siteId: tracked, metricDate: '2026-01-02' });
    await insertPoint({ siteId: tracked, metricDate: '2026-01-02', source: PLUGIN_SOURCE });
    await insertPoint({ siteId: untracked, metricDate: '2026-01-02' });
    await insertPoint({ siteId: untracked, metricDate: '2026-01-02', source: PLUGIN_SOURCE });

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 1, pluginRows: 1 });
    // 計測しているサイトの行だけが消え、していないサイトの行は両方残る。
    expect((await analyticsRows()).map((row) => row.site_id)).toEqual(
      [untracked, untracked].sort(),
    );
  });

  /**
   * #118。境界値。生ログが**ちょうど 1 行**のサイト。
   *
   * その 1 行が属する日は残り、それ以外の日は消える。
   */
  it('生ログが 1 行のサイトは、その日だけ残って他の日が消える', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: '2026-01-05T10:00:00Z' }]);
    await insertPoint({ siteId: site, metricDate: '2026-01-05' });
    await insertPoint({ siteId: site, metricDate: '2026-01-04' });
    await insertPoint({ siteId: site, metricDate: '2026-01-06', source: PLUGIN_SOURCE });

    const deleted = await withConnection((connection) =>
      analyticsRepository.deleteStalePoints(connection, 'UTC'),
    );

    expect(deleted).toMatchObject({ coreRows: 1, pluginRows: 1 });
    const remaining = await analyticsRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.metric_date).toBe('2026-01-05');
  });

  /** #119。プレビューにも数えない（ダイアログの件数が実際と食い違わない）。 */
  it('summarizeStaleDays が、生ログの無いサイトをどの数にも数えない', async () => {
    const untracked = await makeSite();
    await insertPoint({ siteId: untracked, metricDate: '2026-01-02' });
    await insertPoint({ siteId: untracked, metricDate: '2026-01-03', source: PLUGIN_SOURCE });

    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect(summary).toMatchObject({
      days: 0,
      sites: 0,
      coreRows: 0,
      pluginRows: 0,
      from: null,
      to: null,
      sources: [],
    });
  });

  /** #119 の対。計測しているサイトが混ざれば、そのぶんだけ数える。 */
  it('計測しているサイトのぶんだけを数える', async () => {
    const tracked = await makeSite();
    const untracked = await makeSite();
    await markTracked(tracked);
    await insertPoint({ siteId: tracked, metricDate: '2026-01-02' });
    await insertPoint({ siteId: untracked, metricDate: '2026-01-02' });
    await insertPoint({ siteId: untracked, metricDate: '2026-01-03', source: PLUGIN_SOURCE });

    const summary = await withConnection((connection) =>
      analyticsRepository.summarizeStaleDays(connection, 'UTC'),
    );

    expect(summary).toMatchObject({ days: 1, sites: 1, coreRows: 1, pluginRows: 0, sources: [] });
  });
});

/**
 * 追加 B：`analytics.purged`（設計 §9.3、受け入れ条件 #123〜#130）。
 *
 * **削除の段はイベントを 1 つも発火していなかった。**
 * 「◯◯日まで取り込み済み」という状態を持つ Plugin は、取り込み済みだと信じたまま
 * 行が消えた状態になり、二度と再取得しない。文書の改訂は**既に出荷済みの Plugin には届かない。**
 *
 * * **削除が成功したあと、1 回だけ**（サイトが複数でも 1 回。§9.3.2）
 * * **1 行も消えなければ発火しない**（起きていないことを知らせない）
 * * ハンドラの失敗は `emit` が握る（**洗い替えを Plugin の不具合で落とさない**）
 */
describe('analytics.purged', () => {
  /** #131 の一部。Core のイベントとして公開されている（Webhook でも受け取れる根拠）。 */
  it('CORE_EVENTS に analytics.purged が含まれる', () => {
    expect(CORE_EVENTS).toContain('analytics.purged');
  });

  /** #123。サイトが複数あっても 1 回だけ。 */
  it('1 行でも消した洗い替えが 1 回だけ発火する', async () => {
    const a = await makeSite();
    const b = await makeSite();
    await markTracked(a);
    await markTracked(b);
    await insertPoint({ siteId: a, metricDate: '2026-01-02' });
    await insertPoint({ siteId: b, metricDate: '2026-01-03' });
    const purged = capturePurged();

    await rebuild('Asia/Tokyo');

    expect(purged).toHaveLength(1);
    expect(purged[0]?.timeZone).toBe('Asia/Tokyo');
    expect(purged[0]?.sites).toHaveLength(2);
  });

  /** #124。境界値。**起きていないことを知らせない。** */
  it('1 行も消さなかった洗い替えは発火しない', async () => {
    const site = await makeSite();
    await insertLogs(site, [{ at: `${OLD_DAY}T10:00:00Z` }]);
    const purged = capturePurged();

    await rebuild('UTC');

    expect(purged).toEqual([]);
  });

  /** #125。取り直す期間を決められるだけの情報を載せる。 */
  it('sites[] に siteId / from / to / rows / sources が入り、from / to が最古・最新', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', metric: 'visitors' });
    await insertPoint({ siteId: site, metricDate: '2026-01-09', source: PLUGIN_SOURCE });
    const purged = capturePurged();

    await rebuild('UTC');

    expect(purged).toHaveLength(1);
    const entry = purged[0]?.sites[0];
    expect(entry?.siteId).toBe(site);
    expect(entry?.from).toBe('2026-01-02');
    expect(entry?.to).toBe('2026-01-09');
    expect(entry?.rows).toBe(3);
  });

  /** #126。**自分の値が消えたのかをここで判定できる。** */
  it('sites[].sources に消えた行の source が重複なく入り、Core が消えていれば core を含む', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', metric: 'visitors' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', source: PLUGIN_SOURCE });
    await insertPoint({ siteId: site, metricDate: '2026-01-03', source: PLUGIN_SOURCE });
    await insertPoint({ siteId: site, metricDate: '2026-01-03', source: OTHER_PLUGIN_SOURCE });
    const purged = capturePurged();

    await rebuild('UTC');

    const sources = [...(purged[0]?.sites[0]?.sources ?? [])].sort();
    expect(sources).toEqual([CORE, OTHER_PLUGIN_SOURCE, PLUGIN_SOURCE].sort());
  });

  /** #127。総行数が `summary` の内訳と一致する。 */
  it('rows が deletedCoreRows + deletedPluginRows と一致する', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    await insertPoint({ siteId: site, metricDate: '2026-01-02', metric: 'visitors' });
    await insertPoint({ siteId: site, metricDate: '2026-01-03', source: PLUGIN_SOURCE });
    const purged = capturePurged();

    const { summary } = await rebuild('UTC');

    const total = Number(summary['deletedCoreRows']) + Number(summary['deletedPluginRows']);
    expect(total).toBe(3);
    expect(purged[0]?.rows).toBe(total);
    expect(purged[0]?.sites.reduce((sum, entry) => sum + entry.rows, 0)).toBe(total);
  });

  /** #128。消えなかったサイトを叩き起こさない。 */
  it('消えなかったサイトは sites[] に現れない', async () => {
    const affected = await makeSite();
    const intact = await makeSite();
    await markTracked(affected);
    await insertPoint({ siteId: affected, metricDate: '2026-01-02' });
    // 生ログのある日にだけ集計値がある → 消えない。
    await insertLogs(intact, [{ at: '2026-01-05T10:00:00Z' }]);
    await insertPoint({ siteId: intact, metricDate: '2026-01-05' });
    const purged = capturePurged();

    await rebuild('UTC');

    expect(purged[0]?.sites.map((entry) => entry.siteId)).toEqual([affected]);
  });

  /**
   * #129。異常系。**洗い替えを Plugin の不具合で落とさない。**
   *
   * `emit` がハンドラの例外を握る（`application/events.ts`）。
   */
  it('ハンドラが例外を投げても洗い替えは ok で終わる', async () => {
    const site = await makeSite();
    await markTracked(site, todayUtc());
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    let called = 0;
    subscribe('analytics.purged', () => {
      called += 1;
      throw new Error('Plugin のハンドラが落ちた');
    });

    const outcome = await withConnection((connection) =>
      runJob(connection, TIMEZONE_REBUILD_JOB, {
        trigger: 'manual',
        wait: true,
        input: { timeZone: 'UTC', previousTimeZone: 'Asia/Tokyo' },
      }),
    );

    expect(outcome.outcome).toBe('ok');
    // **落ちるハンドラが本当に呼ばれたこと**まで見る（発火しなければ空振りで通ってしまう）。
    expect(called, 'analytics.purged が発火していない').toBe(1);
    const runs = await jobRuns('analytics.timezoneRebuild');
    expect(runs[0]?.status).toBe('ok');
    // 削除自体は済んでいる。
    expect(runs[0]?.summary).toMatchObject({ deletedCoreRows: 1 });
  }, 60_000);

  /** #130。異常系。**発火は削除の後**（§9.3.2）。削除が落ちれば知らせるものが無い。 */
  it('削除が失敗したときは発火しない', async () => {
    const site = await makeSite();
    await markTracked(site);
    await insertPoint({ siteId: site, metricDate: '2026-01-02' });
    const purged = capturePurged();
    const failing = vi
      .spyOn(analyticsRepository, 'deleteStalePoints')
      .mockRejectedValueOnce(new Error('消せない'));

    await expect(rebuild('UTC')).rejects.toThrow('消せない');

    expect(purged).toEqual([]);

    // **対照**：同じ下ごしらえで削除が通れば発火する。
    // これが無いと「そもそも発火しない実装」でもこのテストが通ってしまう。
    failing.mockRestore();
    await rebuild('UTC');
    expect(purged).toHaveLength(1);
  });
});
