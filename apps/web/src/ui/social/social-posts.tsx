'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PostStatus } from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import {
  Button,
  Card,
  ConfirmDialog,
  Pagination,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import { POST_STATUS_LABEL } from '@/ui/social/labels';
import { AsyncState } from '@/ui/states/async-state';

/**
 * SNS投稿一覧。
 *
 * 型A（一覧画面）の実装（`02_画面デザイン方針.md` §4）。
 * `007-sites` で確立した形をそのまま踏襲する（`01_スプリント計画.md` S7/S9）。
 *
 * **ここが表示するのは登録された投稿であって、配信の実績ではない。**
 * 外部SNSへの実配信は Plugin の責務（`01_アーキテクチャ設計.md` §12）。
 */

export interface PostRow {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
}

/** 一覧に本文を全部出すと表が崩れる。1行に収まる長さで切る。 */
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

export interface SocialPostsProps {
  readonly initialPosts: readonly PostRow[];
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
}

export function SocialPosts(props: SocialPostsProps) {
  const [posts, setPosts] = useState(props.initialPosts);
  const [deleting, setDeleting] = useState<PostRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している（06_画面設計.md §29）。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setDeleting(null);

    const result = await apiRequest(`/api/v1/social/posts/${target.id}`, {
      method: 'DELETE',
      body: {},
    });

    if (result.ok) {
      setPosts((current) => current.filter((post) => post.id !== target.id));
      setToast({ id: target.id, text: '削除しました。', tone: 'success' });
    } else {
      setToast({ id: target.id, text: result.error.message, tone: 'danger' });
    }
  }

  const columns: Column<PostRow>[] = [
    {
      key: 'account',
      header: 'アカウント',
      width: '12rem',
      render: (post) => props.accountNames[post.socialAccountId] ?? post.socialAccountId,
    },
    { key: 'body', header: '本文', render: (post) => excerpt(post.body) },
    {
      key: 'scheduledAt',
      header: '予約日時',
      width: '12rem',
      render: (post) => formatDateTime(post.scheduledAt),
    },
    {
      key: 'status',
      header: '状態',
      width: '8rem',
      render: (post) => POST_STATUS_LABEL[post.status as PostStatus] ?? post.status,
    },
    {
      key: 'actions',
      header: '操作',
      width: '12rem',
      render: (post) => (
        <span style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
          {canWrite && (
            <Link href={`/social/posts/${post.id}/edit`}>
              <Button variant="ghost">編集</Button>
            </Link>
          )}
          {canDelete && (
            <Button variant="ghost" onClick={() => setDeleting(post)}>
              削除
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          margin: 'var(--tf-space-6) 0 var(--tf-space-4)',
        }}
      >
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>投稿</h2>
        {canWrite && (
          <Link href="/social/posts/new">
            <Button variant="primary">+ 投稿を作成</Button>
          </Link>
        )}
      </header>

      <AsyncState
        status={posts.length === 0 ? 'empty' : 'ready'}
        emptyMessage="投稿が登録されていません。"
        emptyAction={
          canWrite ? (
            <Link href="/social/posts/new">
              <Button variant="primary">投稿を作成</Button>
            </Link>
          ) : undefined
        }
      >
        <Card>
          <Table columns={columns} rows={posts} rowKey={(post) => post.id} />
          <Pagination
            page={props.page}
            perPage={props.perPage}
            total={props.total}
            onChange={(page) => {
              window.location.assign(`/social?postPage=${page}`);
            }}
          />
        </Card>
      </AsyncState>

      <ConfirmDialog
        open={deleting !== null}
        title="投稿を削除しますか？"
        message={deleting === null ? '' : `「${excerpt(deleting.body)}」を削除します。`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
