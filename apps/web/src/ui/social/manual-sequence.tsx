'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Input, Modal } from '@/ui/components';
import { excerptOf } from '@/ui/social/bulk-plan';
import type { SequenceRecord } from '@/ui/social/bulk-post-plan';
import {
  BULK_POST_MANUAL_RESULT,
  BULK_POST_RESULT_TITLE,
  BULK_POST_UNRECORDED,
  BULK_RESULT_CLOSE,
  MANUAL_DONE_URL_LABEL,
  MANUAL_PENDING_FALLBACK_LABEL,
  MANUAL_PENDING_OPEN_LABEL,
  MANUAL_SEQUENCE_BACK,
  MANUAL_SEQUENCE_CONFIRM_LABEL,
  MANUAL_SEQUENCE_CONFIRM_MESSAGE,
  MANUAL_SEQUENCE_CONFIRM_TITLE,
  MANUAL_SEQUENCE_NEXT_GUIDE,
  MANUAL_SEQUENCE_NEXT_OPENED,
  MANUAL_SEQUENCE_NOT_POSTED,
  MANUAL_SEQUENCE_OPENED_GUIDE,
  MANUAL_SEQUENCE_POSTED,
  MANUAL_SEQUENCE_PROGRESS,
  MANUAL_SEQUENCE_QUIT,
  MANUAL_SEQUENCE_RECORD_NOW,
  MANUAL_SEQUENCE_SCHEDULED_LABEL,
  MANUAL_SEQUENCE_SKIP,
  MANUAL_SEQUENCE_SKIPPED,
  MANUAL_SEQUENCE_STALE_MESSAGE,
  MANUAL_SEQUENCE_TITLE,
} from '@/ui/social/labels';
import { openManualWindow, type OpenManualWindow } from '@/ui/social/manual-handoff';
import {
  manualOutcomeRequestBody,
  windowStageAfter,
  type ManualSequenceTarget,
  type WindowEvent,
  type WindowStage,
  type WindowState,
} from '@/ui/social/manual-sequence-plan';

/**
 * 手動投稿の順に投稿のダイアログ（055-social-pending-tab 設計 §9.5.2 を 057-social-bulk-post 設計 §5.4・§7.5 で作り直した）。
 *
 * 対象を 1 件ずつ出す。今の件の段（`ready` → `opened` → `returned`）は `windowStageAfter` で移す。
 * **窓を閉じたことは知れない**（X・Threads の COOP で、開き手の参照は開いた直後から閉じた扱いになる。057 §3.4）ので、
 * 窓の参照は持たず（`noopener`・`noreferrer` は 035 のまま）、とりふねの画面から離れて戻ってきたこと
 * （`window` の `blur`・`focus` と `document` の `visibilitychange`）を「閉じた」の代わりにする。
 * 検知に頼り切らないよう「記録へ進む」で戻らずに記録へ進める。
 *
 * **開くのは人のクリックだけ。** `openManualWindow` は「投稿画面を開く」と、「投稿した」「失敗にする」の `onClick` の
 * 同期処理の中（記録の要求を送るより先）で呼ぶ。記録を待ってから開くとクリックの外になりブロックされうる。
 * 最後の件では次を開かない。記録が失敗しても次の窓は開いたままで、「飛ばして次へ」は開き直さない。
 *
 * 記録は `POST /social/posts/{id}/manual-outcome` に対象の `updatedAt`（承認した手動投稿では承認の結果の値）を添える。
 * **まだ記録していない件は何も変えない**（「やめる」はいつでも押せる）。やめた後と全件の後は終わりの表示
 * （題「一括投稿の結果」）を描き、「閉じる」で `onFinish` に記録を渡す。読み込み直すかは呼ぶ側が決める。
 */

/** 1 件の記録。「飛ばした」はその投稿を変えずに次へ進んだ件。 */
export type ManualSequenceRecord = SequenceRecord;

export interface ManualSequenceProps {
  /** 順に開く対象（表の順。057 設計 §7.4）。 */
  readonly targets: readonly ManualSequenceTarget[];
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  /** 1 件目の窓を呼ぶ側がすでに開いた（一括投稿の「投稿する」。1 件目を `opened` から始める）。 */
  readonly firstOpened?: boolean;
  /** 終わりの表示に出す 1 段目（承認・今すぐ送る）の結果。 */
  readonly summary?: ReactNode;
  /** 終わりの表示の「閉じる」。それまでの記録と、途中でやめたか（`quit`）を渡す。 */
  readonly onFinish: (
    records: readonly ManualSequenceRecord[],
    options: { readonly quit: boolean },
  ) => void;
  /** 子ウィンドウを開く口。既定は `window.open`（単体テストの環境には `window` が無い）。 */
  readonly open?: OpenManualWindow;
  /**
   * 今の件（0 から数える。対象の数なら終わりの表示から）・それまでの記録・「投稿しなかった」の確認・今の件の段
   * （テストのための口。既定は 0・空・偽・`ready`。`firstOpened` なら 1 件目は `opened`）。
   */
  readonly initialIndex?: number;
  readonly initialRecords?: readonly ManualSequenceRecord[];
  readonly initialConfirming?: boolean;
  readonly initialStage?: WindowStage;
}

