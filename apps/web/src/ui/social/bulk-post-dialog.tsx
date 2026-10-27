'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import type { ManualHandoffOutcome } from '@/application/social/social-use-cases';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Modal, Spinner, type ToastMessage } from '@/ui/components';
import {
  bulkPublishNowRequestBody,
  effectBreakdownOf,
  summarizeBulkResults,
  type BulkRequestFailure,
  type BulkResultItem,
} from '@/ui/social/bulk-plan';
import {
  approvedManualTargetsOf,
  bulkPostApproveRequestBody,
  bulkPostOutcomeOf,
  bulkPostPlanOf,
  bulkPostTargetCountOf,
  scheduledManualTargetsOf,
  type BulkPostPermissions,
  type BulkPostPlan,
  type BulkPostRow,
  type HandoffFailedItem,
} from '@/ui/social/bulk-post-plan';
import {
  BULK_EXCLUDED_TEXT,
  BULK_POST_APPROVE_LINE,
  BULK_POST_CONFIRM,
  BULK_POST_EXCLUDED_LABEL,
  BULK_POST_FIRST_OPENED,
  BULK_POST_HANDOFF_FAILED_LABEL,
  BULK_POST_LABEL,
  BULK_POST_LEAD,
  BULK_POST_MANUAL_GUIDE,
  BULK_POST_MANUAL_LINE,
  BULK_POST_PUBLISH_NOW_LINE,
  BULK_POST_RESULT_TITLE,
  BULK_POST_RUNNING,
  BULK_POST_TITLE,
  BULK_RESULT_CLOSE,
  BULK_RESULT_FAILED,
  BULK_RESULT_RETRY_HINT,
  BULK_RESULT_SUCCEEDED,
} from '@/ui/social/labels';
import { openManualWindow, type OpenManualWindow } from '@/ui/social/manual-handoff';
import { ManualSequence, type ManualSequenceRecord } from '@/ui/social/manual-sequence';
import type { ManualSequenceTarget } from '@/ui/social/manual-sequence-plan';

/**
 * 送信待ちタブの「一括投稿…」とそのダイアログ（057-social-bulk-post 設計 §5.2〜§5.4・§7.2〜§7.5。ユーザー裁定 3・4）。
 *
 * 確認 → 処理中 → 順に投稿（`ManualSequence`）→ 終わりの表示、の順に進む。
 *
 * * **最初の窓は「投稿する」のクリックの同期処理の中で開く**（順に開く先頭が予約済みの手動投稿のとき。URL は描画時の
 *   `handoff`）。承認した手動投稿の URL は承認の後でないと取れないので、それしか無ければ 1 件目は「開いていない」段で出す
 * * 承認を先、今すぐ送るを次に送る（054 §9.5 と同じ。2 本目が要求ごと失敗しても 1 本目の結果は捨てない）。
 *   承認できた手動投稿ごとに画面専用の `GET /social/posts/{id}/manual-handoff` を並行に送り、URL を取る
 * * 順に開くのは予約済みの手動（表の順）→ 承認できて URL の取れた手動（表の順）
 *
 * 振り分けは**画面が読んだ行**からの見込み（`bulkPostPlanOf`）で、正はサーバの項目ごとの結果。
 * 表示は権限で出し分けるが、認可は UseCase が行う。
 */

type Stage = 'closed' | 'confirm' | 'running' | 'sequence' | 'result';

/** 一括の応答の `data`（054 設計 §8.1）。 */
interface BulkResponse {
  readonly results: readonly BulkResultItem[];
}

/** 「投稿する」で始めた一括投稿の、1 段目までの結果。 */
interface RunState {
  /** 始めたときの選択（選び直しで変わらない。結果の抜粋もここから引く）。 */
  readonly rows: readonly BulkPostRow[];
  readonly results: readonly BulkResultItem[];
  readonly requestFailures: readonly BulkRequestFailure[];
  readonly handoffFailed: readonly HandoffFailedItem[];
  readonly targets: readonly ManualSequenceTarget[];
  /** 1 件目の窓を「投稿する」で開いたか。 */
  readonly firstOpened: boolean;
}

