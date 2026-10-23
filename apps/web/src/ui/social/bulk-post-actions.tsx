'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  ConfirmDialog,
  Modal,
  Spinner,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import {
  afterSingleDelete,
  bulkApproveRequestBody,
  bulkDeleteRequestBody,
  bulkPublishNowRequestBody,
  deleteBreakdownOf,
  deleteExcludedOf,
  deletePlanOf,
  effectBreakdownOf,
  excerptOf,
  excludedBreakdownOf,
  isSelectable,
  selectionState,
  sendPlanOf,
  summarizeBulkResults,
  toggleAllSelection,
  type BulkPlanRow,
  type BulkRequestFailure,
  type BulkResultItem,
  type BulkSendTiming,
} from '@/ui/social/bulk-plan';
import {
  BULK_DELETE_CAMPAIGN_NOTE,
  BULK_DELETE_LABEL,
  BULK_DELETE_MESSAGE,
  BULK_DELETE_TITLE,
  BULK_DELETED_TOAST,
  BULK_EXCLUDED_TEXT,
  BULK_RESULT_CLOSE,
  BULK_RESULT_FAILED,
  BULK_RESULT_RETRY_HINT,
  BULK_RESULT_SUCCEEDED,
  BULK_RESULT_TITLE,
  BULK_SEND_APPROVE_LINE,
  BULK_SEND_CONFIRM,
  BULK_SEND_DESIRED_OPTION,
  BULK_SEND_LABEL,
  BULK_SEND_LEAD,
  BULK_SEND_NOTE_MANUAL_DELIVERY,
  BULK_SEND_NOTE_MANUAL_ONLY,
  BULK_SEND_NOW_OPTION,
  BULK_SEND_PUBLISH_NOW_LINE,
  BULK_SEND_TITLE,
  BULK_SEND_WARN_DESIRED_PAST,
  BULK_SEND_WARN_NO_DESIRED,
  SELECT_PAGE_LABEL,
  SELECT_ROW_LABEL,
  SELECTED_COUNT,
  SELECTED_PAGE_COUNT,
} from '@/ui/social/labels';

/**
 * 投稿の選択と一括操作・1 件の削除（054-bulk-post-actions 設計 §9.3〜§9.7。055-social-pending-tab 設計 §9.4 で
 * `social-posts.tsx` から切り出した）。
 *
 * 投稿タブ（`SocialPosts`）と送信待ちタブ（`SocialPending`）が使う。選択・手元で隠した行・ダイアログ・Toast・
 * 読み込み直しの状態をここに持ち、表と帯は呼ぶ側が `children` で描く（選択の列・帯・行の操作を渡す）。
 * **振る舞い・文言は 054 のまま。** 内訳は `bulk-plan.ts` の純関数が作り、正はサーバの項目ごとの結果。
 *
 * **一括選択は表示中のページの行だけ**（054 設計 §5.3）。部品は作り直されない（`key` は条件とページから作る）ので、
 * 一括操作の後は選択をここで空にする。
 */

/** 一括操作の結果のダイアログに渡すもの（`summarizeBulkResults` の引数と同じ形。054 実装プラン §8 の 52）。 */
export interface BulkResultsInput {
  readonly results: readonly BulkResultItem[];
  readonly requestFailures?: readonly BulkRequestFailure[];
}

/** 一括の応答の `data`（054 設計 §8.1）。 */
interface BulkResponse {
  readonly bulkId: string;
  readonly results: readonly BulkResultItem[];
}

/** 一括操作の行（計画の項目と、行を見分ける本文）。 */
export type BulkActionRow = BulkPlanRow;

/** `children` に渡すもの。 */
export interface BulkPostActionsApi<R extends BulkActionRow> {
  /** 表示する行（手元で隠した行を除く）。 */
  readonly rows: readonly R[];
  /** 選択の列。選べないとき（操作の権限が無い）は null。 */
  readonly selectColumn: Column<R> | null;
  /** 一括の帯。描かないとき（選べない・行が無い）は null。 */
  readonly band: ReactNode;
  /** 選んでいる行（表示中の行の並び）。 */
  readonly selectedRows: readonly R[];
  /** 一括操作の処理中か。 */
  readonly busy: boolean;
  /** 行の「削除」：確認を開く。 */
  readonly requestDelete: (row: R) => void;
  /** 1 件の操作が通った行を手元で隠し、選択から外す。 */
  readonly hideRow: (id: string) => void;
  readonly showToast: (message: ToastMessage) => void;
  /** 画面を読み込み直す（`router.refresh()`）。 */
  readonly refresh: () => void;
  /** 選択を空にして読み込み直す。 */
  readonly reload: () => void;
}

