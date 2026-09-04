import { hostname } from 'node:os';
import { parseIntervalMinutes, parseSchedulerSwitch } from '@/domain/jobs/job';
import { log } from '@/infrastructure/logging';

/**
 * 定期実行の設定（029-scheduled-jobs 設計 §6.1.2）。
 *
 * | 変数 | 既定 | 意味 |
 * | --- | --- | --- |
 * | `TORIFUNE_SCHEDULER` | `on` | `off` で本体の定期実行を止める（外部スケジューラ向け） |
 * | `TORIFUNE_ROLLUP_INTERVAL_MINUTES` | `15` | analytics ロールアップの間隔（1〜1440 の整数） |
 * | `TORIFUNE_WEBHOOK_INTERVAL_MINUTES` | `1` | Webhook 配信の間隔（1〜1440 の整数） |
 *
 * **落とさない。** `TORIFUNE_TIMEZONE` と同じ扱いで、設定の誤りで本体の起動を止めない。
 * ただし黙って既定へ落ちない（警告をプロセスで 1 回だけ出す）。
 *
 * 読み取りは 1 回だけ。実行中に変えても反映しない（再起動が要る）。
 */

const DEFAULT_ROLLUP_INTERVAL_MINUTES = 15;
const DEFAULT_WEBHOOK_INTERVAL_MINUTES = 1;

export interface SchedulerConfig {
  readonly enabled: boolean;
  readonly rollupIntervalMinutes: number;
  readonly webhookIntervalMinutes: number;
}

let cached: SchedulerConfig | null = null;

/** 未設定（未定義・空）か。未設定は既定を使うだけで、警告の対象ではない。 */
function isUnset(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '';
}

function readInterval(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = parseIntervalMinutes(raw);
  if (parsed !== null) {
    return parsed;
  }
  if (!isUnset(raw)) {
    log.warn('定期実行の間隔の指定が不正なため既定値を使う', {
      variable: name,
      value: raw,
      fallbackMinutes: fallback,
    });
  }
  return fallback;
}

function readEnabled(): boolean {
  const raw = process.env['TORIFUNE_SCHEDULER'];
  const parsed = parseSchedulerSwitch(raw);
  if (parsed !== null) {
    return parsed;
  }
  log.warn('TORIFUNE_SCHEDULER の指定が不正なため定期実行を有効のままにする', { value: raw });
  return true;
}

export function schedulerConfig(): SchedulerConfig {
  cached ??= {
    enabled: readEnabled(),
    rollupIntervalMinutes: readInterval(
      'TORIFUNE_ROLLUP_INTERVAL_MINUTES',
      DEFAULT_ROLLUP_INTERVAL_MINUTES,
    ),
    webhookIntervalMinutes: readInterval(
      'TORIFUNE_WEBHOOK_INTERVAL_MINUTES',
      DEFAULT_WEBHOOK_INTERVAL_MINUTES,
    ),
  };
  return cached;
}

/** テスト用。読み直し（と警告）をやり直せるようにする（`resetTimeZoneWarning` と同じ役目）。 */
export function resetSchedulerConfig(): void {
  cached = null;
}

/**
 * 実行したプロセスの名前（`hostname:pid`）。
 *
 * 複数プロセス構成で「どれが動いたか」を `job_runs.runner` から見る。
 */
export function runnerName(): string {
  return `${hostname()}:${process.pid}`;
}
