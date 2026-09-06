import { withConnection } from '@/application/transaction';
import { isValidTimeZone } from '@/domain/analytics/day';
import { SYSTEM_SETTING_KEYS, toSystemSettings } from '@/domain/system-settings';
import { log } from '@/infrastructure/logging';
import { processState } from '@/infrastructure/process-state';
import { redactSecrets } from '@/infrastructure/secret-text';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';

/**
 * 集計の「1日の境目」を決めるタイムゾーンの解決（032-timezone-setting 設計 §6.1）。
 *
 * **インスタンス単位の設定にする。** サイトごとやユーザーごとにすると、
 * 同じ集計値が見る人によって違う日に属することになり、保存した日次の値を説明できなくなる。
 *
 * 優先順位は **`system_settings`（画面設定）> `TORIFUNE_TIMEZONE` > `UTC`**（裁定 §3.1）。
 * 環境変数は「画面で保存されるまでの初期値」であり、既存環境は触るまで従来どおり動く。
 *
 * 経路を 2 つに分ける。
 *
 * * `analyticsTimeZone()`（同期）——**キャッシュを読むだけ。DB を読む経路を持たない。**
 *   呼んでよいのは `collect` のホットパス（`saltDay`）だけ。アクセス受信のたびに呼ばれるので、
 *   ここで問い合わせを 1 本でも増やすと計測全体が重くなる（要件 §4）
 * * `resolveAnalyticsTimeZone()`（非同期）——古ければ読み直してから返す。
 *   ジョブ・UseCase・画面はこちら（どれも既に非同期の文脈にある）
 *
 * **どちらも落ちない。** 設定の誤りや DB の一時的な失敗で、集計や画面まで止めない。
 *
 * **変えたら、保存済みの集計値を洗い替える。** 画面から変えれば
 * `analytics.timezoneRebuild` が自動で流し直す（`application/analytics/rebuild.ts`）。
 */

const DEFAULT_TIME_ZONE = 'UTC';

/**
 * キャッシュを古いとみなすまでの時間。
 *
 * 他プロセスへ変更を push する仕組みは持たない（`LISTEN` / `NOTIFY` も共有メモリも入れない）。
 * 収束は **TTL による pull だけ**で行う。ずれている間に起きることは設計 §6.1.3 に書いてある。
 */
const TIME_ZONE_TTL_MS = 30_000;

let warned = false;

interface TimeZoneCache {
  /** DB から読めた値。`null` は「まだ読めていない」か「未設定」。 */
  value: string | null;
  /** 最後に読んだ時刻（ミリ秒）。`0` は未読み込み。 */
  loadedAt: number;
  /** 進行中の読み直し。二重に走らせない。 */
  inflight: Promise<void> | null;
}

interface TimeZoneCacheHolder {
  current: TimeZoneCache;
}

function emptyCache(): TimeZoneCache {
  return { value: null, loadedAt: 0, inflight: null };
}

/**
 * **モジュール変数にしない。**
 *
 * Next.js は Route Handler・Server Component を別バンドルへ分けることがあり、
 * 同じファイルの実体が複数になると「画面で変えたのに `collect` に効かない」という壊れ方をする。
 *
 * 中身を差し替えられるホルダにしてある（`scheduler.ts` の `holder()` と同じ形）。
 * 走行中の読み直しが、リセット後の状態へ書き戻すことがない。
 */
function holder(): TimeZoneCacheHolder {
  return processState('analytics.time-zone', (): TimeZoneCacheHolder => ({
    current: emptyCache(),
  }));
}

function cache(): TimeZoneCache {
  return holder().current;
}

/**
 * 環境変数から解決する（`system_settings` に値が無いときの落ち先）。
 *
 * **落とさない。** 設定の誤りでアクセス記録まで止まると被害が大きい。
 * ただし黙って既定へ落ちると、ずれた集計の原因が分からなくなるので警告を 1 度だけ出す。
 */
function environmentTimeZone(): string {
  const configured = process.env['TORIFUNE_TIMEZONE']?.trim();

  if (configured === undefined || configured === '') {
    return DEFAULT_TIME_ZONE;
  }

  if (!isValidTimeZone(configured)) {
    if (!warned) {
      warned = true;
      log.warn('TORIFUNE_TIMEZONE が不正なため UTC で集計する', { value: configured });
    }
    return DEFAULT_TIME_ZONE;
  }

  return configured;
}

function isStale(state: TimeZoneCache): boolean {
  return Date.now() - state.loadedAt > TIME_ZONE_TTL_MS;
}