export interface BulkPostActionsProps<R extends BulkActionRow> {
  /** 表示中のページの行（props のまま。消した行はここで隠す）。 */
  readonly rows: readonly R[];
  /** 絞り込みに合う全件数（全行を選んだときの「全 n 件」）。 */
  readonly total: number;
  readonly permissions: readonly string[];
  /** 帯の末尾に足すボタン（送信待ちタブの「選んだ手動投稿を順に投稿…」。055 設計 §9.5.1）。 */
  readonly bandExtra?: (input: {
    readonly selectedRows: readonly R[];
    readonly busy: boolean;
  }) => ReactNode;
  /**
   * 選んだ状態・ダイアログを開いた状態・結果のダイアログ・1 件の削除の確認を開いた状態で描く
   * （テストのための口。Server Component は渡さない。054 設計 §9.8・055 実装プラン §8 の 62）。
   */
  readonly initialSelectedIds?: readonly string[];
  readonly initialDialog?: 'send' | 'delete' | null;
  readonly initialResults?: BulkResultsInput;
  readonly initialDeletingId?: string;
  readonly children: (api: BulkPostActionsApi<R>) => ReactNode;
}

const CAPTION_STYLE = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
} as const;

/** 長い本文・文言も折る。ページ全体を横へスクロールさせない（054 設計 §9.11）。 */
const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

/** 帯の並び。狭い画面では折り返す（054 設計 §9.11）。 */
const BAND_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--tf-space-2) var(--tf-space-4)',
  marginBottom: 'var(--tf-space-4)',
};

/**
 * 画面を読み込み直す（`router.refresh()`）。**描いたときに 1 回だけ呼ぶ。**
 *
 * `useRouter` は App Router の外では例外を投げるので、部品の本体では呼ばず、
 * 読み込み直すときだけこれを描く（一覧を単体で描く既存の呼び出しを壊さない）。
 */
export function RefreshOnMount() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}

