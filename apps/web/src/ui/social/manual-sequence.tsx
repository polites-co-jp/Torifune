'use client';

import { useState, type CSSProperties } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Input, Modal } from '@/ui/components';
import { excerptOf } from '@/ui/social/bulk-plan';
import {
  BULK_EXCLUDED_TEXT,
  BULK_RESULT_CLOSE,
  MANUAL_DONE_URL_LABEL,
  MANUAL_PENDING_FALLBACK_LABEL,
  MANUAL_PENDING_OPEN_LABEL,
  MANUAL_SEQUENCE_BACK,
  MANUAL_SEQUENCE_CONFIRM_LABEL,
  MANUAL_SEQUENCE_CONFIRM_MESSAGE,
  MANUAL_SEQUENCE_CONFIRM_TITLE,
  MANUAL_SEQUENCE_DONE,
  MANUAL_SEQUENCE_EXCLUDED_LABEL,
  MANUAL_SEQUENCE_LABEL,
  MANUAL_SEQUENCE_NOT_POSTED,
  MANUAL_SEQUENCE_POSTED,
  MANUAL_SEQUENCE_PROGRESS,
  MANUAL_SEQUENCE_QUIT,
  MANUAL_SEQUENCE_SCHEDULED_LABEL,
  MANUAL_SEQUENCE_SKIP,
  MANUAL_SEQUENCE_SKIPPED,
  MANUAL_SEQUENCE_STALE_MESSAGE,
  MANUAL_SEQUENCE_TITLE,
} from '@/ui/social/labels';
import { openManualWindow, type OpenManualWindow } from '@/ui/social/manual-handoff';
import {
  manualOutcomeRequestBody,
  type ManualSequencePlan,
} from '@/ui/social/manual-sequence-plan';
import type { PendingRow } from '@/ui/social/social-pending';

/**
 * 選んだ手動投稿を順に投稿のダイアログ（055-social-pending-tab 設計 §9.5.2。ユーザー裁定 6）。
 *
 * 対象を 1 件ずつ出し、「投稿画面を開く」→ SNS で投稿 →「投稿した」／「投稿しなかった」で記録して次の件へ進む。
 * **開くのは人のクリックだけ。** `openManualWindow` は「投稿画面を開く」の `onClick` の同期処理の中で呼び、
 * ダイアログを開いたとき・記録の後に自動で開かない（クリックの外の `window.open` はポップアップとして
 * ブロックされる）。窓の名前は同じなので、2 件目も同じ窓に開く。
 *
 * 記録は `POST /social/posts/{id}/manual-outcome` に描画時の `updatedAt` を添える（見た内容に対して記録する）。
 * **まだ記録していない件は何も変えない**（「やめる」でいつでも閉じる）。部品は開いている間だけ描かれる
 * （`SocialPending` が始めたときに描く）。閉じたときの Toast と読み込み直しは呼ぶ側が行う。
 */

/** 1 件の記録。「飛ばした」はその投稿を変えずに次へ進んだ件。 */
export interface ManualSequenceRecord {
  readonly id: string;
  readonly outcome: 'posted' | 'not_posted' | 'skipped';
}

export interface ManualSequenceProps {
  /** 対象と対象外（`manualSequencePlanOf` の出力のまま）。 */
  readonly plan: ManualSequencePlan<PendingRow>;
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  /** 閉じた（「やめる」・×・「閉じる」）。それまでの記録を渡す。 */
  readonly onClose: (records: readonly ManualSequenceRecord[]) => void;
  /** 子ウィンドウを開く口。既定は `window.open`（単体テストの環境には `window` が無い）。 */
  readonly open?: OpenManualWindow;
  /** 今の件（0 から数える）・それまでの記録・「投稿しなかった」の確認（テストのための口。既定は 0・空・偽）。 */
  readonly initialIndex?: number;
  readonly initialRecords?: readonly ManualSequenceRecord[];
  readonly initialConfirming?: boolean;
}

/** 本文・URL は折る。ダイアログの幅に収める（設計 §9.10）。 */
const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

const CAPTION_STYLE: CSSProperties = {
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
};

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

function countOf(
  records: readonly ManualSequenceRecord[],
  outcome: ManualSequenceRecord['outcome'],
) {
  return records.filter((record) => record.outcome === outcome).length;
}

