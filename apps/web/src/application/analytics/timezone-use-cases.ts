import {
  analyticsTimeZoneSetting,
  primeAnalyticsTimeZone,
  resolveAnalyticsTimeZone,
  type AnalyticsTimeZoneSource,
} from '@/application/analytics/timezone';
import { defineUseCase } from '@/application/authorization/use-case';
import { TIMEZONE_REBUILD_JOB } from '@/application/jobs/definitions';
import { startJobInBackground } from '@/application/jobs/run-job';
import { rangeDays } from '@/domain/analytics/analytics';
import { dateInTimeZone, todayInTimeZone } from '@/domain/analytics/day';
import { canonicalTimeZone, isSelectableTimeZone } from '@/domain/analytics/time-zone';
import { ValidationError } from '@/domain/repository';
import { SYSTEM_SETTING_KEYS } from '@/domain/system-settings';
import { analyticsRepository } from '@/infrastructure/analytics-repository';
import { systemSettingsRepository } from '@/infrastructure/system-settings-repository';

/**
 * 基準タイムゾーンの設定（032-timezone-setting 設計 §6.4）。
 *
 * **`updateSystemSettings` に相乗りさせない**（設計 §4.1）。保存のあとに
 * キャッシュの更新と洗い替えジョブの起動が要るため、`system-settings` 側から呼ぶと
 * `system-settings → analytics → system-settings` の循環ができる。
 * UX 上も、表示名の保存と**確認を挟む不可逆な操作**を同じボタンに乗せてはいけない。
 *
 * 3 つとも `system.manage`。**新しい Permission を作らない**（設計 §8）。
 * プレビューも変更と同じ水準に置く——集計値の件数を数える操作であり、変更の前段である。
 */

export interface TimeZoneChangePreview {
  /** 正規化した候補。 */
  readonly timeZone: string;
  /** いま効いている値と、その出所。 */
  readonly currentTimeZone: string;
  readonly currentSource: AnalyticsTimeZoneSource;
  /** 候補が現在値と同じか（同じなら洗い替えは走らない）。 */
  readonly unchanged: boolean;
  /** 洗い替える期間。生ログが 1 行も無ければ null。 */
  readonly rebuildFrom: string | null;
  readonly rebuildTo: string | null;
  readonly rebuildDays: number;
  /** 失われるもの。**出所ごとに分けて返す**（`要件.md` §7-1）。 */
  readonly lostDays: number;
  readonly lostCoreRows: number;
  readonly lostPluginRows: number;
  /** 消える値を入れた Plugin の ID。導入済み Plugin の数で上限が付く。 */
  readonly lostSources: readonly string[];
  readonly lostSites: number;
  readonly lostFrom: string | null;
  readonly lostTo: string | null;
}

/**
 * 保存を許す値だけを通す（設計 §5.3.1）。
 *
 * **保存時は厳しく。** 環境変数のように「警告して UTC へ落とす」扱いにはしない
 * （要件 §5）。別名は正規化した値を返し、オフセット表記（`+09:00`）や
 * 一覧に無い値（`Etc/GMT+5`）は拒否する。
 */
function selectableTimeZone(value: string): string {
  const canonical = canonicalTimeZone(value);
  if (canonical === null || !isSelectableTimeZone(canonical)) {
    throw new ValidationError('SystemSettings', 'timeZone', 'タイムゾーンを選び直してください。');
  }
  return canonical;
}

export const previewTimeZoneChange = defineUseCase<
  { readonly timeZone: string },
  TimeZoneChangePreview
>({
  name: 'analytics.timeZonePreview',
  permission: 'system.manage',
  handler: async (context, input) => {
    const timeZone = selectableTimeZone(input.timeZone);
    const current = await analyticsTimeZoneSetting();

    // 削除と**同じ条件**で数える（設計 §5.4）。**何も変更しない。**
    const oldest = await analyticsRepository.findOldestAccessAt(context.connection);
    const stale = await analyticsRepository.summarizeStaleDays(context.connection, timeZone);

    const rebuildFrom = oldest === null ? null : dateInTimeZone(oldest, timeZone);
    const rebuildTo = oldest === null ? null : todayInTimeZone(timeZone);

    return {
      timeZone,
      currentTimeZone: current.value,
      currentSource: current.source,
      unchanged: timeZone === current.value,
      rebuildFrom,
      rebuildTo,
      rebuildDays:
        rebuildFrom === null || rebuildTo === null ? 0 : rangeDays(rebuildFrom, rebuildTo),
      lostDays: stale.days,
      lostCoreRows: stale.coreRows,
      lostPluginRows: stale.pluginRows,
      lostSources: stale.sources,
      lostSites: stale.sites,
      lostFrom: stale.from,
      lostTo: stale.to,
    };
  },
});

