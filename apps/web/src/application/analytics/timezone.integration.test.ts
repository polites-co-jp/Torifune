import { sql } from 'kysely';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsTimeZone,
  analyticsTimeZoneSetting,
  resetAnalyticsTimeZoneForTests,
  resetTimeZoneWarning,
  resolveAnalyticsTimeZone,
} from '@/application/analytics/timezone';
import {
  previewTimeZoneChange,
  rebuildAnalyticsTimeZone,
  updateAnalyticsTimeZone,
} from '@/application/analytics/timezone-use-cases';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { SYSTEM_SETTING_KEYS } from '@/domain/system-settings';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 基準タイムゾーンの解決・キャッシュと UseCase
 * （032-timezone-setting 設計 §6.1 / §6.4、受け入れ条件 #16〜#25、#53〜#62、#112〜#114）。
 *
 * 優先順位は **`system_settings` > `TORIFUNE_TIMEZONE` > `UTC`**（裁定 §3.1）。
 * 画面設定が環境変数に勝つので、既存環境は画面で触るまで env のまま動く。
 *
 * * 同期版 `analyticsTimeZone()` は**キャッシュを読むだけ**で DB を読まない（`collect` のホットパス）
 * * 非同期版 `resolveAnalyticsTimeZone()` は TTL（30 秒）を過ぎていれば読み直してから返す
 * * どちらも**落ちない。** DB の一時的な失敗で集計や画面を止めない
 *
 * 洗い替えは `startJobInBackground` で起きる（待てない）ので、
 * **`job_runs` に行が増えた／増えないを待ち合わせで見る**（実装プラン §8 #C）。
 */

