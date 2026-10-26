'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import { ownValue } from '@/domain/own-value';
import {
  isPostStatus,
  POST_STATUSES,
  type DeliveryMode,
  type PostStatus,
} from '@/domain/social/social';
import { Alert, Badge, Button, Card, Pagination, Table, type Column } from '@/ui/components';
import { BulkPostActions, type BulkResultsInput } from '@/ui/social/bulk-post-actions';
import {
  APPROVAL_PENDING_ROW_NOTE,
  APPROVED_ROW_NOTE,
  DELIVERY_MODE_LABEL,
  MANUAL_PENDING_LABEL,
  NO_CREDENTIAL_BADGE,
  NO_PUBLISHER_BADGE,
  PENDING_APPROVAL_HREF,
  PENDING_MANUAL_HREF,
  POST_FILTER_ALL,
  POST_FILTER_CLEAR,
  POST_FILTER_EMPTY,
  POST_SOURCE_COLUMN_HEADER,
  POST_SOURCE_DELETED_SUFFIX,
  POST_SOURCE_REVOKED_SUFFIX,
  POST_SOURCE_SCREEN_LABEL,
  POST_STATUS_LABEL,
  remainingSkipsLabel,
  retryingNoteLabel,
} from '@/ui/social/labels';
import { PostFilterBar } from '@/ui/social/post-filter-bar';
import { PostBodyPreview } from '@/ui/social/post-preview';
import {
  DEFAULT_POST_PER_PAGE,
  openPostListPage,
  postListHref,
  type PostListFilters,
  type PostListOption,
  type PostSourceView,
} from '@/ui/social/post-list-params';
import { AsyncState } from '@/ui/states/async-state';

export type { BulkResultsInput } from '@/ui/social/bulk-post-actions';

/**
 * SNS投稿一覧。
 *
 * 型A（一覧画面）の実装（`02_画面デザイン方針.md` §4）。
 * `007-sites` で確立した形をそのまま踏襲する（`01_スプリント計画.md` S7/S9）。
 *
 * **ここが表示するのは登録された投稿であって、配信の実績ではない。**
 * 外部SNSへの実配信は Plugin の責務（`01_アーキテクチャ設計.md` §12）。
 *
 * 054-bulk-post-actions で、登録元の列・絞り込みの帯・行の選択と一括操作（一括送信・一括取り消し）を足した
 * （設計 §9.1〜§9.7）。**一括選択は表示中のページの行だけ**（設計 §5.3）。絞り込みはサーバで掛け、
 * 選び直すとページ全体を読み込み直す。一括の内訳は `bulk-plan.ts` の純関数が作り、正はサーバの項目ごとの結果。
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
  /**
   * 同じ理由で続けて飛ばされた回数（設計 §7.3。裁定 #15-a）。
   *
   * **`attemptCount` とは別。** あれは配信に着手した回数で、飛ばされた行では 0 のまま。
   * 予約し直しでは減らない（裁定 #14-a）ので、**運用者が予約し直す前に残りを知る**のに要る。
   */
  readonly skipCount: number;
  /** 配信後の投稿の URL。 */
  readonly externalUrl: string | null;
  /**
   * 手動投稿待ちか（設計 §7.3）。
   *
   * **「いま」は Server Component が判定する。** ここで `Date.now()` を見ると
   * Server と Client で描画が食い違う（設計 §7.1 の補足）。
   */
  readonly manualPending?: boolean;
  /**
   * 承認して予約にした時刻（ISO。048-social-post-approval 設計 §7.3）。承認を経ていなければ null。
   * **任意。** 渡さない行は承認を経ていないものとして描く。
   */
  readonly approvedAt?: string | null;
  /**
   * 一括操作の `expectedUpdatedAt`（ISO。054 設計 §9.8）。**渡さない行は選べない**
   * （チェックボックスを描かない。見た内容に対して操作する約束を守れないため）。
   */
  readonly updatedAt?: string;
  /** 登録元の表示（054 設計 §5.6）。**トークンの ID は持たない。** 渡さない行は「—」。 */
  readonly source?: PostSourceView;
  /** `scheduled` で、予約日時が未来か NULL（今すぐ送れる。「いま」は Server Component）。 */
  readonly scheduledFuture?: boolean;
  /** `scheduled`・自動配信で着手印がある（配信中）。 */
  readonly publishing?: boolean;
  /** `awaiting_approval` で、希望日時が過去（いまと等しいを含む）。 */
  readonly desiredPast?: boolean;
  /** 手動投稿のみの SNS のアカウント（承認は常に即投稿になる。048 裁定 5）。 */
  readonly manualOnly?: boolean;
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
export type Unready = 'no_publisher' | 'no_credential' | null;

