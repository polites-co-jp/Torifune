'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { ReceptionState } from '@/domain/analytics/reception';
import type { JobRunStatus } from '@/domain/jobs/job';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Card, ConfirmDialog, Toast, type ToastMessage } from '@/ui/components';
import { NO_VALUE, RECEPTION_STATE_LABEL, SCHEDULER_OFF_TEXT, schedulerText } from './labels';
import { MONO, Note, SectionHeader } from './parts';

/**
 * 設定タブ（028-analytics-dashboard-redesign 設計 §7.3.6）。計測タグと受信状況。
 *
 * `site.read` があるときだけ描かれる（公開キーが要るため）。
 * 「公開キーを再発行」は `site.write` があるときだけ出す。**表示制御であって認可ではない。**
 * 認可は UseCase（`site.regeneratePublicKey`）が行う。
 */

export interface SettingsData {
  readonly siteId: string;
  readonly publicKey: string;
  /** 計測タグの src に付けるオリジン。分からなければ null。 */
  readonly scriptOrigin: string | null;
  /** 「公開キーを再発行」を出すか（`site.write`）。 */
  readonly canRegenerate: boolean;
  /** 生ログの最終受信（`YYYY-MM-DD HH:mm`）。届いたことが無ければ null。 */
  readonly lastSeenAt: string | null;
  /**
   * **このサイトの**集計値の最終更新（`YYYY-MM-DD HH:mm`）。
   *
   * `rollup.lastSucceededAt`（全体）とは役目が違うので、両方を別の行に出す（裁定 #7）。
   */
  readonly lastRollupAt: string | null;
  /** 1 日の境目に使っているタイムゾーン。 */
  readonly timeZone: string;
  /** 受信状況の 4 状態（029 設計 §5.5）。 */
  readonly state: ReceptionState;
  /** 未集計の受信の文言。0 件なら null。 */
  readonly pendingText: string | null;
  /** 最終集計（全体。`job_runs` の最後に成功したロールアップ）。 */
  readonly lastSucceededAt: string | null;
  /** 直近の実行の結果。実行が無ければ null。 */
  readonly lastRunStatus: JobRunStatus | null;
  /** 定期実行が有効か（この画面を返したプロセス）。 */
  readonly scheduled: boolean;
  readonly intervalMinutes: number;
  /** 次回の予定（`YYYY-MM-DD HH:mm`）。無効なら null。 */
  readonly nextRunAt: string | null;
}

/** 状態ごとの色。**色だけに頼らない**（文字で状態を書く）。 */
const STATE_COLOR: Record<ReceptionState, string> = {
  'not-received': 'var(--tf-color-text-subtle)',
  'pending-rollup': 'var(--tf-color-warning)',
  'bots-only': 'var(--tf-color-warning)',
  receiving: 'var(--tf-color-success)',
};

/** 「最終集計（全体）」へ添える注釈。前回の実行が成功でないときだけ出す。 */
function lastRunNote(status: JobRunStatus | null): { text: string; danger: boolean } | null {
  if (status === 'error') {
    return { text: '（前回の実行は失敗）', danger: true };
  }
  if (status === 'running') {
    return { text: '（実行中）', danger: false };
  }
  return null;
}

/** 「コピーしました」を出しておく時間（ミリ秒）。 */
const COPIED_MS = 2000;

/**
 * 計測タグの 1 行。
 *
 * **`src` は絶対 URL にする。** 相対パスのまま別のホストへ貼られると、
 * 貼った先のサーバーの `/t.js` を探しに行って計測が届かない。
 */
function snippetFor(publicKey: string, origin: string | null): string {
  const src = origin === null ? '/t.js' : `${origin}/t.js`;
  return `<script src="${src}" data-site="${publicKey}"></script>`;
}

function StatusRow({
  label,
  children,
  last = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly last?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 'var(--tf-space-4)',
        padding: 'var(--tf-space-3) 0',
        borderBottom: last ? 'none' : '1px solid var(--tf-color-border-weak)',
      }}
    >
      <span style={{ color: 'var(--tf-color-text-muted)' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{children}</span>
    </div>
  );
}

