'use client';

import { useState } from 'react';
import type { JobName, JobRunStatus } from '@/domain/jobs/job';
import {
  JOB_STATUS_LABEL,
  NO_VALUE,
  REBUILD_RETRY_LABEL,
  SCHEDULER_OFF_TEXT,
} from '@/ui/analytics/labels';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Badge, Button, Card, Table, type BadgeTone, type Column } from '@/ui/components';

/**
 * 設定 → 一般の「定期実行」の区画（029-scheduled-jobs 設計 §7.2）。
 *
 * **`system.manage` を持つときだけ描かれる。** 表示制御であって認可ではない
 * （認可は `listJobStatuses`）。読み取りだけで、操作はほぼ無い。
 *
 * 日時は Server Component が運用タイムゾーンの文字列にして渡す。
 * ここでは並べるだけ（`app/settings/page.tsx`）。
 *
 * 唯一の操作が**洗い替えの再実行**（032-timezone-setting 設計 §7.3）。
 * 失敗・中断した洗い替えを人が立て直すための口で、**自動再試行は無い**。
 * 出す条件（直近の実行が `ok` でないとき）の判定も Server Component 側にある。
 */

/** 画面に出す直近のエラーの本文の長さ。全文は `GET /api/v1/jobs`。 */
const ERROR_PREVIEW_LENGTH = 200;

export interface JobStatusRow {
  readonly name: JobName;
  /** 表示名（「アクセス解析の集計」など）。 */
  readonly label: string;
  /** 周期（分）。**周期を持たないジョブは `null`**（表示は `—`）。 */
  readonly intervalMinutes: number | null;
  /** 前回の実行（`YYYY-MM-DD HH:mm`）。未実行なら null。 */
  readonly lastRunAt: string | null;
  readonly lastRunStatus: JobRunStatus | null;
  /** 前回の成功（`YYYY-MM-DD HH:mm`）。 */
  readonly lastSuccessAt: string | null;
  /** 次回の予定（`YYYY-MM-DD HH:mm`）。無効・未起動なら null。 */
  readonly nextRunAt: string | null;
  /**
   * 再実行の導線を出すか（032-timezone-setting 設計 §7.3.1）。
   *
   * **判定は Server Component（`app/settings/page.tsx`）が組み立てて渡す。**
   * ここは渡された値で描くだけ。
   */
  readonly canRetry: boolean;
  /** 実行中の進捗の注記（`summary.completedThrough` 由来）。 */
  readonly progressNote?: string | null;
  /** 再実行を勧める理由。 */
  readonly retryNote?: string | null;
}

export interface JobStatusError {
  readonly jobLabel: string;
  /** 発生時刻（`YYYY-MM-DD HH:mm`）。 */
  readonly at: string;
  readonly error: string;
}

export interface JobStatusCardData {
  /** `instrumentation.ts` が基盤を起こしたか。通常は true（false なら配線の不備）。 */
  readonly booted: boolean;
  readonly enabled: boolean;
  readonly jobs: readonly JobStatusRow[];
  /** 直近のエラー（新しい順）。 */
  readonly recentErrors: readonly JobStatusError[];
}

const STATUS_TONE: Record<JobRunStatus, BadgeTone> = {
  ok: 'success',
  error: 'danger',
  skipped: 'neutral',
  running: 'neutral',
};

/** 基盤の状態を 1 行で。 */
function headlineOf(data: JobStatusCardData): string {
  if (!data.booted) {
    return '定期実行の基盤が起動していません。';
  }
  return data.enabled ? '定期実行は有効です（このプロセス）。' : `定期実行は ${SCHEDULER_OFF_TEXT}`;
}

