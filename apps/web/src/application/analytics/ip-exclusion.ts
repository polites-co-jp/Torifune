import { withConnection } from '@/application/transaction';
import {
  matchesAnyIpExclusion,
  parseIpExclusionRules,
  type IpExclusionRule,
} from '@/domain/analytics/ip-exclusion';
import { accessLogExcludedIpsOf } from '@/domain/system-settings';
import { log } from '@/infrastructure/logging';
import { processState } from '@/infrastructure/process-state';
import { redactSecrets } from '@/infrastructure/secret-text';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';

/**
 * アクセスログの除外IPの参照（033-analytics-ip-exclusion 設計 §6）。
 *
 * **記録の手前でしか除外できない。** `access_logs` に IP は保存されず、
 * `visitor_hash` の日次ソルトも保存しないので、取りこぼした 1 件は後から消せない
 * （設計 §2）。判定はここで確実に行う。
 *
 * ## `timezone.ts` と形はそろえ、待ち方だけ変える
 *
 * キャッシュの置き場（`processState`）も TTL も同じにする。違うのは 1 点だけ。
 *
 * * `analyticsTimeZone()` は**同期・待たない**。ずれても後から洗い替えれば直る
 * * こちらは**非同期・古ければ待つ**。待たない設計にすると、**プロセスが
 *   立ち上がるたびに最初の数件が必ず記録される**（設計 §6.2）
 *
 * `collectAccess` は既に `async` なので、同期版は持たない。
 */

/** キャッシュを古いとみなすまでの時間（`timezone.ts` と同じ）。 */
const EXCLUSION_TTL_MS = 30_000;

interface ExclusionCache {
  /** 読めた値。`null` は「まだ読めていない」。 */
  value: readonly IpExclusionRule[] | null;
  /** 最後に読んだ時刻（ミリ秒）。`0` は未読み込み。 */
  loadedAt: number;
  /** 進行中の読み直し。二重に走らせない。 */
  inflight: Promise<void> | null;
}

interface ExclusionCacheHolder {
  current: ExclusionCache;
}

function emptyCache(): ExclusionCache {
  return { value: null, loadedAt: 0, inflight: null };
}

/**
 * **モジュール変数にしない**（`timezone.ts` の `holder()` と同じ理由）。
 *
 * Next.js は Route Handler・Server Component を別バンドルへ分けることがあり、
 * 同じファイルの実体が複数になると「画面で保存したのに `collect` に効かない」という
 * 壊れ方をする。
 */
function holder(): ExclusionCacheHolder {
  return processState('analytics.ip-exclusion', (): ExclusionCacheHolder => ({
    current: emptyCache(),
  }));
}

function cache(): ExclusionCache {
  return holder().current;
}

function isStale(state: ExclusionCache): boolean {
  return Date.now() - state.loadedAt > EXCLUSION_TTL_MS;
}

/** `system_settings` を 1 度読んで、読んだ状態へ書き戻す。 */
async function load(state: ExclusionCache): Promise<void> {
  const stored = await withConnection((connection) => systemSettingsRepository.loadAll(connection));

  // 正規化と壊れた行の切り落としは Domain（`accessLogExcludedIpsOf`）が済ませている。
  // **全項目（`toSystemSettings`）を取らない。** 要らない設定まで運ぶ経路を増やさない。
  state.value = parseIpExclusionRules(accessLogExcludedIpsOf(stored)).rules;
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
 * **例外のメッセージは `redactSecrets` を通す**（029 §6.1.7 の規約）。
 * `withConnection` は Database Provider を差し替えた Plugin の例外を運びうる。
 */
function warnRefreshFailed(error: unknown): void {
  log.warn('除外IPの設定を読み直せなかった。直前の値で続行する', {
    reason: redactSecrets(error instanceof Error ? error.message : String(error)),
  });
}

/**
 * いま効いている除外ルール。**古ければ読み直してから返す。**
 *
 * 読み直しに失敗したら、直前の値（未読み込みなら空）を返して警告を出す
 * ——**記録する側へ倒す**（設計 §6.3）。逆にすると DB の不調がそのまま
 * 計測の全損になり、後から復元できない。
 */
export async function resolveAccessLogIpExclusions(): Promise<readonly IpExclusionRule[]> {
  const state = cache();

  if (isStale(state)) {
    try {
      await refresh();
    } catch (error) {
      warnRefreshFailed(error);
    }
  }

  return state.value ?? [];
}

/**
 * この送信元を記録しないか（設計 §6.4）。
 *
 * **IP が分からないものは落とさない。** 落とすと、Proxy の設定ミスで計測が全損する。
 * 表記の揺れ（ポート付き・角括弧・IPv4 射影）は Domain 側で吸収する。
 */
export async function isAccessLogExcluded(rawIp: string | null | undefined): Promise<boolean> {
  if (rawIp === null || rawIp === undefined || rawIp.trim() === '') {
    // 設定を読みにも行かない。判定しようがない。
    return false;
  }

  return matchesAnyIpExclusion(await resolveAccessLogIpExclusions(), rawIp);
}

/**
 * 保存した直後に、そのプロセスへ即座に反映する（設計 §6.1）。
 *
 * 読み直しを待たない。他プロセスは TTL で追いつく。
 */
export function primeAccessLogIpExclusions(texts: readonly string[]): void {
  const state = cache();
  state.value = parseIpExclusionRules(texts).rules;
  state.loadedAt = Date.now();
}

/**
 * テスト用。キャッシュを未読み込みの状態へ戻す。
 *
 * **TTL 30 秒はテストをまたいで効く**（`processState` は `globalThis` に置かれる）。
 */
export function resetAccessLogIpExclusionsForTests(): void {
  holder().current = emptyCache();
}
