'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type CSSProperties } from 'react';
import type { ApprovalTiming, DeliveryMode } from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Modal,
  Toast,
  type ToastMessage,
} from '@/ui/components';
import { approveRequestBody, defaultApprovalTiming } from '@/ui/social/approval-request';
import { toLocalInputValue } from '@/ui/social/datetime-local';
import {
  APPROVAL_DESIRED_LABEL,
  APPROVAL_DESIRED_PAST_NOTE,
  APPROVAL_LINK_LABEL,
  APPROVAL_MEDIA_LABEL,
  APPROVAL_PENDING_ANCHOR,
  APPROVAL_PENDING_GUIDE,
  APPROVAL_PENDING_LABEL,
  APPROVAL_REQUESTED_LABEL,
  APPROVAL_VIA_LABEL,
  APPROVE_DESIRED_PAST_WARNING,
  APPROVE_DIALOG_TITLE,
  APPROVE_LABEL,
  APPROVE_NOW_LABEL,
  APPROVE_OPEN_LABEL,
  APPROVE_RELOAD_LABEL,
  APPROVE_SCHEDULED_LABEL,
  APPROVE_STALE_MESSAGE,
  APPROVED_TOAST_AUTO,
  APPROVED_TOAST_MANUAL,
  DELIVERY_MODE_LABEL,
  MANUAL_ONLY_APPROVAL_NOTE,
  NO_CREDENTIAL_BADGE,
  NO_PUBLISHER_BADGE,
  REJECT_CONFIRM_MESSAGE,
  REJECT_CONFIRM_TITLE,
  REJECT_LABEL,
  REJECTED_TOAST,
} from '@/ui/social/labels';

/**
 * 「承認待ち」区画（048-social-post-approval 設計 §7.1・§7.2）。
 *
 * **「いま」を見ない。** 希望日時が過ぎているか（`desiredPast`）は Server Component が決めて渡す。
 * ここで `Date.now()` を見ると Server と Client で描画が食い違う。
 *
 * **画像は描かない**（`<img>` を使わない）。画面のセキュリティヘッダが外部の画像を読ませないので、
 * URL と代替テキストを出す（設計 §3.2・§7.1.2）。
 *
 * 承認待ちの手動投稿に「投稿画面を開く」は出さない（承認の前に SNS へ出させない。設計 §7.2）。
 *
 * ボタンの出し分けは**表示制御であって認可ではない**。認可は UseCase が行う（設計 §8）。
 */

export interface ApprovalPendingRow {
  readonly id: string;
  /** 「表示名（provider の表示名）」。 */
  readonly accountName: string;
  readonly deliveryMode: DeliveryMode;
  readonly body: string;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  /** 依頼の日時（`createdAt` の ISO）。 */
  readonly requestedAt: string;
  /** API トークンからの登録か。**トークンの ID は渡さない**（Server が真偽にする）。 */
  readonly viaApi: boolean;
  /** 希望日時（`scheduledAt` の ISO）。無ければ null。 */
  readonly desiredScheduledAt: string | null;
  /** 希望日時が「いま」以前か（Server が決める）。 */
  readonly desiredPast: boolean;
  /** 手動投稿しかできない配信 Plugin の provider か（承認は常に即投稿になる。設計 §6.7）。 */
  readonly manualOnly: boolean;
  /** 承認の `expectedUpdatedAt` に添える（見た内容を承認する。設計 §6.4.3）。 */
  readonly updatedAt: string;
  /** 自動配信で配信の支度が無い（承認しても支度待ちになる）。承認は止めない。 */
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

export interface ApprovalPendingProps {
  readonly rows: readonly ApprovalPendingRow[];
  /** 承認待ちの全件数（区画に出すのは先頭 50 件まで。見出しで溢れが分かる）。 */
  readonly total: number;
  /** `social.approve` を持つか。**表示制御であって認可ではない。** */
  readonly canApprove: boolean;
  /** `social.write` を持つか。**表示制御であって認可ではない。** */
  readonly canWrite: boolean;
  /**
   * 承認のダイアログを開いた状態で描く行（テストのための口。Server Component は渡さない）。
   * `social-accounts.tsx` の `initialEditingAccountId` と同じ形。
   */
  readonly initialApprovingId?: string;
}

const CAPTION_STYLE: CSSProperties = {
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
};

/** 長い URL も折る。ページ全体を横へスクロールさせない（設計 §7.1.5）。 */
const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

const LINK_STYLE: CSSProperties = { color: 'var(--tf-color-primary)', ...WRAP_ANYWHERE };

const FIELD_ERROR_STYLE: CSSProperties = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-danger)',
  fontSize: 'var(--tf-text-caption)',
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

