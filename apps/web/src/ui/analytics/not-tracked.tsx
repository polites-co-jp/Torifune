'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge, Button } from '@/ui/components';
import { CAPTION, MONO } from './parts';

/**
 * 数字の出ないサイトの導線（028-analytics-dashboard-redesign 設計 §7.3.7、
 * 029-scheduled-jobs 設計 §7.1.3 で 3 状態へ広げた）。
 *
 * 数字の代わりに「いま何が起きていて、何をすれば数字が出るか」を示す。
 *
 * | state | 何が起きているか |
 * | --- | --- |
 * | `not-received` | 一度も届いていない（計測タグが貼られていない可能性） |
 * | `pending-rollup` | 届いている。次の集計を待っている |
 * | `bots-only` | 届いているが、すべて Bot と判定されている |
 *
 * `receiving` はここへ来ない（通常のタブを出す）。
 */

/** 導線を出す 3 状態。`ReceptionState` から `receiving` を除いたもの。 */
export type NotTrackedState = 'not-received' | 'pending-rollup' | 'bots-only';

export interface NotTrackedData {
  readonly state: NotTrackedState;
  /** 生ログの最終受信（`YYYY-MM-DD HH:mm`）。 */
  readonly lastReceivedAt: string | null;
  /** 未集計の受信の文言。0 件なら null。 */
  readonly pendingText: string | null;
  /** 定期実行が有効か（この画面を返したプロセス）。 */
  readonly scheduled: boolean;
  readonly intervalMinutes: number;
  /** 次回の予定（`YYYY-MM-DD HH:mm`）。無効なら null。 */
  readonly nextRunAt: string | null;
}

const ROLLUP_API = 'POST /api/v1/analytics/rollup';

/** 「次回の集計」に出す時刻（`YYYY-MM-DD HH:mm` の `HH:mm`）。 */
function timeOf(dateTime: string | null): string | null {
  const match = /(\d{2}:\d{2})$/.exec(dateTime ?? '');
  return match?.[1] ?? null;
}

/** 3 ステップの 01 は共通。02 / 03 は定期実行の有無で変わる。 */
function stepsFor(data: NotTrackedData): readonly { title: string; body: ReactNode }[] {
  const next = timeOf(data.nextRunAt);

  return [
    {
      title: 'タグを貼る',
      body: '測りたいページの <head> に 1 行貼ります。Cookie は使いません。',
    },
    {
      title: '受信を確かめる',
      body: 'タグを貼ったページを開き、この画面を再読み込みすると最終受信が出ます。',
    },
    {
      title: '集計を待つ',
      body:
        data.scheduled && next !== null
          ? `次回の集計（${next} 頃）のあとに数字が出ます。`
          : data.scheduled
            ? '次回の集計のあとに数字が出ます。'
            : '集計 API を実行すると数字が出ます。',
    },
  ];
}

/** 状態ごとの Badge・見出し・説明。 */
function contentFor(data: NotTrackedData): {
  badge: string;
  tone: 'neutral' | 'warning';
  heading: string;
  description: ReactNode;
} {
  const next = timeOf(data.nextRunAt);
  const received = data.lastReceivedAt === null ? '' : `最終受信 ${data.lastReceivedAt}。`;
  const pending = data.pendingText === null ? '' : `未集計 ${data.pendingText}。`;

  switch (data.state) {
    case 'not-received':
      return {
        badge: '計測タグ未設置',
        tone: 'neutral',
        heading: 'まだアクセスの記録がありません',
        description: data.scheduled ? (
          <>
            数字が出るには、計測タグをサイトへ貼る必要があります。集計は Torifune が{' '}
            {data.intervalMinutes} 分ごとに自動で行います。
          </>
        ) : (
          <>
            数字が出るには、計測タグをサイトへ貼る必要があります。定期実行が無効なので、集計は{' '}
            <code>{ROLLUP_API}</code> で行ってください。
          </>
        ),
      };

    case 'pending-rollup':
      return {
        badge: '受信済み・集計待ち',
        tone: 'warning',
        heading: 'アクセスは届いています。集計を待っています',
        description:
          data.scheduled && next !== null ? (
            <>
              {received}
              {pending}次回の集計は {next} 頃で、そのあとにこの画面へ数字が出ます。
            </>
          ) : (
            <>
              {received}
              {pending}定期実行が無効です。<code>{ROLLUP_API}</code> を実行すると数字が出ます。
            </>
          ),
      };

    case 'bots-only':
      return {
        badge: 'Bot のみ受信',
        tone: 'warning',
        heading: '届いたアクセスはすべて Bot と判定されています',
        description: (
          <>
            {received}
            {data.pendingText === null ? '' : `未集計 ${data.pendingText} はすべて Bot です。`}
            User-Agent が空、または bot / crawler / spider / curl / headless
            などを含むアクセスは集計に含めません。実際のブラウザでページを開いて確かめてください。
            集計後は「Bot を集計に含める」で件数を見られます。
          </>
        ),
      };
  }
}

export function NotTracked({
  settingsHref,
  canOpenSettings,
  data,
}: {
  /** 設定タブ（`tab=settings`）へ移る URL。 */
  readonly settingsHref: string;
  /** 計測タグを見られるか（`site.read`）。無ければ管理者に依頼する旨を出す。 */
  readonly canOpenSettings: boolean;
  readonly data: NotTrackedData;
}) {
  const router = useRouter();
  const content = contentFor(data);
  // 「計測タグを取得」は未受信のときだけ。届いているサイトで貼り直しを促さない。
  const showSnippetButton = data.state === 'not-received';

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
      <Badge tone={content.tone}>{content.badge}</Badge>
      <h2 style={{ margin: 0, fontSize: 'var(--tf-text-h1)', fontWeight: 400, lineHeight: 1.2 }}>
        {content.heading}
      </h2>
      <p
        style={{
          margin: 0,
          maxWidth: 'var(--tf-size-form)',
          lineHeight: 1.5,
          color: 'var(--tf-color-text-muted)',
        }}
      >
        {content.description}
      </p>

      {showSnippetButton && (
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
          {stepsFor(data).map((step, index) => (
            <li key={step.title} style={{ display: 'grid', gap: 'var(--tf-space-2)' }}>
              <span style={{ ...MONO, ...CAPTION, color: 'var(--tf-color-primary)' }}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <span style={{ fontWeight: 600 }}>{step.title}</span>
              <span style={{ ...CAPTION, lineHeight: 1.5 }}>{step.body}</span>
            </li>
          ))}
        </ol>
      )}

      {/* **表示制御であって認可ではない。** 認可は UseCase（`analytics.trackedSites`）が行う。 */}
      {canOpenSettings ? (
        showSnippetButton ? (
          <Button variant="primary" onClick={() => router.push(settingsHref)}>
            計測タグを取得
          </Button>
        ) : (
          <Link href={settingsHref} style={{ color: 'var(--tf-color-primary)', fontWeight: 600 }}>
            受信状況を見る
          </Link>
        )
      ) : (
        showSnippetButton && (
          <p style={{ ...CAPTION, margin: 0 }}>
            計測タグの取得には Webサイトの閲覧権限が要ります。管理者に依頼してください。
          </p>
        )
      )}
    </section>
  );
}