/** 設計 §6.1.2 の `TIME_ZONE_TTL_MS`。 */
const TTL_MS = 30_000;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let viewer: AuthorizationContext;

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `t${suffix}`,
        email: `t${suffix}@example.com`,
        display_name: 'timezone test',
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
    loginId: `t${suffix}`,
    displayName: 'timezone test',
    email: `t${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** `system_settings` にタイムゾーンを直接書く（UseCase を通さずに前提を作る）。 */
async function storeTimeZone(value: unknown): Promise<void> {
  await withConnection((connection) =>
    systemSettingsRepository.put(connection, SYSTEM_SETTING_KEYS.analyticsTimeZone, value),
  );
}

async function storedTimeZone(): Promise<unknown> {
  const stored = await withConnection((connection) => systemSettingsRepository.loadAll(connection));
  return stored.get(SYSTEM_SETTING_KEYS.analyticsTimeZone);
}

interface JobRunRow {
  readonly job_name: string;
  readonly status: string;
  readonly summary: Record<string, unknown>;
}

async function rebuildRuns(): Promise<JobRunRow[]> {
  return withConnection(async (connection) => {
    const result = await sql<JobRunRow>`
      SELECT job_name, status, summary FROM job_runs
      WHERE job_name = 'analytics.timezoneRebuild'
      ORDER BY started_at DESC, id DESC
    `.execute(connection.db);
    return result.rows;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 条件が満たされるまで待つ（最大 `timeoutMs`）。
 *
 * **`setTimeout` で決め打ちの待ちを書かない**（実行環境で不安定になる。実装プラン §7 #7）。
 */
async function waitFor<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last = await read();
  while (!ok(last)) {
    if (Date.now() > until) {
      throw new Error(`待ち合わせがタイムアウトした: ${label}`);
    }
    await sleep(100);
    last = await read();
  }
  return last;
}

/** 洗い替えが 1 回終わるまで待ち、その `summary` を返す。 */
async function waitForRebuildSummary(): Promise<Record<string, unknown>> {
  const runs = await waitFor(
    rebuildRuns,
    (rows) => rows.length > 0 && rows[0]?.status !== 'running',
    'analytics.timezoneRebuild の完了',
  );
  expect(runs[0]?.status, JSON.stringify(runs[0]?.summary)).toBe('ok');
  return runs[0]?.summary ?? {};
}

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('timezone');
  admin = await contextFor('administrator');
  viewer = await contextFor('viewer');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(() => {
  delete process.env['TORIFUNE_TIMEZONE'];
  resetTimeZoneWarning();
  resetAnalyticsTimeZoneForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetLogger();
  delete process.env['TORIFUNE_TIMEZONE'];
  resetTimeZoneWarning();
  // **TTL 30 秒のキャッシュはテストをまたいで効く**（`processState` は globalThis に置かれる）。
  resetAnalyticsTimeZoneForTests();

  await withConnection(async (connection) => {
    await sql`DELETE FROM system_settings`.execute(connection.db);
    await sql`DELETE FROM job_runs`.execute(connection.db);
    await sql`DELETE FROM audit_logs`.execute(connection.db);
  });
});

describe('解決の優先順位', () => {
  /** #16 */
  it('設定も環境変数も無ければ UTC', async () => {
    await expect(resolveAnalyticsTimeZone()).resolves.toBe('UTC');
  });

  /** #17。裁定 §3.1。既存環境は画面で触るまで env のまま動く。 */
  it('設定が無ければ TORIFUNE_TIMEZONE を使う', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Asia/Tokyo');
  });

  /** #18。**画面設定が環境変数に勝つ。** */
  it('設定があれば環境変数より優先する', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';
    await storeTimeZone('Europe/Berlin');

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Europe/Berlin');
  });

  /** #19。異常系。**落ちない。** */
  it('設定が壊れていたら警告を出して UTC を返す', async () => {
    const logs = capture();
    await storeTimeZone('Foo/Bar');

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('UTC');
    expect(logs.records.some((record) => record.level === 'warn')).toBe(true);
  });

  /** 出所を画面に出す（§7.1）。認可の文脈を持たない。 */
  it.each([
    ['database', 'Europe/Berlin', 'Asia/Tokyo', 'Europe/Berlin'],
    ['environment', null, 'Asia/Tokyo', 'Asia/Tokyo'],
    ['default', null, null, 'UTC'],
  ] as const)(
    'analyticsTimeZoneSetting の source が %s になる',
    async (source, stored, env, value) => {
      if (env !== null) {
        process.env['TORIFUNE_TIMEZONE'] = env;
      }
      if (stored !== null) {
        await storeTimeZone(stored);
      }

      await expect(analyticsTimeZoneSetting()).resolves.toEqual({ value, source });
    },
  );
});

describe('同期版 analyticsTimeZone', () => {
  /** #20。一度も読み込んでいない状態でも例外を投げない。 */
  it('未読み込みでも環境変数の値を返し、例外を投げない', () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    expect(() => analyticsTimeZone()).not.toThrow();
    expect(analyticsTimeZone()).toBe('Asia/Tokyo');
  });

  /** #20。未読み込み・環境変数も無ければ UTC。 */
  it('未読み込みで環境変数も無ければ UTC', () => {
    expect(analyticsTimeZone()).toBe('UTC');
  });

  /**
   * #21 / #29。**DB へ問い合わせない。**
   *
   * `collect` のホットパスから呼ばれる。読み直しは TTL 超過のときだけ、
   * 別の非同期処理として起きる（リクエストを待たせない）。
   */
  it('キャッシュが新しい間は system_settings を読まない', async () => {
    await storeTimeZone('Europe/Berlin');
    // 1 度読ませてキャッシュを新しくする。
    await resolveAnalyticsTimeZone();

    const spy = vi.spyOn(systemSettingsRepository, 'loadAll');
    for (let index = 0; index < 50; index += 1) {
      expect(analyticsTimeZone()).toBe('Europe/Berlin');
    }

    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * キャッシュの TTL（#22 / #23）。
 *
 * **偽タイマーは `Date` だけにする。** タイマーごと止めると DB 接続の内部タイマーまで止まる。
 */
describe('キャッシュの TTL', () => {
  const BASE = new Date('2026-09-06T00:00:00Z');

  beforeEach(async () => {
    await storeTimeZone('Europe/Berlin');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BASE);
    resetAnalyticsTimeZoneForTests();
  });

  /** #22 */
  it('TTL 内に 2 回呼んでも読み出しは 1 回だけ', async () => {
    const spy = vi.spyOn(systemSettingsRepository, 'loadAll');

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Europe/Berlin');
    vi.setSystemTime(new Date(BASE.getTime() + TTL_MS - 1_000));
    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Europe/Berlin');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  /** #23。境界値。 */
  it('TTL を過ぎたら読み直す', async () => {
    const spy = vi.spyOn(systemSettingsRepository, 'loadAll');

    await resolveAnalyticsTimeZone();
    vi.setSystemTime(new Date(BASE.getTime() + TTL_MS + 1_000));
    await resolveAnalyticsTimeZone();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  /** #23 の対。読み直したあとは新しい値になる。 */
  it('TTL を過ぎたあとは保存し直された値を返す', async () => {
    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Europe/Berlin');

    await storeTimeZone('America/Los_Angeles');
    vi.setSystemTime(new Date(BASE.getTime() + TTL_MS + 1_000));

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('America/Los_Angeles');
  });

  /**
   * #24。異常系。**集計や画面を DB の一時的な失敗で落とさない。**
   */
  it('読み直しが失敗しても直前の値を返し、警告を出す', async () => {
    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Europe/Berlin');

    const logs = capture();
    vi.spyOn(systemSettingsRepository, 'loadAll').mockRejectedValue(new Error('db is down'));
    vi.setSystemTime(new Date(BASE.getTime() + TTL_MS + 1_000));

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Europe/Berlin');
    expect(logs.records.some((record) => record.level === 'warn')).toBe(true);
  });

  /** #24。一度も読めていなければ環境変数へ落ちる（それでも落ちない）。 */
  it('一度も読めていない状態で読み直しが失敗したら環境変数の値を返す', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';
    resetAnalyticsTimeZoneForTests();
    vi.spyOn(systemSettingsRepository, 'loadAll').mockRejectedValue(new Error('db is down'));

    await expect(resolveAnalyticsTimeZone()).resolves.toBe('Asia/Tokyo');
  });
});

describe('analytics.timeZoneUpdate', () => {
  /** #53。保存するのは**正規化後**の値（別名のままだと画面の一覧に一致する項目が無くなる）。 */
  it('正規化した値を保存する（utc → UTC）', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    const result = await updateAnalyticsTimeZone(admin, { timeZone: 'utc' });

    expect(result.timeZone).toBe('UTC');
    expect(await storedTimeZone()).toBe('UTC');
    await waitForRebuildSummary();
  });

  /** #53 の対。別名も正規化される。 */
  it('Japan を保存すると Asia/Tokyo になる', async () => {
    const result = await updateAnalyticsTimeZone(admin, { timeZone: 'Japan' });

    expect(result.timeZone).toBe('Asia/Tokyo');
    expect(await storedTimeZone()).toBe('Asia/Tokyo');
    await waitForRebuildSummary();
  });

  /** #54。異常系。**保存を拒否する**（環境変数のように警告して UTC へ落とさない）。 */
  it('オフセット表記は ValidationError で拒否し、保存しない', async () => {
    await expect(updateAnalyticsTimeZone(admin, { timeZone: '+09:00' })).rejects.toThrowError(
      ValidationError,
    );

    expect(await storedTimeZone()).toBeUndefined();
    expect(await rebuildRuns()).toEqual([]);
  });

  /** #55。異常系。 */
  it('解釈できない名前は ValidationError で拒否し、保存しない', async () => {
    await expect(updateAnalyticsTimeZone(admin, { timeZone: 'Foo/Bar' })).rejects.toThrowError(
      ValidationError,
    );

    expect(await storedTimeZone()).toBeUndefined();
  });

  /** #56。要件 §5「変えていない保存では洗い替えが走らない」。 */
  it('いま効いている値と同じなら rebuildStarted は false で、洗い替えが起きない', async () => {
    await storeTimeZone('Europe/Berlin');
    await resolveAnalyticsTimeZone();

    const result = await updateAnalyticsTimeZone(admin, { timeZone: 'Europe/Berlin' });

    expect(result.rebuildStarted).toBe(false);
    expect(result.previousTimeZone).toBe('Europe/Berlin');
    // 起きていないことは「増えない」ことでしか見えない。しばらく見張る。
    await sleep(1_000);
    expect(await rebuildRuns()).toEqual([]);
  });

  /**
   * #57。境界値。
   *
   * 行が無い状態で環境変数と同じ値を保存すると、**出所が「データベース」へ固定される**。
   * 値は変わらないので洗い替えは走らない。
   */
  it('行が無く環境変数と同じ値を保存すると、行はできるが洗い替えは走らない', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';
    expect(await storedTimeZone()).toBeUndefined();

    const result = await updateAnalyticsTimeZone(admin, { timeZone: 'Asia/Tokyo' });

    expect(result.rebuildStarted).toBe(false);
    expect(await storedTimeZone()).toBe('Asia/Tokyo');
    await expect(analyticsTimeZoneSetting()).resolves.toEqual({
      value: 'Asia/Tokyo',
      source: 'database',
    });
    await sleep(1_000);
    expect(await rebuildRuns()).toEqual([]);
  });

  /** #58 */
  it('値が変わる保存では job_runs に洗い替えの行が増える', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';

    const result = await updateAnalyticsTimeZone(admin, { timeZone: 'Asia/Tokyo' });

    expect(result).toEqual({
      timeZone: 'Asia/Tokyo',
      previousTimeZone: 'UTC',
      rebuildStarted: true,
    });
    const summary = await waitForRebuildSummary();
    expect(summary['timeZone']).toBe('Asia/Tokyo');
  });

  /** #25。**保存したプロセスは即座に反映する。** 読み直しを待たない。 */
  it('保存の直後、同じプロセスの同期版が新しい値を返す', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';
    await resolveAnalyticsTimeZone();

    await updateAnalyticsTimeZone(admin, { timeZone: 'Europe/Berlin' });

    expect(analyticsTimeZone()).toBe('Europe/Berlin');
    await waitForRebuildSummary();
  });

  /** #59。既存の `updateSystemSettings` と同じ `action` / `resourceType` を使う（列挙値を足さない）。 */
  it('監査ログを updated / system_settings で残し、detail に前後の値を入れる', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';

    await updateAnalyticsTimeZone(admin, { timeZone: 'Asia/Tokyo' });

    const rows = await withConnection((connection) =>
      connection.db
        .selectFrom('audit_logs')
        .select(['action', 'resource_type', 'resource_id', 'detail'])
        .execute(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('updated');
    expect(rows[0]?.resource_type).toBe('system_settings');
    expect(rows[0]?.resource_id).toBeNull();
    expect(rows[0]?.detail).toMatchObject({
      setting: 'analytics.time_zone',
      from: 'UTC',
      to: 'Asia/Tokyo',
    });
    await waitForRebuildSummary();
  });

  /** #112。`PUT` 経由の洗い替えは、**値が変わったときしか起きない**ので前後が必ず違う。 */
  it('保存から起きた洗い替えの summary は previousTimeZone !== timeZone', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';

    await updateAnalyticsTimeZone(admin, { timeZone: 'Asia/Tokyo' });
    const summary = await waitForRebuildSummary();

    expect(summary['previousTimeZone']).toBe('UTC');
    expect(summary['timeZone']).toBe('Asia/Tokyo');
    expect(summary['previousTimeZone']).not.toBe(summary['timeZone']);
  });
});

describe('analytics.timeZonePreview', () => {
  /** #61。**何も変更しない。** */
  it('失われるものを出所ごとに返し、設定も集計値も変えない', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';

    const preview = await previewTimeZoneChange(admin, { timeZone: 'Asia/Tokyo' });

    expect(preview.timeZone).toBe('Asia/Tokyo');
    expect(preview.currentTimeZone).toBe('UTC');
    expect(preview.currentSource).toBe('environment');
    expect(preview.unchanged).toBe(false);
    for (const key of ['lostDays', 'lostCoreRows', 'lostPluginRows', 'lostSites'] as const) {
      expect(typeof preview[key], key).toBe('number');
    }
    expect(Array.isArray(preview.lostSources)).toBe(true);
    expect(preview).toHaveProperty('lostFrom');
    expect(preview).toHaveProperty('lostTo');
    expect(preview).toHaveProperty('rebuildFrom');
    expect(preview).toHaveProperty('rebuildTo');

    // 何も変えていない。
    expect(await storedTimeZone()).toBeUndefined();
    expect(await rebuildRuns()).toEqual([]);
  });

  /** #61。生ログが無ければ洗い替える期間も無い。 */
  it('生ログが 1 行も無ければ rebuildFrom / rebuildTo が null', async () => {
    const preview = await previewTimeZoneChange(admin, { timeZone: 'Asia/Tokyo' });

    expect(preview.rebuildFrom).toBeNull();
    expect(preview.rebuildTo).toBeNull();
    expect(preview.rebuildDays).toBe(0);
  });

  /** #62 */
  it('現在値と同じ値なら unchanged が true', async () => {
    await storeTimeZone('Europe/Berlin');
    await resolveAnalyticsTimeZone();

    const preview = await previewTimeZoneChange(admin, { timeZone: 'Europe/Berlin' });

    expect(preview.unchanged).toBe(true);
    expect(preview.currentSource).toBe('database');
  });

  /** #62。正規化してから比べる（`utc` と `UTC` は同じ）。 */
  it('別名でも正規化して比べる', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';

    const preview = await previewTimeZoneChange(admin, { timeZone: 'utc' });

    expect(preview.timeZone).toBe('UTC');
    expect(preview.unchanged).toBe(true);
  });

  /** 異常系。プレビューでも保存と同じ厳しさで弾く（「不正だから UTC で数えました」を返さない）。 */
  it.each(['Foo/Bar', '+09:00', 'Etc/GMT+5'])('%s は ValidationError', async (value) => {
    await expect(previewTimeZoneChange(admin, { timeZone: value })).rejects.toThrowError(
      ValidationError,
    );
  });
});

describe('analytics.timeZoneRebuild（やり直し）', () => {
  /** #113。**前後が同じであること自体が「やり直し」の印**（§6.2.6）。 */
  it('やり直しから起きた洗い替えの summary は previousTimeZone === timeZone', async () => {
    await storeTimeZone('Asia/Tokyo');
    await resolveAnalyticsTimeZone();

    await expect(rebuildAnalyticsTimeZone(admin, {})).resolves.toEqual({ started: true });

    const summary = await waitForRebuildSummary();
    expect(summary['previousTimeZone']).toBe(summary['timeZone']);
  });

  /** #114。渡す `previousTimeZone` は、そのとき有効な値と等しい。 */
  it('やり直しが渡す previousTimeZone が、いま有効なタイムゾーンと等しい', async () => {
    await storeTimeZone('America/Los_Angeles');
    const effective = await resolveAnalyticsTimeZone();
    expect(effective).toBe('America/Los_Angeles');

    await rebuildAnalyticsTimeZone(admin, {});

    const summary = await waitForRebuildSummary();
    expect(summary['timeZone']).toBe(effective);
    expect(summary['previousTimeZone']).toBe(effective);
  });

  /** #106 の結合側。**`system_settings` を書き換えない**（タイムゾーンは保存済み）。 */
  it('system_settings を書き換えない', async () => {
    await storeTimeZone('Asia/Tokyo');
    const before = await withConnection((connection) =>
      connection.db
        .selectFrom('system_settings')
        .select(['key', 'value', 'updated_at'])
        .orderBy('key')
        .execute(),
    );

    await rebuildAnalyticsTimeZone(admin, {});
    await waitForRebuildSummary();

    const after = await withConnection((connection) =>
      connection.db
        .selectFrom('system_settings')
        .select(['key', 'value', 'updated_at'])
        .orderBy('key')
        .execute(),
    );
    expect(after).toEqual(before);
  });
});

/**
 * #60。**`system.manage` を持たない主体は、消える件数すら数えられない。**
 *
 * 本件はサイト・ユーザー単位の資源を扱わない（インスタンス全体の設定と全サイトの集計値）ので、
 * 「ID を差し替えて他人のデータを取る」経路が無い。代わりにここを固定する。
 */
describe('権限', () => {
  it('system.manage が無ければ analytics.timeZonePreview は ForbiddenError', async () => {
    await expect(previewTimeZoneChange(viewer, { timeZone: 'Asia/Tokyo' })).rejects.toThrowError(
      ForbiddenError,
    );
  });

  it('system.manage が無ければ analytics.timeZoneUpdate は ForbiddenError', async () => {
    await expect(updateAnalyticsTimeZone(viewer, { timeZone: 'Asia/Tokyo' })).rejects.toThrowError(
      ForbiddenError,
    );

    expect(await storedTimeZone()).toBeUndefined();
  });

  it('system.manage が無ければ analytics.timeZoneRebuild は ForbiddenError', async () => {
    await expect(rebuildAnalyticsTimeZone(viewer, {})).rejects.toThrowError(ForbiddenError);

    await sleep(500);
    expect(await rebuildRuns()).toEqual([]);
  });
});

/**
 * 追加 C：ログの秘匿（設計 §6.1.2、受け入れ条件 #133 / #134）。
 *
 * 読み直しは `withConnection` → Provider の `connect()` を通るので、
 * **Database Provider を差し替えた Plugin の例外**を受けうる。その文字列は
 * 標準 Provider の秘匿を通らず、接続文字列やトークンを含みうる。
 * `logging.ts` の `maskSecrets` はキー名で落とす仕組みなので、自由文には効かない。
 *
 * `029` §6.1.7 が規約化した `redactSecrets`（`infrastructure/secret-text.ts`）を通す。
 */
describe('読み直しの失敗をログへ出すときの秘匿', () => {
  /** そのとき効いている接続文字列（`redactSecrets` はこれを伏せる）。 */
  function databaseUrl(): string {
    const url = process.env['DATABASE_URL'];
    expect(url, 'DATABASE_URL が要る').toBeTruthy();
    return url ?? '';
  }

  /** `warn` に出た `reason` を集める。 */
  function warnedReasons(records: readonly LogRecord[]): string[] {
    return records
      .filter((record) => record.level === 'warn')
      .map((record) => String((record.fields as Record<string, unknown> | undefined)?.['reason']))
      .filter((reason) => reason !== 'undefined');
  }

  /** #133。非同期の読み直し。 */
  it('resolveAnalyticsTimeZone の失敗の reason が redactSecrets を通っている', async () => {
    const logs = capture();
    vi.spyOn(systemSettingsRepository, 'loadAll').mockRejectedValue(
      new Error(`connect ECONNREFUSED ${databaseUrl()}`),
    );

    await resolveAnalyticsTimeZone();

    const reasons = warnedReasons(logs.records);
    expect(reasons.length, 'warn の reason が出ていない').toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason, '接続文字列がそのまま出ている').not.toContain(databaseUrl());
      expect(reason, 'credential がそのまま出ている').not.toMatch(/:\/\/[^/@\s]+:[^/@\s]+@/);
      expect(reason).toContain('***');
    }
  });

  /**
   * #134。同期版が起こす読み直しの失敗でも同じ。
   *
   * 同期版は待たないので、読み直しが終わるまで待ってからログを見る。
   */
  it('analyticsTimeZone が起こす読み直しの失敗でも reason が伏せられる', async () => {
    const logs = capture();
    vi.spyOn(systemSettingsRepository, 'loadAll').mockRejectedValue(
      new Error(`connect ECONNREFUSED ${databaseUrl()}`),
    );

    // 同期版は例外を投げず、待たずに読み直しを起こすだけ。
    expect(() => analyticsTimeZone()).not.toThrow();

    await waitFor(
      async () => warnedReasons(logs.records),
      (reasons) => reasons.length > 0,
      '同期版が起こした読み直しの警告',
      5_000,
    );

    for (const reason of warnedReasons(logs.records)) {
      expect(reason).not.toContain(databaseUrl());
      expect(reason).not.toMatch(/:\/\/[^/@\s]+:[^/@\s]+@/);
      expect(reason).toContain('***');
    }
  });
});

/**
 * 追加 D：やり直しの監査ログ（設計 §6.4.1、受け入れ条件 #135〜#137）。
 *
 * やり直しは `system_settings` を書かないが、**`analytics` から Core と Plugin の行を
 * 出所を問わず削除する。** `system.manage` は複数人が持ちうる権限であり、
 * **Plugin の数値を永久に失わせた操作について誰がやったかが分からない**のは受け入れられない。
 *
 * `job_runs` に actor の列は無く（`021_job_runs.sql`）、`startJobInBackground` は
 * `AuthorizationContext` を捨てるので、残せる場所は `audit_logs` しかない。
 */
describe('やり直しの監査ログ', () => {
  async function auditRows(): Promise<
    {
      action: string;
      resource_type: string;
      resource_id: string | null;
      detail: unknown;
      actor_user_id: string | null;
    }[]
  > {
    return withConnection((connection) =>
      connection.db
        .selectFrom('audit_logs')
        .select(['action', 'resource_type', 'resource_id', 'detail', 'actor_user_id'])
        .execute(),
    );
  }

  /** #135。**誰が起こしたか**を残す。 */
  it('updated / system_settings の行を残し、actor_user_id に実行者が入る', async () => {
    await storeTimeZone('Asia/Tokyo');
    await resolveAnalyticsTimeZone();

    await rebuildAnalyticsTimeZone(admin, {});

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('updated');
    expect(rows[0]?.resource_type).toBe('system_settings');
    expect(rows[0]?.resource_id).toBeNull();
    expect(rows[0]?.actor_user_id).toBe(admin.identity?.userId);

    await waitForRebuildSummary();
  });

  /** #136。保存に伴う洗い替え（`from` / `to` を持つ）と読み分けられる。 */
  it('detail に setting と rebuild = retry が入り、保存の記録と読み分けられる', async () => {
    await storeTimeZone('Asia/Tokyo');
    await resolveAnalyticsTimeZone();

    await rebuildAnalyticsTimeZone(admin, {});
    await waitForRebuildSummary();

    const retry = (await auditRows())[0]?.detail as Record<string, unknown>;
    expect(retry['setting']).toBe('analytics.time_zone');
    expect(retry['rebuild']).toBe('retry');
    // 保存の記録は `from` / `to` を持ち、`rebuild` を持たない。
    expect(retry['from']).toBeUndefined();
    expect(retry['to']).toBeUndefined();
  });

  /** #136 の対。保存経路の記録と同じ表に並んでも区別できる。 */
  it('保存の記録は rebuild を持たず、from / to を持つ', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'UTC';

    await updateAnalyticsTimeZone(admin, { timeZone: 'Asia/Tokyo' });
    await waitForRebuildSummary();

    const saved = (await auditRows())[0]?.detail as Record<string, unknown>;
    expect(saved['rebuild']).toBeUndefined();
    expect(saved['from']).toBe('UTC');
    expect(saved['to']).toBe('Asia/Tokyo');
  });

  /** #137。異常系。`defineUseCase` は成功したものだけを記録する。 */
  it('system.manage が無いとき（403）は監査ログが残らない', async () => {
    await storeTimeZone('Asia/Tokyo');

    await expect(rebuildAnalyticsTimeZone(viewer, {})).rejects.toThrowError(ForbiddenError);

    expect(await auditRows()).toEqual([]);
  });
});

/**
 * 追加 E：やり直し経路のタイムゾーン検証（設計 §6.4.2、受け入れ条件 #138〜#141）。
 *
 * 保存経路は `canonicalTimeZone` ＋ `isSelectableTimeZone` を通すが、やり直し経路は
 * `resolveAnalyticsTimeZone()` の値をそのまま使う。その値は `system_settings` に行が無い環境では
 * `TORIFUNE_TIMEZONE` 由来で、**検査は `isValidTimeZone` だけ**（`+09:00` と `Etc/GMT+5` が通る）。
 *
 * **危ないのは「解釈が割れる」場合。** 日付の切り出しは JS 側（`dateInTimeZone`）と
 * PostgreSQL 側（`AT TIME ZONE`）の両方で行う。食い違えば
 * **生ログのある日を「無い日」と誤判定して消す**ことが起こりうる。消すのは不可逆である。
 */
describe('やり直し経路のタイムゾーン検証', () => {
  /** #138。異常系。**走らせずに弾く。** */
  it('一覧に無いオフセット表記の環境変数では ValidationError になり、ジョブが起きない', async () => {
    process.env['TORIFUNE_TIMEZONE'] = '+09:00';

    await expect(rebuildAnalyticsTimeZone(admin, {})).rejects.toThrowError(ValidationError);

    await sleep(1_000);
    expect(await rebuildRuns()).toEqual([]);
  });

  /** #139。境界値。`Etc/*` は `isValidTimeZone` を通るが一覧に無い。 */
  it('Etc/GMT+5 の環境変数でも ValidationError になり、ジョブが起きない', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Etc/GMT+5';

    await expect(rebuildAnalyticsTimeZone(admin, {})).rejects.toThrowError(ValidationError);

    await sleep(1_000);
    expect(await rebuildRuns()).toEqual([]);
  });

  /** #140。一覧にある値なら通る（検査が空振りしていない）。 */
  it('一覧にある環境変数なら洗い替えが始まる', async () => {
    process.env['TORIFUNE_TIMEZONE'] = 'Asia/Tokyo';

    await expect(rebuildAnalyticsTimeZone(admin, {})).resolves.toEqual({ started: true });

    const summary = await waitForRebuildSummary();
    expect(summary['timeZone']).toBe('Asia/Tokyo');
  });

  /**
   * #141。**保存経路が正規化した値を書く**ので、一度でも画面から保存していれば通る。
   *
   * 環境変数が一覧に無い値のままでも、`system_settings` の値が勝つ（裁定 §3.1）。
   */
  it('一度でも画面から保存していれば、環境変数の値によらずやり直しが通る', async () => {
    process.env['TORIFUNE_TIMEZONE'] = '+09:00';
    await storeTimeZone('Asia/Tokyo');
    await resolveAnalyticsTimeZone();

    await expect(rebuildAnalyticsTimeZone(admin, {})).resolves.toEqual({ started: true });

    const summary = await waitForRebuildSummary();
    expect(summary['timeZone']).toBe('Asia/Tokyo');
  });
});
