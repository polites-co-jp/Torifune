'use client';

import Link from 'next/link';
import { useState, type CSSProperties } from 'react';
import type { ManualHandoffOutcome } from '@/application/social/social-use-cases';
import {
  DEFAULT_PENDING_SORT,
  isPendingKind,
  PENDING_KINDS,
  PENDING_SORTS,
  type PendingKind,
  type PendingSort,
} from '@/domain/social/pending';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Modal,
  Pagination,
  Table,
  type Column,
} from '@/ui/components';
import { ApprovalDialog, RejectDialog } from '@/ui/social/approval-dialog';
import { excerptOf } from '@/ui/social/bulk-plan';
import { BulkPostActions, type BulkResultsInput } from '@/ui/social/bulk-post-actions';
import {
  APPROVAL_DESIRED_PAST_NOTE,
  APPROVAL_PENDING_GUIDE,
  APPROVE_OPEN_LABEL,
  APPROVED_ROW_NOTE,
  APPROVED_TOAST_AUTO,
  APPROVED_TOAST_MANUAL,
  DELIVERY_MODE_LABEL,
  MANUAL_CANCEL_CONFIRM_LABEL,
  MANUAL_CANCEL_CONFIRM_MESSAGE,
  MANUAL_CANCEL_CONFIRM_TITLE,
  MANUAL_CANCELLED_TOAST,
  MANUAL_DONE_CONFIRM_LABEL,
  MANUAL_DONE_DIALOG_MESSAGE,
  MANUAL_DONE_DIALOG_TITLE,
  MANUAL_DONE_TOAST,
  MANUAL_DONE_URL_LABEL,
  MANUAL_HANDOFF_REASON_LABEL,
  MANUAL_OUTCOME_STALE_MESSAGE,
  MANUAL_PENDING_CANCEL_LABEL,
  MANUAL_PENDING_DONE_LABEL,
  MANUAL_PENDING_FALLBACK_LABEL,
  MANUAL_PENDING_GUIDE,
  MANUAL_PENDING_OPEN_LABEL,
  MANUAL_SEQUENCE_LABEL,
  NO_CREDENTIAL_BADGE,
  NO_PUBLISHER_BADGE,
  PENDING_AWAITING_MANUAL_NOTE,
  PENDING_COUNT_OPTION,
  PENDING_DESIRED_NOTE,
  PENDING_ELAPSED_NOTE,
  PENDING_EMPTY,
  PENDING_EMPTY_POSTS_LINK,
  PENDING_HEADING,
  PENDING_KIND_LABEL,
  PENDING_MANUAL_ONLY_NOTE,
  PENDING_PUBLISHING_NOTE,
  PENDING_SORT_LABEL,
  PENDING_SORT_OPTION_LABEL,
  POST_FILTER_ALL,
  POST_FILTER_CLEAR,
  POST_FILTER_EMPTY,
  POST_SOURCE_COLUMN_HEADER,
  REJECT_LABEL,
  REJECTED_TOAST,
  remainingSkipsLabel,
  retryingNoteLabel,
} from '@/ui/social/labels';
import { openManualWindow, type OpenManualWindow } from '@/ui/social/manual-handoff';
import { manualOutcomeRequestBody, manualSequencePlanOf } from '@/ui/social/manual-sequence-plan';
import { pendingListHref, type PendingListFilters } from '@/ui/social/pending-list-params';
import { DEFAULT_POST_PER_PAGE, type PostListOption } from '@/ui/social/post-list-params';
import { PostFilterBar } from '@/ui/social/post-filter-bar';
import {
  PostSourceLabel,
  UnreadyAlert,
  UnreadyBadge,
  unreadyOf,
  type AccountProvider,
  type PostRow,
  type PublisherProvider,
} from '@/ui/social/social-posts';
import { socialTabHref } from '@/ui/social/social-tabs';
import { AsyncState } from '@/ui/states/async-state';

