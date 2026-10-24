'use client';

import { useState, type CSSProperties } from 'react';
import type { ApprovalTiming, DeliveryMode } from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Badge, Button, ConfirmDialog, Input, Modal } from '@/ui/components';
import { approveRequestBody, defaultApprovalTiming } from '@/ui/social/approval-request';
import { toLocalInputValue } from '@/ui/social/datetime-local';
import {
  APPROVAL_DESIRED_LABEL,
  APPROVAL_DESIRED_PAST_NOTE,
  APPROVAL_LINK_LABEL,
  APPROVAL_MEDIA_LABEL,
  APPROVAL_REQUESTED_LABEL,
  APPROVE_DESIRED_PAST_WARNING,
  APPROVE_DIALOG_TITLE,
  APPROVE_LABEL,
  APPROVE_NOW_LABEL,
  APPROVE_RELOAD_LABEL,
  APPROVE_SCHEDULED_LABEL,
  APPROVE_STALE_MESSAGE,
  DELIVERY_MODE_LABEL,
  MANUAL_ONLY_APPROVAL_NOTE,
  NO_CREDENTIAL_BADGE,
  NO_PUBLISHER_BADGE,
  POST_SOURCE_COLUMN_HEADER,
  REJECT_CONFIRM_MESSAGE,
  REJECT_CONFIRM_TITLE,
  REJECT_LABEL,
} from '@/ui/social/labels';
import type { PostSourceView } from '@/ui/social/post-list-params';
import { PostSourceLabel } from '@/ui/social/social-posts';

/**
 * 1 件の承認のダイアログと差し戻しの確認（048-social-post-approval 設計 §7.1.3、055-social-pending-tab 設計 §9.3.4）。
 *
 * 送信待ちの表の「承認する…」が開く。承認は内容を確かめる操作で、抜粋では判断できないので、
 * 承認待ちの区画のカードが出していた内容（本文の全文・リンク・画像の URL と代替テキスト・依頼の日時と登録元・
 * 希望日時・支度の警告・手動投稿のみの注意）を時機の選択の上に出す（048 §7.1.2）。
 * **登録元は 054 の表示**（「管理画面」／トークンの名前）。区画の依頼の経路「API／画面」は出さない（055 §9.3.4）。
 *
 * **「いま」を見ない。** 希望日時が過ぎているか（`desiredPast`）は Server Component が決めて渡す。
 * **画像は描かない**（`<img>` を使わない。画面のセキュリティヘッダが外部の画像を読ませない。048 §3.2）。
 * 承認待ちの手動投稿に「投稿画面を開く」は出さない（承認の前に SNS へ出させない。048 §7.2）。
 *
 * 閉じた後の読み込み直しは呼ぶ側が行う（`useRouter` をこの部品の本体で呼ばない。055 実装プラン §8 の 22）。
 */

/** 承認に要る行の項目（送信待ちの行 `PendingRow` の一部。055 設計 §9.3.5）。 */
export interface ApprovalDialogRow {
  readonly id: string;
  readonly body: string;
  readonly deliveryMode: DeliveryMode;
  /** 承認待ちでは希望日時（ISO）。無ければ null。 */
  readonly scheduledAt: string | null;
  /** 希望日時が「いま」以前か（Server が決める）。 */
  readonly desiredPast?: boolean;
  /** 手動投稿しかできない配信 Plugin の provider か（承認は常に即投稿になる。048 §6.7）。 */
  readonly manualOnly?: boolean;
  /** 承認の `expectedUpdatedAt` に添える（見た内容を承認する。048 §6.4.3）。 */
  readonly updatedAt?: string;
  /** 登録元の表示（054）。**トークンの ID は持たない。** 渡さない行は「—」。 */
  readonly source?: PostSourceView;
  readonly link: string | null;
  readonly media: readonly { readonly url: string; readonly alt: string | null }[];
  /** 依頼の日時（`createdAt` の ISO）。 */
  readonly requestedAt: string;
  /** 自動配信で配信の支度が無い（承認しても支度待ちになる）。承認は止めない。 */
  readonly warning: 'no_publisher' | 'credential_missing' | null;
}