const COLUMNS: readonly Column<JobStatusRow>[] = [
  { key: 'label', header: 'ジョブ', render: (row) => row.label },
  {
    key: 'interval',
    header: '間隔',
    // 周期を持たないジョブ（要求されたときだけ走る）は `—`。
    render: (row) => (row.intervalMinutes === null ? NO_VALUE : `${row.intervalMinutes} 分`),
  },
  { key: 'lastRun', header: '前回の実行', render: (row) => row.lastRunAt ?? NO_VALUE },
  {
    key: 'status',
    header: '結果',
    render: (row) =>
      row.lastRunStatus === null ? (
        NO_VALUE
      ) : (
        // `Badge` は `data-*` を受けないので、包む要素に付ける（E2E がここを引く）。
        <span data-job-status={row.lastRunStatus}>
          <Badge tone={STATUS_TONE[row.lastRunStatus]}>{JOB_STATUS_LABEL[row.lastRunStatus]}</Badge>
        </span>
      ),
  },
  { key: 'lastSuccess', header: '前回の成功', render: (row) => row.lastSuccessAt ?? NO_VALUE },
  { key: 'nextRun', header: '次回', render: (row) => row.nextRunAt ?? NO_VALUE },
];

/**
 * 進捗の注記と再実行の導線。
 *
 * **表の中に置かない。** 行を増やすと「ジョブが 1 つ増えた」ように見える。
 */
function JobNotes({ jobs }: { readonly jobs: readonly JobStatusRow[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = jobs.filter(
    (job) =>
      job.canRetry || (job.progressNote ?? null) !== null || (job.retryNote ?? null) !== null,
  );

  if (shown.length === 0) {
    return null;
  }

  async function onRetry(): Promise<void> {
    setError(null);
    setBusy(true);
    const result = await apiRequest('/api/v1/analytics/timezone-rebuild', { method: 'POST' });
    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    // 結果は表の行そのものが示す。サーバー描画なので読み込み直す。
    window.location.reload();
  }

  return (
    <div style={{ marginTop: 'var(--tf-space-4)' }}>
      {error !== null && <Alert tone="danger">{error}</Alert>}

      {shown.map((job) => (
        <div key={job.name} style={{ marginBottom: 'var(--tf-space-2)' }}>
          {(job.progressNote ?? null) !== null && (
            <p style={{ margin: '0 0 var(--tf-space-2)', color: 'var(--tf-color-text-muted)' }}>
              {job.progressNote}
            </p>
          )}
          {(job.retryNote ?? null) !== null && (
            <p style={{ margin: '0 0 var(--tf-space-2)', color: 'var(--tf-color-text-muted)' }}>
              {job.retryNote}
            </p>
          )}
          {job.canRetry && (
            <Button variant="secondary" disabled={busy} onClick={() => void onRetry()}>
              {REBUILD_RETRY_LABEL}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function JobStatusCard({ data }: { readonly data: JobStatusCardData }) {
  return (
    <Card>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>定期実行</h2>

      <p style={{ margin: '0 0 var(--tf-space-4)', color: 'var(--tf-color-text-muted)' }}>
        {headlineOf(data)}
      </p>

      <Table columns={COLUMNS} rows={data.jobs} rowKey={(row) => row.name} />

      <JobNotes jobs={data.jobs} />

      {data.recentErrors.length > 0 && (
        <div style={{ marginTop: 'var(--tf-space-5)' }}>
          <h3 style={{ fontSize: 'var(--tf-text-label)', margin: '0 0 var(--tf-space-2)' }}>
            直近のエラー
          </h3>
          <ul style={{ margin: 0, paddingLeft: 'var(--tf-space-5)' }}>
            {data.recentErrors.map((entry) => (
              <li
                key={`${entry.jobLabel}-${entry.at}-${entry.error.slice(0, 20)}`}
                style={{ color: 'var(--tf-color-text-muted)', lineHeight: 1.6 }}
              >
                <span>
                  {entry.jobLabel} {entry.at}
                </span>{' '}
                <span style={{ overflowWrap: 'anywhere' }}>
                  {entry.error.slice(0, ERROR_PREVIEW_LENGTH)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p
        style={{
          margin: 'var(--tf-space-4) 0 0',
          fontSize: 'var(--tf-text-caption)',
          color: 'var(--tf-color-text-subtle)',
          lineHeight: 1.6,
        }}
      >
        複数プロセスで動かしている場合、「次回」はこの画面を返したプロセスの予定です。
        実行はジョブごとのロックにより 1 プロセスだけが行います。
        間隔と有効・無効は環境変数で決まります（画面からは変えられません）。
      </p>
    </Card>
  );
}