/**
 * 見出し「投稿」の `id`（054 設計 §9.2 のアンカー）。リンクの組み立てには使わないが、古いブックマーク
 * （`/social?tab=posts#posts`）も見出しへ着くよう残す（055-social-pending-tab 設計 §9.8）。
 */
const POSTS_HEADING_ID = 'posts';

/** 「条件をクリア」の行き先の条件（条件の無い投稿タブ。055 設計 §9.8）。 */
const CLEARED_FILTERS: PostListFilters = {
  status: null,
  accountId: null,
  source: null,
  perPage: DEFAULT_POST_PER_PAGE,
  page: 1,
};

/** 状態の絞り込みの選択肢（「すべて」と投稿の全状態。054 設計 §9.2）。 */
const STATUS_OPTIONS: readonly PostListOption[] = [
  { value: '', label: POST_FILTER_ALL },
  ...POST_STATUSES.map((status) => ({ value: status, label: POST_STATUS_LABEL[status] })),
];

function toPostStatus(value: string): PostStatus | null {
  return isPostStatus(value) ? value : null;
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

/** 日時の値は折り返さない（056 設計 §5.5）。 */
const DATE_VALUE_STYLE: CSSProperties = { whiteSpace: 'nowrap' };

/** 操作のセル。入りきらないボタンは次の行へ折り返す（056 設計 §5.5）。「削除」は最後。 */
const OPS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--tf-space-2)',
  alignItems: 'center',
};

const CAPTION_STYLE = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
} as const;

