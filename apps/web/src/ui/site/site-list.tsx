'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import {
  Button,
  ConfirmDialog,
  Pagination,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import { AsyncState } from '@/ui/states/async-state';

/**
 * Webサイト一覧。
 *
 * 型A（一覧画面）の実装（`02_画面デザイン方針.md` §4）。
 * 以降のドメインもこの形を踏襲する。
 */

export interface SiteRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: '稼働中',
  paused: '停止中',
  archived: 'アーカイブ',
};

export interface SiteListProps {
  readonly initialSites: readonly SiteRow[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
}

export function SiteList(props: SiteListProps) {
  const [sites, setSites] = useState(props.initialSites);
  const [deleting, setDeleting] = useState<SiteRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している。
  const canWrite = permissions.has('site.write');
  const canDelete = permissions.has('site.delete');

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setDeleting(null);

    const result = await apiRequest(`/api/v1/sites/${target.id}`, { method: 'DELETE', body: {} });

    if (result.ok) {
      setSites((current) => current.filter((site) => site.id !== target.id));
      setToast({ id: target.id, text: '削除しました。', tone: 'success' });
    } else {
      setToast({ id: target.id, text: result.error.message, tone: 'danger' });
    }
  }

  const columns: Column<SiteRow>[] = [
    { key: 'name', header: '名前', render: (site) => site.name },
    {
      key: 'url',
      header: 'URL',
      render: (site) => (
        // rel を付けないと、開いた先から window.opener 経由で操作されうる。
        <a href={site.url} target="_blank" rel="noopener noreferrer">
          {site.url}
        </a>
      ),
    },
    {
      key: 'status',
      header: '状態',
      render: (site) => STATUS_LABEL[site.status] ?? site.status,
      width: '8rem',
    },
    {
      key: 'actions',
      header: '操作',
      width: '12rem',
      render: (site) => (
        <span style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
          {canWrite && (
            <Link href={`/sites/${site.id}/edit`}>
              <Button variant="ghost">編集</Button>
            </Link>
          )}
          {canDelete && (
            <Button variant="ghost" onClick={() => setDeleting(site)}>
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
          marginBottom: 'var(--tf-space-4)',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Webサイト</h1>
        {canWrite && (
          <Link href="/sites/new">
            <Button variant="primary">+ 新規</Button>
          </Link>
        )}
      </header>

      <AsyncState
        status={sites.length === 0 ? 'empty' : 'ready'}
        emptyMessage="Webサイトが登録されていません。"
        emptyAction={
          canWrite ? (
            <Link href="/sites/new">
              <Button variant="primary">新しいWebサイトを登録</Button>
            </Link>
          ) : undefined
        }
      >
        <Table columns={columns} rows={sites} rowKey={(site) => site.id} />
        <Pagination
          page={props.page}
          perPage={props.perPage}
          total={props.total}
          onChange={(page) => {
            window.location.assign(`/sites?page=${page}`);
          }}
        />
      </AsyncState>

      <ConfirmDialog
        open={deleting !== null}
        title="Webサイトを削除しますか？"
        message={deleting === null ? '' : `「${deleting.name}」を削除します。`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