/** 承認のダイアログの状態。 */
interface ApprovingState {
  readonly id: string;
  readonly timing: ApprovalTiming;
  readonly scheduledAtLocal: string;
  /** 409：見た後に内容が変わっていた。 */
  readonly stale: boolean;
  /** 日時の欄の下に出す 422 の文言。 */
  readonly scheduledAtErrors: readonly string[];
  /** ダイアログの上に出す文言（日時以外の 422・その他の失敗）。 */
  readonly errors: readonly string[];
  readonly busy: boolean;
}

function openState(row: ApprovalPendingRow): ApprovingState {
  return {
    id: row.id,
    timing: defaultApprovalTiming(row),
    scheduledAtLocal: toLocalInputValue(row.desiredScheduledAt),
    stale: false,
    scheduledAtErrors: [],
    errors: [],
    busy: false,
  };
}

export function ApprovalPending(props: ApprovalPendingProps) {
  const router = useRouter();
  // **行は props から導く。** `router.refresh()` で描き直された内容（書き換えられた本文など）を
  // そのまま映すため。片付けた行だけを手元で隠す（次の描画を待つ間に二重に押させない）。
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const rows = props.rows.filter((row) => !removed.has(row.id));

  const [approving, setApproving] = useState<ApprovingState | null>(() => {
    const initial = props.rows.find((row) => row.id === props.initialApprovingId);
    return initial === undefined ? null : openState(initial);
  });
  const [rejecting, setRejecting] = useState<ApprovalPendingRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const approvingRow = approving === null ? undefined : rows.find((row) => row.id === approving.id);

  function hide(id: string): void {
    setRemoved((current) => new Set([...current, id]));
  }

  async function submitApproval(): Promise<void> {
    if (approving === null || approvingRow === undefined) return;
    const row = approvingRow;
    // 手動投稿しかできない配信 Plugin の行は「即投稿」だけ（サーバも読み替える。設計 §6.7.3）。
    const timing: ApprovalTiming = row.manualOnly ? 'now' : approving.timing;
    setApproving({ ...approving, busy: true, errors: [], scheduledAtErrors: [] });

    const result = await apiRequest(`/api/v1/social/posts/${row.id}/approve`, {
      method: 'POST',
      body: approveRequestBody({
        timing,
        scheduledAtLocal: approving.scheduledAtLocal,
        updatedAt: row.updatedAt,
      }),
    });

    if (result.ok) {
      setApproving(null);
      hide(row.id);
      setToast({
        id: row.id,
        text: row.deliveryMode === 'manual' ? APPROVED_TOAST_MANUAL : APPROVED_TOAST_AUTO,
        tone: 'success',
      });
      // 予約になった行を投稿一覧へ、手動投稿なら「手動投稿待ち」へ映す（設計 §7.2）。
      router.refresh();
      return;
    }

    const { error } = result;
    if (error.status === 409 || error.code === 'CONFLICT') {
      setApproving({ ...approving, busy: false, stale: true });
      return;
    }
    const details = error.details ?? {};
    const scheduledAtErrors = details['scheduledAt'] ?? [];
    const others = Object.entries(details)
      .filter(([key]) => key !== 'scheduledAt')
      .flatMap(([, messages]) => messages);
    setApproving({
      ...approving,
      busy: false,
      scheduledAtErrors,
      errors: others.length > 0 || scheduledAtErrors.length > 0 ? others : [error.message],
    });
  }

  function reloadAfterStale(): void {
    setApproving(null);
    router.refresh();
  }

  async function confirmReject(): Promise<void> {
    const target = rejecting;
    if (target === null) return;
    setRejecting(null);

    const result = await apiRequest(`/api/v1/social/posts/${target.id}`, {
      method: 'PATCH',
      body: { status: 'draft' },
    });
    if (result.ok) {
      hide(target.id);
      setToast({ id: target.id, text: REJECTED_TOAST, tone: 'success' });
      router.refresh();
    } else {
      setToast({ id: target.id, text: result.error.message, tone: 'danger' });
    }
  }

  // 0 件なら区画そのものを描かない（設計 §7.1）。
  if (rows.length === 0) {
    return null;
  }

  const count = Math.max(props.total - removed.size, rows.length);

  return (
    <section id={APPROVAL_PENDING_ANCHOR} style={{ marginTop: 'var(--tf-space-6)' }}>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 var(--tf-space-3)' }}>
        {`${APPROVAL_PENDING_LABEL}（${count} 件）`}
      </h2>

      <div style={{ marginBottom: 'var(--tf-space-3)' }}>
        <Alert tone="info">{APPROVAL_PENDING_GUIDE}</Alert>
      </div>

      <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
        {rows.map((row) => (
          <Card key={row.id}>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 'var(--tf-space-2) var(--tf-space-4)',
                alignItems: 'center',
                ...WRAP_ANYWHERE,
              }}
            >
              <strong>{row.accountName}</strong>
              <Badge>{DELIVERY_MODE_LABEL[row.deliveryMode]}</Badge>
              <span style={CAPTION_STYLE}>
                {`${APPROVAL_REQUESTED_LABEL} ${formatDateTime(row.requestedAt)}（${
                  row.viaApi ? APPROVAL_VIA_LABEL.api : APPROVAL_VIA_LABEL.screen
                }）`}
              </span>
              <span style={CAPTION_STYLE}>
                {`${APPROVAL_DESIRED_LABEL} ${
                  row.desiredScheduledAt === null ? '—' : formatDateTime(row.desiredScheduledAt)
                }`}
                {row.desiredScheduledAt !== null && row.desiredPast && APPROVAL_DESIRED_PAST_NOTE}
              </span>
              {row.warning !== null && (
                <Badge tone="warning">
                  {row.warning === 'no_publisher' ? NO_PUBLISHER_BADGE : NO_CREDENTIAL_BADGE}
                </Badge>
              )}
            </div>

            {row.manualOnly && (
              <div style={{ marginTop: 'var(--tf-space-3)' }}>
                <Alert tone="warning">{MANUAL_ONLY_APPROVAL_NOTE}</Alert>
              </div>
            )}

            {/* 本文は全文を出す。承認は内容を確かめる操作で、抜粋では判断できない（設計 §7.1.2）。 */}
            <p
              style={{
                whiteSpace: 'pre-wrap',
                margin: 'var(--tf-space-3) 0 0',
                ...WRAP_ANYWHERE,
              }}
            >
              {row.body}
            </p>

            {row.link !== null && (
              <p style={{ margin: 'var(--tf-space-2) 0 0', ...WRAP_ANYWHERE }}>
                {`${APPROVAL_LINK_LABEL}：`}
                <a href={row.link} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
                  {row.link}
                </a>
              </p>
            )}

            {row.media.length > 0 && (
              <ul style={{ margin: 'var(--tf-space-2) 0 0', paddingLeft: '1.2em' }}>
                {row.media.map((item, index) => (
                  <li key={`${item.url}-${index}`} style={WRAP_ANYWHERE}>
                    {`${APPROVAL_MEDIA_LABEL}：`}
                    <a href={item.url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
                      {item.url}
                    </a>
                    {item.alt !== null && item.alt !== '' && `（${item.alt}）`}
                  </li>
                ))}
              </ul>
            )}

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                gap: 'var(--tf-space-2)',
                marginTop: 'var(--tf-space-3)',
              }}
            >
              {props.canWrite && (
                <Link href={`/social/posts/${row.id}/edit`}>
                  <Button variant="ghost">編集</Button>
                </Link>
              )}
              {props.canWrite && (
                <Button variant="secondary" onClick={() => setRejecting(row)}>
                  {REJECT_LABEL}
                </Button>
              )}
              {props.canApprove && (
                <Button variant="primary" onClick={() => setApproving(openState(row))}>
                  {APPROVE_OPEN_LABEL}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {approving !== null && approvingRow !== undefined && (
        <Modal
          open
          title={APPROVE_DIALOG_TITLE}
          onClose={() => setApproving(null)}
          footer={
            approving.stale ? (
              <Button variant="primary" onClick={reloadAfterStale}>
                {APPROVE_RELOAD_LABEL}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setApproving(null)}>
                  キャンセル
                </Button>
                <Button
                  variant="primary"
                  disabled={approving.busy}
                  onClick={() => void submitApproval()}
                >
                  {APPROVE_LABEL}
                </Button>
              </>
            )
          }
        >
          {approving.stale && (
            <div style={{ marginBottom: 'var(--tf-space-3)' }}>
              <Alert tone="danger">{APPROVE_STALE_MESSAGE}</Alert>
            </div>
          )}
          {approving.errors.length > 0 && (
            <div style={{ marginBottom: 'var(--tf-space-3)' }}>
              <Alert tone="danger">{approving.errors.join(' ')}</Alert>
            </div>
          )}

          <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
            <label style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}>
              <input
                type="radio"
                name="approvalTiming"
                value="now"
                checked={approvingRow.manualOnly || approving.timing === 'now'}
                onChange={() => setApproving({ ...approving, timing: 'now' })}
              />
              {APPROVE_NOW_LABEL}
            </label>

            {approvingRow.manualOnly ? (
              <Alert tone="warning">{MANUAL_ONLY_APPROVAL_NOTE}</Alert>
            ) : (
              <div>
                <label style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}>
                  <input
                    type="radio"
                    name="approvalTiming"
                    value="scheduled"
                    checked={approving.timing === 'scheduled'}
                    onChange={() => setApproving({ ...approving, timing: 'scheduled' })}
                  />
                  {APPROVE_SCHEDULED_LABEL}
                </label>
                <div style={{ marginTop: 'var(--tf-space-2)', paddingLeft: '1.6em' }}>
                  <Input
                    type="datetime-local"
                    name="approvalScheduledAt"
                    aria-label={APPROVE_SCHEDULED_LABEL}
                    value={approving.scheduledAtLocal}
                    disabled={approving.timing === 'now'}
                    onChange={(event) =>
                      setApproving({ ...approving, scheduledAtLocal: event.target.value })
                    }
                    style={{ maxWidth: '100%' }}
                  />
                  {approvingRow.desiredScheduledAt !== null && (
                    <span style={{ ...CAPTION_STYLE, marginLeft: 'var(--tf-space-2)' }}>
                      （{APPROVAL_DESIRED_LABEL}）
                    </span>
                  )}
                  {approving.scheduledAtErrors.map((message) => (
                    <span key={message} style={FIELD_ERROR_STYLE}>
                      {message}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {!approvingRow.manualOnly &&
              approvingRow.desiredScheduledAt !== null &&
              approvingRow.desiredPast && (
                <Alert tone="warning">{APPROVE_DESIRED_PAST_WARNING}</Alert>
              )}
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={rejecting !== null}
        title={REJECT_CONFIRM_TITLE}
        message={REJECT_CONFIRM_MESSAGE}
        confirmLabel={REJECT_LABEL}
        onConfirm={() => void confirmReject()}
        onCancel={() => setRejecting(null)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  );
}
