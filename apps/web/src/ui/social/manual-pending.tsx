'use client';

import { useState } from 'react';
import type { ManualHandoffOutcome } from '@/application/social/social-use-cases';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Modal,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import {
  MANUAL_HANDOFF_REASON_LABEL,
  MANUAL_PENDING_ANCHOR,
  MANUAL_PENDING_CANCEL_LABEL,
  MANUAL_PENDING_DONE_LABEL,
  MANUAL_PENDING_FALLBACK_LABEL,
  MANUAL_PENDING_GUIDE,
  MANUAL_PENDING_LABEL,
  MANUAL_PENDING_OPEN_LABEL,
} from '@/ui/social/labels';

/**
 * 「手動投稿待ち」区画（035-social-publishing 設計 §7.1 / §7.2）。
 *
 * **URL は描画時に確定している。** `window.open` はクリックの同期処理の中で
 * 呼ばないとポップアップとして扱われずブロックされるため、押してから
 * publisher に問い合わせることはできない。Server Component が行ごとに
 * `resolveManualHandoff` を掛け、その結果をそのまま受け取る。
 *
 * **「いま」を見ない。** 経過時間は Server Component が文字列にして渡す（`elapsedText`）。
 * ここで `Date.now()` を見ると Server と Client で描画が食い違う（hydration mismatch）。
 *
 * 操作ボタンの出し分けは**表示制御であって認可ではない**。認可は UseCase が行う
 * （`CLAUDE.md`「認可を書く場所」、設計 §8）。
 */

/** 窓の名前を固定する。同じ名前を使い回すので、2 件目を開いても窓が増えない（設計 §7.2）。 */
const MANUAL_WINDOW_NAME = 'torifune-manual-post';

/**
 * 子ウィンドウの開き方（設計 §7.2）。
 *
 * **`noopener` を付ける。** 開いた先は外部 SNS の画面で、`window.opener` から
 * とりふねの画面へ戻れる状態にしない。`noreferrer` も付け、URL を Referer で渡さない。
 * その代わり `window.open` は `null` を返し、ブロックされたか判別できないので、
 * 同じ URL のリンクを併置する。
 */
const MANUAL_WINDOW_FEATURES = 'popup=yes,width=600,height=720,noopener=yes,noreferrer=yes';

/** 一覧に本文を全部出すと表が崩れる。1 行に収まる長さで切る。 */
const EXCERPT_LENGTH = 60;

export interface ManualPendingPost {
  readonly id: string;
  readonly accountName: string;
  readonly body: string;
  /** 予約日時。**ISO 文字列のまま受け取る**（整形は閲覧者の時刻で行う）。 */
  readonly scheduledAt: string;
  /** 予約時刻からの経過（例：`12 分`）。**Server Component が文字列にして渡す**（設計 §7.1）。 */
  readonly elapsedText?: string;
}

export interface ManualPendingRow {
  readonly post: ManualPendingPost;
  /** `resolveManualHandoff` の結果。行ごとに独立している。 */
  readonly handoff: ManualHandoffOutcome;
}

export interface ManualPendingProps {
  readonly rows: readonly ManualPendingRow[];
  /** `social.write` を持つか。**表示制御であって認可ではない。** */
  readonly canWrite: boolean;
  /**
   * 子ウィンドウを開く口。既定は `window.open`。
   *
   * 単体テストの環境（`environment: 'node'`）には `window` が無く、
   * `vi.spyOn(window, 'open')` が使えないため props にしてある
   * （実装プラン §7 の 13）。既定値なので通常の経路は変わらない。
   */
  readonly open?: (url: string, name: string, features: string) => unknown;
}

function excerpt(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EXCERPT_LENGTH ? oneLine : `${oneLine.slice(0, EXCERPT_LENGTH)}…`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

const CAPTION_STYLE = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
} as const;