/**
 * 送信待ちの表（055-social-pending-tab 設計 §9.2〜§9.4・§9.10）。
 *
 * 承認待ち・予約済み（自動・手動）・手動投稿待ちを **1 つの表**に並べる（ユーザー裁定 3）。
 * 一括の選択・帯・ダイアログ・1 件の削除は投稿タブと同じ `BulkPostActions`、絞り込みの帯は `PostFilterBar`。
 *
 * **URL は描画時に確定している。** 「投稿画面を開く」は `window.open` をクリックの同期処理の中で呼ぶ
 * （`openManualWindow`）。押してから publisher に問い合わせるとポップアップとして扱われずブロックされる。
 * Server Component が手動の予約の行だけ `resolveManualHandoff` を掛け、その結果を `handoff` で渡す。
 * **承認待ちの行には `handoff` を渡さない**（承認を経ずに SNS へ出す手がかりを画面に残さない。設計 §5.5）。
 *
 * **「いま」を見ない。** 区分・経過・希望日時が過ぎたかは Server Component が決めて行に載せる。
 * 操作ボタンの出し分けは**表示制御であって認可ではない**。認可は UseCase が行う。
 */

/** 送信待ちの行（054 の `PostRow` に足す。Server Component が作る。設計 §9.3.5）。 */
export interface PendingRow extends PostRow {
  readonly kind: PendingKind;
  /** 予約時刻からの経過（例：`12 分`）。`manual_pending` のとき。 */
  readonly elapsedText?: string;
  /** `resolveManualHandoff` の結果。手動の予約（`scheduled`・`manual`）の行だけ。 */
  readonly handoff?: ManualHandoffOutcome;
  /** 承認のダイアログの全文の確認に使う。 */
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  /** 依頼の日時（`createdAt` の ISO）。 */
  readonly requestedAt: string;
  /** 承認待ちの自動の行で、配信の支度が無い。 */
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

export interface SocialPendingProps {
  readonly rows: readonly PendingRow[];
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  /** アカウントIDから provider と資格情報の有無を引く対応表。 */
  readonly accountProviders: Readonly<Record<string, AccountProvider>>;
  /** provider から登録された publisher を引く対応表。 */
  readonly publisherProviders: Readonly<Record<string, PublisherProvider>>;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
  /** 解釈した送信待ちの条件（設計 §9.2）。 */
  readonly filters: PendingListFilters;
  /** 区分ごとの件数（アカウント・登録元を掛けた後、状態を掛ける前。UseCase の出力のまま）。 */
  readonly counts: Readonly<Record<PendingKind, number>>;
  /** 登録元の絞り込みの選択肢（「すべて」を含む。`postSourceOptionsOf` が作る）。 */
  readonly sourceOptions?: readonly PostListOption[];
  /** アカウントの絞り込みの選択肢（「すべて」を含めない。名前順）。 */
  readonly accountOptions?: readonly PostListOption[];
  /**
   * 子ウィンドウを開く口。既定は `window.open`（単体テストの環境には `window` が無い。
   * `manual-pending.tsx` と同じ）。既定値なので通常の経路は変わらない。
   */
  readonly open?: OpenManualWindow;
  /**
   * 選んだ状態・ダイアログを開いた状態で描く（テストのための口。Server Component は渡さない）。
   * 054 設計 §9.8 の 3 つと、承認のダイアログ・1 件の削除の確認（実装プラン §8 の 61・62）。
   */
  readonly initialSelectedIds?: readonly string[];
  readonly initialDialog?: 'send' | 'delete' | null;
  readonly initialResults?: BulkResultsInput;
  readonly initialApprovingId?: string;
  readonly initialDeletingId?: string;
}

/** 「条件をクリア」の行き先（並び順も既定に戻す `/social`。設計 §9.2）。 */
const CLEARED_FILTERS: PendingListFilters = {
  status: null,
  accountId: null,
  source: null,
  perPage: DEFAULT_POST_PER_PAGE,
  sort: DEFAULT_PENDING_SORT,
  page: 1,
};

const SORT_OPTIONS: readonly PostListOption[] = PENDING_SORTS.map((sort) => ({
  value: sort,
  label: PENDING_SORT_OPTION_LABEL[sort],
}));

function toPendingKind(value: string): PendingKind | null {
  return isPendingKind(value) ? value : null;
}

function toPendingSort(value: string): PendingSort {
  return (PENDING_SORTS as readonly string[]).includes(value)
    ? (value as PendingSort)
    : DEFAULT_PENDING_SORT;
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

/** 手動の予約（「投稿画面を開く」「投稿した」「取りやめ」を出す行。設計 §5.5）。 */
function isManualScheduled(row: PendingRow): boolean {
  return row.deliveryMode === 'manual' && row.status === 'scheduled';
}

const CAPTION_STYLE = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
} as const;

/**
 * 操作のセル（設計 §9.3.4。ユーザー裁定 8）。入りきらないボタンは次の行へ折り返す。
 * 並びは主な操作 → 記録・判断 → 編集 → 削除で、「削除」は常に最後。
 */
const OPS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--tf-space-2)',
  alignItems: 'center',
};

