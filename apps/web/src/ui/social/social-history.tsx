'use client';

import Link from 'next/link';
import type { PostStatus } from '@/domain/social/social';
import { Alert, Button, Card, Pagination, Table, type Column } from '@/ui/components';
import { POST_STATUS_LABEL } from '@/ui/social/labels';
import { AsyncState } from '@/ui/states/async-state';

/**
 * SNS の配信履歴（06_画面設計.md §13「履歴」）。
 *
 * **試行履歴のテーブルは無い。** `published` / `failed` は終端状態で、
 * 1つの投稿が持つ配信結果は高々1つ。ここが出すのは
 * **配信結果が確定した投稿の一覧**である（026-screen-completion 設計 §4.3）。
 *
 * **失敗の理由を必ず列に出す。** 「失敗」とだけ出ても、
 * 見た人は何をすればよいか分からない。
 */

export interface HistoryRow {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly status: PostStatus;
  /** 配信済みなら配信時刻、失敗なら失敗時刻。 */
  readonly resultAt: string | null;
  readonly failureReason: string | null;
}

const EXCERPT_LENGTH = 60;

function excerpt(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EXCERPT_LENGTH ? oneLine : `${oneLine.slice(0, EXCERPT_LENGTH)}…`;
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

export interface SocialHistoryProps {
  readonly rows: readonly HistoryRow[];
  readonly accountNames: Readonly<Record<string, string>>;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  /** 'published' / 'failed' / '' （すべて）。 */
  readonly status: string;
}

/** 絞り込みを保ったままページを送る。 */
function hrefFor(page: number, status: string): string {
  const params = new URLSearchParams();
  if (status !== '') {
    params.set('status', status);
  }
  if (page > 1) {
    params.set('page', String(page));
  }
  const query = params.toString();
  return query === '' ? '/social/history' : `/social/history?${query}`;
}

export function SocialHistory(props: SocialHistoryProps) {
  const failures = props.rows.filter((row) => row.status === 'failed').length;

  const columns: readonly Column<HistoryRow>[] = [
    {
      key: 'account',
      header: 'アカウント',
      width: '12rem',
      render: (row) => props.accountNames[row.socialAccountId] ?? row.socialAccountId,
    },
    { key: 'body', header: '投稿', render: (row) => excerpt(row.body) },
    {
      key: 'status',
      header: '結果',
      width: '7rem',
      render: (row) => POST_STATUS_LABEL[row.status] ?? row.status,
    },
    {
      key: 'resultAt',
      header: '日時',
      width: '12rem',
      render: (row) => formatDateTime(row.resultAt),
    },
    {
      key: 'failureReason',
      header: '失敗の理由',
      render: (row) => row.failureReason ?? '—',
    },
  ];

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>配信履歴</h1>
        <Link href="/social">
          <Button variant="secondary">SNSへ戻る</Button>
        </Link>
      </div>

      <Card>
        {/*
          絞り込みは form の GET で行う。Client の状態にすると、
          ページを送ったときに絞り込みが外れる。
        */}
        <form method="get" style={{ display: 'flex', gap: 'var(--tf-space-3)', alignItems: 'end' }}>
          <label>
            結果
            <select name="status" defaultValue={props.status}>
              <option value="">すべて</option>
              <option value="published">配信済み</option>
              <option value="failed">失敗</option>
            </select>
          </label>
          <Button type="submit" variant="secondary">
            絞り込む
          </Button>
        </form>
      </Card>

      {failures > 0 && (
        <Alert tone="danger">
          この画面に失敗した投稿が {failures} 件あります。理由を確認してください。
        </Alert>
      )}

      <AsyncState
        status={props.rows.length === 0 ? 'empty' : 'ready'}
        emptyMessage="配信結果が確定した投稿はまだありません。"
      >
        <Card>
          <Table columns={columns} rows={props.rows} rowKey={(row) => row.id} />
          <Pagination
            page={props.page}
            perPage={props.perPage}
            total={props.total}
            onChange={(next) => window.location.assign(hrefFor(next, props.status))}
          />
        </Card>
      </AsyncState>

      <p style={{ color: 'var(--tf-color-text-muted)', margin: 0 }}>
        実際の配信は連携プラグインが行い、その結果がここへ記録されます （01_アーキテクチャ設計.md
        §12）。
      </p>
    </div>
  );
}