/** 長いトークンの名前は 1 行で省略する（全体は `title`。設計 §9.1）。 */
const ELLIPSIS_STYLE: CSSProperties = {
  display: 'block',
  maxWidth: '10rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/**
 * 登録元の表示（054 設計 §5.6・§9.1）。画面の登録は「管理画面」、トークンは名前（失効・削除済みを添える）。
 * 渡さない行は「—」。送信待ちの表と承認のダイアログも使う（055-social-pending-tab 設計 §9.3.1・§9.3.4）。
 */
export function PostSourceLabel({ source }: { readonly source: PostSourceView | undefined }) {
  if (source === undefined) return '—';
  if (source.kind === 'screen') return POST_SOURCE_SCREEN_LABEL;
  return (
    <span>
      <span title={source.label} style={ELLIPSIS_STYLE}>
        {source.label}
      </span>
      {source.kind === 'token' && source.revoked && (
        <span style={CAPTION_STYLE}>{POST_SOURCE_REVOKED_SUFFIX}</span>
      )}
      {source.kind === 'deleted_token' && (
        <span style={CAPTION_STYLE}>{POST_SOURCE_DELETED_SUFFIX}</span>
      )}
    </span>
  );
}

/**
 * 配信の支度ができていない予約か（設計 §7.3、要件 §4 裁定 #8）。送信待ちの表も使う（055 設計 §9.3.1）。
 *
 * **予約そのものは断らない。** 弾かない代わりに、予約した時点で画面に出す。
 * 見るのは `scheduled` かつ `auto` の行だけ（手動投稿はジョブを通らない）。
 */
export function unreadyOf(
  post: Pick<PostRow, 'status' | 'deliveryMode' | 'socialAccountId'>,
  accountProviders: Readonly<Record<string, AccountProvider>>,
  publisherProviders: Readonly<Record<string, PublisherProvider>>,
): Unready {
  if (post.status !== 'scheduled' || post.deliveryMode !== 'auto') {
    return null;
  }
  const account = accountProviders[post.socialAccountId];
  if (account === undefined) {
    return null;
  }
  // provider は HTTP で決められるので、自分のプロパティだけを見る（047 設計 §4.1）。
  const publisher = ownValue(publisherProviders, account.provider);
  if (publisher === undefined || !publisher.publish) {
    return 'no_publisher';
  }
  // 資格情報の要らない配信手段では「未設定」を警告しない（設計 §5.7）。
  if (publisher.credentialFieldKeys.length > 0 && !account.credentialConfigured) {
    return 'no_credential';
  }
  return null;
}

/**
 * 支度のできていない予約の件数の警告（設計 §6.1.2・§7.3）。送信待ちの表も使う（055 設計 §9.3.3）。
 *
 * **これは「予約を断らない」ことと対になっている**（要件 §4 裁定 #8）。
 * 表示中のページの行の中で数える。全件を数える問い合わせは足さない。
 */
export function UnreadyAlert({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <div style={{ marginBottom: 'var(--tf-space-4)' }}>
      <Alert tone="warning">
        {/*
          **「いつまでに直せばよいか」まで伝える**（設計 §7.3、裁定 #9）。
          支度が整わない予約は約24時間で `failed` になる。画面がそれを言わないと、
          運用者は取りやめられて初めて知ることになる。
        */}
        {`配信の支度ができていない予約投稿が ${count} 件あります。配信 Plugin の有効化と資格情報の設定が済むまで配信されません。予約日時から約24時間が過ぎても支度が整わない投稿は、取りやめ（失敗）になります。`}
      </Alert>
    </div>
  );
}

/** 支度の Badge（設計 §7.3）。送信待ちの表も使う（055 設計 §9.3.1）。 */
export function UnreadyBadge({ unready }: { readonly unready: Unready }) {
  if (unready === null) return null;
  return (
    <span style={{ display: 'block', marginTop: 'var(--tf-space-1)' }}>
      <Badge tone="warning">
        {unready === 'no_publisher' ? NO_PUBLISHER_BADGE : NO_CREDENTIAL_BADGE}
      </Badge>
    </span>
  );
}

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
  /**
   * 解釈した一覧の条件（054 設計 §9.2）。**任意。** 渡したときだけ絞り込みの帯を描く。
   * 渡さなければ条件なし（ページ送りは `page` / `perPage` を保つ）。
   */
  readonly filters?: PostListFilters;
  /** 登録元の絞り込みの選択肢（「すべて」を含む。`postSourceOptionsOf` が作る）。 */
  readonly sourceOptions?: readonly PostListOption[];
  /** アカウントの絞り込みの選択肢（「すべて」を含めない。名前順）。 */
  readonly accountOptions?: readonly PostListOption[];
  /**
   * 選んだ状態・ダイアログを開いた状態・結果のダイアログで描く（テストのための口。Server Component は渡さない）。
   * `social-accounts.tsx` の `initialEditingAccountId` と同じ形（054 設計 §9.8）。
   */
  readonly initialSelectedIds?: readonly string[];
  readonly initialDialog?: 'send' | 'delete' | null;
  readonly initialResults?: BulkResultsInput;
}

