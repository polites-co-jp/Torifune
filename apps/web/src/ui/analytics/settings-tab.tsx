'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import { Alert, Button, Card, ConfirmDialog, Toast, type ToastMessage } from '@/ui/components';
import { NO_VALUE } from './labels';
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
  /** 最終受信（`YYYY-MM-DD HH:mm`）。計測したことが無ければ null。 */
  readonly lastSeenAt: string | null;
  /** 最終集計（`YYYY-MM-DD HH:mm`）。集計したことが無ければ null。 */
  readonly lastRollupAt: string | null;
  /** 1 日の境目に使っているタイムゾーン。 */
  readonly timeZone: string;
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
  const receiving = data.lastSeenAt !== null;

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
            <span
              style={{
                fontWeight: 600,
                color: receiving ? 'var(--tf-color-success)' : 'var(--tf-color-text-subtle)',
              }}
            >
              {receiving ? '受信中' : '未受信'}
            </span>
          </StatusRow>
          <StatusRow label="最終受信">
            <span style={MONO}>{data.lastSeenAt ?? NO_VALUE}</span>
          </StatusRow>
          <StatusRow label="最終集計">
            <span style={MONO}>{data.lastRollupAt ?? NO_VALUE}</span>
          </StatusRow>
          <StatusRow label="日付の区切り" last>
            <span style={MONO}>{data.timeZone}</span>
          </StatusRow>
        </div>
        <Note>
          集計は <code>POST /api/v1/analytics/rollup</code> を cron から毎日実行します（API
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