export interface ApprovalDialogProps {
  /** 開いている行。閉じているときは null。 */
  readonly row: ApprovalDialogRow | null;
  /** 「表示名（provider の表示名）」。 */
  readonly accountName: string;
  readonly open: boolean;
  /** キャンセル・×で閉じる。 */
  readonly onClose: () => void;
  /** 承認が通った。行を隠す・Toast・読み込み直しは呼ぶ側が行う。 */
  readonly onApproved: (row: ApprovalDialogRow) => void;
  /** 409 の後の「閉じて読み込み直す」。渡さなければ `onClose`。 */
  readonly onReload?: () => void;
}

const CAPTION_STYLE: CSSProperties = {
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
};

/** 長い URL も折る。ページ全体を横へスクロールさせない（048 §7.1.5）。 */
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

function openState(row: ApprovalDialogRow): ApprovingState {
  return {
    id: row.id,
    timing: defaultApprovalTiming({
      desiredScheduledAt: row.scheduledAt,
      desiredPast: row.desiredPast === true,
      manualOnly: row.manualOnly === true,
    }),
    scheduledAtLocal: toLocalInputValue(row.scheduledAt),
    stale: false,
    scheduledAtErrors: [],
    errors: [],
    busy: false,
  };
}

export function ApprovalDialog(props: ApprovalDialogProps) {
  const row = props.open ? props.row : null;
  // 開いた行ごとに状態を持つ。別の行を開き直したら初めからにする。
  const [state, setState] = useState<ApprovingState | null>(() =>
    row === null ? null : openState(row),
  );
  if (row === null) {
    return null;
  }
  const approving = state !== null && state.id === row.id ? state : openState(row);
  const manualOnly = row.manualOnly === true;
  const desiredPast = row.desiredPast === true;

  async function submitApproval(target: ApprovalDialogRow, current: ApprovingState): Promise<void> {
    // 手動投稿しかできない配信 Plugin の行は「即投稿」だけ（サーバも読み替える。048 §6.7.3）。
    const timing: ApprovalTiming = target.manualOnly === true ? 'now' : current.timing;
    setState({ ...current, busy: true, errors: [], scheduledAtErrors: [] });

    const result = await apiRequest(`/api/v1/social/posts/${target.id}/approve`, {
      method: 'POST',
      body: approveRequestBody({
        timing,
        scheduledAtLocal: current.scheduledAtLocal,
        updatedAt: target.updatedAt ?? '',
      }),
    });

    if (result.ok) {
      setState(null);
      props.onApproved(target);
      return;
    }

    const { error } = result;
    if (error.status === 409 || error.code === 'CONFLICT') {
      setState({ ...current, busy: false, stale: true });
      return;
    }
    const details = error.details ?? {};
    const scheduledAtErrors = details['scheduledAt'] ?? [];
    const others = Object.entries(details)
      .filter(([key]) => key !== 'scheduledAt')
      .flatMap(([, messages]) => messages);
    setState({
      ...current,
      busy: false,
      scheduledAtErrors,
      errors: others.length > 0 || scheduledAtErrors.length > 0 ? others : [error.message],
    });
  }

  function close(): void {
    setState(null);
    props.onClose();
  }

  function reload(): void {
    setState(null);
    (props.onReload ?? props.onClose)();
  }

  return (
    <Modal
      open
      title={APPROVE_DIALOG_TITLE}
      onClose={close}
      footer={
        approving.stale ? (
          <Button variant="primary" onClick={reload}>
            {APPROVE_RELOAD_LABEL}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={close}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              disabled={approving.busy}
              onClick={() => void submitApproval(row, approving)}
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

      {/* 承認の前に確かめる内容（区画のカードが出していたもの。055 設計 §9.3.4）。 */}
      <div style={{ display: 'grid', gap: 'var(--tf-space-2)', marginBottom: 'var(--tf-space-4)' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--tf-space-2) var(--tf-space-4)',
            alignItems: 'center',
            ...WRAP_ANYWHERE,
          }}
        >
          <strong>{props.accountName}</strong>
          <Badge>{DELIVERY_MODE_LABEL[row.deliveryMode]}</Badge>
          {row.warning !== null && (
            <Badge tone="warning">
              {row.warning === 'no_publisher' ? NO_PUBLISHER_BADGE : NO_CREDENTIAL_BADGE}
            </Badge>
          )}
        </div>
        <span style={CAPTION_STYLE}>
          {`${APPROVAL_REQUESTED_LABEL} ${formatDateTime(row.requestedAt)}`}
        </span>
        <span style={CAPTION_STYLE}>
          {`${POST_SOURCE_COLUMN_HEADER}：`}
          <PostSourceLabel source={row.source} />
        </span>
        <span style={CAPTION_STYLE}>
          {`${APPROVAL_DESIRED_LABEL} ${
            row.scheduledAt === null ? '—' : formatDateTime(row.scheduledAt)
          }`}
          {row.scheduledAt !== null && desiredPast && APPROVAL_DESIRED_PAST_NOTE}
        </span>

        {/* 本文は全文を出す。承認は内容を確かめる操作で、抜粋では判断できない（048 §7.1.2）。 */}
        <p style={{ whiteSpace: 'pre-wrap', margin: 0, ...WRAP_ANYWHERE }}>{row.body}</p>

        {row.link !== null && (
          <p style={{ margin: 0, ...WRAP_ANYWHERE }}>
            {`${APPROVAL_LINK_LABEL}：`}
            <a href={row.link} target="_blank" rel="noopener noreferrer" style={LINK_STYLE}>
              {row.link}
            </a>
          </p>
        )}

        {row.media.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
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
      </div>

      <div style={{ display: 'grid', gap: 'var(--tf-space-3)' }}>
        <label style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}>
          <input
            type="radio"
            name="approvalTiming"
            value="now"
            checked={manualOnly || approving.timing === 'now'}
            onChange={() => setState({ ...approving, timing: 'now' })}
          />
          {APPROVE_NOW_LABEL}
        </label>

        {manualOnly ? (
          <Alert tone="warning">{MANUAL_ONLY_APPROVAL_NOTE}</Alert>
        ) : (
          <div>
            <label style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}>
              <input
                type="radio"
                name="approvalTiming"
                value="scheduled"
                checked={approving.timing === 'scheduled'}
                onChange={() => setState({ ...approving, timing: 'scheduled' })}
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
                  setState({ ...approving, scheduledAtLocal: event.target.value })
                }
                style={{ maxWidth: '100%' }}
              />
              {row.scheduledAt !== null && (
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

        {!manualOnly && row.scheduledAt !== null && desiredPast && (
          <Alert tone="warning">{APPROVE_DESIRED_PAST_WARNING}</Alert>
        )}
      </div>
    </Modal>
  );
}

export interface RejectDialogProps {
  /** 差し戻す行。閉じているときは null。 */
  readonly target: { readonly id: string } | null;
  readonly onCancel: () => void;
  /** 差し戻しが通った。行を隠す・Toast・読み込み直しは呼ぶ側が行う。 */
  readonly onRejected: (id: string) => void;
  /** 差し戻しが失敗した（サーバの文言）。 */
  readonly onFailed: (id: string, message: string) => void;
}

/** 差し戻しの確認（048 設計 §7.1.4）。確定で `PATCH { status: 'draft' }`。 */
export function RejectDialog(props: RejectDialogProps) {
  async function confirmReject(): Promise<void> {
    const target = props.target;
    if (target === null) return;
    props.onCancel();

    const result = await apiRequest(`/api/v1/social/posts/${target.id}`, {
      method: 'PATCH',
      body: { status: 'draft' },
    });
    if (result.ok) {
      props.onRejected(target.id);
    } else {
      props.onFailed(target.id, result.error.message);
    }
  }

  return (
    <ConfirmDialog
      open={props.target !== null}
      title={REJECT_CONFIRM_TITLE}
      message={REJECT_CONFIRM_MESSAGE}
      confirmLabel={REJECT_LABEL}
      onConfirm={() => void confirmReject()}
      onCancel={props.onCancel}
    />
  );
}