export interface BulkPostDialogProps<R extends BulkPostRow> {
  /** 選んでいる行（表示中の行の並び）。 */
  readonly selectedRows: readonly R[];
  /** 一括操作（一括取り消し）の処理中か。 */
  readonly busy: boolean;
  readonly permissions: BulkPostPermissions;
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  readonly showToast: (message: ToastMessage) => void;
  /** 選択を空にして読み込み直す。 */
  readonly reload: () => void;
  /** 子ウィンドウを開く口。既定は `window.open`（単体テストの環境には `window` が無い）。 */
  readonly open?: OpenManualWindow;
  /** 確認を開いた状態で描く（テストのための口。057 実装プラン §8 の 14）。 */
  readonly initialStage?: 'confirm';
}

/** 長い本文・文言も折る。ページ全体を横へスクロールさせない（057 設計 §7.7）。 */
const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

const CAPTION_STYLE: CSSProperties = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
};

const LIST_STYLE: CSSProperties = { margin: 0, paddingLeft: '1.2em' };

/** 対象外の内訳（例「配信待ち・配信中 1」）。並びは `bulkPostPlanOf` の理由の順。 */
function excludedBreakdownOf(plan: BulkPostPlan<BulkPostRow>): string {
  return plan.excluded
    .map((entry) => `${BULK_POST_EXCLUDED_LABEL[entry.reason]} ${entry.count}`)
    .join('・');
}