/** 本文・URL は折る。ダイアログの幅に収める（055 設計 §9.10・057 設計 §7.7）。 */
const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

const CAPTION_STYLE: CSSProperties = {
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
};

/** ダイアログの下のボタンの並び。入りきらなければ次の行へ折り返す。 */
const FOOTER_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 'var(--tf-space-2)',
};

const OPEN_ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--tf-space-2)',
  alignItems: 'center',
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
): number {
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

/** 段から状態を作る（`returned` は離れて戻った後の段）。 */
function windowStateOf(stage: WindowStage): WindowState {
  return { stage, left: stage === 'returned' };
}

export function ManualSequence(props: ManualSequenceProps) {
  const targets = props.targets;
  const [index, setIndex] = useState(props.initialIndex ?? 0);
  const [records, setRecords] = useState<readonly ManualSequenceRecord[]>(
    props.initialRecords ?? [],
  );
  const [confirming, setConfirming] = useState(props.initialConfirming ?? false);
  const [externalUrl, setExternalUrl] = useState('');
  const [busy, setBusy] = useState(false);
  // 保存に失敗したときの文言（409 は部品の文言、他はサーバの文言。055 設計 §9.5.2）。
  const [error, setError] = useState<string | null>(null);
  // 今の件の段（057 設計 §5.4）。
  const [windowState, setWindowState] = useState<WindowState>(() =>
    windowStateOf(
      props.initialStage ?? (props.firstOpened === true && index === 0 ? 'opened' : 'ready'),
    ),
  );
  // 記録の前に次の件の窓を開いたか。記録が失敗した後の「飛ばして次へ」で、次の件を `opened` で出すかを決める。
  const [nextOpened, setNextOpened] = useState(false);
  // 「やめる」で終わりの表示へ移った。
  const [quit, setQuit] = useState(false);

  const current = targets[index];
  const finished = quit || current === undefined;
  const stage = windowState.stage;

  function send(event: WindowEvent): void {
    setWindowState((state) => windowStageAfter(state, event));
  }

  // 窓を開いた段の間だけ、とりふねの画面から離れた・戻ったを聞く（057 設計 §5.4。監視の間隔は持たない）。
  // 窓はクリックの中で同期で開くので、聞き始める前に離れていることがある。付けた時点で離れていれば数える。
  useEffect(() => {
    if (stage !== 'opened') return;
    const onLeft = (): void => send('left');
    const onBack = (): void => send('back');
    const onVisibility = (): void => send(document.visibilityState === 'hidden' ? 'left' : 'back');
    window.addEventListener('blur', onLeft);
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onVisibility);
    if (document.hidden || !document.hasFocus()) {
      send('left');
    }
    return () => {
      window.removeEventListener('blur', onLeft);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [stage, index]);

  /** 次の件へ進む。次の件の窓を開いていれば `opened`、開いていなければ `ready` から。 */
  function advance(record: ManualSequenceRecord, opened: boolean): void {
    setRecords((items) => [...items, record]);
    setIndex((value) => value + 1);
    setConfirming(false);
    setExternalUrl('');
    setError(null);
    setNextOpened(false);
    setWindowState(windowStateOf(opened ? 'opened' : 'ready'));
  }

  function openCurrent(): void {
    if (current === undefined) return;
    // 押した瞬間に開く（クリックの同期処理の中。開くのは人のクリックだけ）。
    openManualWindow(current.url, props.open);
    send('open');
  }

  async function record(outcome: 'posted' | 'not_posted'): Promise<void> {
    if (current === undefined || busy) return;
    // 次の件の窓を**記録の要求より先に**開く（要求を待つとクリックの外になる。057 設計 §5.4）。最後の件では開かない。
    const next = targets[index + 1];
    if (next !== undefined) {
      openManualWindow(next.url, props.open);
    }
    const opened = next !== undefined;
    setNextOpened(opened);
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/v1/social/posts/${current.id}/manual-outcome`, {
      method: 'POST',
      body: manualOutcomeRequestBody(outcome, current.updatedAt, externalUrl),
    });
    setBusy(false);
    if (result.ok) {
      advance({ id: current.id, outcome }, opened);
      return;
    }
    setConfirming(false);
    setError(result.error.status === 409 ? MANUAL_SEQUENCE_STALE_MESSAGE : result.error.message);
  }

  function finish(): void {
    props.onFinish(records, { quit });
  }

  if (finished) {
    const unrecorded = targets.length - records.length;
    return (
      <Modal
        open
        title={BULK_POST_RESULT_TITLE}
        onClose={finish}
        footer={
          <Button variant="primary" onClick={finish}>
            {BULK_RESULT_CLOSE}
          </Button>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
          {props.summary}
          {records.length > 0 && (
            <p style={{ margin: 0 }}>
              {BULK_POST_MANUAL_RESULT(
                countOf(records, 'posted'),
                countOf(records, 'not_posted'),
                countOf(records, 'skipped'),
              )}
            </p>
          )}
          {unrecorded > 0 && <p style={{ margin: 0 }}>{BULK_POST_UNRECORDED(unrecorded)}</p>}
        </div>
      </Modal>
    );
  }

  const hasNext = targets[index + 1] !== undefined;
  // 保存中は閉じさせない（記録の結果を取りこぼさない）。それ以外の × は「やめる」と同じ。
  const quitNow = (): void => {
    if (!busy) setQuit(true);
  };

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
      <Button variant="secondary" onClick={quitNow}>
        {MANUAL_SEQUENCE_QUIT}
      </Button>
      <Button
        variant="primary"
        // 次の窓は記録の前に開いている。開き直さない（057 設計 §7.5）。
        onClick={() => advance({ id: current.id, outcome: 'skipped' }, nextOpened)}
      >
        {MANUAL_SEQUENCE_SKIP}
      </Button>
    </>
  ) : stage === 'returned' ? (
    <>
      <Button variant="secondary" disabled={busy} onClick={quitNow}>
        {MANUAL_SEQUENCE_QUIT}
      </Button>
      <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
        {MANUAL_SEQUENCE_NOT_POSTED}
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => void record('posted')}>
        {MANUAL_SEQUENCE_POSTED}
      </Button>
    </>
  ) : (
    <>
      <Button variant="secondary" onClick={quitNow}>
        {MANUAL_SEQUENCE_QUIT}
      </Button>
      <Button variant="primary" onClick={() => send('recordNow')}>
        {MANUAL_SEQUENCE_RECORD_NOW}
      </Button>
    </>
  );

  return (
    <Modal
      open
      title={MANUAL_SEQUENCE_TITLE(index + 1, targets.length)}
      onClose={quitNow}
      footer={
        // 幅 375px では 3 つのボタンが 1 行に入らないので折り返す（Modal の帯は折り返さない。055 設計 §9.10）。
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
          {error !== null && (
            <Alert tone="danger">
              {error}
              {nextOpened && (
                <span style={{ display: 'block' }}>{MANUAL_SEQUENCE_NEXT_OPENED}</span>
              )}
            </Alert>
          )}
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
          {current.note !== null && <p style={{ margin: 0, ...CAPTION_STYLE }}>{current.note}</p>}
          {error === null && (
            <>
              <div style={OPEN_ROW_STYLE}>
                <Button
                  variant={stage === 'returned' ? 'secondary' : 'primary'}
                  disabled={busy}
                  onClick={openCurrent}
                >
                  {MANUAL_PENDING_OPEN_LABEL}
                </Button>
                <a
                  href={current.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  // リンクで開いても「開いた」にする（既定の動作は止めない。057 実装プラン §8 の 13）。
                  onClick={() => send('open')}
                  style={{ color: 'var(--tf-color-primary)', fontSize: 'var(--tf-text-caption)' }}
                >
                  {MANUAL_PENDING_FALLBACK_LABEL}
                </a>
              </div>
              {stage === 'opened' && <p style={{ margin: 0 }}>{MANUAL_SEQUENCE_OPENED_GUIDE}</p>}
              {stage === 'returned' && (
                <>
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
                  {hasNext && <p style={{ margin: 0 }}>{MANUAL_SEQUENCE_NEXT_GUIDE}</p>}
                </>
              )}
            </>
          )}
          <p style={{ margin: 0, ...CAPTION_STYLE }}>
            {MANUAL_SEQUENCE_PROGRESS(records.length, recordBreakdownOf(records))}
          </p>
        </div>
      )}
    </Modal>
  );
}