/** 記録の内訳（例「投稿した 1・投稿しなかった 1」）。0 件の結果は書かない。 */
function recordBreakdownOf(records: readonly ManualSequenceRecord[]): string {
  return (
    [
      [MANUAL_SEQUENCE_POSTED, countOf(records, 'posted')],
      [MANUAL_SEQUENCE_NOT_POSTED, countOf(records, 'not_posted')],
      [MANUAL_SEQUENCE_SKIPPED, countOf(records, 'skipped')],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join('・');
}

/** ダイアログの下のボタンの並び。入りきらなければ次の行へ折り返す。 */
const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 'var(--tf-space-2)',
};

export function ManualSequence(props: ManualSequenceProps) {
  const targets = props.plan.targets;
  const [index, setIndex] = useState(props.initialIndex ?? 0);
  const [records, setRecords] = useState<readonly ManualSequenceRecord[]>(
    props.initialRecords ?? [],
  );
  const [confirming, setConfirming] = useState(props.initialConfirming ?? false);
  const [externalUrl, setExternalUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // 保存に失敗したときの文言（409 は部品の文言、他はサーバの文言。設計 §9.5.2）。
  const [error, setError] = useState<string | null>(null);

  const current = targets[index];
  const finished = current === undefined;

  function close(): void {
    props.onClose(records);
  }

  /** 次の件を表示して止まる（次の「投稿画面を開く」を押すまで開かない）。 */
  function advance(record: ManualSequenceRecord): void {
    setRecords((items) => [...items, record]);
    setIndex((value) => value + 1);
    setConfirming(false);
    setExternalUrl('');
    setError(null);
  }

  async function record(outcome: 'posted' | 'not_posted'): Promise<void> {
    if (current === undefined || busy) return;
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/v1/social/posts/${current.id}/manual-outcome`, {
      method: 'POST',
      body: manualOutcomeRequestBody(outcome, current.updatedAt ?? '', externalUrl),
    });
    setBusy(false);
    if (result.ok) {
      advance({ id: current.id, outcome });
      return;
    }
    setConfirming(false);
    setError(result.error.status === 409 ? MANUAL_SEQUENCE_STALE_MESSAGE : result.error.message);
  }

  const excludedCount = props.plan.excluded.reduce((sum, entry) => sum + entry.count, 0);
  const excludedBreakdown = props.plan.excluded
    .map((entry) => `${MANUAL_SEQUENCE_EXCLUDED_LABEL[entry.reason]} ${entry.count}`)
    .join('・');

  if (finished) {
    return (
      <Modal
        open
        title={MANUAL_SEQUENCE_LABEL}
        onClose={close}
        footer={
          <Button variant="primary" onClick={close}>
            {BULK_RESULT_CLOSE}
          </Button>
        }
      >
        <p style={{ margin: 0 }}>
          {MANUAL_SEQUENCE_DONE(
            countOf(records, 'posted'),
            countOf(records, 'not_posted'),
            countOf(records, 'skipped'),
          )}
        </p>
      </Modal>
    );
  }

  const handoff = current.handoff;
  const footer = confirming ? (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
        {MANUAL_SEQUENCE_BACK}
      </Button>
      <Button variant="danger" disabled={busy} onClick={() => void record('not_posted')}>
        {MANUAL_SEQUENCE_CONFIRM_LABEL}
      </Button>
    </>
  ) : error !== null ? (
    <>
      <Button variant="secondary" onClick={close}>
        {MANUAL_SEQUENCE_QUIT}
      </Button>
      <Button variant="primary" onClick={() => advance({ id: current.id, outcome: 'skipped' })}>
        {MANUAL_SEQUENCE_SKIP}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" disabled={busy} onClick={close}>
        {MANUAL_SEQUENCE_QUIT}
      </Button>
      <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
        {MANUAL_SEQUENCE_NOT_POSTED}
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => void record('posted')}>
        {MANUAL_SEQUENCE_POSTED}
      </Button>
    </>
  );

  return (
    <Modal
      open
      title={MANUAL_SEQUENCE_TITLE(index + 1, targets.length)}
      onClose={close}
      footer={
        // 幅 375px では 3 つのボタンが 1 行に入らないので折り返す（Modal の帯は折り返さない。設計 §9.10）。
        <div style={FOOTER_STYLE}>{footer}</div>
      }
    >
      {confirming ? (
        <div style={{ display: 'grid', gap: 'var(--tf-space-2)', ...WRAP_ANYWHERE }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {MANUAL_SEQUENCE_CONFIRM_TITLE(excerptOf(current.body))}
          </p>
          <p style={{ margin: 0 }}>{MANUAL_SEQUENCE_CONFIRM_MESSAGE}</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
          {error !== null && <Alert tone="danger">{error}</Alert>}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--tf-space-2) var(--tf-space-4)',
            }}
          >
            <strong>
              {props.accountNames[current.socialAccountId] ?? current.socialAccountId}
            </strong>
            <span style={CAPTION_STYLE}>
              {`${MANUAL_SEQUENCE_SCHEDULED_LABEL} ${formatDateTime(current.scheduledAt)}`}
            </span>
          </div>
          {/* 本文は全文（投稿画面に入る内容を確かめる）。 */}
          <p style={{ margin: 0, whiteSpace: 'pre-wrap', ...WRAP_ANYWHERE }}>{current.body}</p>
          {handoff !== undefined && handoff.ok && handoff.note !== null && (
            <p style={{ margin: 0, ...CAPTION_STYLE }}>{handoff.note}</p>
          )}
          {error === null && (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 'var(--tf-space-2)',
                  alignItems: 'center',
                }}
              >
                <Button
                  variant="primary"
                  disabled={busy || handoff === undefined || !handoff.ok}
                  onClick={() => {
                    // 押した瞬間に開く（クリックの同期処理の中。開くのは人のクリックだけ）。
                    if (handoff !== undefined && handoff.ok) {
                      openManualWindow(handoff.url, props.open);
                    }
                  }}
                >
                  {MANUAL_PENDING_OPEN_LABEL}
                </Button>
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
              </div>
              <label style={{ display: 'block' }}>
                {MANUAL_DONE_URL_LABEL}
                <Input
                  type="url"
                  name="externalUrl"
                  value={externalUrl}
                  placeholder="https://"
                  disabled={busy}
                  onChange={(event) => setExternalUrl(event.target.value)}
                  style={{ marginTop: 'var(--tf-space-1)' }}
                />
              </label>
            </>
          )}
          <p style={{ margin: 0, ...CAPTION_STYLE }}>
            {MANUAL_SEQUENCE_PROGRESS(records.length, recordBreakdownOf(records))}
            {excludedCount > 0 && (
              <span style={{ marginLeft: 'var(--tf-space-3)' }}>
                {BULK_EXCLUDED_TEXT(excludedCount, excludedBreakdown)}
              </span>
            )}
          </p>
        </div>
      )}
    </Modal>
  );
}