export interface TimeZoneUpdateResult {
  readonly timeZone: string;
  readonly previousTimeZone: string;
  /** 洗い替えを起こしたか。**値が変わったときだけ true。** */
  readonly rebuildStarted: boolean;
}

export const updateAnalyticsTimeZone = defineUseCase<
  { readonly timeZone: string },
  TimeZoneUpdateResult
>({
  name: 'analytics.timeZoneUpdate',
  permission: 'system.manage',
  audit: {
    // 既存の `updateSystemSettings` と同じ `action` / `resourceType`。**列挙値を足さない。**
    action: 'updated',
    resourceType: 'system_settings',
    resourceId: () => null,
    detail: (_input, output) => ({
      setting: SYSTEM_SETTING_KEYS.analyticsTimeZone,
      from: output.previousTimeZone,
      to: output.timeZone,
    }),
  },
  handler: async (context, input) => {
    const timeZone = selectableTimeZone(input.timeZone);

    // **洗い替えを走らせるかは「いま効いている値」との比較だけで決める**（要件 §5）。
    const previousTimeZone = await resolveAnalyticsTimeZone();

    // **値が同じでも書く。** 行が無く環境変数と同じ値を選んだ場合に、
    // 出所を「データベース」へ固定するため（以後、環境変数を変えても効かない状態にそろう）。
    await context.connection.transaction((tx) =>
      systemSettingsRepository.put(tx, SYSTEM_SETTING_KEYS.analyticsTimeZone, timeZone),
    );

    // **保存したプロセスは即座に反映する。** 他プロセスは TTL で追いつく（設計 §6.1.3）。
    primeAnalyticsTimeZone(timeZone);

    const rebuildStarted = timeZone !== previousTimeZone;
    if (rebuildStarted) {
      // **待たずに返す。** 進捗は `job_runs`（設定 → 一般の「定期実行」）から見る。
      startJobInBackground(TIMEZONE_REBUILD_JOB, { timeZone, previousTimeZone });
    }

    return { timeZone, previousTimeZone, rebuildStarted };
  },
});

export const rebuildAnalyticsTimeZone = defineUseCase<
  Record<string, never>,
  { readonly started: boolean }
>({
  name: 'analytics.timeZoneRebuild',
  permission: 'system.manage',
  // **やり直しも監査ログを残す**（設計 §6.4.1）。
  // `system_settings` は書かないが、`analytics` から Core と Plugin の行を出所を問わず消す。
  // `system.manage` は複数人が持ちうる権限であり、`job_runs` に actor の列は無く、
  // `startJobInBackground` は `AuthorizationContext` を捨てる。**残せる場所はここしかない。**
  //
  // **記録が確定するのはジョブを起こした後。** `defineUseCase` は `handler` の戻り値を得てから
  // `recordAudit` を呼び、`startJobInBackground` はその `handler` の中で走る。
  // それでよい——**残すのは「誰がやり直しを起こしたか」**であって、集計の結果ではない。
  audit: {
    // 既存の `updateSystemSettings` / `timeZoneUpdate` と同じ。**列挙値を足さない。**
    action: 'updated',
    resourceType: 'system_settings',
    resourceId: () => null,
    // `rebuild: 'retry'` で、保存に伴う洗い替えの記録（`from` / `to` を持つ）と読み分けられる。
    detail: () => ({ setting: SYSTEM_SETTING_KEYS.analyticsTimeZone, rebuild: 'retry' }),
  },
  handler: async () => {
    // **`system_settings` に触らない。** タイムゾーンは既に保存済みで、
    // やり直しはジョブを起こすだけ（設計 §6.5）。
    //
    // **保存経路と同じ関数で検証する（入口を 2 つ持たない。設計 §6.4.2）。**
    // ここを通さないと、`system_settings` に行が無い環境で `TORIFUNE_TIMEZONE` の値
    // （`isValidTimeZone` しか通っていない）がそのまま削除条件の `AT TIME ZONE` に入る。
    // 注入は無い（バインド値）が、**JS 側と PostgreSQL 側で解釈が割れると、
    // 生ログのある日を「無い日」と誤判定して消す。** 消すのは不可逆である。
    // **走らせずに弾く**（`job_runs` に行を増やさない）。
    const timeZone = selectableTimeZone(await resolveAnalyticsTimeZone());

    // **やり直しでは `previousTimeZone = timeZone`。** 「何から変えたか」は
    // この時点では失われている。前後が同じであること自体を
    // 「これはやり直しである」の印として使う（設計 §6.2.6）。
    // `previousTimeZone` は処理に 1 度も使われないので、印に流用しても結果は変わらない。
    startJobInBackground(TIMEZONE_REBUILD_JOB, { timeZone, previousTimeZone: timeZone });

    return { started: true };
  },
});
