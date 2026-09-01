'use client';

import Link from 'next/link';
import { useState } from 'react';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  Pagination,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import { campaignStatusLabel } from '@/ui/campaign/labels';

/**
 * キャンペーン一覧（06_画面設計.md §14）。
 *
 * `site-list.tsx` と同じ形にそろえている。
 */

export interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteCount: number;
  readonly postCount: number;
}

export function CampaignList({
  initialCampaigns,
  total,
  page,
  perPage,
  permissions,
}: {
  readonly initialCampaigns: readonly CampaignRow[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
}) {
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [deleting, setDeleting] = useState<CampaignRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const canWrite = permissions.includes('campaign.write');
  const canDelete = permissions.includes('campaign.delete');

  async function onDelete(campaign: CampaignRow): Promise<void> {
    const result = await apiRequest(`/api/v1/campaigns/${campaign.id}`, { method: 'DELETE' });
    setDeleting(null);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setCampaigns((current) => current.filter((row) => row.id !== campaign.id));
    setToast({ id: crypto.randomUUID(), tone: 'success', text: '削除しました。' });
  }

  const columns: readonly Column<CampaignRow>[] = [
    {
      key: 'name',
      header: '名前',
      render: (campaign) =>
        canWrite ? (
          <Link href={`/campaigns/${campaign.id}/edit`}>{campaign.name}</Link>
        ) : (
          campaign.name
        ),
    },
    {
      key: 'status',
      header: '状態',
      render: (campaign) => campaignStatusLabel(campaign.status),
    },
    {
      key: 'period',
      header: '期間',
      // 終わりが無いのは「まだ続いている」こと。空欄にすると欠損に見える。
      render: (campaign) => `${campaign.startsOn} 〜 ${campaign.endsOn ?? '（未定）'}`,
    },
    {
      key: 'sites',
      header: '対象サイト',
      render: (campaign) => (campaign.siteCount === 0 ? '—' : `${campaign.siteCount} 件`),
    },
    {
      key: 'posts',
      header: 'SNS投稿',
      render: (campaign) => (campaign.postCount === 0 ? '—' : `${campaign.postCount} 件`),
    },
    {
      key: 'actions',
      header: '',
      render: (campaign) => (
        <span style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
          {/* 分析は参照だけなので、一覧を開けている相手には常に出す（06_画面設計.md §14）。 */}
          <Link href={`/campaigns/${campaign.id}/analytics`}>
            <Button variant="ghost">分析</Button>
          </Link>
          {canDelete && (
            <Button variant="danger" onClick={() => setDeleting(campaign)}>
              削除
            </Button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 'var(--tf-space-4)',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>キャンペーン</h1>
        {canWrite && (
          <Link href="/campaigns/new">
            <Button variant="primary">新規作成</Button>
          </Link>
        )}
      </div>

      {error !== null && <Alert tone="danger">{error}</Alert>}

      {campaigns.length === 0 ? (
        <EmptyState message="キャンペーンはまだありません。" />
      ) : (
        <>
          <Table columns={columns} rows={campaigns} rowKey={(campaign) => campaign.id} />
          <Pagination
            page={page}
            perPage={perPage}
            total={total}
            onChange={(next) => window.location.assign(`/campaigns?page=${next}`)}
          />
        </>
      )}

      {deleting !== null && (
        <ConfirmDialog
          open
          title="キャンペーンを削除しますか？"
          message={`「${deleting.name}」を削除します。元に戻せません。`}
          confirmLabel="削除する"
          onConfirm={() => void onDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {toast !== null && <Toast message={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
