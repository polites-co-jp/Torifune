'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { DeliveryMode, PostStatus } from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Pagination,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import {
  DELIVERY_MODE_LABEL,
  MANUAL_PENDING_ANCHOR,
  MANUAL_PENDING_LABEL,
  NO_CREDENTIAL_BADGE,
  NO_PUBLISHER_BADGE,
  POST_STATUS_LABEL,
} from '@/ui/social/labels';
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
  readonly deliveryMode: DeliveryMode;
  /** 直近の失敗理由。`scheduled` のまま残っていれば再試行待ち（設計 §5.8）。 */
  readonly failureReason: string | null;
  readonly attemptCount: number;
  /** 配信後の投稿の URL。 */
  readonly externalUrl: string | null;
  /**
   * 手動投稿待ちか（設計 §7.3）。
   *
   * **「いま」は Server Component が判定する。** ここで `Date.now()` を見ると
   * Server と Client で描画が食い違う（設計 §7.1 の補足）。
   */
  readonly manualPending?: boolean;
}

/** アカウントごとの配信の支度（設計 §7.3）。 */
export interface AccountProvider {
  readonly provider: string;
  readonly credentialConfigured: boolean;
}

/** 登録された publisher（`publisherRegistry.listPublishers()` から Server Component が組む）。 */
export interface PublisherProvider {
  readonly label: string;
  readonly manual: boolean;
  readonly publish: boolean;
  readonly credentialFieldKeys: readonly string[];
}

/** 配信の支度ができていない理由。整っていれば null。 */
type Unready = 'no_publisher' | 'no_credential' | null;

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

const CAPTION_STYLE = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
} as const;

export interface SocialPostsProps {
  readonly initialPosts: readonly PostRow[];
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  /** アカウントIDから provider と資格情報の有無を引く対応表。 */
  readonly accountProviders: Readonly<Record<string, AccountProvider>>;
  /** provider から登録された publisher を引く対応表。 */
  readonly publisherProviders: Readonly<Record<string, PublisherProvider>>;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
}

export function SocialPosts(props: SocialPostsProps) {
  /**
   * 配信の支度ができていない予約か（設計 §7.3、要件 §4 裁定 #8）。
   *
   * **予約そのものは断らない。** 弾かない代わりに、予約した時点で画面に出す。
   * 見るのは `scheduled` かつ `auto` の行だけ（手動投稿はジョブを通らない）。
   */
  function unreadyOf(post: PostRow): Unready {
    if (post.status !== 'scheduled' || post.deliveryMode !== 'auto') {
      return null;
    }
    const account = props.accountProviders[post.socialAccountId];
    if (account === undefined) {
      return null;
    }
    const publisher = props.publisherProviders[account.provider];
    if (publisher === undefined || !publisher.publish) {
      return 'no_publisher';
    }
    // 資格情報の要らない配信手段では「未設定」を警告しない（設計 §5.7）。
    if (publisher.credentialFieldKeys.length > 0 && !account.credentialConfigured) {
      return 'no_credential';
    }
    return null;
  }

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
    {
      key: 'body',
      header: '本文',
      render: (post) => (
        <span>
          {excerpt(post.body)}
          {/* 配信済みの投稿は外部の本物へ辿れるようにする（設計 §7.3）。 */}
          {post.status === 'published' && post.externalUrl !== null && (
            <a
              href={post.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: 'var(--tf-space-2)',
                color: 'var(--tf-color-primary)',
                fontSize: 'var(--tf-text-caption)',
              }}
            >
              投稿を見る ↗
            </a>
          )}
        </span>
      ),
    },
    {
      key: 'scheduledAt',
      header: '予約日時',
      width: '12rem',
      render: (post) => formatDateTime(post.scheduledAt),
    },
    {
      key: 'deliveryMode',
      header: '配信方法',
      width: '7rem',
      render: (post) => DELIVERY_MODE_LABEL[post.deliveryMode] ?? post.deliveryMode,
    },
    {
      key: 'status',
      header: '状態',
      width: '12rem',
      render: (post) => {
        const unready = unreadyOf(post);
        return (
          <span>
            {POST_STATUS_LABEL[post.status as PostStatus] ?? post.status}
            {/*
              **再試行待ちは状態ではない**（設計 §5.8）。`scheduled` のまま失敗理由が
              残っている行がそれで、次は `attemptCount + 1` 回目になる。
            */}
            {post.status === 'scheduled' && post.failureReason !== null && (
              <span style={CAPTION_STYLE}>{`（再試行待ち・${post.attemptCount + 1} 回目）`}</span>
            )}
            {post.status === 'scheduled' && post.manualPending === true && (
              <span style={CAPTION_STYLE}>
                <a href={`#${MANUAL_PENDING_ANCHOR}`}>{MANUAL_PENDING_LABEL}</a>
              </span>
            )}
            {unready !== null && (
              <span style={{ display: 'block', marginTop: 'var(--tf-space-1)' }}>
                <Badge tone="warning">
                  {unready === 'no_publisher' ? NO_PUBLISHER_BADGE : NO_CREDENTIAL_BADGE}
                </Badge>
              </span>
            )}
          </span>
        );
      },
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

  const unreadyCount = posts.filter((post) => unreadyOf(post) !== null).length;

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

      {/*
        **これは「予約を断らない」ことと対になっている**（設計 §6.1.2、要件 §4 裁定 #8）。
        このページの行の中で数える。全件を数える問い合わせは足さない。
      */}
      {unreadyCount > 0 && (
        <div style={{ marginBottom: 'var(--tf-space-4)' }}>
          <Alert tone="warning">
            {`配信の支度ができていない予約投稿が ${unreadyCount} 件あります。配信 Plugin の有効化と資格情報の設定が済むまで配信されません。`}
          </Alert>
        </div>
      )}

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