/** `system_settings` を 1 度読んで、読んだ状態へ書き戻す。 */
async function load(state: TimeZoneCache): Promise<void> {
  const stored = await withConnection((connection) => systemSettingsRepository.loadAll(connection));
  const value = toSystemSettings(stored).analyticsTimeZone;

  if (value === null && stored.get(SYSTEM_SETTING_KEYS.analyticsTimeZone) !== undefined) {
    // 保存されているのに解釈できない。**落とさずに既定へ落ちる**が、黙って落ちない。
    log.warn('保存された基準タイムゾーンが不正なため、環境変数または UTC で集計する');
  }

  state.value = value;
  state.loadedAt = Date.now();
}

/** 読み直しを 1 本だけ走らせる。既に走っていればそれを返す。 */
function refresh(): Promise<void> {
  const state = cache();
  if (state.inflight !== null) {
    return state.inflight;
  }
  const inflight = load(state).finally(() => {
    state.inflight = null;
  });
  state.inflight = inflight;
  return inflight;
}

/**
 * 読み直しの失敗を警告する。
 *
 * **例外のメッセージは `redactSecrets` を通してから入れる**（`029` §6.1.7 の規約）。
 * 読み直しは `withConnection` → Provider の `connect()` を通るので、
 * **Database Provider を差し替えた Plugin の例外**を受けうる。その文字列は標準 Provider の
 * 秘匿を通らず、接続文字列やトークンを含みうる（`logging.ts` の `maskSecrets` は
 * キー名で落とす仕組みなので自由文には効かない）。
 *
 * しかもここは画面・ジョブ・起動時から呼ばれるので、**DB が不調な間は繰り返しログに残る。**
 */
function warnRefreshFailed(error: unknown): void {
  log.warn('基準タイムゾーンを読み直せなかった。直前の値で続行する', {
    reason: redactSecrets(error instanceof Error ? error.message : String(error)),
  });
}

/**
 * **同期。キャッシュを読むだけ。DB を読まない。**
 *
 * 呼んでよいのは `collect` のホットパス（`saltDay`）だけ
 * （`application/analytics/timezone-static-checks.test.ts` が機械的に見ている）。
 *
 * TTL を過ぎていれば読み直しを**起こすだけ**で待たない。
 * 読み直しは別の接続・別の非同期処理であり、要求の応答を待たせない。
 */
export function analyticsTimeZone(): string {
  const state = cache();

  if (isStale(state)) {
    // 失敗は握る。**計測が落ちる経路を新たに作らない。**
    // 待たないだけで、起きたことは同じ形で（秘匿して）記録する。
    void refresh().catch(warnRefreshFailed);
  }

  return state.value ?? environmentTimeZone();
}

/**
 * **非同期。キャッシュが古ければ読み直してから返す。**
 *
 * 読み直しに失敗したら、直前のキャッシュ（無ければ環境変数）を返して警告を出す。
 * **集計や画面を DB の一時的な失敗で落とさない。**
 */
export async function resolveAnalyticsTimeZone(): Promise<string> {
  const state = cache();

  if (isStale(state)) {
    try {
      await refresh();
    } catch (error) {
      warnRefreshFailed(error);
    }
  }

  return state.value ?? environmentTimeZone();
}

/** いま効いている値の出所。 */
export type AnalyticsTimeZoneSource = 'database' | 'environment' | 'default';

/**
 * いまどの値がどこから効いているか（画面に出す。設計 §7.1）。
 *
 * **認可の文脈を持たない**（`loadSystemSettings` と同じ扱い）。
 * 基準タイムゾーンは秘密ではなく、アナリティクスの設定タブにも既に出ている。
 */
export async function analyticsTimeZoneSetting(): Promise<{
  readonly value: string;
  readonly source: AnalyticsTimeZoneSource;
}> {
  const value = await resolveAnalyticsTimeZone();

  if (cache().value !== null) {
    return { value, source: 'database' };
  }

  const configured = process.env['TORIFUNE_TIMEZONE']?.trim();
  const fromEnvironment =
    configured !== undefined && configured !== '' && isValidTimeZone(configured);

  return { value, source: fromEnvironment ? 'environment' : 'default' };
}

/**
 * 保存した直後に、そのプロセスへ即座に反映する（設計 §6.1.2）。
 *
 * 読み直しを待たない。他プロセスは TTL で追いつく。
 */
export function primeAnalyticsTimeZone(value: string): void {
  const state = cache();
  state.value = value;
  state.loadedAt = Date.now();
}

/** テスト用。警告を1度しか出さない状態を戻す。 */
export function resetTimeZoneWarning(): void {
  warned = false;
}

/**
 * テスト用。キャッシュを未読み込みの状態へ戻す。
 *
 * **TTL 30 秒はテストをまたいで効く**（`processState` は `globalThis` に置かれる）。
 * `system_settings` を触るテストは `afterEach` でこれを呼ぶ。
 */
export function resetAnalyticsTimeZoneForTests(): void {
  holder().current = emptyCache();
}