export function BulkPostDialog<R extends BulkPostRow>(props: BulkPostDialogProps<R>) {
  const [stage, setStage] = useState<Stage>(props.initialStage ?? 'closed');
  const [run, setRun] = useState<RunState | null>(null);

  const plan = bulkPostPlanOf(props.selectedRows, props.permissions);
  const targetCount = bulkPostTargetCountOf(plan);
  const excludedCount = plan.excluded.reduce((sum, entry) => sum + entry.count, 0);
  const approveManual = plan.approve.filter((row) => row.deliveryMode === 'manual').length;
  const manualCount = plan.manual.length + approveManual;

  function close(): void {
    setStage('closed');
    setRun(null);
  }

  /** 1 本の一括の要求を送り、結果か要求ごとの失敗に振り分ける（054 の `sendBulk` と同じ）。 */
  async function sendBulk(
    path: string,
    body: unknown,
    ids: readonly string[],
    items: BulkResultItem[],
    requestFailures: BulkRequestFailure[],
  ): Promise<void> {
    const result = await apiRequest<BulkResponse>(path, { method: 'POST', body });
    if (result.ok) {
      items.push(...result.data.results);
    } else {
      requestFailures.push({ ids, message: result.error.message });
    }
  }

  async function submit(): Promise<void> {
    if (stage !== 'confirm') return;
    // 始めたときの選択で進める（処理中に選び直しても変わらない）。
    const started = bulkPostPlanOf(props.selectedRows, props.permissions);
    const rows: readonly BulkPostRow[] = props.selectedRows;
    const scheduled = scheduledManualTargetsOf(started.manual);
    // **同期で**先頭の予約済みの手動投稿の窓を開く（クリックの同期処理の中。057 設計 §5.4・§7.4 の 1）。
    const first = scheduled[0];
    if (first !== undefined) {
      openManualWindow(first.url, props.open);
    }
    setStage('running');
    setRun({
      rows,
      results: [],
      requestFailures: [],
      handoffFailed: [],
      targets: [],
      firstOpened: first !== undefined,
    });

    const items: BulkResultItem[] = [];
    const requestFailures: BulkRequestFailure[] = [];
    if (started.approve.length > 0) {
      await sendBulk(
        '/api/v1/social/posts/bulk/approve',
        bulkPostApproveRequestBody(started.approve),
        started.approve.map((row) => row.id),
        items,
        requestFailures,
      );
    }
    if (started.publishNow.length > 0) {
      await sendBulk(
        '/api/v1/social/posts/bulk/publish-now',
        bulkPublishNowRequestBody({ rows: started.publishNow }),
        started.publishNow.map((row) => row.id),
        items,
        requestFailures,
      );
    }

    // 承認できた手動投稿の投稿画面の URL を並行に取る（057 設計 §5.3）。失敗は「URL の取れなかった件」になる。
    const manualIds = new Set(
      started.approve.filter((row) => row.deliveryMode === 'manual').map((row) => row.id),
    );
    const approvedManualIds = items
      .filter((item) => item.ok && manualIds.has(item.id))
      .map((item) => item.id);
    const handoffs = Object.fromEntries(
      await Promise.all(
        approvedManualIds.map(async (id) => {
          const result = await apiRequest<ManualHandoffOutcome>(
            `/api/v1/social/posts/${id}/manual-handoff`,
            { method: 'GET' },
          );
          return [id, result.ok ? result.data : null] as const;
        }),
      ),
    );
    const approved = approvedManualTargetsOf(items, started.approve, handoffs);
    const targets = [...scheduled, ...approved.targets];
    const state: RunState = {
      rows,
      results: items,
      requestFailures,
      handoffFailed: approved.handoffFailed,
      targets,
      firstOpened: first !== undefined,
    };
    setRun(state);

    if (targets.length > 0) {
      setStage('sequence');
      return;
    }
    // 順に開くものが無ければ 054 の終え方（057 設計 §7.4 の 7）。
    const firstFailure = requestFailures[0];
    if (items.length === 0 && firstFailure !== undefined) {
      close();
      props.showToast({ id: 'bulk-post', text: firstFailure.message, tone: 'danger' });
      return;
    }
    if (
      requestFailures.length === 0 &&
      approved.handoffFailed.length === 0 &&
      items.every((item) => item.ok)
    ) {
      const summary = summarizeBulkResults(items, rows);
      close();
      props.showToast({
        id: 'bulk-post',
        text: BULK_RESULT_SUCCEEDED(
          summary.succeeded.total,
          effectBreakdownOf(summary.succeeded.byEffect),
        ),
        tone: 'success',
      });
      props.reload();
      return;
    }
    setStage('result');
  }

  /** 終わりの表示を閉じた（057 設計 §7.5）。1 段目の成功か記録が 1 件以上なら選択を空にして読み込み直す。 */
  function finish(records: readonly ManualSequenceRecord[]): void {
    if (run === null) {
      close();
      return;
    }
    const outcome = bulkPostOutcomeOf({
      results: run.results,
      requestFailures: run.requestFailures,
      rows: run.rows,
      records,
      sequenceTotal: run.targets.length,
      handoffFailed: run.handoffFailed,
    });
    close();
    if (outcome.reload) props.reload();
  }

  /** 1 段目（承認・今すぐ送る）の結果。1 段目の要求も URL の取得の失敗も無ければ何も出さない。 */
  function summaryOf(state: RunState): ReactNode {
    const ran = state.results.length > 0 || state.requestFailures.length > 0;
    if (!ran && state.handoffFailed.length === 0) return null;
    const summary = summarizeBulkResults(state.results, state.rows, state.requestFailures);
    return (
      <>
        {ran && (
          <p style={{ margin: 0 }}>
            {BULK_RESULT_SUCCEEDED(
              summary.succeeded.total,
              effectBreakdownOf(summary.succeeded.byEffect),
            )}
          </p>
        )}
        {state.handoffFailed.length > 0 && (
          <>
            <p style={{ margin: 0 }}>{BULK_POST_HANDOFF_FAILED_LABEL}</p>
            <ul style={LIST_STYLE}>
              {state.handoffFailed.map((item) => (
                <li key={item.id}>{`「${item.excerpt}」`}</li>
              ))}
            </ul>
          </>
        )}
        {summary.failures.length > 0 && (
          <>
            <p style={{ margin: 0 }}>{BULK_RESULT_FAILED(summary.failures.length)}</p>
            <ul style={LIST_STYLE}>
              {summary.failures.map((failure) => (
                <li key={failure.id}>
                  {`「${failure.excerpt}」 ${failure.reasonLabel}`}
                  <span style={CAPTION_STYLE}>{failure.message}</span>
                </li>
              ))}
            </ul>
            <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
              {BULK_RESULT_RETRY_HINT}
            </p>
          </>
        )}
      </>
    );
  }

  const running = stage === 'running';

  return (
    <>
      <Button
        variant="secondary"
        disabled={props.busy || stage !== 'closed' || targetCount === 0}
        onClick={() => setStage('confirm')}
      >
        {`${BULK_POST_LABEL}…`}
        {stage === 'running' && <Spinner />}
      </Button>

      {/* 確認と処理中（057 設計 §7.3・§7.4）。処理中は × と「投稿する」を効かせない。 */}
      <Modal
        open={stage === 'confirm' || running}
        title={BULK_POST_TITLE}
        onClose={() => {
          if (!running) close();
        }}
        footer={
          <>
            <Button variant="secondary" disabled={running} onClick={close}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              disabled={running || targetCount === 0}
              onClick={() => void submit()}
            >
              {BULK_POST_CONFIRM}
            </Button>
          </>
        }
      >
        {running ? (
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
            <p
              style={{
                margin: 0,
                display: 'flex',
                gap: 'var(--tf-space-2)',
                alignItems: 'center',
              }}
            >
              <Spinner />
              {BULK_POST_RUNNING}
            </p>
            {run?.firstOpened === true && <p style={{ margin: 0 }}>{BULK_POST_FIRST_OPENED}</p>}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
            <p style={{ margin: 0 }}>{BULK_POST_LEAD(props.selectedRows.length, targetCount)}</p>
            {targetCount > 0 && (
              <ul style={LIST_STYLE}>
                {plan.publishNow.length > 0 && (
                  <li>{BULK_POST_PUBLISH_NOW_LINE(plan.publishNow.length)}</li>
                )}
                {plan.approve.length > 0 && (
                  <li>
                    {BULK_POST_APPROVE_LINE(
                      plan.approve.length,
                      plan.approve.length - approveManual,
                      approveManual,
                    )}
                  </li>
                )}
                {manualCount > 0 && <li>{BULK_POST_MANUAL_LINE(manualCount)}</li>}
              </ul>
            )}
            {manualCount > 0 && <Alert tone="info">{BULK_POST_MANUAL_GUIDE}</Alert>}
            {excludedCount > 0 && (
              <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
                {BULK_EXCLUDED_TEXT(excludedCount, excludedBreakdownOf(plan))}
              </p>
            )}
          </div>
        )}
      </Modal>

      {stage === 'sequence' && run !== null && (
        <ManualSequence
          targets={run.targets}
          accountNames={props.accountNames}
          firstOpened={run.firstOpened}
          summary={summaryOf(run)}
          onFinish={(records) => finish(records)}
          {...(props.open === undefined ? {} : { open: props.open })}
        />
      )}

      {/* 順に投稿の無い一括投稿の結果（057 設計 §7.4 の 7。実装プラン §8 の 21）。 */}
      <Modal
        open={stage === 'result' && run !== null}
        title={BULK_POST_RESULT_TITLE}
        onClose={() => finish([])}
        footer={
          <Button variant="primary" onClick={() => finish([])}>
            {BULK_RESULT_CLOSE}
          </Button>
        }
      >
        {run !== null && (
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
            {summaryOf(run)}
          </div>
        )}
      </Modal>
    </>
  );
}