export function SocialPosts(props: SocialPostsProps) {
  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している（06_画面設計.md §29）。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');

  const filters: PostListFilters = props.filters ?? {
    status: null,
    accountId: null,
    source: null,
    perPage: props.perPage,
    page: props.page,
  };
  // 表示件数は「条件」に数えない（絞り込む条件ではない）。
  const hasConditions =
    filters.status !== null || filters.accountId !== null || filters.source !== null;

  // 条件の無い投稿タブ（`postListHref` の既定値。055-social-pending-tab 設計 §9.8）。
  const clearHref = postListHref(CLEARED_FILTERS);

  /** 状態の列（設計 §7.3）。 */
  function statusCell(post: PostRow) {
    return (
      <span>
        {POST_STATUS_LABEL[post.status as PostStatus] ?? post.status}
        {/*
          **再試行待ちは状態ではない**（設計 §5.8）。`scheduled` のまま失敗理由が
          残っている行がそれで、次は `attemptCount + 1` 回目になる。
        */}
        {post.status === 'scheduled' && post.failureReason !== null && (
          <span style={CAPTION_STYLE}>{retryingNoteLabel(post.attemptCount)}</span>
        )}
        {/* 承認待ちは送信待ちタブで承認する（048 設計 §7.3、055-social-pending-tab 設計 §9.8）。 */}
        {post.status === 'awaiting_approval' && (
          <span style={CAPTION_STYLE}>
            <a href={PENDING_APPROVAL_HREF}>{APPROVAL_PENDING_ROW_NOTE}</a>
          </span>
        )}
        {/* 承認を経た予約。編集すると承認待ちへ戻ることの手がかり（048 設計 §7.3）。 */}
        {post.status === 'scheduled' &&
          post.approvedAt !== undefined &&
          post.approvedAt !== null && <span style={CAPTION_STYLE}>{APPROVED_ROW_NOTE}</span>}
        {/* 手動投稿は送信待ちタブで投稿する（055 設計 §9.8）。 */}
        {post.status === 'scheduled' && post.manualPending === true && (
          <span style={CAPTION_STYLE}>
            <a href={PENDING_MANUAL_HREF}>{MANUAL_PENDING_LABEL}</a>
          </span>
        )}
        {/*
          **残り回数は Badge とは別の問いに答える**（設計 §7.3、裁定 #15-a）。
          Badge は「支度の何が足りないか」、こちらは「あと何回で取りやめか」。
          支度が整った直後は Badge が消えても補足は残る（0 に戻るのは配信に着手できたとき）。
          飛ばされるのは `scheduled` かつ `auto` の行だけ（手動投稿はジョブを通らない）。
        */}
        {post.status === 'scheduled' && post.deliveryMode === 'auto' && post.skipCount > 0 && (
          <span style={CAPTION_STYLE}>{remainingSkipsLabel(post.skipCount)}</span>
        )}
        <UnreadyBadge unready={unreadyOf(post, props.accountProviders, props.publisherProviders)} />
      </span>
    );
  }

  return (
    // 選択・一括の帯・ダイアログ・1 件の削除は BulkPostActions が持つ（055 設計 §9.4）。
    <BulkPostActions
      rows={props.initialPosts}
      total={props.total}
      permissions={props.permissions}
      {...(props.initialSelectedIds === undefined
        ? {}
        : { initialSelectedIds: props.initialSelectedIds })}
      {...(props.initialDialog === undefined ? {} : { initialDialog: props.initialDialog })}
      {...(props.initialResults === undefined ? {} : { initialResults: props.initialResults })}
    >
      {({ rows: posts, selectColumn, band, requestDelete }) => {
        const columns: Column<PostRow>[] = [
          ...(selectColumn === null ? [] : [selectColumn]),
          // 並びは送信待ちと揃える（状態が先頭。056 設計 §5.4）。列の幅は選択の列だけが持つ（§5.5）。
          // 本文は 2 段目（detailCell）。
          { key: 'status', header: '状態', render: statusCell },
          {
            key: 'account',
            header: 'アカウント',
            render: (post) => props.accountNames[post.socialAccountId] ?? post.socialAccountId,
          },
          {
            // どのアプリ（トークン）から来た投稿か（054 設計 §5.6・§9.1）。閲覧者にも出す。
            key: 'source',
            header: POST_SOURCE_COLUMN_HEADER,
            render: (post) => <PostSourceLabel source={post.source} />,
          },
          {
            key: 'scheduledAt',
            header: '予約日時',
            render: (post) => (
              <span style={DATE_VALUE_STYLE}>{formatDateTime(post.scheduledAt)}</span>
            ),
          },
          {
            key: 'deliveryMode',
            header: '配信方法',
            render: (post) => DELIVERY_MODE_LABEL[post.deliveryMode] ?? post.deliveryMode,
          },
          {
            key: 'actions',
            header: '操作',
            render: (post) => (
              <span style={OPS_STYLE}>
                {canWrite && (
                  <Link href={`/social/posts/${post.id}/edit`}>
                    <Button variant="ghost">編集</Button>
                  </Link>
                )}
                {canDelete && (
                  <Button variant="ghost" onClick={() => requestDelete(post)}>
                    削除
                  </Button>
                )}
              </span>
            ),
          },
        ];

        /** 2 段目：本文の全文と、配信済みならその下に外部の投稿へのリンク（056 設計 §5.2）。 */
        function detailCell(post: PostRow) {
          return (
            <>
              <PostBodyPreview body={post.body} />
              {/* 配信済みの投稿は外部の本物へ辿れるようにする（設計 §7.3）。 */}
              {post.status === 'published' && post.externalUrl !== null && (
                <span style={{ display: 'block', marginTop: 'var(--tf-space-1)' }}>
                  <a
                    href={post.externalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--tf-color-primary)',
                      fontSize: 'var(--tf-text-caption)',
                    }}
                  >
                    投稿を見る ↗
                  </a>
                </span>
              )}
            </>
          );
        }

        const unreadyCount = posts.filter(
          (post) => unreadyOf(post, props.accountProviders, props.publisherProviders) !== null,
        ).length;
        const clearLink = <a href={clearHref}>{POST_FILTER_CLEAR}</a>;

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
              {/* 絞り込み・ページ送りで読み込み直した後に一覧へ戻る先（054 設計 §9.2）。 */}
              <h2 id={POSTS_HEADING_ID} style={{ fontSize: '1.05rem', margin: 0 }}>
                投稿
              </h2>
              {canWrite && (
                <Link href="/social/posts/new">
                  <Button variant="primary">+ 投稿を作成</Button>
                </Link>
              )}
            </header>

            {/* 絞り込みの帯（054 設計 §9.2）。条件はサーバで掛ける。 */}
            {props.filters !== undefined && (
              <PostFilterBar
                filters={filters}
                hrefFor={postListHref}
                statusOptions={STATUS_OPTIONS}
                toStatus={toPostStatus}
                {...(props.accountOptions === undefined
                  ? {}
                  : { accountOptions: props.accountOptions })}
                {...(props.sourceOptions === undefined
                  ? {}
                  : { sourceOptions: props.sourceOptions })}
                hasConditions={hasConditions}
                clearHref={clearHref}
              />
            )}

            <UnreadyAlert count={unreadyCount} />

            {band}

            <AsyncState
              status={posts.length === 0 ? 'empty' : 'ready'}
              // 条件で絞って 0 件なら、登録が無いのではなく条件に合わないことを伝える（054 設計 §9.2）。
              emptyMessage={hasConditions ? POST_FILTER_EMPTY : '投稿が登録されていません。'}
              emptyAction={
                hasConditions ? (
                  clearLink
                ) : canWrite ? (
                  <Link href="/social/posts/new">
                    <Button variant="primary">投稿を作成</Button>
                  </Link>
                ) : undefined
              }
            >
              <Card>
                <Table
                  columns={columns}
                  rows={posts}
                  rowKey={(post) => post.id}
                  detail={detailCell}
                />
                <Pagination
                  page={props.page}
                  perPage={props.perPage}
                  total={props.total}
                  // 絞り込みを保ったまま移る（054 設計 §9.2）。選択は読み込み直しで消える。
                  onChange={(page) => openPostListPage(filters, page)}
                />
              </Card>
            </AsyncState>
          </>
        );
      }}
    </BulkPostActions>
  );
}