export function SettingsTab({ data }: { readonly data: SettingsData }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const snippet = snippetFor(data.publicKey, data.scriptOrigin);
  const note = lastRunNote(data.lastRunStatus);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copySnippet(): Promise<void> {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      // クリップボードが使えない環境（HTTP など）。手で選んで写してもらう。
      setToast({
        id: 'copy',
        text: 'コピーできませんでした。タグを選択して写してください。',
        tone: 'danger',
      });
    }
  }

  async function regenerate(): Promise<void> {
    setConfirming(false);
    setBusy(true);
    const result = await apiRequest<{ siteId: string; publicKey: string }>(
      `/api/v1/sites/${encodeURIComponent(data.siteId)}/public-key`,
      { method: 'POST', body: {} },
    );
    setBusy(false);

    if (result.ok) {
      setToast({
        id: `regenerated-${result.data.publicKey}`,
        text: '公開キーを再発行しました',
        tone: 'success',
      });
      // 新しいタグを Server Component から読み直す。
      router.refresh();
    } else {
      setToast({ id: 'regenerate-failed', text: result.error.message, tone: 'danger' });
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(18rem, 100%), 1fr))',
        gap: 'var(--tf-space-6)',
        alignItems: 'start',
      }}
    >
      <Card>
        <SectionHeader title="計測タグ" />
        <div style={{ display: 'grid', gap: 'var(--tf-space-4)', minWidth: 0 }}>
          <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
            測りたいページの <code>&lt;head&gt;</code> に貼ってください。
          </p>
          {/*
            **minWidth: 0 が要る。** grid の子は既定で min-width:auto のため、
            中の長い 1 行がトラックを押し広げ、ページ全体が横スクロールする。
          */}
          <pre
            data-tracking-snippet
            data-site-id={data.siteId}
            style={{
              ...MONO,
              margin: 0,
              minWidth: 0,
              padding: 'var(--tf-space-5) var(--tf-space-6)',
              background: 'var(--tf-color-surface)',
              borderRadius: 'var(--tf-radius-lg)',
              fontSize: 'var(--tf-text-caption)',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {snippet}
          </pre>
          <div style={{ display: 'flex', gap: 'var(--tf-space-3)', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={copySnippet}>
              {copied ? 'コピーしました' : 'タグをコピー'}
            </Button>
            {data.canRegenerate && (
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
                公開キーを再発行
              </Button>
            )}
          </div>
          {data.scriptOrigin === null && (
            <Alert tone="warning">
              送信先のホストを特定できませんでした。<code>APP_URL</code> を設定してください。
              このままのタグを別のホストへ貼っても計測は届きません。
            </Alert>
          )}
          <Note>
            Cookie
            は使いません。IPアドレスとブラウザ情報は保存せず、日ごとに変わるハッシュだけを記録します。
            公開キーが漏れても、偽のアクセスを送られる以上の被害はありません。
          </Note>
        </div>
      </Card>

      <Card>
        <SectionHeader title="受信状況" />
        <div>
          <StatusRow label="状態">
            <span style={{ fontWeight: 600, color: STATE_COLOR[data.state] }}>
              {RECEPTION_STATE_LABEL[data.state]}
            </span>
          </StatusRow>
          <StatusRow label="最終受信">
            <span style={MONO}>{data.lastSeenAt ?? NO_VALUE}</span>
          </StatusRow>
          <StatusRow label="未集計の受信">
            <span style={MONO}>{data.pendingText ?? NO_VALUE}</span>
          </StatusRow>
          {/*
            **「最終集計」は 2 つ出す**（裁定 #7）。
            前者が新しく後者が古ければ「集計は回っているが、このサイトに新しい生ログが無い」と読める。
          */}
          <StatusRow label="最終集計（全体）">
            <span style={MONO}>{data.lastSucceededAt ?? NO_VALUE}</span>
            {note !== null && (
              <span
                style={{
                  marginLeft: 'var(--tf-space-2)',
                  color: note.danger ? 'var(--tf-color-danger)' : 'var(--tf-color-text-muted)',
                }}
              >
                {note.text}
              </span>
            )}
          </StatusRow>
          <StatusRow label="このサイトの集計値の最終更新">
            <span style={MONO}>{data.lastRollupAt ?? NO_VALUE}</span>
          </StatusRow>
          <StatusRow label="定期実行">
            <span style={data.scheduled ? MONO : undefined}>
              {data.scheduled
                ? schedulerText(data.intervalMinutes, data.nextRunAt)
                : SCHEDULER_OFF_TEXT}
            </span>
          </StatusRow>
          <StatusRow label="日付の区切り" last>
            <span style={MONO}>{data.timeZone}</span>
          </StatusRow>
        </div>
        <Note>
          {data.scheduled ? (
            <>
              集計は Torifune が {data.intervalMinutes}{' '}
              分ごとに自動で行います（前回の集計以降の未集計分。最大 7 日さかのぼります）。
            </>
          ) : (
            <>定期実行は無効です。</>
          )}
          7 日を超えて止まっていた期間や過去の期間を集計し直すとき、または定期実行を止めているときは{' '}
          <code>POST /api/v1/analytics/rollup</code> を実行してください（API
          トークンで叩けます）。集計値は消しません。
        </Note>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="公開キーを再発行しますか？"
        message="いまのキーで貼ってある計測タグは無効になり、貼り直すまでアクセスは記録されません。"
        confirmLabel="再発行する"
        onConfirm={regenerate}
        onCancel={() => setConfirming(false)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