export function ManualPending(props: ManualPendingProps) {
  const [rows, setRows] = useState(props.rows);
  const [done, setDone] = useState<ManualPendingRow | null>(null);
  const [externalUrl, setExternalUrl] = useState('');
  const [cancelling, setCancelling] = useState<ManualPendingRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  /** 押した瞬間に開く。押してから問い合わせるとポップアップとして扱われない（設計 §7.1）。 */
  function openManualWindow(url: string): void {
    const opener = props.open;
    if (opener === undefined) {
      window.open(url, MANUAL_WINDOW_NAME, MANUAL_WINDOW_FEATURES);
      return;
    }
    opener(url, MANUAL_WINDOW_NAME, MANUAL_WINDOW_FEATURES);
  }

  async function patch(
    row: ManualPendingRow,
    body: Record<string, unknown>,
    text: string,
  ): Promise<void> {
    const result = await apiRequest(`/api/v1/social/posts/${row.post.id}`, {
      method: 'PATCH',
      body,
    });

    if (result.ok) {
      // 手動投稿待ちでなくなった行は消す。次の描画まで残すと、二重に押せてしまう。
      setRows((current) => current.filter((item) => item.post.id !== row.post.id));
      setToast({ id: row.post.id, text, tone: 'success' });
    } else {
      setToast({ id: row.post.id, text: result.error.message, tone: 'danger' });
    }
  }

  async function confirmDone(): Promise<void> {
    const target = done;
    if (target === null) return;
    setDone(null);

    const url = externalUrl.trim();
    setExternalUrl('');
    await patch(
      target,
      { status: 'published', ...(url === '' ? {} : { externalUrl: url }) },
      '投稿したことを記録しました。',
    );
  }

  async function confirmCancel(): Promise<void> {
    const target = cancelling;
    if (target === null) return;
    setCancelling(null);
    await patch(target, { status: 'draft' }, '予約を取りやめ、下書きに戻しました。');
  }

  const columns: readonly Column<ManualPendingRow>[] = [
    {
      key: 'account',
      header: 'アカウント',
      width: '12rem',
      render: (row) => row.post.accountName,
    },
    {
      key: 'body',
      header: '本文',
      render: (row) => (
        <span>
          {excerpt(row.post.body)}
          {row.handoff.ok && row.handoff.note !== null && (
            <span style={CAPTION_STYLE}>{row.handoff.note}</span>
          )}
          {!row.handoff.ok && (
            <span style={{ ...CAPTION_STYLE, color: 'var(--tf-color-warning)' }}>
              ⚠ {MANUAL_HANDOFF_REASON_LABEL[row.handoff.reason]}。
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'scheduledAt',
      header: '予約日時',
      width: '12rem',
      render: (row) => formatDateTime(row.post.scheduledAt),
    },
    {
      key: 'elapsed',
      header: '経過',
      width: '6rem',
      render: (row) => row.post.elapsedText ?? '—',
    },
    {
      key: 'actions',
      header: '操作',
      width: '20rem',
      render: (row) => (
        <span
          style={{
            display: 'flex',
            gap: 'var(--tf-space-2)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Button
            variant="primary"
            disabled={!row.handoff.ok}
            onClick={() => {
              if (row.handoff.ok) {
                openManualWindow(row.handoff.url);
              }
            }}
          >
            {MANUAL_PENDING_OPEN_LABEL}
          </Button>
          {/* ブロックされたときの逃げ道。`noopener` を付けると開けたか判別できない（設計 §7.2）。 */}
          {row.handoff.ok && (
            <a
              href={row.handoff.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--tf-color-primary)', fontSize: 'var(--tf-text-caption)' }}
            >
              {MANUAL_PENDING_FALLBACK_LABEL}
            </a>
          )}
          {/* 開けない行でも押せる。人が別の手段で投稿した場合を閉ざさない（設計 §7.1）。 */}
          {props.canWrite && (
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
          {props.canWrite && (
            <Button variant="ghost" onClick={() => setCancelling(row)}>
              {MANUAL_PENDING_CANCEL_LABEL}
            </Button>
          )}
        </span>
      ),
    },
  ];

  // 0 件なら区画そのものを描かない。空の枠は見た目を崩す（設計 §7.1）。
  if (rows.length === 0) {
    return null;
  }

  return (
    <section id={MANUAL_PENDING_ANCHOR} style={{ marginTop: 'var(--tf-space-6)' }}>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 var(--tf-space-3)' }}>
        {`${MANUAL_PENDING_LABEL}（${rows.length} 件）`}
      </h2>

      {props.canWrite && (
        <div style={{ marginBottom: 'var(--tf-space-3)' }}>
          <Alert tone="warning">{MANUAL_PENDING_GUIDE}</Alert>
        </div>
      )}

      <Card>
        <Table columns={columns} rows={rows} rowKey={(row) => row.post.id} />
      </Card>

      <Modal
        open={done !== null}
        title="投稿を記録しますか？"
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
            <Button variant="primary" onClick={confirmDone}>
              記録する
            </Button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          SNS 側で投稿し終えたことを記録します。投稿の URL が分かれば、履歴から辿れます。
        </p>
        <label style={{ display: 'block' }}>
          投稿の URL（任意）
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
        title="予約を取りやめますか？"
        message="下書きに戻します。予約は解除されます。"
        confirmLabel="取りやめる"
        onConfirm={confirmCancel}
        onCancel={() => setCancelling(null)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </section>
  );
}