export function BulkPostActions<R extends BulkActionRow>(props: BulkPostActionsProps<R>) {
  // **行は props から導く**（054 実装プラン §8 の 56）。読み込み直しで描き直された内容（状態・`updatedAt`）を
  // そのまま映し、部品は作り直さない（成功の Toast を残す）。消した行だけを手元で隠す（二重に押させない）。
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const rows = props.rows.filter((row) => !removed.has(row.id));
  const [deleting, setDeleting] = useState<R | null>(
    () => props.rows.find((row) => row.id === props.initialDeletingId) ?? null,
  );
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // 選択は表示中のページの行の ID の集合（054 設計 §5.3・§9.3）。読み込み直すと消える。
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(props.initialSelectedIds ?? []),
  );
  const [dialog, setDialog] = useState<'send' | 'delete' | null>(props.initialDialog ?? null);
  // 時機の既定は選ばない（押したときに選ぶ。054 ユーザー裁定 2）。
  const [sendTiming, setSendTiming] = useState<BulkSendTiming | null>(null);
  const [busy, setBusy] = useState<'send' | 'delete' | null>(null);
  const [results, setResults] = useState<BulkResultsInput | null>(props.initialResults ?? null);
  // 読み込み直した回数。増やすと `RefreshOnMount` を描き直して `router.refresh()` を呼ぶ。
  const [refreshCount, setRefreshCount] = useState(0);

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している（06_画面設計.md §29）。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');
  const canApprove = permissions.has('social.approve');
  // 一括操作のボタンを 1 つでも出せるときだけ選択の列を描く（054 設計 §9.1・§10.1）。
  const canSelect = canApprove || canWrite || canDelete;
  const canSend = canApprove || canWrite;

  const selectedRows = rows.filter((row) => selected.has(row.id));
  const pageState = selectionState(selected, rows);
  const sendPermissions = { canApprove, canWrite };
  // ボタンの disabled は即投稿の内訳で決める（「即投稿」で対象が無いなら「希望日時」でも無い。054 設計 §9.4）。
  const sendNowPlan = sendPlanOf(selectedRows, 'now', sendPermissions);
  const sendTargetCount = sendNowPlan.approve.length + sendNowPlan.publishNow.length;
  const deletePlan = deletePlanOf(selectedRows);

  function refresh(): void {
    setRefreshCount((count) => count + 1);
  }

  /**
   * 一括操作の後に読み込み直す。部品は作り直されない（`key` は絞り込みとページから作る）ので、
   * 選択はここで自分で空にする（054 設計 §9.3・§9.7）。
   */
  function reload(): void {
    setSelected(new Set());
    refresh();
  }

  function hideRow(id: string): void {
    setRemoved((current) => new Set([...current, id]));
    setSelected((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function toggleRow(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * 一括操作を終えたあとの表示（054 設計 §9.7）。
   *
   * * 要求ごと失敗し、1 件も処理していない：Toast（danger）。読み込み直さない（選択は残る）
   * * 全件成功：Toast（success）と読み込み直し
   * * それ以外：結果のダイアログ（「閉じる」で読み込み直す）
   */
  function finish(
    kind: 'send' | 'delete',
    items: readonly BulkResultItem[],
    requestFailures: readonly BulkRequestFailure[],
  ): void {
    const first = requestFailures[0];
    if (items.length === 0 && first !== undefined) {
      setToast({ id: `bulk-${kind}`, text: first.message, tone: 'danger' });
      return;
    }
    if (requestFailures.length === 0 && items.every((item) => item.ok)) {
      const summary = summarizeBulkResults(items, rows);
      setToast({
        id: `bulk-${kind}`,
        text:
          kind === 'delete'
            ? BULK_DELETED_TOAST(summary.succeeded.total)
            : BULK_RESULT_SUCCEEDED(
                summary.succeeded.total,
                effectBreakdownOf(summary.succeeded.byEffect),
              ),
        tone: 'success',
      });
      reload();
      return;
    }
    setResults({ results: items, requestFailures });
  }

  /** 1 本の一括の要求を送り、結果か要求ごとの失敗に振り分ける。 */
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

  async function submitSend(): Promise<void> {
    const timing = sendTiming;
    if (timing === null) return;
    const plan = sendPlanOf(selectedRows, timing, sendPermissions);
    setBusy('send');
    setDialog(null);
    setSendTiming(null);

    const items: BulkResultItem[] = [];
    const requestFailures: BulkRequestFailure[] = [];
    // 承認を先に、今すぐ送るを次に送る（054 設計 §9.5）。2 本目が要求ごと失敗しても 1 本目の結果は捨てない。
    if (plan.approve.length > 0) {
      await sendBulk(
        '/api/v1/social/posts/bulk/approve',
        bulkApproveRequestBody({ timing, rows: plan.approve }),
        plan.approve.map((row) => row.id),
        items,
        requestFailures,
      );
    }
    if (plan.publishNow.length > 0) {
      await sendBulk(
        '/api/v1/social/posts/bulk/publish-now',
        bulkPublishNowRequestBody({ rows: plan.publishNow }),
        plan.publishNow.map((row) => row.id),
        items,
        requestFailures,
      );
    }
    setBusy(null);
    finish('send', items, requestFailures);
  }

  async function submitBulkDelete(): Promise<void> {
    const targets = deletePlan.targets;
    setDialog(null);
    if (targets.length === 0) return;
    setBusy('delete');

    const items: BulkResultItem[] = [];
    const requestFailures: BulkRequestFailure[] = [];
    await sendBulk(
      '/api/v1/social/posts/bulk/delete',
      bulkDeleteRequestBody({ rows: targets }),
      targets.map((row) => row.id),
      items,
      requestFailures,
    );
    setBusy(null);
    // 消えた行は読み込み直す前に手元でも隠す（1 件の削除と同じ）。
    const deleted = new Set(items.filter((item) => item.ok).map((item) => item.id));
    if (deleted.size > 0) {
      setRemoved((current) => new Set([...current, ...deleted]));
    }
    finish('delete', items, requestFailures);
  }

  /** 1 件の削除（055 設計 §9.3.4。投稿タブと送信待ちタブの行の「削除」）。後の状態は `afterSingleDelete`。 */
  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setDeleting(null);

    const result = await apiRequest(`/api/v1/social/posts/${target.id}`, {
      method: 'DELETE',
      body: {},
    });

    // 成功なら行を隠し、選択から外す（054 設計 §9.3）。待つ間に変わった集合へ当てる。失敗なら行は残る。
    const id = target.id;
    setRemoved(
      (current) =>
        afterSingleDelete({ hiddenIds: current, selectedIds: selected }, id, result).hiddenIds,
    );
    setSelected(
      (current) =>
        afterSingleDelete({ hiddenIds: removed, selectedIds: current }, id, result).selectedIds,
    );
    setToast(afterSingleDelete({ hiddenIds: removed, selectedIds: selected }, id, result).toast);
  }

  const selectColumn: Column<R> = {
    key: 'select',
    header: (
      <input
        type="checkbox"
        aria-label={SELECT_PAGE_LABEL}
        checked={pageState === 'all'}
        // `indeterminate` は DOM のプロパティなので ref で立て、描画で見られるよう印も描く（054 実装プラン §8 の 16）。
        data-indeterminate={pageState === 'some' ? 'true' : undefined}
        ref={(element) => {
          if (element !== null) element.indeterminate = pageState === 'some';
        }}
        disabled={busy !== null}
        onChange={() => setSelected(toggleAllSelection(selected, rows))}
      />
    ),
    width: '2.5rem',
    render: (row) =>
      isSelectable(row) ? (
        <input
          type="checkbox"
          aria-label={SELECT_ROW_LABEL(excerptOf(row.body))}
          checked={selected.has(row.id)}
          disabled={busy !== null}
          onChange={() => toggleRow(row.id)}
        />
      ) : null,
  };

  /*
    一括の帯（054 設計 §9.4）。**ボタンの文言に「削除」を含めない**（既存の E2E の locator と取り違えない）。
    押せるかは選んだ行の内訳で決める。正はサーバの項目ごとの結果。
  */
  const band =
    canSelect && rows.length > 0 ? (
      <div style={BAND_STYLE}>
        <span>
          {pageState === 'all' && rows.length < props.total
            ? SELECTED_PAGE_COUNT(selectedRows.length, props.total)
            : SELECTED_COUNT(selectedRows.length)}
        </span>
        {canSend && (
          <Button
            variant="secondary"
            disabled={busy !== null || sendTargetCount === 0}
            onClick={() => {
              setSendTiming(null);
              setDialog('send');
            }}
          >
            {`${BULK_SEND_LABEL}…`}
            {busy === 'send' && <Spinner />}
          </Button>
        )}
        {canDelete && (
          <Button
            variant="secondary"
            disabled={busy !== null || deletePlan.targets.length === 0}
            onClick={() => setDialog('delete')}
          >
            {`${BULK_DELETE_LABEL}…`}
            {busy === 'delete' && <Spinner />}
          </Button>
        )}
        {props.bandExtra?.({ selectedRows, busy: busy !== null })}
      </div>
    ) : null;

  // 一括送信のダイアログの内訳。時機を選ぶ前は即投稿の内訳を出す（054 設計 §9.5）。
  const sendPlan =
    sendTiming === null ? sendNowPlan : sendPlanOf(selectedRows, sendTiming, sendPermissions);
  const sendCount = sendPlan.approve.length + sendPlan.publishNow.length;
  const sendExcludedCount = sendPlan.excluded.reduce((sum, entry) => sum + entry.count, 0);
  const deleteExcluded = deleteExcludedOf(deletePlan);
  const summary =
    results === null
      ? null
      : summarizeBulkResults(results.results, rows, results.requestFailures ?? []);

  return (
    <>
      {props.children({
        rows,
        selectColumn: canSelect ? selectColumn : null,
        band,
        selectedRows,
        busy: busy !== null,
        requestDelete: (row) => setDeleting(row),
        hideRow,
        showToast: (message) => setToast(message),
        refresh,
        reload,
      })}

      <ConfirmDialog
        open={deleting !== null}
        title="投稿を削除しますか？"
        message={deleting === null ? '' : `「${excerptOf(deleting.body)}」を削除します。`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />

      {/* 一括送信（承認）のダイアログ（054 設計 §9.5）。 */}
      <Modal
        open={dialog === 'send'}
        title={BULK_SEND_TITLE}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              disabled={sendTiming === null || sendCount === 0 || busy !== null}
              onClick={() => void submitSend()}
            >
              {BULK_SEND_CONFIRM}
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
          <p style={{ margin: 0 }}>{BULK_SEND_LEAD(selectedRows.length, sendCount)}</p>
          {(['now', 'scheduled'] as const).map((timing) => (
            <label
              key={timing}
              style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}
            >
              <input
                type="radio"
                name="bulkSendTiming"
                value={timing}
                checked={sendTiming === timing}
                onChange={() => setSendTiming(timing)}
              />
              {timing === 'now' ? BULK_SEND_NOW_OPTION : BULK_SEND_DESIRED_OPTION}
            </label>
          ))}
          {sendCount > 0 && (
            <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
              {sendPlan.approve.length > 0 && (
                <li>{BULK_SEND_APPROVE_LINE(sendPlan.approve.length)}</li>
              )}
              {sendPlan.publishNow.length > 0 && (
                <li>{BULK_SEND_PUBLISH_NOW_LINE(sendPlan.publishNow.length)}</li>
              )}
            </ul>
          )}
          {sendPlan.warnings.desiredPast > 0 && (
            <Alert tone="warning">
              {BULK_SEND_WARN_DESIRED_PAST(sendPlan.warnings.desiredPast)}
            </Alert>
          )}
          {sendPlan.warnings.noDesired > 0 && (
            <Alert tone="warning">{BULK_SEND_WARN_NO_DESIRED(sendPlan.warnings.noDesired)}</Alert>
          )}
          {sendPlan.warnings.manualOnly > 0 && (
            <Alert tone="info">{BULK_SEND_NOTE_MANUAL_ONLY(sendPlan.warnings.manualOnly)}</Alert>
          )}
          {sendPlan.warnings.manualDelivery > 0 && (
            <Alert tone="info">
              {BULK_SEND_NOTE_MANUAL_DELIVERY(sendPlan.warnings.manualDelivery)}
            </Alert>
          )}
          {sendExcludedCount > 0 && (
            <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
              {BULK_EXCLUDED_TEXT(sendExcludedCount, excludedBreakdownOf(sendPlan.excluded))}
            </p>
          )}
        </div>
      </Modal>

      {/* 一括取り消しの確認（054 設計 §9.6）。「この操作は取り消せません。」は ConfirmDialog が出す。 */}
      <ConfirmDialog
        open={dialog === 'delete'}
        title={BULK_DELETE_TITLE}
        message={BULK_DELETE_MESSAGE(
          selectedRows.length,
          deletePlan.targets.length,
          deleteBreakdownOf(deletePlan),
        )}
        onConfirm={() => void submitBulkDelete()}
        onCancel={() => setDialog(null)}
      >
        {deleteExcluded.count > 0 && (
          <p style={{ marginBottom: 0 }}>
            {BULK_EXCLUDED_TEXT(deleteExcluded.count, deleteExcluded.breakdown)}
          </p>
        )}
        <p style={{ marginBottom: 0 }}>{BULK_DELETE_CAMPAIGN_NOTE}</p>
      </ConfirmDialog>

      {/* 一括操作の結果（054 設計 §9.7）。「閉じる」で読み込み直す。 */}
      <Modal
        open={summary !== null}
        title={BULK_RESULT_TITLE}
        onClose={() => {
          setResults(null);
          reload();
        }}
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setResults(null);
              reload();
            }}
          >
            {BULK_RESULT_CLOSE}
          </Button>
        }
      >
        {summary !== null && (
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
            <p style={{ margin: 0 }}>
              {BULK_RESULT_SUCCEEDED(
                summary.succeeded.total,
                effectBreakdownOf(summary.succeeded.byEffect),
              )}
            </p>
            {summary.failures.length > 0 && (
              <>
                <p style={{ margin: 0 }}>{BULK_RESULT_FAILED(summary.failures.length)}</p>
                <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {summary.failures.map((failure) => (
                    <li key={failure.id}>
                      {`「${failure.excerpt}」 ${failure.reasonLabel}`}
                      <span style={CAPTION_STYLE}>{failure.message}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
              {BULK_RESULT_RETRY_HINT}
            </p>
          </div>
        )}
      </Modal>

      {refreshCount > 0 && <RefreshOnMount key={refreshCount} />}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
