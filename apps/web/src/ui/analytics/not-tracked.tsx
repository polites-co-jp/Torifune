'use client';

import { useRouter } from 'next/navigation';
import { Badge, Button } from '@/ui/components';
import { CAPTION, MONO } from './parts';

/**
 * 未設置サイトの導線（028-analytics-dashboard-redesign 設計 §7.3.7）。
 *
 * 「未設置」= 最終受信が無く、当期の集計値も無いサイト。
 * 数字の代わりに「何をすれば数字が出るか」を 3 ステップで示す。
 */

const STEPS: readonly { readonly title: string; readonly body: string }[] = [
  {
    title: 'タグを貼る',
    body: '測りたいページの <head> に 1 行貼ります。Cookie は使いません。',
  },
  {
    title: '受信を確かめる',
    body: '集計後に「設定」タブの最終受信が更新されれば届いています。',
  },
  {
    title: '集計を待つ',
    body: '日次のロールアップ後に、この画面へ数字が出ます。',
  },
];

export function NotTracked({
  settingsHref,
  canOpenSettings,
}: {
  /** 設定タブ（`tab=settings`）へ移る URL。 */
  readonly settingsHref: string;
  /** 計測タグを見られるか（`site.read`）。無ければ管理者に依頼する旨を出す。 */
  readonly canOpenSettings: boolean;
}) {
  const router = useRouter();

  return (
    <section
      style={{
        border: '1px dashed var(--tf-color-border)',
        borderRadius: 'var(--tf-radius-2xl)',
        padding: 'var(--tf-space-12) var(--tf-space-8)',
        display: 'grid',
        gap: 'var(--tf-space-6)',
        justifyItems: 'center',
        textAlign: 'center',
      }}
    >
      <Badge>計測タグ未設置</Badge>
      <h2 style={{ margin: 0, fontSize: 'var(--tf-text-h1)', fontWeight: 400, lineHeight: 1.2 }}>
        まだアクセスの記録がありません
      </h2>
      <p
        style={{
          margin: 0,
          maxWidth: 'var(--tf-size-form)',
          lineHeight: 1.5,
          color: 'var(--tf-color-text-muted)',
        }}
      >
        数字が出るには、計測タグをサイトへ貼り、集計を実行する必要があります。集計は{' '}
        <code>POST /api/v1/analytics/rollup</code> で行います（cron から API トークンで叩けます）。
      </p>

      <ol
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))',
          gap: 'var(--tf-space-6)',
          width: '100%',
          maxWidth: 'var(--tf-size-content)',
          margin: 0,
          padding: 0,
          listStyle: 'none',
          textAlign: 'left',
        }}
      >
        {STEPS.map((step, index) => (
          <li key={step.title} style={{ display: 'grid', gap: 'var(--tf-space-2)' }}>
            <span style={{ ...MONO, ...CAPTION, color: 'var(--tf-color-primary)' }}>
              {String(index + 1).padStart(2, '0')}
            </span>
            <span style={{ fontWeight: 600 }}>{step.title}</span>
            <span style={{ ...CAPTION, lineHeight: 1.5 }}>{step.body}</span>
          </li>
        ))}
      </ol>

      {canOpenSettings ? (
        <Button variant="primary" onClick={() => router.push(settingsHref)}>
          計測タグを取得
        </Button>
      ) : (
        <p style={{ ...CAPTION, margin: 0 }}>
          計測タグの取得には Webサイトの閲覧権限が要ります。管理者に依頼してください。
        </p>
      )}
    </section>
  );
}