export function SocialPending(props: SocialPendingProps) {
  const [approvingId, setApprovingId] = useState<string | null>(
    () => props.rows.find((row) => row.id === props.initialApprovingId)?.id ?? null,
  );
  const [rejecting, setRejecting] = useState<PendingRow | null>(null);
  const [done, setDone] = useState<PendingRow | null>(null);
  const [externalUrl, setExternalUrl] = useState('');
  const [cancelling, setCancelling] = useState<PendingRow | null>(null);

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している（06_画面設計.md §29）。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');
  const canApprove = permissions.has('social.approve');

  const { filters } = props;
  // 表示件数と並び順は「条件」に数えない（見え方の設定で行を絞らない。設計 §9.2）。
  const hasConditions =
    filters.status !== null || filters.accountId !== null || filters.source !== null;
  const clearHref = pendingListHref(CLEARED_FILTERS);

  const totalCount = PENDING_KINDS.reduce((sum, kind) => sum + props.counts[kind], 0);
  const statusOptions: readonly PostListOption[] = [
    { value: '', label: PENDING_COUNT_OPTION(POST_FILTER_ALL, totalCount) },
    ...PENDING_KINDS.map((kind) => ({
      value: kind,
      label: PENDING_COUNT_OPTION(PENDING_KIND_LABEL[kind], props.counts[kind]),
    })),
  ];

  return (
    <BulkPostActions
      rows={props.rows}
      total={props.total}
      permissions={props.permissions}
      bandExtra={({ selectedRows, busy }) =>
        canWrite ? (
          <Button
            variant="secondary"
            disabled={busy || manualSequencePlanOf(selectedRows).targets.length === 0}
          >
            {`${MANUAL_SEQUENCE_LABEL}…`}
          </Button>
        ) : null
      }
      {...(props.initialSelectedIds === undefined
        ? {}
        : { initialSelectedIds: props.initialSelectedIds })}
      {...(props.initialDialog === undefined ? {} : { initialDialog: props.initialDialog })}
      {...(props.initialResults === undefined ? {} : { initialResults: props.initialResults })}
      {...(props.initialDeletingId === undefined
        ? {}
        : { initialDeletingId: props.initialDeletingId })}
    >
      {({ rows, selectColumn, band, requestDelete, hideRow, showToast, refresh }) => {
        /** 1 件の操作が通った行を隠し、Toast を出して読み込み直す（設計 §9.3.4）。 */
        function succeeded(id: string, text: string): void {
          hideRow(id);
          showToast({ id, text, tone: 'success' });
          refresh();
        }

        async function confirmDone(): Promise<void> {
          const target = done;
          if (target === null) return;
          setDone(null);
          const url = externalUrl;
          setExternalUrl('');

          const result = await apiRequest(`/api/v1/social/posts/${target.id}/manual-outcome`, {
            method: 'POST',
            body: manualOutcomeRequestBody('posted', target.updatedAt ?? '', url),
          });
          if (result.ok) {
            succeeded(target.id, MANUAL_DONE_TOAST);
            return;
          }
          // 見た後に内容が変わった（409）。部品が文言を決め、読み込み直す（設計 §9.9）。
          if (result.error.status === 409) {
            showToast({ id: target.id, text: MANUAL_OUTCOME_STALE_MESSAGE, tone: 'danger' });
            refresh();
            return;
          }
          showToast({ id: target.id, text: result.error.message, tone: 'danger' });
        }

        async function confirmCancel(): Promise<void> {
          const target = cancelling;
          if (target === null) return;
          setCancelling(null);

          const result = await apiRequest(`/api/v1/social/posts/${target.id}`, {
            method: 'PATCH',
            body: { status: 'draft' },
          });
          if (result.ok) {
            succeeded(target.id, MANUAL_CANCELLED_TOAST);
          } else {
            showToast({ id: target.id, text: result.error.message, tone: 'danger' });
          }
        }

        function statusCell(row: PendingRow) {
          const handoff = row.handoff;
          return (
            <span>
              {PENDING_KIND_LABEL[row.kind]}
              {row.kind === 'manual_pending' && row.elapsedText !== undefined && (
                <span style={CAPTION_STYLE}>{PENDING_ELAPSED_NOTE(row.elapsedText)}</span>
              )}
              {row.status === 'scheduled' &&
                row.approvedAt !== undefined &&
                row.approvedAt !== null && <span style={CAPTION_STYLE}>{APPROVED_ROW_NOTE}</span>}
              {row.status === 'scheduled' && row.failureReason !== null && (
                <span style={CAPTION_STYLE}>{retryingNoteLabel(row.attemptCount)}</span>
              )}
              {row.publishing === true && (
                <span style={CAPTION_STYLE}>{PENDING_PUBLISHING_NOTE}</span>
              )}
              {row.status === 'scheduled' && row.deliveryMode === 'auto' && row.skipCount > 0 && (
                <span style={CAPTION_STYLE}>{remainingSkipsLabel(row.skipCount)}</span>
              )}
              {row.status === 'awaiting_approval' && row.manualOnly === true && (
                <span style={CAPTION_STYLE}>{PENDING_MANUAL_ONLY_NOTE}</span>
              )}
              {/* 承認待ちの手動投稿は承認の後に投稿画面を開ける（設計 §5.5）。 */}
              {row.status === 'awaiting_approval' && row.deliveryMode === 'manual' && (
                <span style={CAPTION_STYLE}>{PENDING_AWAITING_MANUAL_NOTE}</span>
              )}
              {isManualScheduled(row) && handoff !== undefined && !handoff.ok && (
                <span style={{ ...CAPTION_STYLE, color: 'var(--tf-color-warning)' }}>
                  ⚠ {MANUAL_HANDOFF_REASON_LABEL[handoff.reason]}。
                </span>
              )}
              {/* 支度の Badge：自動の予約は今の投稿一覧と同じ判定、承認待ちの自動は Server の判定。 */}
              <UnreadyBadge
                unready={unreadyOf(row, props.accountProviders, props.publisherProviders)}
              />
              {row.status === 'awaiting_approval' && row.warning !== null && (
                <span style={{ display: 'block', marginTop: 'var(--tf-space-1)' }}>
                  <Badge tone="warning">
                    {row.warning === 'no_publisher' ? NO_PUBLISHER_BADGE : NO_CREDENTIAL_BADGE}
                  </Badge>
                </span>
              )}
            </span>
          );
        }

        function dateCell(row: PendingRow) {
          if (row.status !== 'awaiting_approval') {
            return formatDateTime(row.scheduledAt);
          }
          // 承認待ちは希望日時（設計 §9.3.1）。
          if (row.scheduledAt === null) {
            return '—';
          }
          return (
            <span>
              {formatDateTime(row.scheduledAt)}
              <span style={CAPTION_STYLE}>
                {PENDING_DESIRED_NOTE}
                {row.desiredPast === true && APPROVAL_DESIRED_PAST_NOTE}
              </span>
            </span>
          );
        }

        function opsCell(row: PendingRow) {
          const handoff = row.handoff;
          const editLink = canWrite && (
            <Link href={`/social/posts/${row.id}/edit?from=pending`}>
              <Button variant="ghost">編集</Button>
            </Link>
          );
          const deleteButton = canDelete && (
            <Button variant="ghost" onClick={() => requestDelete(row)}>
              削除
            </Button>
          );

          if (isManualScheduled(row)) {
            return (
              <span style={OPS_STYLE}>
                <Button
                  variant="primary"
                  disabled={handoff === undefined || !handoff.ok}
                  onClick={() => {
                    // 押した瞬間に開く（クリックの同期処理の中。035 設計 §7.1）。
                    if (handoff !== undefined && handoff.ok) {
                      openManualWindow(handoff.url, props.open);
                    }
                  }}
                >
                  {MANUAL_PENDING_OPEN_LABEL}
                </Button>
                {/* ブロックされたときの逃げ道。`noopener` を付けると開けたか判別できない（035 設計 §7.2）。 */}
                {handoff !== undefined && handoff.ok && (
                  <a
                    href={handoff.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--tf-color-primary)', fontSize: 'var(--tf-text-caption)' }}
                  >
                    {MANUAL_PENDING_FALLBACK_LABEL}
                  </a>
                )}
                {/* 開けない行でも押せる。人が別の手段で投稿した場合を閉ざさない（035 設計 §7.1）。 */}
                {canWrite && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setExternalUrl('');
                      setDone(row);
                    }}
                  >
                    {MANUAL_PENDING_DONE_LABEL}
                  </Button>
                )}
                {canWrite && (
                  <Button variant="ghost" onClick={() => setCancelling(row)}>
                    {MANUAL_PENDING_CANCEL_LABEL}
                  </Button>
                )}
                {editLink}
                {deleteButton}
              </span>
            );
          }

          if (row.status === 'awaiting_approval') {
            return (
              <span style={OPS_STYLE}>
                {canApprove && (
                  <Button variant="primary" onClick={() => setApprovingId(row.id)}>
                    {APPROVE_OPEN_LABEL}
                  </Button>
                )}
                {canWrite && (
                  <Button variant="secondary" onClick={() => setRejecting(row)}>
                    {REJECT_LABEL}
                  </Button>
                )}
                {editLink}
                {deleteButton}
              </span>
            );
          }

          return (
            <span style={OPS_STYLE}>
              {editLink}
              {deleteButton}
            </span>
          );
        }

        const columns: Column<PendingRow>[] = [
          ...(selectColumn === null ? [] : [selectColumn]),
          { key: 'status', header: '状態', width: '12rem', render: statusCell },
          {
            key: 'account',
            header: 'アカウント',
            width: '12rem',
            render: (row) => props.accountNames[row.socialAccountId] ?? row.socialAccountId,
          },
          {
            key: 'body',
            header: '本文',
            render: (row) => (
              <span>
                {excerptOf(row.body)}
                {/* Plugin の補足は抜粋の下に出す（今の区画と同じ。実装プラン §8 の 11）。 */}
                {row.handoff !== undefined && row.handoff.ok && row.handoff.note !== null && (
                  <span style={CAPTION_STYLE}>{row.handoff.note}</span>
                )}
              </span>
            ),
          },
          {
            key: 'source',
            header: POST_SOURCE_COLUMN_HEADER,
            width: '10rem',
            render: (row) => <PostSourceLabel source={row.source} />,
          },
          { key: 'date', header: '日時', width: '12rem', render: dateCell },
          {
            key: 'deliveryMode',
            header: '配信方法',
            width: '7rem',
            render: (row) => DELIVERY_MODE_LABEL[row.deliveryMode] ?? row.deliveryMode,
          },
          { key: 'actions', header: '操作', width: '16rem', render: opsCell },
        ];

        const unreadyCount = rows.filter(
          (row) => unreadyOf(row, props.accountProviders, props.publisherProviders) !== null,
        ).length;
        const hasManualPending = rows.some((row) => row.kind === 'manual_pending');
        const hasAwaiting = rows.some((row) => row.kind === 'awaiting_approval');
        const approvingRow =
          approvingId === null ? undefined : rows.find((row) => row.id === approvingId);
        const createLink = (label: string) => (
          <Link href="/social/posts/new?from=pending">
            <Button variant="primary">{label}</Button>
          </Link>
        );

        return (
          <>
            <header
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                margin: 'var(--tf-space-6) 0 var(--tf-space-4)',
              }}
            >
              <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{PENDING_HEADING}</h2>
              {canWrite && createLink('+ 投稿を作成')}
            </header>

            {hasManualPending && canWrite && (
              <div style={{ marginBottom: 'var(--tf-space-3)' }}>
                <Alert tone="warning">{MANUAL_PENDING_GUIDE}</Alert>
              </div>
            )}
            {hasAwaiting && (
              <div style={{ marginBottom: 'var(--tf-space-3)' }}>
                <Alert tone="info">{APPROVAL_PENDING_GUIDE}</Alert>
              </div>
            )}

            <PostFilterBar
              filters={filters}
              hrefFor={pendingListHref}
              statusOptions={statusOptions}
              toStatus={toPendingKind}
              {...(props.accountOptions === undefined
                ? {}
                : { accountOptions: props.accountOptions })}
              {...(props.sourceOptions === undefined ? {} : { sourceOptions: props.sourceOptions })}
              extraSelect={{
                label: PENDING_SORT_LABEL,
                value: filters.sort,
                options: SORT_OPTIONS,
                apply: (value) => ({ sort: toPendingSort(value) }),
              }}
              hasConditions={hasConditions}
              clearHref={clearHref}
            />

            <UnreadyAlert count={unreadyCount} />

            {band}

            <AsyncState
              status={rows.length === 0 ? 'empty' : 'ready'}
              // 条件で絞って 0 件なら、送信待ちが無いのではなく条件に合わないことを伝える（設計 §9.3.2）。
              emptyMessage={hasConditions ? POST_FILTER_EMPTY : PENDING_EMPTY}
              emptyAction={
                hasConditions ? (
                  <a href={clearHref}>{POST_FILTER_CLEAR}</a>
                ) : (
                  <span
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 'var(--tf-space-3)',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <a href={socialTabHref('posts')}>{PENDING_EMPTY_POSTS_LINK}</a>
                    {canWrite && createLink('投稿を作成')}
                  </span>
                )
              }
            >
              <Card>
                <Table columns={columns} rows={rows} rowKey={(row) => row.id} />
                <Pagination
                  page={props.page}
                  perPage={props.perPage}
                  total={props.total}
                  // 絞り込みと並び順を保ったまま移る（設計 §9.2）。選択は読み込み直しで消える。
                  onChange={(page) => window.location.assign(pendingListHref({ ...filters, page }))}
                />
              </Card>
            </AsyncState>

            <ApprovalDialog
              key={approvingRow?.id ?? 'closed'}
              row={approvingRow ?? null}
              accountName={
                approvingRow === undefined
                  ? ''
                  : (props.accountNames[approvingRow.socialAccountId] ??
                    approvingRow.socialAccountId)
              }
              open={approvingRow !== undefined}
              onClose={() => setApprovingId(null)}
              onApproved={(row) => {
                setApprovingId(null);
                succeeded(
                  row.id,
                  row.deliveryMode === 'manual' ? APPROVED_TOAST_MANUAL : APPROVED_TOAST_AUTO,
                );
              }}
              onReload={() => {
                setApprovingId(null);
                refresh();
              }}
            />

            <RejectDialog
              target={rejecting}
              onCancel={() => setRejecting(null)}
              onRejected={(id) => succeeded(id, REJECTED_TOAST)}
              onFailed={(id, message) => showToast({ id, text: message, tone: 'danger' })}
            />

            <Modal
              open={done !== null}
              title={MANUAL_DONE_DIALOG_TITLE}
              onClose={() => {
                setDone(null);
                setExternalUrl('');
              }}
              footer={
                <>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDone(null);
                      setExternalUrl('');
                    }}
                  >
                    キャンセル
                  </Button>
                  <Button variant="primary" onClick={() => void confirmDone()}>
                    {MANUAL_DONE_CONFIRM_LABEL}
                  </Button>
                </>
              }
            >
              <p style={{ marginTop: 0 }}>{MANUAL_DONE_DIALOG_MESSAGE}</p>
              <label style={{ display: 'block' }}>
                {MANUAL_DONE_URL_LABEL}
                <Input
                  type="url"
                  name="externalUrl"
                  value={externalUrl}
                  placeholder="https://"
                  onChange={(event) => setExternalUrl(event.target.value)}
                  style={{ marginTop: 'var(--tf-space-1)' }}
                />
              </label>
            </Modal>

            <ConfirmDialog
              open={cancelling !== null}
              title={MANUAL_CANCEL_CONFIRM_TITLE}
              message={MANUAL_CANCEL_CONFIRM_MESSAGE}
              confirmLabel={MANUAL_CANCEL_CONFIRM_LABEL}
              onConfirm={() => void confirmCancel()}
              onCancel={() => setCancelling(null)}
            />
          </>
        );
      }}
    </BulkPostActions>
  );
}
